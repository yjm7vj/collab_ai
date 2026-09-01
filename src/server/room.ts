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
  asVisibility,
  INVITABLE_ROLES,
  UID_RE,
  colorFor,
  tally,
  type AgentBlock,
  type ClientMsg,
  type Entry,
  type GithubStatus,
  type InviteSummary,
  type MemberSummary,
  type PendingTool,
  type Presence,
  type DocumentRevision,
  type RoomState,
  type ServerMsg,
  type WorkerStatus,
  redactEntry,
} from "../shared/protocol";
import {
  DEFAULT_POLICY,
  approvalThreshold,
  asRole,
  can,
  canSeeFileContents,
  describePolicy,
  isFileContentTool,
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
  DEFAULT_GRAPH,
  delegatesOf,
  describeGraph,
  handoffChain,
  leadOf,
  promptOf,
  reviewersOf,
  sanitizeGraph,
  type AgentNode,
  type WorkflowGraph,
} from "../shared/workflow";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_CONTINUATIONS,
  outputLimitRecovery,
  repairToolConversation,
  runModel,
  runStage,
  runWorker,
  stageSystemFor,
  summarize as summarizeConversation,
  workerSystemFor,
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
  workspaceGrantsFileTools,
  type ToolCtx,
  type ToolOutcome,
} from "./tools";
import { constantTimeEqual, mintToken, newInviteCode } from "./auth";
import { GITHUB_REPO_STATE_ROLE, repoAuthorizeUrl } from "./oauth";
import {
  GithubProvider,
  installationToken,
  listAppInstallations,
  listInstallationRepos,
  listUserInstallations,
  listUserRepos,
  parseRepoRef,
  pemToPkcs8,
  refHead,
  repoAccess,
  type RepoRef,
} from "./github";
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
  /** The member whose request caused this agent turn. */
  authorUid?: string;
  authorName?: string;
  /**
   * How many blocks the entry held when the current round started.
   *
   * A round streams straight into the entry, so an instance that dies mid-model
   * call leaves half a block behind. The resume truncates back to this mark
   * before re-running the round, or the reader would get the abandoned attempt
   * followed by the second one. Absent on turns written before this existed, in
   * which case nothing is truncated.
   */
  blocks?: number;
  /** How many times this turn has been picked back up. See MAX_RESUMES. */
  resumes?: number;
  /** Completed automatic continuations after an output-limited response. */
  outputContinuations?: number;
  /** Output allowance for the next model round, raised after a partial tool call. */
  maxOutputTokens?: number;
  /**
   * True while a round is actually being run, false once the turn parks on a
   * vote. This is what `onStart` reads to tell "nobody is driving this turn"
   * from "this turn is waiting for people, as designed" — and it lives in the
   * room's own storage rather than in `state`, so it can be trusted at init
   * time before anything else has been loaded.
   */
  running?: boolean;
};

/**
 * Anthropic requires one result for each tool use in a conversation. A room
 * can be evicted between the conversation write and the turn checkpoint, so
 * old state may contain a duplicated result after a resume. Clean that state
 * before it reaches the API, while preserving all ordinary text and thinking
 * blocks.
 */
export function normalizeConversation(convo: MessageParam[]): MessageParam[] {
  let changed = false;
  const normalized = convo.map((message) => {
    if (!Array.isArray(message.content)) return message;

    const seen = new Set<string>();
    const content = message.content.filter((block) => {
      if (block.type !== "tool_result" && block.type !== "tool_use") return true;
      const id = block.type === "tool_result" ? block.tool_use_id : block.id;
      if (seen.has(id)) {
        changed = true;
        return false;
      }
      seen.add(id);
      return true;
    });
    return content.length === message.content.length ? message : { ...message, content };
  });
  return changed ? normalized : convo;
}

function uniqueToolResults(results: ToolResultBlockParam[]): ToolResultBlockParam[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.tool_use_id)) return false;
    seen.add(result.tool_use_id);
    return true;
  });
}

type QueuedLine = { uid?: string; name: string; text: string };

/** Hard stop on tool round-trips so a confused turn can't loop forever. */
/**
 * How many tool rounds one agent turn may take before it is cut off.
 *
 * Real work on a codebase is not a couple of calls: reading a file, following
 * what it imports, checking a caller and then proposing an edit is already
 * most of a dozen. Twelve stopped turns mid-investigation often enough to be
 * the thing people noticed about the agent.
 *
 * The ceiling above this one is not a number in this file. A whole turn runs
 * inside one Worker invocation and shares its outbound-request budget, which
 * is as low as fifty on some plans — every round costs at least one model
 * call, and every tool call costs more on top. Raising this too far trades a
 * turn that stops early for one that dies outright with "Too many
 * subrequests", which is a worse failure because it loses the work. Twenty
 * leaves headroom for the tool calls those rounds make; see #runGithub for
 * what happens when the budget runs out anyway.
 */
const MAX_ROUNDS = 20;

/**
 * How many times an interrupted turn may be picked back up before the room
 * gives up on it.
 *
 * A deploy or an eviction mid-turn is normal and should cost nothing but the
 * round that was in flight. A turn that dies the same way every time is not
 * being interrupted, it is failing — retrying it forever would burn tokens on
 * every wake and never finish.
 */
export const MAX_RESUMES = 3;

/**
 * Set once a write has created the repository's working branch, after which
 * reads resolve against it. See #runGithub.
 */
const GITHUB_WORKING_KEY = "github:working";

export class Room extends Agent<Env, RoomState> {
  initialState: RoomState = INITIAL_ROOM_STATE;

  #schemaReady = false;

