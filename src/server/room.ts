/**
 * One Durable Object per room. Everything the room needs to agree on lives here:
 * the transcript, the shared document, who is present, and the agent's turn.
 * Because a DO is single-threaded, none of it needs locking.
 *
 * The important design decision is in `advance()` / `settleIfDecided()`. An agent
 * turn that hits an approval-gated tool cannot simply `await` the vote: the
 * runtime may evict this object long before a human clicks a button. So the turn
 * is a state machine whose progress is written to storage. `advance()` runs until
 * it either finishes or parks on a vote, then returns. A later `vote` message —
 * separate invocation, possibly a fresh instance — reads that state back and
 * resumes. Nothing is held in memory across the wait.
 */

import { Agent, type Connection, type ConnectionContext } from "agents";
import type {
  MessageParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";

import {
  INITIAL_ROOM_STATE,
  INVITABLE_ROLES,
  UID_RE,
  colorFor,
  tally,
  type AgentBlock,
  type ClientMsg,
  type Entry,
  type InviteSummary,
  type MemberSummary,
  type PendingTool,
  type Presence,
  type RoomState,
  type ServerMsg,
  type WorkerStatus,
} from "../shared/protocol";
import {
  DEFAULT_POLICY,
  approvalThreshold,
  asRole,
  can,
  describePolicy,
  isVoter,
  outranks,
  sanitizeAccessPolicy,
  type AccessPolicy,
  type Capability,
  type Role,
} from "../shared/access";
import {
  DEFAULT_SETTINGS,
  addUsage,
  describeSettings,
  effectiveWorkerCap,
  sanitizeSettings,
  type RoomSettings,
} from "../shared/models";
import {
  runModel,
  runWorker,
  summarize as summarizeConversation,
  type ModelConfig,
  type Usage,
  type WorkerTask,
} from "./model";
import {
  execute,
  gatedFor,
  summarize as summarizeCall,
  toolsForRoom,
  workerToolsFor,
  type ToolCtx,
  type ToolOutcome,
} from "./tools";
import { constantTimeEqual, mintToken, newInviteCode } from "./auth";
import { GithubProvider, installationToken, parseRepoRef, pemToPkcs8 } from "./github";
import { PendingRequests } from "./workspace";
import {
  FS_LIMITS,
  NO_WORKSPACE,
  clampRequest,
  isWriteOp,
  normalizePath,
  pathDecision,
  type FsRequest,
  type FsResponse,
  type WorkspaceKind,
} from "../shared/workspace";

/** In-flight turn bookkeeping. Persisted, because a turn can outlive this instance. */
type Turn = {
  /** Transcript entry this turn is writing into. */
  entryId: string;
  /** Results from auto-approved tools, held until the gated ones are decided. */
  carried: ToolResultBlockParam[];
};

type QueuedLine = { name: string; text: string };

/** Hard stop on tool round-trips so a confused turn can't loop forever. */
const MAX_ROUNDS = 12;

export class Room extends Agent<Env, RoomState> {
  initialState: RoomState = INITIAL_ROOM_STATE;

  #schemaReady = false;

  /**
   * Correlates outstanding filesystem requests sent to the workspace host's
   * socket with their eventual "fs.res" reply. See src/server/workspace.ts for
   * why this lives in memory rather than storage.
   */
  #pending = new PendingRequests();

  // ---------------------------------------------------------------- storage

  #ready() {
    if (this.#schemaReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS members (
      uid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    )`;
    // Added after the members table shipped, so it has to be tolerated as a
    // no-op on a room that already has the column.
    try {
      this.sql`ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'editor'`;
    } catch {
      /* column already present */
    }
    this.sql`CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      max_uses INTEGER NOT NULL,
      uses INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER NOT NULL DEFAULT 0,
      label TEXT NOT NULL DEFAULT ''
    )`;
    // Only the installation id and repo are stored here. Installation tokens
    // are short-lived (about an hour) and are minted fresh per request, never
    // persisted — a stored token is a stored credential with an hour to be
    // stolen in, and RoomState syncs to every connected client, so anything
    // secret placed there or here is handed to every member of the room.
    this.sql`CREATE TABLE IF NOT EXISTS github (
      k TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      connected_by TEXT NOT NULL,
      connected_at INTEGER NOT NULL
    )`;
    this.#schemaReady = true;
  }

  #kvGet<T>(key: string, fallback: T): T {
    const rows = this.sql<{ v: string }>`SELECT v FROM kv WHERE k = ${key}`;
    if (rows.length === 0) return fallback;
    try {
      return JSON.parse(rows[0]!.v) as T;
    } catch {
      return fallback;
    }
  }

  #kvSet(key: string, value: unknown) {
    const v = JSON.stringify(value);
    this.sql`INSERT INTO kv (k, v) VALUES (${key}, ${v})
             ON CONFLICT(k) DO UPDATE SET v = excluded.v`;
  }

  #kvDel(key: string) {
    this.sql`DELETE FROM kv WHERE k = ${key}`;
  }

  #convo(): MessageParam[] {
    return this.#kvGet<MessageParam[]>("convo", []);
  }
  #setConvo(m: MessageParam[]) {
    this.#kvSet("convo", m);
  }

  #inbox(): QueuedLine[] {
    return this.#kvGet<QueuedLine[]>("inbox", []);
  }
  #setInbox(q: QueuedLine[]) {
    this.#kvSet("inbox", q);
  }

  #turn(): Turn | null {
    return this.#kvGet<Turn | null>("turn", null);
  }
  #setTurn(t: Turn | null) {
    if (t === null) this.#kvDel("turn");
    else this.#kvSet("turn", t);
  }

  // -------------------------------------------------------------- transcript

  #entries(): Entry[] {
    const rows = this.sql<{ json: string }>`SELECT json FROM entries ORDER BY ts ASC`;
    return rows.map((r) => JSON.parse(r.json) as Entry);
  }

  #getEntry(id: string): Entry | null {
    const rows = this.sql<{ json: string }>`SELECT json FROM entries WHERE id = ${id}`;
    return rows.length ? (JSON.parse(rows[0]!.json) as Entry) : null;
  }

  #putEntry(entry: Entry) {
    const json = JSON.stringify(entry);
    this.sql`INSERT INTO entries (id, ts, json) VALUES (${entry.id}, ${entry.ts}, ${json})
             ON CONFLICT(id) DO UPDATE SET json = excluded.json`;
  }

  #append(entry: Entry) {
    this.#putEntry(entry);
    this.#send({ t: "entry", entry });
  }

  #patch(entry: Entry) {
    this.#putEntry(entry);
    this.#send({ t: "patch", entry });
  }

  #system(text: string) {
    this.#append({ id: crypto.randomUUID(), ts: Date.now(), kind: "system", text });
  }

  #send(msg: ServerMsg) {
    this.broadcast(JSON.stringify(msg));
  }

  /** The member this socket joined as, or null if it hasn't joined yet. */
  #uidOf(connection: Connection): string | null {
    const s = connection.state as { uid?: string } | null;
    return s?.uid ?? null;
  }

  /** The display name on record for a member, or null if there is no such member. */
  #memberName(uid: string): string | null {
    const rows = this.sql<{ name: string }>`SELECT name FROM members WHERE uid = ${uid}`;
    return rows.length ? rows[0]!.name : null;
  }

  /** The name behind a socket, or null if it hasn't joined. */
  #nameOf(connection: Connection): string | null {
    const uid = this.#uidOf(connection);
    return uid ? this.#memberName(uid) : null;
  }

  /** The role bound to this socket at connect time. */
  #roleOf(connection: Connection): Role {
    const s = connection.state as { role?: string } | null;
    return asRole(s?.role);
  }

  /**
   * Gate one action. Returns true when the socket may proceed.
   *
   * Every handler that changes anything calls this first. The client hides
   * controls it knows are unavailable, but that is cosmetic — this is the
   * boundary, and it is the only one that counts.
   */
  #allow(connection: Connection, cap: Capability, refusal: string): boolean {
    const uid = this.#uidOf(connection);
    if (!uid || this.#memberRole(uid) === null) return false;
    if (!can(this.#roleOf(connection), cap)) {
      this.#refuse(connection, refusal);
      return false;
    }
    return true;
  }

  /** The room's own record, or null if this room was never created. */
  #room(): { title: string; visibility: string; createdAt: number } | null {
    return this.#kvGet<{ title: string; visibility: string; createdAt: number } | null>(
      "room",
      null,
    );
  }

  /** The role on record for a member, or null if they are not a member. */
  #memberRole(uid: string): string | null {
    const rows = this.sql<{ role: string }>`SELECT role FROM members WHERE uid = ${uid}`;
    return rows.length ? rows[0]!.role : null;
  }

  /**
   * Decide whether an invite code admits its holder, and why not if it doesn't.
   *
   * Ordering matters: a revoked code reports as revoked even after it expires,
   * because "we took that link away" and "that link aged out" are different
   * things to tell someone, and the first is the one an admin acted on.
   */
  #checkInvite(code: string):
    | { ok: true; role: string }
    | { ok: false; reason: "bad_code" | "code_revoked" | "code_expired" | "code_used_up" } {
    const rows = this.sql<{
      code: string;
      role: string;
      max_uses: number;
      uses: number;
      expires_at: number;
      revoked_at: number;
    }>`SELECT code, role, max_uses, uses, expires_at, revoked_at FROM invites WHERE code = ${code}`;

    const row = rows[0];
    if (!row) return { ok: false, reason: "bad_code" };
    if (row.revoked_at > 0) return { ok: false, reason: "code_revoked" };
    if (row.expires_at > 0 && row.expires_at <= Date.now()) {
      return { ok: false, reason: "code_expired" };
    }
    if (row.max_uses > 0 && row.uses >= row.max_uses) {
      return { ok: false, reason: "code_used_up" };
    }
    return { ok: true, role: row.role };
  }

  /** Every invite for this room, newest first. Only ever sent to one connection. */
  #invites(): InviteSummary[] {
    const rows = this.sql<{
      code: string;
      role: string;
      max_uses: number;
      uses: number;
      expires_at: number;
      created_at: number;
      revoked_at: number;
      label: string;
    }>`SELECT code, role, max_uses, uses, expires_at, created_at, revoked_at, label
       FROM invites ORDER BY created_at DESC`;
    return rows.map((r) => ({
      code: r.code,
      role: r.role,
      maxUses: r.max_uses,
      uses: r.uses,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      revoked: r.revoked_at > 0,
      label: r.label,
    }));
  }

  /** Everyone who has ever joined, with whether they are connected right now. */
  #members(): MemberSummary[] {
    const online = new Set(this.#presence().map((u) => u.uid));
    const rows = this.sql<{
      uid: string; name: string; role: string; joined_at: number; last_seen: number;
    }>`SELECT uid, name, role, joined_at, last_seen FROM members ORDER BY joined_at ASC`;
    return rows.map((r) => ({
      uid: r.uid,
      name: r.name,
      role: asRole(r.role),
      joinedAt: r.joined_at,
      lastSeen: r.last_seen,
      online: online.has(r.uid),
    }));
  }

  // ---------------------------------------------------------------- presence

  /**
   * Who is in the room, one entry per person rather than one per socket.
   *
   * `exclude` drops a single connection id from the count. `onClose` needs it
   * because the closing socket may still be listed when the handler runs.
   */
  #presence(exclude?: string): Presence[] {
    const counts = new Map<string, number>();
    for (const conn of this.getConnections()) {
      if (exclude !== undefined && conn.id === exclude) continue;
      const uid = this.#uidOf(conn);
      if (!uid) continue;
      counts.set(uid, (counts.get(uid) ?? 0) + 1);
    }

    const out: Presence[] = [];
    for (const [uid, connections] of counts) {
      const name = this.#memberName(uid);
      if (!name) continue;
      out.push({ uid, name, color: colorFor(uid), connections, role: asRole(this.#memberRole(uid)) });
    }
    // Stable order, so the presence strip doesn't reshuffle on every update.
    out.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
    return out;
  }

  /**
   * Recompute who is here. Thresholds on open votes move with the headcount —
   * otherwise a vote raised in a busy room becomes undecidable once people leave.
   */
  async #refreshPresence(exclude?: string) {
    const users = this.#presence(exclude);
    // Viewers are present but cannot vote, so they must not raise the bar.
    const threshold = approvalThreshold(
      this.#policy().approval,
      users.filter((u) => isVoter(u.role)).length,
    );
    const present = new Set(users.map((u) => u.uid));

    const pending = this.state.pending.map((p) => {
      // Drop votes from people who have left, so tallies match the new threshold.
      const votes = Object.fromEntries(
        Object.entries(p.votes).filter(([uid]) => present.has(uid)),
      );
      return { ...p, votes, threshold };
    });

    this.setState({ ...this.state, users, pending });
    if (pending.length > 0) await this.#settleIfDecided();
  }

  /**
   * The room's internal HTTP surface, called by the Worker and by nothing else.
   *
   * Admission is decided here rather than in the Worker because it depends on
   * state only this object holds: whether the room exists, who is already a
   * member, and what the room's visibility is set to.
   */
  override async onRequest(request: Request): Promise<Response> {
    this.#ready();
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    // `/init` hands out ownership, so this surface is restricted to the Worker
    // by proof rather than by assumption. A request that arrives from outside
    // carries the `/agents/room/:id` prefix and would miss the exact pathname
    // matches below — but that is a property of how the router happens to
    // forward paths, and ownership of a room is too much to stake on it.
    const caller = request.headers.get("x-internal-auth") ?? "";
    if (!constantTimeEqual(caller, this.env.ROOM_SECRET ?? "")) {
      return json({ error: "not_found" }, 404);
    }

    let body: { uid?: string; name?: string; title?: string; code?: string; installationId?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "bad_request" }, 400);
    }

    const uid = String(body.uid ?? "");
    const name = String(body.name ?? "").trim().slice(0, 32) || "anon";
    if (!UID_RE.test(uid)) return json({ error: "bad_request" }, 400);

    const now = Date.now();

    if (url.pathname === "/init") {
      // Creating a room that already exists would silently hand ownership to
      // whoever asked second, so it is refused outright.
      if (this.#room() !== null) return json({ error: "bad_request" }, 409);
      this.#kvSet("room", {
        title: String(body.title ?? "").trim().slice(0, 64) || "Untitled room",
        visibility: "invite",
        createdAt: now,
      });
      this.sql`INSERT INTO members (uid, name, joined_at, last_seen, role)
               VALUES (${uid}, ${name}, ${now}, ${now}, 'owner')`;
      return json({ role: "owner" });
    }

    if (url.pathname === "/admit") {
      const room = this.#room();
      if (room === null) return json({ error: "not_found" }, 404);

      // An existing member keeps the role they already have; re-joining is not
      // a way to be re-graded.
      const existing = this.#memberRole(uid);
      if (existing !== null) {
        this.sql`UPDATE members SET name = ${name}, last_seen = ${now} WHERE uid = ${uid}`;
        return json({ role: existing });
      }

      if (room.visibility === "locked") return json({ error: "locked" }, 403);

      // A code is checked even in an open room: it is how someone arrives at a
      // role other than the default, so honouring it matters either way.
      const code = String(body.code ?? "");
      if (code) {
        const verdict = this.#checkInvite(code);
        if (!verdict.ok) return json({ error: verdict.reason }, 403);

        this.sql`INSERT INTO members (uid, name, joined_at, last_seen, role)
                 VALUES (${uid}, ${name}, ${now}, ${now}, ${verdict.role})`;
        // Counted only after the member row lands, so a failed insert cannot
        // burn a use of a single-use invite.
        this.sql`UPDATE invites SET uses = uses + 1 WHERE code = ${code}`;
        this.#system(`${name} joined as ${verdict.role}`);
        return json({ role: verdict.role });
      }

      if (room.visibility !== "open") return json({ error: "invite_required" }, 403);

      this.sql`INSERT INTO members (uid, name, joined_at, last_seen, role)
               VALUES (${uid}, ${name}, ${now}, ${now}, 'editor')`;
      this.#system(`${name} joined`);
      return json({ role: "editor" });
    }

    if (url.pathname === "/github-installed") {
      const pending = this.#kvGet<{ repo: string; uid: string } | null>("github:pending", null);
      if (!pending) return json({ error: "bad_request" }, 409);

      const installationId = String(body.installationId ?? "");

      this.sql`INSERT INTO github (k, installation_id, repo, connected_by, connected_at)
               VALUES ('current', ${installationId}, ${pending.repo}, ${uid}, ${now})
               ON CONFLICT(k) DO UPDATE SET
                 installation_id = excluded.installation_id,
                 repo = excluded.repo,
                 connected_by = excluded.connected_by,
                 connected_at = excluded.connected_at`;
      this.#kvDel("github:pending");

      this.setState({
        ...this.state,
        workspace: { kind: "github", online: true, hostUid: uid, label: pending.repo },
      });
      const connectedName = this.#memberName(uid) ?? "someone";
      this.#system(`${connectedName} connected ${pending.repo}`);

      return json({ ok: true });
    }

    return json({ error: "not_found" }, 404);
  }

  // ------------------------------------------------------------ connections

  /**
   * Bind a verified identity to the socket.
   *
   * The Worker has already checked the token's signature and expiry before this
   * runs, and passes the result in headers a client cannot forge. What is
   * re-checked here is everything the token cannot know: whether that member
   * still exists. A token stays cryptographically valid after someone is
   * removed, so membership — not the token — is the authority.
   */
  override async onConnect(connection: Connection, ctx: ConnectionContext) {
    this.#ready();

    const uid = ctx.request.headers.get("x-room-uid");
    const role = ctx.request.headers.get("x-room-role");
    if (!uid || !role) {
      connection.close(4401, "unauthorized");
      return;
    }
    if (this.#memberRole(uid) === null) {
      connection.close(4403, "not a member of this room");
      return;
    }

    connection.setState({ uid, role });
    connection.send(JSON.stringify({ t: "you", uid, role } satisfies ServerMsg));
    connection.send(
      JSON.stringify({ t: "history", entries: this.#entries() } satisfies ServerMsg),
    );

    // The workspace stays configured while its host is offline — see onClose —
    // so a reconnect from that same host is what brings it back, not a fresh
    // "workspace.attach".
    if (this.state.workspace.hostUid === uid && !this.state.workspace.online) {
      this.setState({ ...this.state, workspace: { ...this.state.workspace, online: true } });
      this.#system(`${this.#memberName(uid) ?? "someone"}'s workspace is back online`);
    }

    await this.#refreshPresence();
  }

  override async onClose(connection: Connection) {
    this.#ready();
    // Membership rows are deliberately not deleted — a member who closes a tab
    // is still a member.
    //
    // Departures are deliberately not written to the transcript. A reload is a
    // disconnect followed by a reconnect, so announcing them filled permanent
    // history with churn nobody asked about. Who is here right now is already
    // live in the presence strip; the transcript records membership changes —
    // joining, role changes, removal — which are the ones that persist.

    // The workspace is still configured after this — hostUid and kind are left
    // alone — it is just unreachable until that member reconnects, which is
    // what onConnect watches for.
    const hostUid = this.state.workspace.hostUid;
    if (hostUid && this.#uidOf(connection) === hostUid && this.state.workspace.online) {
      let stillConnected = false;
      for (const c of this.getConnections()) {
        if (c.id !== connection.id && this.#uidOf(c) === hostUid) {
          stillConnected = true;
          break;
        }
      }
      if (!stillConnected) {
        this.#pending.failAll("The workspace host went offline.");
        this.setState({ ...this.state, workspace: { ...this.state.workspace, online: false } });
        this.#system(`${this.#memberName(hostUid) ?? "someone"}'s workspace went offline`);
      }
    }

    await this.#refreshPresence(connection.id);
  }

  override async onMessage(connection: Connection, raw: string | ArrayBuffer) {
    this.#ready();
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    switch (msg.t) {
      case "rename":
        return this.#onRename(connection, msg.name);
      case "say":
        return this.#onSay(connection, msg.text);
      case "vote":
        return this.#onVote(connection, msg.toolUseId, msg.vote);
      case "interrupt":
        return this.#onInterrupt(connection);
      case "settings":
        return this.#onSettings(connection, msg.settings);
      case "policy":
        return this.#onPolicy(connection, msg.policy);
      case "compact":
        return this.#onCompact(connection);
      case "invite.create":
        return this.#onInviteCreate(connection, msg);
      case "invite.revoke":
        return this.#onInviteRevoke(connection, msg.code);
      case "invite.list":
        return this.#onInviteList(connection);
      case "member.list":
        return this.#onMemberList(connection);
      case "member.role":
        return this.#onMemberRole(connection, msg.uid, msg.role);
      case "member.remove":
        return this.#onMemberRemove(connection, msg.uid);
      case "workspace.attach":
        return this.#onWorkspaceAttach(connection, msg.kind, msg.label);
      case "workspace.detach":
        return this.#onWorkspaceDetach(connection);
      case "github.connect":
        return this.#onGithubConnect(connection, msg.repo);
      case "fs.res":
        return this.#onFsRes(connection, msg.id, msg.res);
    }
  }

  /**
   * Apply a configuration change.
   *
   * Settings are room-wide — everyone shares one agent, so everyone shares its
   * configuration. Rather than putting changes to a vote, every change is
   * announced in the transcript with who made it, so the room can see the model
   * or the spend policy shift under them.
   */
  async #onSettings(connection: Connection, incoming: unknown) {
    if (!this.#allow(connection, "settings", "Only the room's owner and admins can change the setup.")) return;
    const name = this.#nameOf(connection);
    if (!name) return;

    // Changing models mid-turn would swap the model underneath a running tool
    // loop and invalidate the prompt cache, so hold changes until it settles.
    if (this.state.status !== "idle") {
      connection.send(
        JSON.stringify({
          t: "error",
          message: "Settings can only change while the agent is idle.",
        } satisfies ServerMsg),
      );
      return;
    }

    // Never trust the client: re-validate against the model catalogue so a stale
    // or crafted frame can't put an invalid parameter on the wire.
    const settings = sanitizeSettings(incoming);
    this.setState({ ...this.state, settings });
    this.#system(
      `${name} changed the setup — ${describeSettings(settings, this.state.users.length)}`,
    );
  }

  /**
   * Replace the agent-permission policy.
   *
   * Held until the agent is idle for the same reason settings are: the tool
   * list is part of the request, and swapping it mid-turn would change what the
   * agent is allowed to do between one round and the next.
   */
  async #onPolicy(connection: Connection, incoming: unknown) {
    if (!this.#allow(connection, "policy", "Only the room's owner and admins can change what the agent may do.")) return;
    if (this.state.status !== "idle") {
      this.#refuse(connection, "Permissions can only change while the agent is idle.");
      return;
    }
    const policy = sanitizeAccessPolicy(incoming);
    this.setState({ ...this.state, policy });
    this.#system(
      `${this.#nameOf(connection) ?? "someone"} changed what the agent may do — ${describePolicy(policy)}`,
    );
    await this.#refreshPresence();
  }

  async #onCompact(connection: Connection) {
    if (!this.#allow(connection, "compact", "You're a viewer in this room, so you can't compact the conversation.")) return;
    const name = this.#nameOf(connection);
    if (!name) return;
    if (this.state.status !== "idle") {
      connection.send(
        JSON.stringify({
          t: "error",
          message: "Wait for the agent to finish before compacting.",
        } satisfies ServerMsg),
      );
      return;
    }
    await this.#compact(`${name} compacted it manually`);
  }

  /**
   * Change a display name. Identity is fixed by the token, so this only ever
   * relabels an existing member — it can never create one.
   */
  async #onRename(connection: Connection, rawName: string) {
    const uid = this.#uidOf(connection);
    if (!uid) return;
    const previous = this.#memberName(uid);
    if (previous === null) return;

    const name = rawName.trim().slice(0, 32) || "anon";
    if (name === previous) return;

    this.sql`UPDATE members SET name = ${name}, last_seen = ${Date.now()} WHERE uid = ${uid}`;
    this.#system(`${previous} is now ${name}`);
    await this.#refreshPresence();
  }

  /** Reply to one connection with the room's invites. Never broadcast. */
  #sendInvites(connection: Connection) {
    connection.send(
      JSON.stringify({ t: "invites", invites: this.#invites() } satisfies ServerMsg),
    );
  }

  #refuse(connection: Connection, message: string) {
    connection.send(JSON.stringify({ t: "error", message } satisfies ServerMsg));
  }

  async #onInviteList(connection: Connection) {
    if (!this.#allow(connection, "invite", "Only the room's owner and admins can see invites.")) return;
    this.#sendInvites(connection);
  }

  async #onInviteCreate(
    connection: Connection,
    msg: { role: string; maxUses: number; expiresInHours: number; label: string },
  ) {
    if (!this.#allow(connection, "invite", "Only the room's owner and admins can create invites.")) return;
    const uid = this.#uidOf(connection);
    if (!uid) return;

    // An invite can never hand out ownership: a room has exactly one owner, and
    // transferring it is a deliberate act, not a side effect of sharing a link.
    const role = (INVITABLE_ROLES as readonly string[]).includes(msg.role)
      ? msg.role
      : "editor";

    const maxUses = Math.max(0, Math.min(1000, Math.round(Number(msg.maxUses) || 0)));
    const hours = Math.max(0, Math.min(24 * 365, Math.round(Number(msg.expiresInHours) || 0)));
    const expiresAt = hours === 0 ? 0 : Date.now() + hours * 3600_000;
    const label = String(msg.label ?? "").trim().slice(0, 48);

    const code = newInviteCode();
    this.sql`INSERT INTO invites (code, role, max_uses, uses, expires_at, created_by, created_at, revoked_at, label)
             VALUES (${code}, ${role}, ${maxUses}, 0, ${expiresAt}, ${uid}, ${Date.now()}, 0, ${label})`;

    // The transcript records that an invite exists and who made it, but never
    // the code itself — the transcript is visible to the whole room.
    this.#system(
      `${this.#memberName(uid) ?? "someone"} created an invite for a new ${role}` +
        (label ? ` (${label})` : ""),
    );
    this.#sendInvites(connection);
  }

  async #onInviteRevoke(connection: Connection, rawCode: string) {
    if (!this.#allow(connection, "invite", "Only the room's owner and admins can revoke invites.")) return;
    const uid = this.#uidOf(connection);
    if (!uid) return;
    const code = String(rawCode ?? "");
    // Revoking is idempotent: the first revocation time is the one that counts.
    this.sql`UPDATE invites SET revoked_at = ${Date.now()}
             WHERE code = ${code} AND revoked_at = 0`;
    this.#system(`${this.#memberName(uid) ?? "someone"} revoked an invite`);
    this.#sendInvites(connection);
  }

  #sendMembers(connection: Connection) {
    connection.send(
      JSON.stringify({ t: "members", members: this.#members() } satisfies ServerMsg),
    );
  }

  async #onMemberList(connection: Connection) {
    if (!this.#allow(connection, "manage_members", "Only the room's owner and admins can manage members.")) return;
    this.#sendMembers(connection);
  }

  /**
   * Re-bind a member's live sockets after their role changes.
   *
   * Role is pinned to the socket at connect time, so without this a demotion
   * would not take effect until the person reconnected — exactly backwards for
   * a demotion.
   */
  #rebind(uid: string, role: Role) {
    for (const conn of this.getConnections()) {
      if (this.#uidOf(conn) !== uid) continue;
      conn.setState({ uid, role });
      conn.send(JSON.stringify({ t: "you", uid, role } satisfies ServerMsg));
    }
  }

  async #onMemberRole(connection: Connection, targetUid: string, rawRole: unknown) {
    if (!this.#allow(connection, "manage_members", "Only the room's owner and admins can change roles.")) return;
    const actorUid = this.#uidOf(connection);
    if (!actorUid) return;

    const actorRole = this.#roleOf(connection);
    const currentRaw = this.#memberRole(targetUid);
    if (currentRaw === null) {
      this.#refuse(connection, "That person isn't a member of this room.");
      return;
    }
    const current = asRole(currentRaw);
    const next = asRole(rawRole);

    if (targetUid === actorUid) {
      this.#refuse(connection, "You can't change your own role.");
      return;
    }
    if (current === "owner") {
      this.#refuse(connection, "The room's owner can't be demoted.");
      return;
    }
    if (next === "owner") {
      this.#refuse(connection, "Ownership can't be handed over this way.");
      return;
    }
    // You may only act on someone below you, and only grant something below
    // you. Without the second check an admin could promote a peer to admin.
    if (!outranks(actorRole, current) || !outranks(actorRole, next)) {
      this.#refuse(connection, "You can only change roles below your own.");
      return;
    }
    if (current === next) {
      this.#sendMembers(connection);
      return;
    }

    this.sql`UPDATE members SET role = ${next} WHERE uid = ${targetUid}`;
    this.#rebind(targetUid, next);
    this.#system(
      `${this.#memberName(actorUid) ?? "someone"} made ` +
        `${this.#memberName(targetUid) ?? "someone"} a ${next}`,
    );
    await this.#refreshPresence();
    this.#sendMembers(connection);
  }

  async #onMemberRemove(connection: Connection, targetUid: string) {
    if (!this.#allow(connection, "manage_members", "Only the room's owner and admins can remove people.")) return;
    const actorUid = this.#uidOf(connection);
    if (!actorUid) return;

    const currentRaw = this.#memberRole(targetUid);
    if (currentRaw === null) {
      this.#refuse(connection, "That person isn't a member of this room.");
      return;
    }
    if (targetUid === actorUid) {
      this.#refuse(connection, "You can't remove yourself.");
      return;
    }
    if (!outranks(this.#roleOf(connection), asRole(currentRaw))) {
      this.#refuse(connection, "You can only remove people below your own role.");
      return;
    }

    const name = this.#memberName(targetUid);
    this.sql`DELETE FROM members WHERE uid = ${targetUid}`;
    // Close their sockets now. The membership check in onConnect would refuse a
    // reconnect anyway, but leaving a live socket open would let them keep
    // reading the room until they happened to disconnect.
    for (const conn of this.getConnections()) {
      if (this.#uidOf(conn) === targetUid) conn.close(4403, "removed from this room");
    }
    this.#system(`${this.#memberName(actorUid) ?? "someone"} removed ${name ?? "someone"}`);
    await this.#refreshPresence();
    this.#sendMembers(connection);
  }

  /**
   * Connect a workspace to the room.
   *
   * Attaching and detaching are gated on "policy" rather than a dedicated
   * capability — deciding what the agent can reach is part of the same
   * decision as deciding what it may do with it, and access.ts is not the
   * place to grow a one-off capability for this phase.
   */
  async #onWorkspaceAttach(connection: Connection, kind: WorkspaceKind, rawLabel: string) {
    if (!this.#allow(connection, "policy", "Only the room's owner and admins can connect a workspace.")) return;

    if (kind !== "local") {
      this.#refuse(connection, "That workspace type isn't supported yet.");
      return;
    }

    const uid = this.#uidOf(connection);
    if (!uid) return;
    const name = this.#memberName(uid);
    const label = String(rawLabel ?? "").trim().slice(0, 64);

    this.setState({
      ...this.state,
      workspace: { kind, online: true, hostUid: uid, label },
    });
    this.#system(`${name ?? "someone"} connected a workspace${label ? ` (${label})` : ""}`);
  }

  async #onWorkspaceDetach(connection: Connection) {
    if (!this.#allow(connection, "policy", "Only the room's owner and admins can disconnect a workspace.")) return;

    const name = this.#nameOf(connection);
    this.#pending.failAll("The workspace was disconnected.");
    this.setState({ ...this.state, workspace: NO_WORKSPACE });
    // A GitHub workspace stores its installation id and repo in the `github`
    // table, not just in state — clear both, or a later re-attach could see
    // stale rows.
    this.sql`DELETE FROM github WHERE k = 'current'`;
    this.#system(`${name ?? "someone"} disconnected the workspace`);
  }

  /**
   * Start connecting a GitHub repository. This only mints a state token and
   * hands back the URL to GitHub's install page — the room is the only party
   * that knows who is asking and whether they may, so the install-initiation
   * route lives here rather than on the Worker. `/github-installed` (see
   * onRequest) finishes the job once GitHub redirects back.
   */
  async #onGithubConnect(connection: Connection, repo: string) {
    if (!this.#allow(connection, "policy", "Only the room's owner and admins can connect a repository.")) return;

    if (!this.env.GITHUB_APP_ID || !this.env.GITHUB_APP_PRIVATE_KEY) {
      this.#refuse(
        connection,
        "GitHub isn't set up on this server. Ask whoever deployed it to add the GitHub App credentials.",
      );
      return;
    }

    if (parseRepoRef(repo) === null) {
      this.#refuse(
        connection,
        "That doesn't look like a repository. Use owner/repo, optionally owner/repo@branch.",
      );
      return;
    }

    const uid = this.#uidOf(connection);
    if (!uid) return;
    const role = this.#roleOf(connection);

    // Ten minutes is plenty for an install round trip and keeps the replay
    // window on this state token small.
    const token = await mintToken(this.env.ROOM_SECRET, {
      rid: this.name,
      uid,
      role,
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    this.#kvSet("github:pending", { repo, uid });

    // The app slug is public — it appears in the app's own URL — and is only
    // needed to send the user straight to the install page instead of a
    // generic settings page they'd have to search from.
    const url = this.env.GITHUB_APP_SLUG
      ? `https://github.com/apps/${this.env.GITHUB_APP_SLUG}/installations/new?state=${token}`
      : `https://github.com/settings/installations`;

    connection.send(JSON.stringify({ t: "github.install", url } satisfies ServerMsg));
  }

  /**
   * A provider's reply to an earlier "fs.req".
   *
   * Deliberately ungated by #allow — any member's socket could in principle
   * send this frame — but it is only ever honoured from the configured
   * workspace host. Without this check, any member could forge file contents
   * into an agent's turn simply by sending a well-timed "fs.res"; this is the
   * security-relevant line in this handler.
   */
  async #onFsRes(connection: Connection, id: string, res: FsResponse) {
    const uid = this.#uidOf(connection);
    if (!uid || uid !== this.state.workspace.hostUid) return;
    this.#pending.settle(id, res);
  }

  /**
   * Run one filesystem request against the connected workspace.
   *
   * Three things happen here in order, and the order matters: the path is
   * normalised, then checked against the room's path policy, and only then sent
   * to the host. A denied path never leaves the server, so a refusal cannot be
   * turned into a request by anything the host's browser does.
   */
  async #fs(req: FsRequest): Promise<FsResponse> {
    if (this.state.workspace.kind === "none") {
      return { ok: false, error: "No workspace is connected to this room." };
    }
    if (!this.state.workspace.online) {
      return { ok: false, error: "The workspace host is offline, so files can't be read right now." };
    }

    // Search and list both walk the tree themselves, so neither names a single
    // path this server can police before the request leaves. Instead the room
    // hands its deny globs to the provider, which does the walking and is the
    // only place that can skip an entry before touching it. Search would
    // otherwise return the contents of a denied file; list would name it, and a
    // filename is itself worth protecting. Injected here rather than taken from
    // the model, which must not get a say in what it may not see.
    const denyGlobs = [...this.#policy().paths.deny];
    const withDeny: FsRequest =
      req.op === "search" || req.op === "list" ? { ...req, deny: denyGlobs } : req;
    const clamped = clampRequest(withDeny);

    // "search" has no single path to check — the glob is applied on the host
    // instead — every other op names one path to police here.
    if (clamped.op !== "search") {
      const normalized = normalizePath(clamped.path);
      if (normalized === null) {
        return { ok: false, error: "That path isn't allowed." };
      }
      const write = isWriteOp(clamped.op);
      const decision = pathDecision(this.#policy().paths, normalized, write);
      if (decision === "deny") {
        return { ok: false, error: "The room's rules don't allow access to that path." };
      }
      // "ask" on a read is treated as allowed — reads are governed by deny,
      // not by votes, so a per-file vote would be unusable. A future phase
      // makes "ask" on a write mean a vote instead of an outright refusal;
      // for now writes of any decision besides "deny" are simply not enabled.
      if (write) {
        return { ok: false, error: "Writing to the workspace isn't enabled yet." };
      }
    }

    // A GitHub workspace has no host socket — it's served straight from the
    // GitHub API using a token minted fresh for this one request, then
    // discarded. Never stored: see the comment on the `github` table.
    if (this.state.workspace.kind === "github") {
      const row = this.sql<{
        installation_id: string;
        repo: string;
      }>`SELECT installation_id, repo FROM github WHERE k = 'current'`[0];
      if (!row) {
        return { ok: false, error: "The repository connection is missing. Reconnect it." };
      }

      const ref = parseRepoRef(row.repo);
      if (!ref) {
        return { ok: false, error: "The repository connection is missing. Reconnect it." };
      }

      const pkcs8 = pemToPkcs8(this.env.GITHUB_APP_PRIVATE_KEY);
      if (!pkcs8.ok) {
        return { ok: false, error: pkcs8.error };
      }

      // Minted fresh for this one request and held only in this local
      // variable — never written to state or storage. See the comment on the
      // `github` table for why.
      const tokenRes = await installationToken(
        { appId: this.env.GITHUB_APP_ID, privateKeyPem: this.env.GITHUB_APP_PRIVATE_KEY },
        row.installation_id,
      );
      if (!tokenRes.ok) {
        return { ok: false, error: tokenRes.error };
      }

      const provider = new GithubProvider(tokenRes.token, ref, denyGlobs);
      return provider.perform(clamped);
    }

    const hostUid = this.state.workspace.hostUid;
    let host: Connection | null = null;
    for (const c of this.getConnections()) {
      if (this.#uidOf(c) === hostUid) {
        host = c;
        break;
      }
    }
    if (!host) {
      return { ok: false, error: "The workspace host isn't connected." };
    }

    const { id, promise } = this.#pending.open(FS_LIMITS.timeoutMs);
    // Sent to the host's connection only, never broadcast — handing a file
    // request to the whole room would let any member answer it.
    host.send(JSON.stringify({ t: "fs.req", id, req: clamped } satisfies ServerMsg));
    return promise;
  }

  /**
   * Build an `FsRequest` from one of the file tools' raw model input.
   *
   * The model can send anything — missing fields, wrong types — so every field
   * is coerced defensively rather than trusted. `#fs` clamps the numeric
   * fields again to `FS_LIMITS`, so this only needs to supply sane defaults
   * for what the model omitted.
   */
  #fsRequestFor(name: "list_files" | "read_file" | "search_files", input: unknown): FsRequest {
    const i = (input ?? {}) as Record<string, unknown>;
    const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
    const num = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;

    switch (name) {
      case "list_files":
        // `deny` is a placeholder; #fs overwrites it with the room's real globs.
        return { op: "list", path: str(i.path, ""), depth: num(i.depth, 2), deny: [] };
      case "read_file":
        return {
          op: "read",
          path: str(i.path, ""),
          offset: num(i.offset, 0),
          limit: num(i.limit, FS_LIMITS.readBytes),
        };
      case "search_files":
        return {
          op: "search",
          pattern: str(i.pattern, ""),
          glob: str(i.glob, ""),
          max: num(i.max, FS_LIMITS.searchMatches),
          // Placeholder only. #fs overwrites this with the room's real deny
          // globs, so nothing the model puts here can survive.
          deny: [],
        };
    }
  }

  async #onSay(connection: Connection, rawText: string) {
    if (!this.#allow(connection, "speak", "You're a viewer in this room, so you can't talk to the agent.")) return;
    const text = rawText.trim();
    if (!text) return;
    const uid = this.#uidOf(connection);
    const name = uid ? this.#memberName(uid) : null;
    if (!uid || !name) return; // must join before speaking

    this.#append({
      id: crypto.randomUUID(),
      ts: Date.now(),
      kind: "user",
      authorUid: uid,
      authorName: name,
      color: colorFor(uid),
      text,
    });

    // Queue rather than interrupt. If the agent is mid-turn this line waits and
    // is folded into the next one, so concurrent speakers never split a turn.
    this.#setInbox([...this.#inbox(), { name, text }]);

    if (this.state.status === "idle") await this.#startTurn();
  }

  async #onVote(connection: Connection, toolUseId: string, vote: "approve" | "deny") {
    if (!this.#allow(connection, "vote", "You're a viewer in this room, so you can't vote.")) return;

    // Not a threshold but a restriction on who may vote at all.
    if (this.#policy().approval === "owner_only" && this.#roleOf(connection) !== "owner") {
      this.#refuse(connection, "Only the room's owner can approve actions here.");
      return;
    }

    const uid = this.#uidOf(connection);
    if (!uid || !this.#memberName(uid)) return;

    // Ignore votes for calls that are no longer open — a stale click from a
    // client whose view hadn't caught up yet.
    if (!this.state.pending.some((p) => p.toolUseId === toolUseId)) return;

    const pending = this.state.pending.map((p) =>
      p.toolUseId === toolUseId
        ? { ...p, votes: { ...p.votes, [uid]: vote } }
        : p,
    );
    this.setState({ ...this.state, pending });
    await this.#settleIfDecided();
  }

  async #onInterrupt(connection: Connection) {
    if (!this.#allow(connection, "speak", "You're a viewer in this room, so you can't stop the agent.")) return;
    const name = this.#nameOf(connection);
    if (this.state.status === "idle") return;
    this.#setTurn(null);
    this.#setInbox([]);
    this.setState({ ...this.state, status: "idle", pending: [] });
    this.#system(`${name ?? "someone"} stopped the agent`);
  }

  // ------------------------------------------------------------- agent turn

  #config(): ModelConfig {
    return { apiKey: this.env.ANTHROPIC_API_KEY };
  }

  #settings(): RoomSettings {
    return this.state.settings ?? DEFAULT_SETTINGS;
  }

  /** The room's agent-permission policy, defaulted for rooms created before it existed. */
  #policy(): AccessPolicy {
    return this.state.policy ?? DEFAULT_POLICY;
  }

  /** Fold one response's token counts into the room's running ledger. */
  #recordUsage(usage: Usage | null | undefined) {
    if (!usage) return;
    this.setState({
      ...this.state,
      cost: addUsage(this.state.cost, usage.model, usage.in, usage.out),
      context: {
        messages: this.#convo().length,
        tokens: usage.promptTokens || this.state.context.tokens,
      },
    });
  }

  /**
   * A document buffer for one tool round.
   *
   * Tools read and write through this rather than through `this.state` directly,
   * for two reasons: several approved edits can land in the same round and each
   * must see the previous one's result, and one flush at the end means one state
   * broadcast instead of one per edit.
   */
  #docBuffer(): ToolCtx & { flush(): void } {
    let doc = this.state.doc;
    let dirty = false;
    return {
      getDoc: () => doc,
      setDoc: (next) => {
        doc = next;
        dirty = true;
      },
      flush: () => {
        if (!dirty) return;
        this.setState({
          ...this.state,
          doc,
          docRevision: this.state.docRevision + 1,
        });
      },
    };
  }

  /* ---------------------------------------------------------- compaction */

  /**
   * Find a message index it is safe to cut the history at.
   *
   * A `tool_use` block must always be followed by its matching `tool_result`, so
   * cutting mid-round would produce a conversation the API rejects. The only
   * unambiguously safe boundary is a plain-text user turn — one that starts a
   * round rather than answering a tool call. Walks backwards from `target`.
   */
  #safeCut(convo: MessageParam[], target: number): number {
    for (let i = Math.min(target, convo.length - 1); i > 0; i--) {
      const m = convo[i]!;
      if (m.role === "user" && typeof m.content === "string") return i;
    }
    return 0;
  }

  /** Whether the conversation has grown past either configured threshold. */
  #needsCompaction(): string | null {
    const { compactAfterMessages, maxContextTokens } = this.#settings().context;
    const messages = this.#convo().length;
    const tokens = this.state.context.tokens;
    if (compactAfterMessages > 0 && messages > compactAfterMessages) {
      return `${messages} messages exceeds the ${compactAfterMessages} limit`;
    }
    if (maxContextTokens > 0 && tokens > maxContextTokens) {
      return `${tokens.toLocaleString()} tokens exceeds the ${maxContextTokens.toLocaleString()} limit`;
    }
    return null;
  }

  /**
   * Replace the older half of the conversation with a summary.
   *
   * Only ever runs between turns, never mid-turn: rewriting history while a turn
   * is parked on a vote would orphan the tool call it is waiting to resolve.
   */
  async #compact(reason: string) {
    const settings = this.#settings();
    const convo = this.#convo();
    const cut = this.#safeCut(convo, convo.length - settings.context.keepRecentMessages);
    if (cut <= 1) return; // nothing meaningful to fold away

    const older = convo.slice(0, cut);
    let summaryText: string;
    try {
      const { text, usage } = await summarizeConversation(this.#config(), settings, older);
      this.#recordUsage(usage);
      summaryText = text;
    } catch (err) {
      console.error("compaction failed", err);
      this.#system(
        "Could not compact the conversation, so it is still growing. " +
          (err instanceof Error ? err.message : String(err)),
      );
      return;
    }

    this.#setConvo([
      {
        role: "user",
        content:
          "[Summary of earlier conversation in this room, folded down to save " +
          `context. ${older.length} messages replaced.]\n\n${summaryText}`,
      },
      ...convo.slice(cut),
    ]);

    this.setState({
      ...this.state,
      context: { messages: this.#convo().length, tokens: 0 },
    });
    this.#system(
      `Compacted ${older.length} earlier messages — ${reason}. ` +
        `The last ${convo.length - cut} are kept verbatim.`,
    );
  }

  /* --------------------------------------------------------- delegation */

  /**
   * Run delegated tasks on the worker model, `cap` at a time.
   *
   * Workers hold read-only tools, so nothing here can change the document or
   * needs the room's approval. Their progress is mirrored into room state so
   * everyone can watch the fan-out rather than staring at a spinner.
   */
  async #delegate(rawTasks: unknown, ctx: ToolCtx): Promise<{ ok: boolean; text: string }> {
    const settings = this.#settings();
    const cap = effectiveWorkerCap(settings, this.state.users.length);

    const parsed = Array.isArray(rawTasks) ? rawTasks : [];
    const tasks: WorkerTask[] = parsed
      .filter((t): t is WorkerTask => !!t && typeof (t as WorkerTask).title === "string")
      .map((t) => ({
        title: String(t.title).slice(0, 120),
        instructions: String(t.instructions ?? ""),
      }));

    if (tasks.length === 0) {
      return { ok: false, text: "delegate requires a non-empty `tasks` array." };
    }

    const dropped = Math.max(0, tasks.length - cap);
    const accepted = tasks.slice(0, cap);

    const statuses: WorkerStatus[] = accepted.map((t) => ({
      id: crypto.randomUUID(),
      title: t.title,
      model: settings.workerModel,
      state: "running",
    }));
    this.setState({ ...this.state, workers: statuses });

    const settle = (id: string, state: WorkerStatus["state"]) => {
      this.setState({
        ...this.state,
        workers: this.state.workers.map((w) => (w.id === id ? { ...w, state } : w)),
      });
    };

    const results = await Promise.all(
      accepted.map(async (task, i) => {
        const id = statuses[i]!.id;
        try {
          const r = await runWorker(this.#config(), settings, task, ctx, workerToolsFor(this.#policy()));
          r.usage.forEach((u) => this.#recordUsage(u));
          settle(id, "done");
          return `## ${task.title}\n\n${r.text}`;
        } catch (err) {
          settle(id, "failed");
          const msg = err instanceof Error ? err.message : String(err);
          return `## ${task.title}\n\n(worker failed: ${msg})`;
        }
      }),
    );

    this.setState({ ...this.state, workers: [] });

    const notice = dropped
      ? `\n\n(${dropped} further task${dropped === 1 ? "" : "s"} were dropped — the ` +
        `room's worker cap is ${cap}. Delegate them in a follow-up call if they matter.)`
      : "";

    return { ok: true, text: results.join("\n\n---\n\n") + notice };
  }

  /** Drain the inbox into one user turn and hand it to the model. */
  async #startTurn() {
    const inbox = this.#inbox();
    if (inbox.length === 0) return;

    // Compact before the turn, never during one. Rewriting history while a turn
    // is parked on a vote would orphan the tool call it is waiting to resolve.
    const reason = this.#needsCompaction();
    if (reason) await this.#compact(reason);

    this.#setInbox([]);

    // The whole point of the room: many speakers collapse into one tagged turn,
    // so the model sees a conversation rather than a single anonymous request.
    const text = inbox.map((l) => `[${l.name}]: ${l.text}`).join("\n");
    this.#setConvo([...this.#convo(), { role: "user", content: text }]);

    const entry: Entry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      kind: "agent",
      blocks: [],
    };
    this.#append(entry);
    this.#setTurn({ entryId: entry.id, carried: [] });
    this.setState({ ...this.state, status: "thinking" });

    await this.#advance();
  }

  /**
   * Run the model until the turn ends or parks on a vote.
   *
   * Returns (rather than awaiting) when a gated tool needs approval. Everything
   * needed to pick the turn back up is in storage by then.
   */
  async #advance() {
    let round = 0;
    try {
      for (; round < MAX_ROUNDS; round++) {
        const turn = this.#turn();
        if (!turn) return; // interrupted

        const entry = this.#getEntry(turn.entryId);
        if (!entry || entry.kind !== "agent") break;

        // Map API content-block index -> index in the entry we render.
        const slots = new Map<number, number>();

        const { message, usage } = await runModel(
          this.#config(),
          this.#settings(),
          this.#convo(),
          toolsForRoom(
            this.#policy(),
            this.#settings().workflow,
            this.state.workspace.kind !== "none" && this.state.workspace.online,
          ),
          {
            onBlockStart: (index, type) => {
              if (type !== "text" && type !== "thinking") return;
              entry.blocks.push({ type, text: "" } as AgentBlock);
              slots.set(index, entry.blocks.length - 1);
              this.#patch(entry);
            },
            onDelta: (index, _kind, text) => {
              const slot = slots.get(index);
              if (slot === undefined) return;
              const block = entry.blocks[slot]!;
              if (block.type === "text" || block.type === "thinking") block.text += text;
              // Stream the token; persist the accumulated entry once, below. A
              // write per token would be a lot of storage traffic for no benefit.
              this.#send({ t: "delta", entryId: entry.id, block: slot, text });
            },
          },
        );

        this.#setConvo([...this.#convo(), { role: "assistant", content: message.content }]);
        this.#recordUsage(usage);

        // Refusals stop the turn; there is no content to act on.
        if (message.stop_reason === "refusal") {
          this.#patch(entry);
          this.#system(
            "The model declined this request" +
              (message.stop_details?.explanation
                ? `: ${message.stop_details.explanation}`
                : "."),
          );
          break;
        }

        // A server-side tool (search/fetch) hit its iteration cap mid-turn.
        // Re-send to let it carry on; there is nothing for us to execute.
        if (message.stop_reason === "pause_turn") {
          this.#patch(entry);
          continue;
        }

        if (message.stop_reason !== "tool_use") {
          this.#patch(entry);
          if (message.stop_reason === "max_tokens") {
            this.#system("The agent hit its output limit and stopped early.");
          }
          break;
        }

        // ---- tool round ----
        const calls = message.content.filter((b) => b.type === "tool_use");
        const results: ToolResultBlockParam[] = [...turn.carried];
        const gated: PendingTool[] = [];
        const gatedNames = gatedFor(this.#policy());
        const threshold = approvalThreshold(
          this.#policy().approval,
          this.state.users.filter((u) => isVoter(u.role)).length,
        );
        const docs = this.#docBuffer();

        for (const call of calls) {
          entry.blocks.push({
            type: "tool",
            toolUseId: call.id,
            name: call.name,
            input: call.input,
            status: "running",
          });

          if (gatedNames.has(call.name)) {
            gated.push({
              toolUseId: call.id,
              name: call.name,
              input: call.input,
              summary: summarizeCall(call.name, call.input),
              votes: {},
              threshold,
            });
          } else {
            // `delegate` is one async tool — it fans out to worker models. The
            // file tools are also async, each a round trip to the workspace
            // host's browser via #fs. Everything else resolves synchronously
            // against the doc buffer.
            let outcome: ToolOutcome;
            if (call.name === "delegate") {
              outcome = await this.#delegate((call.input as { tasks?: unknown })?.tasks, docs);
            } else if (
              call.name === "list_files" ||
              call.name === "read_file" ||
              call.name === "search_files"
            ) {
              const res = await this.#fs(this.#fsRequestFor(call.name, call.input));
              outcome = { ok: res.ok, text: res.ok ? res.data : res.error };
            } else {
              outcome = execute(call.name, call.input, docs);
            }

            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: outcome.text,
              is_error: !outcome.ok,
            });
            const block = entry.blocks.at(-1)!;
            if (block.type === "tool") {
              block.status = outcome.ok ? "ok" : "error";
              block.result = outcome.text;
            }
          }
        }
        docs.flush();
        this.#patch(entry);

        if (gated.length > 0) {
          // Park. The vote handler resumes from here.
          this.#setTurn({ ...turn, carried: results });
          this.setState({ ...this.state, status: "awaiting_approval", pending: gated });
          return;
        }

        this.#setConvo([...this.#convo(), { role: "user", content: results }]);
        this.#setTurn({ ...turn, carried: [] });
      }

      if (round >= MAX_ROUNDS) {
        this.#system(
          `The agent stopped after ${MAX_ROUNDS} tool rounds without finishing. ` +
            "Say something to nudge it in a different direction.",
        );
      }
    } catch (err) {
      console.error("agent turn failed", err);
      this.#system(
        `The agent turn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.#finishTurn();
  }

  async #finishTurn() {
    this.#setTurn(null);
    this.setState({ ...this.state, status: "idle", pending: [] });
    // Anything said while the agent was busy becomes the next turn.
    if (this.#inbox().length > 0) await this.#startTurn();
  }

  /**
   * If every parked tool call has reached its threshold, apply the verdicts and
   * resume the turn. Called after any vote and after presence changes.
   */
  async #settleIfDecided() {
    const turn = this.#turn();
    if (!turn || this.state.pending.length === 0) return;

    const verdicts: { p: PendingTool; approved: boolean }[] = [];
    for (const p of this.state.pending) {
      const { approve, deny } = tally(p);
      if (approve >= p.threshold) verdicts.push({ p, approved: true });
      else if (deny >= p.threshold) verdicts.push({ p, approved: false });
      else return; // at least one still undecided — keep waiting
    }

    const entry = this.#getEntry(turn.entryId);
    if (!entry || entry.kind !== "agent") return;

    const results: ToolResultBlockParam[] = [...turn.carried];
    const docs = this.#docBuffer();
    for (const { p, approved } of verdicts) {
      const outcome = approved
        ? execute(p.name, p.input, docs)
        : {
            ok: false,
            text:
              "The room voted against this action, so it did not run. Do not " +
              "retry the same call — ask the room what they would prefer.",
          };

      results.push({
        type: "tool_result",
        tool_use_id: p.toolUseId,
        content: outcome.text,
        is_error: !outcome.ok,
      });

      const block = entry.blocks.find(
        (b) => b.type === "tool" && b.toolUseId === p.toolUseId,
      );
      if (block && block.type === "tool") {
        block.status = approved ? (outcome.ok ? "ok" : "error") : "denied";
        block.result = outcome.text;
      }
    }
    docs.flush();
    this.#patch(entry);

    this.#setConvo([...this.#convo(), { role: "user", content: results }]);
    this.#setTurn({ ...turn, carried: [] });
    this.setState({ ...this.state, status: "thinking", pending: [] });

    await this.#advance();
  }
}