  /**
   * Correlates outstanding filesystem requests sent to the workspace host's
   * socket with their eventual "fs.res" reply. See src/server/workspace.ts for
   * why this lives in memory rather than storage.
   */
  #pending = new PendingRequests();
  #settling = false;

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
      avatar TEXT NOT NULL DEFAULT '',
      joined_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    )`;
    try {
      this.sql`ALTER TABLE members ADD COLUMN avatar TEXT NOT NULL DEFAULT ''`;
    } catch {
      /* column already present */
    }
    this.sql`CREATE TABLE IF NOT EXISTS revisions (
      revision INTEGER PRIMARY KEY,
      doc TEXT NOT NULL,
      ts INTEGER NOT NULL,
      author TEXT NOT NULL,
      author_uid TEXT NOT NULL DEFAULT 'agent'
    )`;
    try {
      this.sql`ALTER TABLE revisions ADD COLUMN author_uid TEXT NOT NULL DEFAULT 'agent'`;
    } catch {
      /* column already present */
    }
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
    // Added after the github table shipped, so — same as members.role above —
    // it has to be tolerated as a no-op on a room that already has the
    // column. Values are the strings 'app' or 'oauth', recording which flow
    // connected the repository this room currently has.
    try {
      this.sql`ALTER TABLE github ADD COLUMN auth TEXT NOT NULL DEFAULT 'app'`;
    } catch {
      /* column already present */
    }
    // The one place in this app where a long-lived OAuth credential is stored. It is
    // here and not in RoomState because RoomState is synced to every connected
    // client; this table is not on the wire at all. Only the member who
    // authorised can cause it to be used, only to list their own repositories
    // and to read the one repository this room has connected, and disconnecting
    // the workspace deletes the row.
    this.sql`CREATE TABLE IF NOT EXISTS github_oauth (
      k TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      token TEXT NOT NULL,
      login TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    )`;
    // Added after github_oauth shipped, so — same as github.auth above — the
    // ALTER has to be tolerated as a no-op on a room that already has it.
    // This is GitHub's own numeric account id for whoever authorised, kept
    // because `uid` cannot stand in for it: a member who signed in with
    // Google has a uid derived from their Google id, and matching that
    // against a GitHub account would never succeed. Rooms that authorised
    // before this column existed hold '', which #onGithubInstalled treats as
    // "cannot prove ownership" rather than as a match.
    try {
      this.sql`ALTER TABLE github_oauth ADD COLUMN github_id TEXT NOT NULL DEFAULT ''`;
    } catch {
      /* column already present */
    }
    this.sql`CREATE TABLE IF NOT EXISTS github_installations (
      k TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
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
    const stored = this.#kvGet<MessageParam[]>("convo", []);
    const normalized = normalizeConversation(stored);
    if (normalized !== stored) this.#kvSet("convo", normalized);
    return normalized;
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

  /**
   * This deployment's own origin, learned from the Worker on connect rather
   * than configured. It is needed to build an OAuth redirect URI, and it is
   * set with `headers.set` on the server side, so a client cannot forge it.
   *
   * It lives in storage rather than a field because a hibernated room wakes on
   * a message without `onConnect` running again — an in-memory copy would be
   * empty exactly when someone clicks "connect a repository" in a room that
   * has been idle, which is most of the time.
   */
  #origin(): string {
    return this.#kvGet<string>("origin", "");
  }
  #setOrigin(origin: string) {
    this.#kvSet("origin", origin);
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
    this.#sendEntry("entry", entry);
  }

  #patch(entry: Entry) {
    this.#putEntry(entry);
    this.#sendEntry("patch", entry);
  }

  #system(text: string) {
    this.#append({ id: crypto.randomUUID(), ts: Date.now(), kind: "system", text });
  }

  #send(msg: ServerMsg) {
    this.broadcast(JSON.stringify(msg));
  }

  /**
   * Send an entry to each connection at the visibility its role allows.
   *
   * This cannot use `broadcast`, because different members are entitled to
   * different versions of the same entry. The stored copy is always the full
   * one; only what leaves the server is trimmed.
   */
  #sendEntry(t: "entry" | "patch", entry: Entry) {
    for (const conn of this.getConnections()) {
      const allowed = canSeeFileContents(this.#roleOf(conn));
      conn.send(JSON.stringify({ t, entry: redactEntry(entry, allowed) } satisfies ServerMsg));
    }
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
   * What this deployment can do with GitHub, and how far this room has got.
   *
   * Booleans and a public login only — never a token. This is safe to put
   * straight into RoomState because it summarizes the stored GitHub
   * authorization state with every secret stripped out of it.
   */
  #githubStatus(): GithubStatus {
    const row = this.sql<{ uid: string; login: string }>`SELECT uid, login FROM github_oauth WHERE k = 'current'`[0];
    const installation = this.sql<{ uid: string }>`SELECT uid FROM github_installations WHERE k = 'current'`[0];
    return {
      oauth: Boolean(this.env.GITHUB_OAUTH_CLIENT_ID) && Boolean(this.env.GITHUB_OAUTH_CLIENT_SECRET),
      app: Boolean(this.env.GITHUB_APP_ID) && Boolean(this.env.GITHUB_APP_PRIVATE_KEY),
      installed: Boolean(installation),
      authorized: Boolean(row || installation),
      login: row?.login ?? "",
    };
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
      uid: string; name: string; avatar: string; role: string; joined_at: number; last_seen: number;
    }>`SELECT uid, name, avatar, role, joined_at, last_seen FROM members ORDER BY joined_at ASC`;
    return rows.map((r) => ({
      uid: r.uid,
      name: r.name,
      avatar: r.avatar,
      role: asRole(r.role),
      joinedAt: r.joined_at,
      lastSeen: r.last_seen,
      online: online.has(r.uid),
    }));
  }

  #revisions(uid: string): DocumentRevision[] {
    return this.sql<{ revision: number; doc: string; ts: number; author: string; author_uid: string }>`
      SELECT revision, doc, ts, author, author_uid FROM revisions
      WHERE author_uid = ${uid} ORDER BY revision DESC
    `.map((row) => ({
      revision: row.revision,
      doc: row.doc,
      ts: row.ts,
      author: row.author,
      authorUid: row.author_uid,
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
      const rows = this.sql<{ avatar: string }>`SELECT avatar FROM members WHERE uid = ${uid}`;
      out.push({ uid, name, avatar: rows[0]?.avatar ?? "", color: colorFor(uid), connections, role: asRole(this.#memberRole(uid)) });
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
    const present = new Set(users.map((u) => u.uid));

    // Each pending call gets its own threshold: a sensitive one (file
    // contents) is decided only by those who can see them, so it must not
    // share a threshold with an ordinary call decided by all voters. Compute
    // eligibility against the freshly-read `users` above, not the stale
    // this.state.users a no-argument call would otherwise see.
    const pending = this.state.pending.map((p) => {
      // Drop votes from people who have left, so tallies match the new threshold.
      const votes = Object.fromEntries(
        Object.entries(p.votes).filter(([uid]) => present.has(uid)),
      );
      const threshold = approvalThreshold(
        this.#policy().approval,
        this.#eligible(p.sensitive === true, users),
      );
      return { ...p, votes, threshold };
    });

    this.setState({ ...this.state, users, pending });
    if (pending.length > 0) await this.#settleIfDecided();
  }

  /** How many people present are eligible to decide this proposal. */
  #eligible(sensitive: boolean, users: Presence[] = this.state.users): number {
    return users.filter(
      (u) => isVoter(u.role) && (!sensitive || canSeeFileContents(u.role)),
    ).length;
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

    let body: {
      uid?: string;
      name?: string;
      avatar?: string;
      title?: string;
      code?: string;
      installationId?: string;
      token?: string;
      login?: string;
      githubId?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "bad_request" }, 400);
    }

    const uid = String(body.uid ?? "");
    const name = String(body.name ?? "").trim().slice(0, 32) || "anon";
    const avatar = typeof body.avatar === "string" ? body.avatar.slice(0, 512) : "";
    if (!UID_RE.test(uid)) return json({ error: "bad_request" }, 400);

    const now = Date.now();

    if (url.pathname === "/init") {
      // Creating a room that already exists would silently hand ownership to
      // whoever asked second, so it is refused outright.
      if (this.#room() !== null) return json({ error: "bad_request" }, 409);
      const title = String(body.title ?? "").trim().slice(0, 64) || "Untitled room";
      this.#kvSet("room", { title, visibility: "invite", createdAt: now });
      this.sql`INSERT INTO members (uid, name, avatar, joined_at, last_seen, role)
               VALUES (${uid}, ${name}, ${avatar}, ${now}, ${now}, 'owner')`;
      // The title travels back so the Worker can label this room in the
      // creator's account-level sidebar without asking the room again.
      return json({ role: "owner", title });
    }

    if (url.pathname === "/admit") {
      const room = this.#room();
      if (room === null) return json({ error: "not_found" }, 404);

      // An existing member keeps the role they already have; re-joining is not
      // a way to be re-graded.
      const existing = this.#memberRole(uid);
      if (existing !== null) {
        this.sql`UPDATE members SET name = ${name}, avatar = ${avatar}, last_seen = ${now} WHERE uid = ${uid}`;
        return json({ role: existing, title: room.title });
      }

      if (room.visibility === "locked") return json({ error: "locked" }, 403);

      // A code is checked even in an open room: it is how someone arrives at a
      // role other than the default, so honouring it matters either way.
      const code = String(body.code ?? "");
      if (code) {
        const verdict = this.#checkInvite(code);
        if (!verdict.ok) return json({ error: verdict.reason }, 403);

        this.sql`INSERT INTO members (uid, name, avatar, joined_at, last_seen, role)
                 VALUES (${uid}, ${name}, ${avatar}, ${now}, ${now}, ${verdict.role})`;
        // Counted only after the member row lands, so a failed insert cannot
        // burn a use of a single-use invite.
        this.sql`UPDATE invites SET uses = uses + 1 WHERE code = ${code}`;
        this.#system(`${name} joined as ${verdict.role}`);
        return json({ role: verdict.role, title: room.title });
      }

      if (room.visibility !== "open") return json({ error: "invite_required" }, 403);

      this.sql`INSERT INTO members (uid, name, avatar, joined_at, last_seen, role)
               VALUES (${uid}, ${name}, ${avatar}, ${now}, ${now}, 'editor')`;
      this.#system(`${name} joined`);
      return json({ role: "editor", title: room.title });
    }

    if (url.pathname === "/presence-exit") {
      if (this.#memberRole(uid) === null) return json({ error: "forbidden" }, 403);
      const key = `presence:exited:${uid}`;
      // Logout followed by pagehide can send two beacons. Keep the transcript
      // to one departure and leave a marker for the next genuine return.
      if (!this.#kvGet<boolean>(key, false)) {
        this.#kvSet(key, true);
        this.#system(`${this.#memberName(uid) ?? "someone"} exited`);
      }
      return json({ ok: true });
    }

    if (url.pathname === "/github-installed") {
      const role = this.#memberRole(uid);
      if (role === null || !can(asRole(role), "policy")) return json({ error: "forbidden" }, 403);
      const pending = this.#kvGet<{ repo: string; uid: string } | null>("github:pending", null);
      const installationId = String(body.installationId ?? "");
      if (!/^[0-9]+$/.test(installationId)) return json({ error: "bad_request" }, 400);

      const oauth = this.sql<{ uid: string; token: string; github_id: string }>`SELECT uid, token, github_id FROM github_oauth WHERE k = 'current'`[0];
      if (!oauth || oauth.uid !== uid) return json({ error: "github_authorization_required" }, 403);

      // Claiming an installation has to be proved, not taken on the word of
      // whoever posted the id. There are two ways to prove it and the right
      // one depends on what kind of credential this deployment holds.
      //
      // The direct question — "which installations may this person use" —
      // can only be put with a GitHub App user-to-server token. Where the
      // OAuth credentials belong to a classic OAuth App that question cannot
      // be asked at all: /user/installations answers 403 regardless of who
      // is signed in, which used to fail the whole flow.
      //
      // So it is asked first and, when it cannot be answered, the App's own
      // JWT answers a weaker one — "does this installation exist" — and the
      // account id stored at authorisation supplies the missing half. That
      // fallback is deliberately stricter: listAppInstallations returns
      // *every* installation of this App, so a bare existence check would
      // let any member claim any of them.
      const viaUser = await listUserInstallations(oauth.token);
      if (viaUser.ok) {
        if (!viaUser.installations.some((installation) => installation.id === installationId)) {
          return json({ error: "installation_not_accessible" }, 403);
        }
      } else {
        if (!this.env.GITHUB_APP_ID || !this.env.GITHUB_APP_PRIVATE_KEY) {
          return json({ error: viaUser.error }, 502);
        }
        const viaApp = await listAppInstallations({
          appId: this.env.GITHUB_APP_ID,
          privateKeyPem: this.env.GITHUB_APP_PRIVATE_KEY,
        });
        if (!viaApp.ok) return json({ error: viaApp.error }, 502);

        // An empty stored id proves nothing and must never match an empty
        // accountId, which is why both sides are required to be non-empty.
        const claimed = viaApp.installations.find((installation) => installation.id === installationId);
        if (!claimed || oauth.github_id.length === 0 || claimed.accountId !== oauth.github_id) {
          return json({ error: "installation_not_accessible" }, 403);
        }
      }

      this.sql`INSERT INTO github_installations (k, uid, installation_id, created_at)
               VALUES ('current', ${uid}, ${installationId}, ${now})
               ON CONFLICT(k) DO UPDATE SET
                 uid = excluded.uid,
                 installation_id = excluded.installation_id,
                 created_at = excluded.created_at`;

      if (!pending) {
        this.setState({ ...this.state, github: this.#githubStatus() });
        return json({ ok: true });
      }

      this.sql`INSERT INTO github (k, installation_id, repo, connected_by, connected_at, auth)
               VALUES ('current', ${installationId}, ${pending.repo}, ${uid}, ${now}, 'app')
               ON CONFLICT(k) DO UPDATE SET
                 installation_id = excluded.installation_id,
                 repo = excluded.repo,
                 connected_by = excluded.connected_by,
                 connected_at = excluded.connected_at,
                 auth = excluded.auth`;
      this.#kvDel("github:pending");

      // Unlike the OAuth path, the install round trip is already over by the
      // time this runs, so a repository the installation cannot write is
      // recorded rather than refused — throwing the install away would leave
      // the person who just did it with nothing. What it must not do is claim
      // write access it does not have, so the installation is asked, and the
      // room shows the answer. If the question cannot be put to GitHub at
      // all, that stays null rather than becoming a "no" this code invented.
      let canWrite: boolean | null = null;
      const ref = parseRepoRef(pending.repo);
      if (ref && this.env.GITHUB_APP_ID && this.env.GITHUB_APP_PRIVATE_KEY) {
        const tokenRes = await installationToken(
          { appId: this.env.GITHUB_APP_ID, privateKeyPem: this.env.GITHUB_APP_PRIVATE_KEY },
          installationId,
        );
        if (tokenRes.ok) {
          const access = await repoAccess(tokenRes.token, ref);
          if (access.ok) canWrite = access.access.canPush;
        }
      }

      this.setState({
        ...this.state,
        workspace: { kind: "github", online: true, hostUid: uid, label: pending.repo, canWrite },
        github: this.#githubStatus(),
      });
      const connectedName = this.#memberName(uid) ?? "someone";
      this.#system(`${connectedName} connected ${pending.repo}`);

      return json({ ok: true });
    }

    // Reached once GitHub redirects back from the repository-authorise
    // round trip (see #onGithubAuth): the Worker has already verified the
    // state token and exchanged the code for an access token, and hands it
    // here to be stored. This route carries the one long-lived credential in
    // this app — it is written straight to github_oauth and never touches
    // RoomState, a broadcast, or a log line.
    if (url.pathname === "/github-oauth") {
      const role = this.#memberRole(uid);
      if (role === null || !can(asRole(role), "policy")) return json({ error: "forbidden" }, 403);
      const token = body.token;
      if (typeof token !== "string" || token.length === 0) {
        return json({ error: "bad_request" }, 400);
      }
      const login = String(body.login ?? "");
      // GitHub's numeric account id for the authorising user. Public, not a
      // secret, and stored because it is the only thing that can later prove
      // a GitHub App installation belongs to this person — see the ALTER on
      // this table and #onGithubInstalled. Absent on an OAuth-only
      // deployment that never fetched a profile, which is why it is
      // tolerated as '' rather than required here.
      const githubId = String(body.githubId ?? "");

      this.sql`INSERT INTO github_oauth (k, uid, token, login, github_id, created_at)
               VALUES ('current', ${uid}, ${token}, ${login}, ${githubId}, ${now})
               ON CONFLICT(k) DO UPDATE SET
                 uid = excluded.uid,
                 token = excluded.token,
                 login = excluded.login,
                 github_id = excluded.github_id,
                 created_at = excluded.created_at`;

      this.setState({ ...this.state, github: this.#githubStatus() });
      // The login, never the token, is safe to name in a transcript everyone
      // in the room reads.
      this.#system(`${this.#memberName(uid) ?? "someone"} connected their GitHub account`);

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

    const origin = ctx.request.headers.get("x-room-origin");
    if (origin) this.#setOrigin(origin);

    // RoomState is rebuilt from initialState on a fresh instance, so the
    // stored visibility has to be read back or the room would report itself
    // as invite-only after every eviction regardless of what it is.
    const stored = this.#room();
    if (stored && this.state.visibility !== stored.visibility) {
      this.setState({ ...this.state, visibility: asVisibility(stored.visibility) });
    }

    // Same reasoning as visibility above: a fresh instance starts from
    // INITIAL_ROOM_STATE's NO_GITHUB, which knows nothing about this
    // deployment's env config or this room's stored authorisation. Recompute
    // and republish it so it's correct from the first connection, not just
    // after the next thing that happens to touch github state.
    const githubStatus = this.#githubStatus();
    if (
      githubStatus.oauth !== this.state.github.oauth ||
      githubStatus.app !== this.state.github.app ||
      githubStatus.installed !== this.state.github.installed ||
      githubStatus.authorized !== this.state.github.authorized ||
      githubStatus.login !== this.state.github.login
    ) {
      this.setState({ ...this.state, github: githubStatus });
    }

    connection.setState({ uid, role });
    connection.send(JSON.stringify({ t: "you", uid, role } satisfies ServerMsg));
    const allowed = canSeeFileContents(asRole(role));
    connection.send(
      JSON.stringify({
        t: "history",
        entries: this.#entries().map((e) => redactEntry(e, allowed)),
      } satisfies ServerMsg),
    );

    const exitKey = `presence:exited:${uid}`;
    if (this.#kvGet<boolean>(exitKey, false)) {
      this.#kvDel(exitKey);
      this.#system(`${this.#memberName(uid) ?? "someone"} entered the chat`);
    }

    // The workspace stays configured while its host is offline — see onClose —
    // so a reconnect from that same host is what brings it back, not a fresh
    // "workspace.attach".
    if (this.state.workspace.hostUid === uid && !this.state.workspace.online) {
      this.setState({ ...this.state, workspace: { ...this.state.workspace, online: true } });
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
      case "workflow":
        return this.#onWorkflow(connection, msg.graph, msg.useCustom);
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
      case "revision.list":
        return this.#onRevisionList(connection, msg.uid);
      case "member.role":
        return this.#onMemberRole(connection, msg.uid, msg.role);
      case "member.remove":
        return this.#onMemberRemove(connection, msg.uid);
      case "workspace.attach":
        return this.#onWorkspaceAttach(connection, msg.kind, msg.label);
      case "room.visibility":
        return this.#onVisibility(connection, msg.visibility);
      case "workspace.detach":
        return this.#onWorkspaceDetach(connection);
      case "github.connect":
        return this.#onGithubConnect(connection, msg.repo);
      case "github.auth":
        return this.#onGithubAuth(connection);
      case "github.repos":
        return this.#onGithubRepos(connection);
      case "github.signout":
        return this.#onGithubSignout(connection);
      case "fs.res":
        return this.#onFsRes(connection, msg.id, msg.res);
      case "fs.client.req":
        return this.#onFsClientReq(connection, msg.id, msg.req);
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
   * Replace the room's agent graph.
   *
   * Editors hold `workflow` without holding `settings`, which is the whole
   * point of the split: shaping the team is design work, choosing which models
   * get billed is a spend decision. So a frame from anyone without `settings`
   * keeps every existing node on the model it already had, and any node they
   * added runs on the room's configured worker model. The editor draws the
   * shape; the owner decides what it costs.
   *
   * Held until idle for the same reason settings and policy are: the graph
   * decides the system prompt, the tool list and the worker roster, and none of
   * those may change between one round of a live turn and the next.
   */
  async #onWorkflow(connection: Connection, incoming: unknown, useCustom: boolean) {
    if (
      !this.#allow(
        connection,
        "workflow",
        "You need to be an editor or above to change the workflow.",
      )
    )
      return;
    const name = this.#nameOf(connection);
    if (!name) return;

    if (this.state.status !== "idle") {
      this.#refuse(connection, "The workflow can only change while the agent is idle.");
      return;
    }

    let graph = sanitizeGraph(incoming);

    if (!can(this.#roleOf(connection), "settings")) {
      const before = this.#graph();
      const settings = this.#settings();
      graph = {
        ...graph,
        nodes: graph.nodes.map((n) => {
          const prior = before.nodes.find((o) => o.id === n.id);
          return { ...n, model: prior?.model ?? settings.workerModel };
        }),
      };
      // Re-sanitize: a preserved model may be a worker model that has just been
      // promoted into the lead slot, which sanitizeGraph is the thing that knows
      // how to correct. Running it twice is cheap and keeps one source of truth.
      graph = sanitizeGraph(graph);
    }

    const settings = this.#settings();
    const workflow = useCustom ? "custom" : settings.workflow === "custom" ? "manager" : settings.workflow;

    this.setState({ ...this.state, graph, settings: { ...settings, workflow } });
    this.#system(
      useCustom
        ? `${name} changed the workflow — ${describeGraph(graph)}`
        : `${name} saved the workflow and switched the room back to ${workflow}`,
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
    const uid = this.#uidOf(connection);
    if (!uid || !this.#memberRole(uid)) return;
    this.#sendMembers(connection);
  }

  async #onRevisionList(connection: Connection, targetUid: string) {
    const actorUid = this.#uidOf(connection);
    if (!actorUid || !this.#memberRole(actorUid) || !this.#memberRole(targetUid)) return;
    if (targetUid !== actorUid && !can(this.#roleOf(connection), "view_revisions")) {
      this.#refuse(connection, "Only the room's owner or admins can view another user's revision history.");
      return;
    }
    connection.send(JSON.stringify({ t: "revisions", uid: targetUid, revisions: this.#revisions(targetUid) } satisfies ServerMsg));
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

    // A local folder's write permission is the hosting browser's to know, not
    // this server's: the directory handle and its grant live in that tab.
    // Null is this server declining to claim anything either way, and the tab
    // hosting the folder supplies the real answer for its own panel.
    this.setState({
      ...this.state,
      workspace: { kind, online: true, hostUid: uid, label, canWrite: null },
    });
    this.#system(`${name ?? "someone"} connected a workspace${label ? ` (${label})` : ""}`);
  }

  /**
   * Change how the room admits people.
   *
   * Owner only, and deliberately not delegated to admins: opening a room up
   * is the one setting that undoes the point of a private room, and it should
   * take the person who owns it.
   */
  async #onVisibility(connection: Connection, incoming: unknown) {
    if (!this.#allow(connection, "admin_room", "Only the room's owner can change who may join.")) return;
    const room = this.#room();
    if (!room) return;
    const visibility = asVisibility(incoming);
    if (visibility === room.visibility) return;

    this.#kvSet("room", { ...room, visibility });
    this.setState({ ...this.state, visibility });
    const how =
      visibility === "open"
        ? "anyone with the link can join as an editor"
        : visibility === "locked"
          ? "nobody new can join"
          : "an invite link is required to join";
    this.#system(`${this.#nameOf(connection) ?? "someone"} changed who may join — ${how}`);
  }

  async #onWorkspaceDetach(connection: Connection) {
    if (!this.#allow(connection, "policy", "Only the room's owner and admins can disconnect a workspace.")) return;

    const name = this.#nameOf(connection);
    this.#pending.failAll("The workspace was disconnected.");
    // A GitHub workspace stores its installation id and repo in the `github`
    // table, not just in state — clear both, or a later re-attach could see
    // stale rows.
    this.sql`DELETE FROM github WHERE k = 'current'`;
    // The working branch belonged to that connection; a later one starts
    // over from its own base branch.
    this.#kvDel(GITHUB_WORKING_KEY);
    // Disconnecting the workspace is the obvious moment a person expects the
    // stored credential to go away, so it does — github_oauth is not
    // per-workspace state, but leaving someone's access token behind after
    // they have just disconnected the thing it was for is exactly the kind
    // of surprise a stored credential should never spring. Deleted before
    // #githubStatus() runs below, so the republished state reflects it.
    this.sql`DELETE FROM github_oauth WHERE k = 'current'`;
    this.setState({ ...this.state, workspace: NO_WORKSPACE, github: this.#githubStatus() });
    this.#system(`${name ?? "someone"} disconnected the workspace`);
  }

  /**
   * Connect a GitHub repository to the room, preferring the simpler of the
   * two paths this deployment supports, preferring an installation belonging
   * to the current member.
   *
   * A malformed repo name is refused first, before either configuration
   * check, because it is wrong regardless of what this server has set up.
   * After that: if the current member has already installed the GitHub App,
   * the repository is validated with its short-lived installation token and
   * connected directly. The OAuth path remains as a fallback for deployments
   * that have not configured an App. If neither is configured, there is
   * simply nothing this server can do yet.
   */
  async #onGithubConnect(connection: Connection, repo: string) {
    if (!this.#allow(connection, "policy", "Only the room's owner and admins can connect a repository.")) return;

    const ref = parseRepoRef(repo);
    if (ref === null) {
      this.#refuse(
        connection,
        "That doesn't look like a repository. Use owner/repo, optionally owner/repo@branch.",
      );
      return;
    }

    const uid = this.#uidOf(connection);
    if (!uid) return;

    const installationRow = this.sql<{ uid: string; installation_id: string }>`SELECT uid, installation_id FROM github_installations WHERE k = 'current'`[0];
    if (installationRow && installationRow.uid === uid) {
      const tokenRes = await installationToken(
        { appId: this.env.GITHUB_APP_ID, privateKeyPem: this.env.GITHUB_APP_PRIVATE_KEY },
        installationRow.installation_id,
      );
      if (!tokenRes.ok) {
        this.#refuse(connection, `Couldn't reach GitHub. ${tokenRes.error}`);
        return;
      }
      // Same question the OAuth path below asks, for the same reason: parsing
      // proves the shape of the name, never that GitHub has anything behind
      // it, and reachable is not writable. An installation makes that second
      // half easy to get wrong — the member connecting may have full write
      // access to the repository while the installation carrying the request
      // holds only `Contents: Read`, and every commit would 403 long after
      // the room approved it.
      const access = await repoAccess(tokenRes.token, ref);
      if (!access.ok) {
        this.#refuse(connection, `Couldn't reach ${repo} on GitHub. ${access.error}`);
        return;
      }
      if (!access.access.canPush) {
        this.#refuse(
          connection,
          `The GitHub App installation has no write access to ${repo}. ` +
            `On GitHub, grant it Contents and Pull requests write access for this repository, then try again.`,
        );
        return;
      }

      // A branch named explicitly still has to exist. When none was named the
      // call above already proved the repository is there.
      if (ref.ref !== "HEAD") {
        const head = await refHead(tokenRes.token, ref);
        if (!head.ok) {
          this.#refuse(connection, `Couldn't reach ${repo} on GitHub. ${head.error}`);
          return;
        }
      }

      const now = Date.now();
      this.sql`INSERT INTO github (k, installation_id, repo, connected_by, connected_at, auth)
               VALUES ('current', ${installationRow.installation_id}, ${repo}, ${uid}, ${now}, 'app')
               ON CONFLICT(k) DO UPDATE SET
                 installation_id = excluded.installation_id,
                 repo = excluded.repo,
                 connected_by = excluded.connected_by,
                 connected_at = excluded.connected_at,
                 auth = excluded.auth`;
      this.setState({
        ...this.state,
        workspace: { kind: "github", online: true, hostUid: uid, label: repo, canWrite: true },
        github: this.#githubStatus(),
      });
      this.#system(`${this.#memberName(uid) ?? "someone"} connected ${repo}`);
      return;
    }

    const oauthRow = this.sql<{ uid: string; token: string }>`SELECT uid, token FROM github_oauth WHERE k = 'current'`[0];
    if (oauthRow && oauthRow.uid === uid) {
      // Parsing proves the shape of the name, never that GitHub has anything
      // behind it: a typo, a repository someone else's account can see, or a
      // branch that was never pushed all parse perfectly. Asking GitHub here
      // is what turns those into a refusal at the moment of connecting,
      // instead of a workspace that publishes `online: true` and only fails
      // when the agent first tries to read it.
      const access = await repoAccess(oauthRow.token, ref);
      if (!access.ok) {
        this.#refuse(connection, `Couldn't reach ${repo} on GitHub. ${access.error}`);
        return;
      }

      // Reachable is not writable, and the difference is worth catching now:
      // a read-only connection works perfectly until the room approves its
      // first edit, which is the worst possible moment to discover it.
      if (!access.access.canPush) {
        this.#refuse(
          connection,
          `GitHub reports no write access to ${repo} for the connected account. ` +
            `Connect an account that can push to it, or grant this one write access, then try again.`,
        );
        return;
      }

      // A branch named explicitly still has to exist. When none was named
      // there is nothing further to check: the call above already proved the
      // repository is there, and a repository with no commits yet is a
      // legitimate thing to connect.
      if (ref.ref !== "HEAD") {
        const head = await refHead(oauthRow.token, ref);
        if (!head.ok) {
          this.#refuse(connection, `Couldn't reach ${repo} on GitHub. ${head.error}`);
          return;
        }
      }

      const now = Date.now();
      this.sql`INSERT INTO github (k, installation_id, repo, connected_by, connected_at, auth)
               VALUES ('current', '', ${repo}, ${uid}, ${now}, 'oauth')
               ON CONFLICT(k) DO UPDATE SET
                 installation_id = excluded.installation_id,
                 repo = excluded.repo,
                 connected_by = excluded.connected_by,
                 connected_at = excluded.connected_at,
                 auth = excluded.auth`;
      this.setState({
        ...this.state,
        workspace: { kind: "github", online: true, hostUid: uid, label: repo, canWrite: true },
        github: this.#githubStatus(),
      });
      this.#system(`${this.#memberName(uid) ?? "someone"} connected ${repo}`);
      return;
    }

    if (this.env.GITHUB_APP_ID && this.env.GITHUB_APP_PRIVATE_KEY) {
      this.#kvSet("github:pending", { repo, uid });
      if (!this.env.GITHUB_OAUTH_CLIENT_ID || !this.env.GITHUB_OAUTH_CLIENT_SECRET) {
        this.#refuse(connection, "GitHub user authorization is required before installing the GitHub App.");
        return;
      }

      const token = await mintToken(this.env.ROOM_SECRET, {
        rid: this.name,
        uid,
        role: GITHUB_REPO_STATE_ROLE,
        exp: Math.floor(Date.now() / 1000) + 600,
      });
      const origin = this.#origin();
      if (!origin) {
        this.#refuse(connection, "Couldn't work out this server's address. Reload the page and try again.");
        return;
      }
      const url = repoAuthorizeUrl(
        this.env.GITHUB_OAUTH_CLIENT_ID,
        `${origin}/api/auth/github/callback`,
        token,
      );

      connection.send(JSON.stringify({ t: "github.install", url } satisfies ServerMsg));
      return;
    }

    this.#refuse(
      connection,
      "GitHub isn't set up on this server. Ask whoever deployed it to add the GitHub OAuth credentials.",
    );
  }

  /**
   * Authorize the current GitHub user so the callback can securely discover
   * an existing App installation or send them to install it when none exists.
   *
   * The state token minted here deliberately does NOT carry the member's own
   * role — it only says "this is
   * a repository connect for this room, begun by this member". Authority is
   * re-checked from membership when the repository is actually connected
   * (in #onGithubConnect and, before that, in #onGithubRepos), so a stale or
   * tampered role riding along in the state token could never grant anything
   * it shouldn't anyway; there is no reason to carry it.
   */
  async #onGithubAuth(connection: Connection) {
    if (!this.#allow(connection, "policy", "Only the room's owner and admins can connect a repository.")) return;

    const uid = this.#uidOf(connection);
    if (!uid) return;

    if (!this.env.GITHUB_OAUTH_CLIENT_ID || !this.env.GITHUB_OAUTH_CLIENT_SECRET) {
      this.#refuse(
        connection,
        "GitHub sign-in isn't set up on this server, so a repository can't be connected. Ask whoever deployed it to add the GitHub OAuth credentials.",
      );
      return;
    }
    const origin = this.#origin();
    if (!origin) {
      this.#refuse(connection, "Couldn't work out this server's address. Reload the page and try again.");
      return;
    }

    const token = await mintToken(this.env.ROOM_SECRET, {
      rid: this.name,
      uid,
      role: GITHUB_REPO_STATE_ROLE,
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    const url = repoAuthorizeUrl(
      this.env.GITHUB_OAUTH_CLIENT_ID,
      `${origin}/api/auth/github/callback`,
      token,
    );

    connection.send(JSON.stringify({ t: "github.install", url } satisfies ServerMsg));
  }

  /**
   * List the repositories the authorising member can reach, to fill their
   * picker.
   */
  async #onGithubRepos(connection: Connection) {
    if (!this.#allow(connection, "policy", "Only the room's owner and admins can connect a repository.")) return;

    const uid = this.#uidOf(connection);
    const installation = this.sql<{ uid: string; installation_id: string }>`SELECT uid, installation_id FROM github_installations WHERE k = 'current'`[0];
    if (installation && installation.uid === uid) {
      const pkcs8 = pemToPkcs8(this.env.GITHUB_APP_PRIVATE_KEY);
      if (!pkcs8.ok) {
        this.#refuse(connection, pkcs8.error);
        return;
      }
      const tokenRes = await installationToken(
        { appId: this.env.GITHUB_APP_ID, privateKeyPem: this.env.GITHUB_APP_PRIVATE_KEY },
        installation.installation_id,
      );
      if (!tokenRes.ok) {
        this.#refuse(connection, tokenRes.error);
        return;
      }
      const res = await listInstallationRepos(tokenRes.token);
      if (!res.ok) {
        this.#refuse(connection, res.error);
        return;
      }
      connection.send(JSON.stringify({ t: "github.repos", repos: res.repos } satisfies ServerMsg));
      return;
    }

    const row = this.sql<{ uid: string; token: string }>`SELECT uid, token FROM github_oauth WHERE k = 'current'`[0];
    if (!row) {
      this.#refuse(connection, "Connect a GitHub account first.");
      return;
    }

    // Which repositories a person can see is their own business, so even
    // another admin in the room may not enumerate them through someone
    // else's stored token — only the member who actually authorised may.
    if (!uid || uid !== row.uid) {
      this.#refuse(connection, "Only the member who connected GitHub can list their repositories.");
      return;
    }

    const res = await listUserRepos(row.token);
    if (!res.ok) {
      this.#refuse(connection, res.error);
      return;
    }

    // Sent to this one connection, never broadcast — see the comment on the
    // "github.repos" ServerMsg case.
    connection.send(JSON.stringify({ t: "github.repos", repos: res.repos } satisfies ServerMsg));
  }

  /**
   * Forget this room's stored GitHub authorisation.
   *
   * A repository connected over OAuth is served entirely by the token being
   * deleted here, so it has to go too. Leaving it would publish a workspace
   * that says `online: true` while every file request behind it fails — a
   * state that reads as a bug to everyone in the room. The GitHub App path
   * does not depend on this token, so a repository connected that way is
   * deliberately left alone.
   */
  async #onGithubSignout(connection: Connection) {
    if (!this.#allow(connection, "policy", "Only the room's owner and admins can connect a repository.")) return;

    this.sql`DELETE FROM github_oauth WHERE k = 'current'`;
    this.sql`DELETE FROM github_installations WHERE k = 'current'`;

    const connected = this.sql<{ auth: string }>`SELECT auth FROM github WHERE k = 'current'`[0];
    const workspace = connected ? NO_WORKSPACE : this.state.workspace;
    if (connected) {
      this.sql`DELETE FROM github WHERE k = 'current'`;
      this.#kvDel(GITHUB_WORKING_KEY);
      this.#pending.failAll("The GitHub connection was signed out.");
    }

    this.setState({ ...this.state, workspace, github: this.#githubStatus() });
    this.#system(`${this.#memberName(this.#uidOf(connection) ?? "") ?? "someone"} disconnected the GitHub account`);
  }

  /**
   * Run one file request against a repository, and remember the moment a
   * write has created the working branch.
   *
   * Writes deliberately land on a working branch so nothing here can change
   * a repository's default branch without a pull request a human reviews.
   * Reads have to follow it once it exists, or the room reads the base
   * branch and sees content older than what it has itself just approved —
   * the agent re-reads a file it changed, finds the old text, and concludes
   * the vote failed when the commit was there the whole time. That is not a
   * hypothetical: it is what happened in production.
   *
   * The flag is set only after a write actually succeeds, because a
   * successful write is what creates the branch. Reading the working branch
   * before it exists would 404 every read in a room that has never written.
   */
  async #runGithub(
    token: string,
    ref: RepoRef,
    deny: readonly string[],
    req: FsRequest,
  ): Promise<FsResponse> {
    const readWorking = this.#kvGet<boolean>(GITHUB_WORKING_KEY, false);
    const provider = new GithubProvider(token, ref, deny, undefined, undefined, readWorking);
    const res = await provider.perform(req);
    if (res.ok && !readWorking && (req.op === "write" || req.op === "edit" || req.op === "remove")) {
      this.#kvSet(GITHUB_WORKING_KEY, true);
    }
    // Keep provider/runtime budget details out of the room transcript. The
    // model must not be encouraged to turn an internal limit into a long
    // user-facing explanation or retry the same request in this turn.
    if (!res.ok && /too many subrequests/i.test(res.error)) {
      return {
        ok: false,
        error: "File request unavailable for this turn. Do not retry this request.",
      };
    }
    return res;
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
   * Serve an explicit IDE request to the member who made it.
   *
   * File contents are more sensitive than ordinary room state, so the IDE is
   * restricted to the same owner/admin roles that can see file-tool results.
   * Writes still pass through the room's deny policy and the provider's own
   * write-permission check; the Save button is the user's explicit approval
   * for a write rather than a way around a denied path.
   */
  async #onFsClientReq(connection: Connection, id: string, req: FsRequest) {
    if (typeof id !== "string" || id.length === 0 || id.length > 100 || !req || typeof req !== "object") return;
    const reply = (res: FsResponse) =>
      connection.send(JSON.stringify({ t: "fs.client.res", id, res } satisfies ServerMsg));

    if (!canSeeFileContents(this.#roleOf(connection))) {
      reply({ ok: false, error: "Only the room's owner or admins can use the code workspace." });
      return;
    }

    if (req.op !== "list" && req.op !== "read" && req.op !== "write") {
      reply({ ok: false, error: "The code workspace supports listing, reading, and writing files." });
      return;
    }

    reply(await this.#fs(req));
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
      // The file tools stay in the model's tool list while the host is away, so
      // this message is the only thing stopping a retry loop. It has to say
      // plainly that waiting will not help and that a person has to act.
      return {
        ok: false,
        error:
          "The workspace host is offline, so no file can be read or written " +
          "right now. Retrying will not help — this clears only when the " +
          "person who connected the workspace reopens the room. Tell the room " +
          "that, and carry on with whatever does not need files.",
      };
    }

    // Search and list both walk the tree themselves, so neither names a single
    // path this server can police before the request leaves. Instead the room
    // hands its deny globs to the provider, which does the walking and is the
    // only place that can skip an entry before touching it. Search would
    // otherwise return the contents of a denied file; list would name it, and a
    // filename is itself worth protecting. Injected here rather than taken from
    // the model, which must not get a say in what it may not see.
    const denyGlobs = [...this.#policy().paths.deny];
    const withDeny: FsRequest = { ...req, deny: denyGlobs } as FsRequest;
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
      // not by votes, so a per-file vote would be unusable. Writes are
      // different: a write reaching this point has already been approved by
      // the room, because gating happens before execution — in `#advance`
      // and `#settleIfDecided` — not here. By the time a write's path clears
      // the "deny" check above, `#fs` just performs it.
    }

    // A GitHub workspace has no host socket — it's served straight from the
    // GitHub API using a token minted fresh for this one request, then
    // discarded. Never stored: see the comment on the `github` table.
    if (this.state.workspace.kind === "github") {
      const row = this.sql<{
        installation_id: string;
        repo: string;
        auth: string;
      }>`SELECT installation_id, repo, auth FROM github WHERE k = 'current'`[0];
      if (!row) {
        return { ok: false, error: "The repository connection is missing. Reconnect it." };
      }

      const ref = parseRepoRef(row.repo);
      if (!ref) {
        return { ok: false, error: "The repository connection is missing. Reconnect it." };
      }

      if (row.auth === "oauth") {
        // Unlike the installation path below — where a fresh short-lived
        // token is minted per request — this token is long-lived and was
        // read from storage at connect time. It is fetched at the last
        // possible moment, held only in this local, and never returned,
        // broadcast, or logged.
        const authRow = this.sql<{ token: string }>`SELECT token FROM github_oauth WHERE k = 'current'`[0];
        if (!authRow) {
          return { ok: false, error: "The GitHub connection was signed out. Reconnect it." };
        }
        return this.#runGithub(authRow.token, ref, denyGlobs, clamped);
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

      return this.#runGithub(tokenRes.token, ref, denyGlobs, clamped);
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
  #fsRequestFor(
    name: "list_files" | "read_file" | "search_files" | "write_file" | "edit_file" | "delete_file",
    input: unknown,
  ): FsRequest {
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
      case "write_file":
        return { op: "write", path: str(i.path, ""), content: str(i.content, ""), deny: [] };
      case "edit_file":
        return {
          op: "edit",
          path: str(i.path, ""),
          oldText: str(i.old_text, ""),
          newText: str(i.new_text, ""),
          deny: [],
        };
      case "delete_file":
        return { op: "remove", path: str(i.path, ""), deny: [] };
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
    this.#setInbox([...this.#inbox(), { uid, name, text }]);

    if (this.state.status === "idle") await this.#startTurn();
  }

  async #onVote(connection: Connection, toolUseId: string, vote: "approve" | "deny") {
    if (!this.#allow(connection, "vote", "You're a viewer in this room, so you can't vote.")) return;

    const target = this.state.pending.find((p) => p.toolUseId === toolUseId);
    if (target?.sensitive && !canSeeFileContents(this.#roleOf(connection))) {
      this.#refuse(connection, "You can't see this file's contents, so you can't vote on it. An owner or admin has to decide.");
      return;
    }

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

  /** The room's agent graph, defaulted for rooms created before it existed. */
  #graph(): WorkflowGraph {
    return this.state.graph ?? DEFAULT_GRAPH;
  }

  /** The graph, but only when the room is actually running on it. */
  #activeGraph(): WorkflowGraph | null {
    return this.#settings().workflow === "custom" ? this.#graph() : null;
  }

  /** Fold one response's token counts into the room's running ledger. */
  #recordUsage(usage: Usage | null | undefined) {
    if (!usage) return;
    this.setState({
      ...this.state,
      cost: addUsage(this.state.cost, usage.model, usage),
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
  #docBuffer(authorUid = "agent", authorName = "Huddle.AI"): ToolCtx & { flush(): void } {
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
        const revision = this.state.docRevision + 1;
        this.sql`INSERT INTO revisions (revision, doc, ts, author, author_uid)
                 VALUES (${revision}, ${doc}, ${Date.now()}, ${authorName}, ${authorUid})
                 ON CONFLICT(revision) DO UPDATE SET doc = excluded.doc, ts = excluded.ts,
                 author = excluded.author, author_uid = excluded.author_uid`;
        this.setState({
          ...this.state,
          doc,
          docRevision: revision,
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
    const graph = this.#activeGraph();
    const roster = graph ? delegatesOf(graph) : [];
    const cap = effectiveWorkerCap(settings, this.state.users.length);

    const parsed = Array.isArray(rawTasks) ? rawTasks : [];

    /** One accepted task, and the teammate it is addressed to under a graph. */
    type Job = { task: WorkerTask; node: AgentNode | null; unknownAgent: string };

    const jobs: Job[] = [];
    for (const raw of parsed) {
      const t = raw as { title?: unknown; instructions?: unknown; agent?: unknown };
      if (!t || typeof t.title !== "string") continue;
      const task: WorkerTask = {
        title: t.title.slice(0, 120),
        instructions: String(t.instructions ?? ""),
      };
      if (!graph) {
        jobs.push({ task, node: null, unknownAgent: "" });
        continue;
      }
      // The `agent` field is an enum in the tool definition, so a name that is
      // not on the roster is a model error rather than a user one. The task is
      // refused by name instead of being quietly reassigned: sending someone
      // else's work to whichever teammate happened to be first would produce a
      // plausible answer to a question nobody asked.
      const wanted = typeof t.agent === "string" ? t.agent.trim().toLowerCase() : "";
      const node = roster.find((n) => n.name.toLowerCase() === wanted) ?? null;
      jobs.push({ task, node, unknownAgent: node ? "" : String(t.agent ?? "") });
    }

    if (jobs.length === 0) {
      return { ok: false, text: "delegate requires a non-empty `tasks` array." };
    }
    if (graph && roster.length === 0) {
      return {
        ok: false,
        text: "This room has no teammates wired up to you. Do the work yourself.",
      };
    }

    const dropped = Math.max(0, jobs.length - cap);
    const accepted = jobs.slice(0, cap);

    const statuses: WorkerStatus[] = accepted.map((j) => ({
      id: crypto.randomUUID(),
      title: j.task.title,
      model: j.node?.model ?? settings.workerModel,
      state: "running",
      agent: j.node?.name,
    }));
    this.setState({ ...this.state, workers: statuses });

    const settle = (id: string, state: WorkerStatus["state"]) => {
      this.setState({
        ...this.state,
        workers: this.state.workers.map((w) => (w.id === id ? { ...w, state } : w)),
      });
    };

    const stage = (id: string, label: string | undefined) => {
      this.setState({
        ...this.state,
        workers: this.state.workers.map((w) => (w.id === id ? { ...w, stage: label } : w)),
      });
    };

    const results = await Promise.all(
      accepted.map(async (job, i) => {
        const id = statuses[i]!.id;
        const { task, node } = job;
        const heading = node ? `## ${task.title} — ${node.name}` : `## ${task.title}`;

        if (graph && !node) {
          settle(id, "failed");
          return (
            `${heading}\n\n(no teammate named "${job.unknownAgent}". Your team is: ` +
            `${roster.map((n) => n.name).join(", ")}. Re-send this task to one of them.)`
          );
        }

        try {
          const r = await runWorker(
            this.#config(),
            settings,
            task,
            ctx,
            workerToolsFor(this.#policy(), node?.model ?? settings.workerModel),
            node && graph ? { model: node.model, system: workerSystemFor(graph, node) } : null,
          );
          r.usage.forEach((u) => this.#recordUsage(u));

          const text =
            graph && node ? await this.#runStages(graph, node, task.title, r.text, (l) => stage(id, l)) : r.text;

          stage(id, undefined);
          settle(id, "done");
          return `${heading}\n\n${text}`;
        } catch (err) {
          settle(id, "failed");
          const msg = err instanceof Error ? err.message : String(err);
          return `${heading}\n\n(worker failed: ${msg})`;
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

  /**
   * Walk the review and handoff links hanging off one teammate's result.
   *
   * Reviews attach; handoffs replace. A node is reviewed by its own reviewers
   * before its output moves down the chain, so a critique always refers to the
   * text the critic actually read rather than to a later rewrite of it.
   *
   * `handoffChain` bounds the walk and drops cycles, so a graph drawn with a
   * loop in it costs a fixed number of calls rather than running until the room
   * runs out of money. A stage that throws is reported inline and does not take
   * the teammate's own work down with it — a failed reviewer should not lose the
   * research it was reviewing.
   */
  async #runStages(
    graph: WorkflowGraph,
    start: AgentNode,
    title: string,
    text: string,
    onStage: (label: string | undefined) => void,
  ): Promise<string> {
    const cfg = this.#config();
    const hops = [start, ...handoffChain(graph, start.id)];
    const critiques: string[] = [];
    let current = text;

    for (let i = 0; i < hops.length; i++) {
      const from = hops[i]!;
      const body = `Task: ${title}\n\nWork by ${from.name}:\n\n${current}`;

      for (const reviewer of reviewersOf(graph, from.id)) {
        const link = graph.edges.find(
          (e) => e.kind === "reviews" && e.from === from.id && e.to === reviewer.id,
        );
        onStage(`reviewed by ${reviewer.name}`);
        try {
          const out = await runStage(
            cfg,
            reviewer.model,
            stageSystemFor("reviews", reviewer, from, link ? promptOf(link) : ""),
            body,
          );
          this.#recordUsage(out.usage);
          if (out.text) critiques.push(`**${reviewer.name} on ${from.name}:** ${out.text}`);
        } catch (err) {
          critiques.push(
            `**${reviewer.name} on ${from.name}:** (review failed: ${
              err instanceof Error ? err.message : String(err)
            })`,
          );
        }
      }

      const next = hops[i + 1];
      if (!next) break;

      const link = graph.edges.find(
        (e) => e.kind === "handoff" && e.from === from.id && e.to === next.id,
      );
      onStage(`handed to ${next.name}`);
      try {
        const out = await runStage(
          cfg,
          next.model,
          stageSystemFor("handoff", next, from, link ? promptOf(link) : ""),
          body,
        );
        this.#recordUsage(out.usage);
        // An empty handoff keeps the upstream text rather than replacing good
        // work with nothing.
        if (out.text) current = out.text;
      } catch (err) {
        critiques.push(
          `**${next.name} handoff failed:** ${err instanceof Error ? err.message : String(err)} ` +
            `(you are seeing ${from.name}'s version)`,
        );
        break;
      }
    }

    return critiques.length ? `${current}\n\n**Review notes**\n\n${critiques.join("\n\n")}` : current;
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
    const firstAuthor = inbox.find((line) => typeof line.uid === "string");
    this.#setTurn({
      entryId: entry.id,
      carried: [],
      authorUid: firstAuthor?.uid,
      authorName: firstAuthor?.name,
    });
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
        const stored = this.#turn();
        if (!stored) return; // interrupted

        const entry = this.#getEntry(stored.entryId);
        if (!entry || entry.kind !== "agent") break;

        // Mark where this round begins before the model call that writes into
        // it. If this instance dies mid-stream, that mark is what tells the
        // resume how much of the entry belongs to an attempt nobody finished.
        const turn: Turn = { ...stored, blocks: entry.blocks.length, running: true };
        this.#setTurn(turn);

        // Map API content-block index -> index in the entry we render.
        const slots = new Map<number, number>();

        const conversation = repairToolConversation(this.#convo());
        if (conversation.repaired) this.#setConvo(conversation.messages);

        const graph = this.#activeGraph();
        const maxOutputTokens = stored.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
        const { message, usage } = await runModel(
          this.#config(),
          this.#settings(),
          graph,
          conversation.messages,
          toolsForRoom(
            this.#policy(),
            this.#settings().workflow,
            // Connected, not online: a relay that blinks must not change the
            // tool list, or the whole cached prefix is rebuilt with it. An
            // offline workspace answers through #fs instead.
            workspaceGrantsFileTools(this.state.workspace),
            graph ? leadOf(graph).model : this.#settings().agentModel,
            graph ?? undefined,
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
          maxOutputTokens,
        );

        this.#recordUsage(usage);

        const outputRecovery = outputLimitRecovery(
          message,
          stored.outputContinuations ?? 0,
          maxOutputTokens,
        );

        // A tool call cut off while its input is being generated cannot be
        // stored: Anthropic would require a tool_result immediately after it,
        // but there is no complete call to execute. Discard the streamed
        // attempt and retry the same round with a larger output allowance.
        if (outputRecovery.kind === "retry") {
          entry.blocks.length = turn.blocks ?? entry.blocks.length;
          this.#patch(entry);
          this.#setTurn({
            ...turn,
            outputContinuations: (stored.outputContinuations ?? 0) + 1,
            maxOutputTokens: outputRecovery.maxTokens,
          });
          continue;
        }

        // At the retry ceiling, an incomplete tool call is still unsafe to
        // persist. Remove it before ending the turn so the next user message
        // cannot inherit an orphaned tool_use block.
        if (outputRecovery.kind === "stop" && outputRecovery.discardResponse) {
          entry.blocks.length = turn.blocks ?? entry.blocks.length;
          this.#patch(entry);
          this.#system(
            `The agent reached its output limit repeatedly and stopped after ` +
              `${MAX_OUTPUT_CONTINUATIONS} automatic continuations.`,
          );
          break;
        }

        this.#setConvo([...this.#convo(), { role: "assistant", content: message.content }]);

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

        if (message.stop_reason === "max_tokens") {
          this.#patch(entry);
          if (outputRecovery.kind === "continue") {
            this.#setConvo([...this.#convo(), outputRecovery.message]);
            this.#setTurn({
              ...turn,
              outputContinuations: (stored.outputContinuations ?? 0) + 1,
              maxOutputTokens,
            });
            continue;
          }
          this.#system(
            `The agent reached its output limit repeatedly and stopped after ` +
              `${MAX_OUTPUT_CONTINUATIONS} automatic continuations.`,
          );
          break;
        }

        if (message.stop_reason !== "tool_use") {
          this.#patch(entry);
          break;
        }

        // ---- tool round ----
        const calls = message.content.filter((b) => b.type === "tool_use");
        const results: ToolResultBlockParam[] = uniqueToolResults([...turn.carried]);
        const handledCallIds = new Set<string>();
        const gated: PendingTool[] = [];
        const gatedNames = gatedFor(this.#policy());
        const docs = this.#docBuffer(turn.authorUid, turn.authorName);

        for (const call of calls) {
          if (handledCallIds.has(call.id)) continue;
          handledCallIds.add(call.id);
          entry.blocks.push({
            type: "tool",
            toolUseId: call.id,
            name: call.name,
            input: call.input,
            status: "running",
          });

          if (gatedNames.has(call.name)) {
            const sensitive = isFileContentTool(call.name);
            gated.push({
              toolUseId: call.id,
              name: call.name,
              input: call.input,
              summary: summarizeCall(call.name, call.input),
              votes: {},
              threshold: approvalThreshold(this.#policy().approval, this.#eligible(sensitive)),
              sensitive,
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
              call.name === "search_files" ||
              // Writes reach here only when the policy did NOT gate them — the
              // gated branch above catches those and parks them on a vote. In
              // auto-accept mode a write is ungated and must execute here; if
              // this listed only the read tools it would fall through to
              // execute(), which knows nothing about workspaces, and every
              // auto-mode write would come back as "Unknown tool".
              call.name === "write_file" ||
              call.name === "edit_file" ||
              call.name === "delete_file"
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
              block.sensitive = isFileContentTool(call.name);
            }
          }
        }
        docs.flush();
        this.#patch(entry);

        if (gated.length > 0) {
          // Park. The vote handler resumes from here.
          this.#setTurn({ ...turn, carried: results, running: false });
          this.setState({ ...this.state, status: "awaiting_approval", pending: gated });
          return;
        }

        this.#setConvo([...this.#convo(), { role: "user", content: uniqueToolResults(results) }]);
        this.#setTurn({ ...turn, carried: [] });
      }

      if (round >= MAX_ROUNDS) {
        this.#system(
          `The agent stopped after ${MAX_ROUNDS} model rounds without finishing. ` +
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
   * Pick up a turn that was running when the previous instance went away.
   *
   * A deploy replaces the code under every live room, and the runtime evicts
   * objects whenever it likes; either way the JavaScript running `#advance` is
   * gone. Storage survives — but nothing was scheduled to look at it, and
   * message intake only starts a turn when the room is idle (see `#onSay`), so
   * a room caught mid-response would sit at "thinking" forever with everything
   * anyone said afterwards piling up in the inbox.
   *
   * `onStart` runs on every wake of a fresh instance, which is exactly when
   * "the state says a turn is running" can only mean nobody is running it. The
   * work is handed to an alarm rather than done here: this runs before the
   * object will serve anything, and a model call is not something to hold that
   * open for. The alarm is also durable, so an interruption during the resume
   * gets the same treatment as the interruption that caused it.
   *
   * A turn parked on a vote is not this — it sits at "awaiting_approval" and is
   * resumed by the vote that decides it, whenever that arrives.
   */
  override async onStart(props?: Record<string, unknown>): Promise<void> {
    await super.onStart(props);
    this.#ready();
    const turn = this.#turn();
    // `running` rather than `state.status`: this is the object's first breath
    // and the room's own tables are the only thing certain to be readable yet.
    if (!turn?.running) return;
    // Keyed by the turn's entry so repeated wakes cannot stack up rows, and so
    // a row left over from an earlier turn is not mistaken for this one.
    await this.schedule(0, "resumeTurn", turn.entryId, { idempotent: true });
  }

  /**
   * The alarm body for the above. Public because the scheduler calls it by
   * name; nothing else should.
   */
  async resumeTurn(entryId: string): Promise<void> {
    this.#ready();
    // Both guards are for a schedule that fired late: the turn may have been
    // stopped, finished, or parked on a vote in the meantime, and a new turn
    // may have started that this row has nothing to do with.
    if (this.state.status !== "thinking") return;
    const turn = this.#turn();
    if (!turn || turn.entryId !== entryId) return;

    // Drop the abandoned round, whichever way this goes below. The conversation
    // the model sees was never told about it — `#advance` appends the assistant
    // message only once the call returns — so re-running the round is a clean
    // retry rather than a continuation, and the transcript has to match. If the
    // turn is being given up on instead, half a block is not something to leave
    // in the transcript for good.
    const entry = this.#getEntry(entryId);
    if (entry?.kind === "agent" && typeof turn.blocks === "number" && entry.blocks.length > turn.blocks) {
      entry.blocks.length = turn.blocks;
      this.#patch(entry);
    }

    const resumes = (turn.resumes ?? 0) + 1;
    if (resumes > MAX_RESUMES) {
      this.#system(
        `The agent turn was interrupted ${MAX_RESUMES} times and has been stopped. ` +
          "Say something to start it again.",
      );
      await this.#finishTurn();
      return;
    }

    this.#setTurn({ ...turn, resumes });
    // Said out loud: a reader watched text appear and then vanish, and is owed
    // the reason. It is also the only trace a deploy leaves in a room.
    this.#system("The agent was interrupted. Picking the turn back up.");
    await this.#advance();
  }

  /**
   * If every parked tool call has reached its threshold, apply the verdicts and
   * resume the turn. Called after any vote and after presence changes.
   */
  async #settleIfDecided() {
    if (this.#settling) return;
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

    this.#settling = true;
    try {
      const results: ToolResultBlockParam[] = uniqueToolResults([...turn.carried]);
      const docs = this.#docBuffer(turn.authorUid, turn.authorName);
      for (const { p, approved } of verdicts) {
        let outcome: ToolOutcome;
        if (!approved) {
          outcome = {
            ok: false,
            text:
              "The room voted against this action, so it did not run. Do not " +
              "retry the same call — ask the room what they would prefer.",
          };
        } else if (p.name === "write_file" || p.name === "edit_file" || p.name === "delete_file") {
          // These are workspace tools, not document tools: they have no
          // synchronous form, so approval resolves them with a round trip to
          // #fs (and, through it, the workspace host) rather than execute().
          const res = await this.#fs(this.#fsRequestFor(p.name, p.input));
          outcome = { ok: res.ok, text: res.ok ? res.data : res.error };
        } else {
          outcome = execute(p.name, p.input, docs);
        }

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
          block.sensitive = isFileContentTool(p.name);
        }
      }
      docs.flush();
      this.#patch(entry);

      this.#setConvo([...this.#convo(), { role: "user", content: uniqueToolResults(results) }]);
      this.#setTurn({ ...turn, carried: [] });
      this.setState({ ...this.state, status: "thinking", pending: [] });

      await this.#advance();
    } finally {
      this.#settling = false;
    }
  }
}
