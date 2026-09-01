/**
 * One Durable Object per signed-in account, holding that account's sidebar:
 * which rooms it knows about, what they are called, and how they are grouped.
 *
 * This is the reverse of the map a Room keeps. A Room knows its members; until
 * this object existed, nothing knew a member's rooms, so the sidebar could only
 * be whatever the browser in front of you happened to remember. That is why a
 * second browser signed into the same account showed nothing.
 *
 * It holds the account's saved workflows for the same reason: a library of
 * team designs is worth nothing if it stops at the edge of one browser. Those
 * rows are graphs, not bookmarks, so they are sanitized on the way in AND on
 * the way out — see #workflowRows.
 *
 * It holds one credential, and exactly one: the GitHub access token the person
 * authorised. That lives here rather than in a Room because it is the person's,
 * not the room's — see the `github` table below. Everything else in this object
 * is a bookmark, not a grant: membership still lives in the Room and is still
 * re-checked on every connect, so deleting a row here loses a way in, not a
 * right to be there.
 *
 * Addressed by uid, which is derived from (provider, account id) and is
 * therefore the same on every device the person signs in on — see `deriveUid`
 * in ./oauth.
 *
 * Only the Worker and other Durable Objects can reach a Durable Object, so
 * these are plain RPC methods with no internal-auth header of their own —
 * there is no route in or out of this class that a browser could address.
 */

import { DurableObject } from "cloudflare:workers";

import {
  SIDEBAR_MAX_PROJECTS,
  SIDEBAR_MAX_ROOMS,
  TOMBSTONE_TTL_MS,
  wins,
  type SidebarPush,
  type SidebarSnapshot,
  type SyncProject,
  type SyncRoom,
} from "../shared/sidebar";
import type { LibraryPush, LibrarySnapshot } from "../shared/library";
import {
  SKILL_LIMITS,
  sanitizeSkill,
  type SkillRef,
  type SkillsPush,
  type SkillsSnapshot,
} from "../shared/skills";
import { SAVED_LIMITS, sanitizeGraph, type SavedWorkflow } from "../shared/workflow";

type RoomRow = {
  room_id: string;
  label: string;
  project_id: string | null;
  archived: number;
  deleted: number;
  updated_at: number;
};

type ProjectRow = {
  id: string;
  name: string;
  archived: number;
  deleted: number;
  updated_at: number;
};

type WorkflowRow = {
  id: string;
  label: string;
  /** The graph as JSON. Re-parsed and re-sanitized on the way out. */
  graph: string;
  deleted: number;
  updated_at: number;
};

/**
 * One installed skill as stored.
 *
 * `source`, `allowed_tools` and `enabled_in` are JSON text, re-parsed and
 * re-sanitized on the way out rather than trusted — see #skillRows for why
 * that check runs twice.
 */
type SkillStorageRow = {
  id: string;
  name: string;
  description: string;
  allowed_tools: string;
  source: string;
  hash: string;
  enabled_in: string;
  deleted: number;
  updated_at: number;
};

type GithubRow = {
  token: string;
  login: string;
  github_id: string;
  installation_id: string;
  created_at: number;
};

/**
 * One account's GitHub authorisation, as the rooms see it.
 *
 * CARRIES A TOKEN. It is handed to a Room over the internal RPC channel and is
 * used there to talk to GitHub; it must never be put into RoomState, a
 * broadcast, a URL, or a log line. `GithubStatus` in ../shared/protocol is the
 * shape that is safe to publish, and it is deliberately a different type.
 */
export type GithubAccount = {
  token: string;
  /** The GitHub login, for display. */
  login: string;
  /** GitHub's own numeric account id — public, and the only thing that can prove an App installation belongs to this person. */
  githubId: string;
  /** The GitHub App installation this account has, or "" if none is known. */
  installationId: string;
};

export class UserIndex extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // `deleted` is a tombstone rather than a real delete: see the note on
    // deletes in ../shared/sidebar. A row's absence has to mean "this browser
    // never heard of it", so removal needs a positive record of its own.
    this.#sql(`CREATE TABLE IF NOT EXISTS rooms (
      room_id    TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      project_id TEXT,
      archived   INTEGER NOT NULL DEFAULT 0,
      deleted    INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`);
    this.#sql(`CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      archived   INTEGER NOT NULL DEFAULT 0,
      deleted    INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`);
    // `updated_at` is the workflow's own `savedAt`: a save is the only thing
    // that changes a row, so the stamp the person's machine wrote is exactly
    // the stamp the merge needs. No second clock to keep in step.
    this.#sql(`CREATE TABLE IF NOT EXISTS workflows (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      graph      TEXT NOT NULL,
      deleted    INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`);
    // The account's skills library. `updated_at` is the ref's own `addedAt`,
    // the same trick as workflows above: installing is the only thing that
    // writes a row, so the stamp the person's machine wrote is exactly the
    // stamp the merge needs, and there is no second clock to keep in step.
    //
    // `enabled_in` is a JSON array of room ids and is the one column that is
    // not about this account alone — it is what puts a skill in front of a
    // shared agent. It still lives here rather than in the Room because the
    // library is the person's; the Room re-checks the vote before acting on
    // it, exactly as it re-checks membership.
    this.#sql(`CREATE TABLE IF NOT EXISTS skills (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL,
      allowed_tools TEXT NOT NULL DEFAULT '[]',
      source        TEXT NOT NULL,
      hash          TEXT NOT NULL,
      enabled_in    TEXT NOT NULL DEFAULT '[]',
      deleted       INTEGER NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL
    )`);
    // Skill text, keyed by its own digest and therefore stored once however
    // many refs point at it. Two people installing the same skill, or one
    // person updating to a new commit and back, cost one row each rather than
    // one per install. Bodies are deliberately not in the `skills` table: a
    // ref syncs on every push and a body is tens of kilobytes of third-party
    // Markdown the client never needs — only the agent does, and it asks for
    // it by hash at the moment it loads the skill.
    this.#sql(`CREATE TABLE IF NOT EXISTS skill_bodies (
      hash       TEXT PRIMARY KEY,
      body       TEXT NOT NULL,
      bytes      INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // The account's GitHub authorisation, and the one long-lived credential
    // this app stores. It is here rather than in each Room because it is the
    // person's authorisation, not the room's: they authorised once, and a
    // second room is not a second decision. Rooms keep only a pointer to the
    // member who authorised — see github_oauth in ./room — and ask for the
    // token at the moment they need it, so signing out here is what signs out
    // everywhere, and disconnecting a workspace touches none of it.
    //
    // Single-row, keyed 'current', because an account has one GitHub account
    // connected at a time; connecting another replaces it.
    this.#sql(`CREATE TABLE IF NOT EXISTS github (
      k               TEXT PRIMARY KEY,
      token           TEXT NOT NULL,
      login           TEXT NOT NULL DEFAULT '',
      github_id       TEXT NOT NULL DEFAULT '',
      installation_id TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL
    )`);
  }

  #sql<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...(bindings as SqlStorageValue[])).toArray();
  }

  /**
   * Merge one browser's view of the sidebar and hand back the account's.
   *
   * The response is the whole live sidebar, not just what changed: the caller
   * pushed what it knew and needs to learn what it did not, and a browser that
   * has been away for a week owes no ordering to catch up.
   */
  sync(push: SidebarPush): SidebarSnapshot {
    const now = Date.now();

    // Deletes first, so a push that both carries a room and deletes it (a
    // stale list plus a fresh removal, which is exactly what a delete looks
    // like from the browser that made it) ends deleted rather than racing.
    for (const roomId of push.deletedRooms) {
      this.#sql(
        `INSERT INTO rooms (room_id, label, project_id, archived, deleted, updated_at)
         VALUES (?, '', NULL, 0, 1, ?)
         ON CONFLICT(room_id) DO UPDATE SET deleted = 1, updated_at = ?`,
        roomId,
        now,
        now,
      );
    }
    for (const projectId of push.deletedProjects) {
      this.#sql(
        `INSERT INTO projects (id, name, archived, deleted, updated_at)
         VALUES (?, '', 0, 1, ?)
         ON CONFLICT(id) DO UPDATE SET deleted = 1, updated_at = ?`,
        projectId,
        now,
        now,
      );
    }
    const deletedRooms = new Set(push.deletedRooms);
    const deletedProjects = new Set(push.deletedProjects);

    const storedRooms = new Map(
      this.#sql<RoomRow>(`SELECT * FROM rooms`).map((row) => [row.room_id, row] as const),
    );
    const storedProjects = new Map(
      this.#sql<ProjectRow>(`SELECT * FROM projects`).map((row) => [row.id, row] as const),
    );

    let liveRooms = [...storedRooms.values()].filter((row) => row.deleted === 0).length;
    let liveProjects = [...storedProjects.values()].filter((row) => row.deleted === 0).length;

    for (const project of push.projects) {
      if (deletedProjects.has(project.id)) continue;
      const stored = storedProjects.get(project.id);
      if (stored && !wins(project.updatedAt, stored.updated_at)) continue;
      // The cap refuses new rows only. An account already at the ceiling can
      // still rename and archive what it has — a full sidebar should be
      // unable to grow, not frozen.
      if (!stored && liveProjects >= SIDEBAR_MAX_PROJECTS) continue;
      if (!stored) liveProjects++;
      this.#sql(
        `INSERT INTO projects (id, name, archived, deleted, updated_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           archived = excluded.archived,
           deleted = 0,
           updated_at = excluded.updated_at`,
        project.id,
        project.name,
        project.archived ? 1 : 0,
        project.updatedAt,
      );
    }

    for (const room of push.rooms) {
      if (deletedRooms.has(room.roomId)) continue;
      const stored = storedRooms.get(room.roomId);
      if (stored && !wins(room.updatedAt, stored.updated_at)) continue;
      if (!stored && liveRooms >= SIDEBAR_MAX_ROOMS) continue;
      if (!stored) liveRooms++;
      this.#sql(
        `INSERT INTO rooms (room_id, label, project_id, archived, deleted, updated_at)
         VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(room_id) DO UPDATE SET
           label = excluded.label,
           project_id = excluded.project_id,
           archived = excluded.archived,
           deleted = 0,
           updated_at = excluded.updated_at`,
        room.roomId,
        room.label,
        room.projectId,
        room.archived ? 1 : 0,
        room.updatedAt,
      );
    }

    this.#sweep(now);
    return this.snapshot();
  }

  /**
   * Record a room the account has just created or been admitted to.
   *
   * Called by the Worker rather than by the browser, so a room joined from an
   * invite link is in the sidebar on every device before the browser that
   * joined has said anything about it — and stays there even if that browser
   * closes on the spot.
   *
   * A row that already exists is left exactly as it is: the label here is the
   * room's own title, and it must never overwrite the name the person chose
   * for the room in their sidebar. A tombstoned row does come back, because
   * arriving in a room you had removed is a deliberate act of re-joining it.
   */
  remember(roomId: string, label: string): void {
    const now = Date.now();
    const stored = this.#sql<RoomRow>(`SELECT * FROM rooms WHERE room_id = ?`, roomId)[0];
    if (stored && stored.deleted === 0) return;
    const live = this.#sql<{ n: number }>(`SELECT COUNT(*) AS n FROM rooms WHERE deleted = 0`)[0]?.n ?? 0;
    if (!stored && live >= SIDEBAR_MAX_ROOMS) return;
    this.#sql(
      `INSERT INTO rooms (room_id, label, project_id, archived, deleted, updated_at)
       VALUES (?, ?, NULL, 0, 0, ?)
       ON CONFLICT(room_id) DO UPDATE SET
         label = excluded.label,
         archived = 0,
         deleted = 0,
         updated_at = excluded.updated_at`,
      roomId,
      label,
      now,
    );
  }

  /** The account's live sidebar — tombstones excluded, they are bookkeeping. */
  snapshot(): SidebarSnapshot {
    const rooms: SyncRoom[] = this.#sql<RoomRow>(
      `SELECT * FROM rooms WHERE deleted = 0 ORDER BY updated_at ASC`,
    ).map((row) => ({
      roomId: row.room_id,
      label: row.label,
      projectId: row.project_id,
      archived: row.archived === 1,
      updatedAt: row.updated_at,
    }));
    const projects: SyncProject[] = this.#sql<ProjectRow>(
      `SELECT * FROM projects WHERE deleted = 0 ORDER BY updated_at ASC`,
    ).map((row) => ({
      id: row.id,
      name: row.name,
      archived: row.archived === 1,
      updatedAt: row.updated_at,
    }));
    return { rooms, projects };
  }

  /* ------------------------------------------------------ saved workflows */

  /**
   * Merge one browser's workflow library and hand back the account's.
   *
   * Deliberately a second method rather than a second field on `sync`: the
   * library is edited in the workflow designer, deep inside a room, while the
   * sidebar is edited in the shell around it. One request carrying both would
   * make every rename of a room re-push every graph the account owns.
   */
  syncWorkflows(push: LibraryPush): LibrarySnapshot {
    const now = Date.now();

    // Deletes first, for the same reason as the sidebar's: a push that both
    // carries a workflow and deletes it is what a delete looks like from the
    // browser that made it, and it must end deleted rather than racing.
    for (const id of push.deleted) {
      this.#sql(
        `INSERT INTO workflows (id, label, graph, deleted, updated_at)
         VALUES (?, '', '', 1, ?)
         ON CONFLICT(id) DO UPDATE SET deleted = 1, updated_at = ?`,
        id,
        now,
        now,
      );
    }
    const deleted = new Set(push.deleted);

    const stored = new Map(
      this.#sql<WorkflowRow>(`SELECT * FROM workflows`).map((row) => [row.id, row] as const),
    );
    let live = [...stored.values()].filter((row) => row.deleted === 0).length;

    for (const workflow of push.workflows) {
      if (deleted.has(workflow.id)) continue;
      const row = stored.get(workflow.id);
      if (row && !wins(workflow.savedAt, row.updated_at)) continue;
      // The cap refuses new rows only, exactly as the sidebar's does. A full
      // library should be unable to grow, not unable to be corrected — and a
      // cap that dropped the oldest row instead would mean two machines both
      // at the ceiling silently eating each other's saved work.
      if (!row && live >= SAVED_LIMITS.count) continue;
      if (!row) live++;
      this.#sql(
        `INSERT INTO workflows (id, label, graph, deleted, updated_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           graph = excluded.graph,
           deleted = 0,
           updated_at = excluded.updated_at`,
        workflow.id,
        workflow.label,
        JSON.stringify(workflow.graph),
        workflow.savedAt,
      );
    }

    this.#sweep(now);
    return { workflows: this.#workflowRows() };
  }

  /** The account's live library, newest save first. */
  workflows(): LibrarySnapshot {
    return { workflows: this.#workflowRows() };
  }

  /**
   * Stored rows as graphs again.
   *
   * Every row is re-sanitized on the way out, not only on the way in. The
   * cheap reason is that a row may have been written by an older version of
   * `sanitizeGraph` than the one that will run it; the real one is that this
   * hands a graph to a room, and a graph that reaches a room without passing
   * the sanitizer is the one thing this file must never produce. A row whose
   * JSON will not parse is dropped rather than repaired into a guess.
   */
  #workflowRows(): SavedWorkflow[] {
    const out: SavedWorkflow[] = [];
    for (const row of this.#sql<WorkflowRow>(
      `SELECT * FROM workflows WHERE deleted = 0 ORDER BY updated_at DESC`,
    )) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.graph);
      } catch {
        continue;
      }
      out.push({
        id: row.id,
        label: row.label,
        savedAt: row.updated_at,
        graph: sanitizeGraph(parsed),
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------- skills */

  /**
   * Merge one browser's skills library and hand back the account's.
   *
   * Structurally the same as `syncWorkflows`, and deliberately so: it is the
   * same problem — two browsers, one account, no coordination — and a second
   * merge rule invented for skills would be a second thing to get wrong.
   *
   * A third method rather than a field on either of the others, for the reason
   * given above `syncWorkflows`: these are edited in different places at
   * different times, and folding them into one request would make every
   * install re-push every graph the account owns.
   */
  syncSkills(push: SkillsPush): SkillsSnapshot {
    const now = Date.now();

    // Deletes first, so a push that both carries a skill and deletes it — what
    // a removal looks like from the browser that made it — ends deleted rather
    // than racing.
    for (const id of push.deleted) {
      this.#sql(
        `INSERT INTO skills (id, name, description, allowed_tools, source, hash, enabled_in, deleted, updated_at)
         VALUES (?, '', '', '[]', '', '', '[]', 1, ?)
         ON CONFLICT(id) DO UPDATE SET deleted = 1, enabled_in = '[]', updated_at = ?`,
        id,
        now,
        now,
      );
    }
    const deleted = new Set(push.deleted);

    const stored = new Map(
      this.#sql<SkillStorageRow>(`SELECT * FROM skills`).map((row) => [row.id, row] as const),
    );
    let live = [...stored.values()].filter((row) => row.deleted === 0).length;

    for (const skill of push.skills) {
      if (deleted.has(skill.id)) continue;
      const row = stored.get(skill.id);
      if (row && !wins(skill.addedAt, row.updated_at)) continue;
      // Refuses new rows only, as everywhere else here: a full library should
      // be unable to grow, not unable to be corrected.
      if (!row && live >= SKILL_LIMITS.count) continue;
      if (!row) live++;
      this.#sql(
        `INSERT INTO skills (id, name, description, allowed_tools, source, hash, enabled_in, deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           allowed_tools = excluded.allowed_tools,
           source = excluded.source,
           hash = excluded.hash,
           enabled_in = excluded.enabled_in,
           deleted = 0,
           updated_at = excluded.updated_at`,
        skill.id,
        skill.name,
        skill.description,
        JSON.stringify(skill.allowedTools),
        JSON.stringify(skill.source),
        skill.hash,
        JSON.stringify(skill.enabledIn),
        skill.addedAt,
      );
    }

    this.#sweep(now);
    return { skills: this.#skillRows() };
  }

  /** The account's live skills library, newest install first. */
  skills(): SkillsSnapshot {
    return { skills: this.#skillRows() };
  }

  /**
   * Stored rows as refs again.
   *
   * Re-sanitized on the way out, not only on the way in, and for a sharper
   * reason than the workflow library's. A row here carries a name and a
   * description written by somebody outside this codebase, and those strings
   * end up in the agent's system prompt. A row that reaches a prompt without
   * passing the sanitizer is the one thing this section must never produce, so
   * the check runs again at the point of use — where an older writer, a
   * migrated row, or a hand-edited database cannot get around it. A row whose
   * JSON will not parse, or that no longer sanitizes, is dropped rather than
   * repaired into a guess.
   */
  #skillRows(): SkillRef[] {
    const now = Date.now();
    const out: SkillRef[] = [];
    for (const row of this.#sql<SkillStorageRow>(
      `SELECT * FROM skills WHERE deleted = 0 ORDER BY updated_at DESC`,
    )) {
      let source: unknown;
      let allowedTools: unknown;
      let enabledIn: unknown;
      try {
        source = JSON.parse(row.source);
        allowedTools = JSON.parse(row.allowed_tools);
        enabledIn = JSON.parse(row.enabled_in);
      } catch {
        continue;
      }
      const clean = sanitizeSkill(
        {
          id: row.id,
          name: row.name,
          description: row.description,
          allowedTools,
          source,
          hash: row.hash,
          addedAt: row.updated_at,
          enabledIn,
        },
        now,
      );
      if (clean) out.push(clean);
    }
    return out;
  }

  /**
   * Store the text of a skill under its digest.
   *
   * Idempotent, because the key is the content: writing the same body twice is
   * the same row. The caller is whoever fetched it — see the GitHub install
   * path — and is responsible for having computed the hash from this exact
   * string; a mismatch here would mean a ref pointing at text it never
   * described, so the digest is not recomputed, it is required to be right by
   * construction at the one place bodies are created.
   */
  putSkillBody(hash: string, body: string): void {
    if (!/^[0-9a-f]{64}$/.test(hash)) return;
    if (body.length === 0 || body.length > SKILL_LIMITS.bodyBytes) return;
    this.#sql(
      `INSERT INTO skill_bodies (hash, body, bytes, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(hash) DO NOTHING`,
      hash,
      body,
      body.length,
      Date.now(),
    );
  }

  /** The text of a skill, or null if it was never stored or has been swept. */
  skillBody(hash: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    return this.#sql<{ body: string }>(`SELECT body FROM skill_bodies WHERE hash = ?`, hash)[0]?.body ?? null;
  }

  /* -------------------------------------------------- github authorisation */

  /**
   * The account's GitHub authorisation, token included, or null if there is
   * none.
   *
   * Called by a Room over the internal RPC channel every time it needs to talk
   * to GitHub on this person's behalf, rather than at connect time into a copy
   * the room then keeps. One store, read live, is what makes `forgetGithub`
   * below a real sign-out instead of a sign-out from whichever room happened to
   * be open.
   */
  githubAccount(): GithubAccount | null {
    const row = this.#sql<GithubRow>(`SELECT * FROM github WHERE k = 'current'`)[0];
    if (!row || row.token.length === 0) return null;
    return {
      token: row.token,
      login: row.login,
      githubId: row.github_id,
      installationId: row.installation_id,
    };
  }

  /**
   * Record the token GitHub just issued.
   *
   * The installation id is deliberately left alone: authorising again — after
   * a token expires, or to widen a scope — is not a reason to forget which App
   * installation this account has. Authorising as a *different* GitHub account
   * is, and that arrives as `forgetGithub` first, because changing accounts is
   * a sign-out followed by a sign-in.
   */
  rememberGithub(account: { token: string; login: string; githubId: string }): void {
    if (account.token.length === 0) return;
    this.#sql(
      `INSERT INTO github (k, token, login, github_id, installation_id, created_at)
       VALUES ('current', ?, ?, ?, '', ?)
       ON CONFLICT(k) DO UPDATE SET
         token = excluded.token,
         login = excluded.login,
         github_id = excluded.github_id,
         created_at = excluded.created_at`,
      account.token,
      account.login,
      account.githubId,
      Date.now(),
    );
  }

  /**
   * Record which GitHub App installation this account has.
   *
   * Only ever an update: an installation is claimed by proving it against the
   * token stored above (see /github-installed in ./room), so a row that is not
   * here yet means there was no authorisation to prove it with, and writing one
   * would be inventing an account that never authorised.
   */
  rememberGithubInstallation(installationId: string): void {
    this.#sql(`UPDATE github SET installation_id = ? WHERE k = 'current'`, installationId);
  }

  /**
   * Forget the account's GitHub authorisation entirely.
   *
   * This is the explicit sign-out, and the only thing that ends the
   * authorisation. Every room that pointed at it reads null from
   * `githubAccount` the next time it asks, which is what makes one sign-out
   * reach all of them.
   */
  forgetGithub(): void {
    this.#sql(`DELETE FROM github WHERE k = 'current'`);
  }

  /**
   * Drop delete markers old enough that no browser could still be carrying the
   * row they suppress. A tombstone only has to outlive the stalest plausible
   * copy of the sidebar; keeping them forever would grow this object for every
   * room the account ever removed.
   */
  #sweep(now: number): void {
    const cutoff = now - TOMBSTONE_TTL_MS;
    this.#sql(`DELETE FROM rooms WHERE deleted = 1 AND updated_at < ?`, cutoff);
    this.#sql(`DELETE FROM projects WHERE deleted = 1 AND updated_at < ?`, cutoff);
    this.#sql(`DELETE FROM workflows WHERE deleted = 1 AND updated_at < ?`, cutoff);
    this.#sql(`DELETE FROM skills WHERE deleted = 1 AND updated_at < ?`, cutoff);
    // Bodies are keyed by content and shared between refs, so one cannot be
    // dropped with the row that removed it — another ref may still point at the
    // same hash. Sweeping by "nothing live references this" is the only correct
    // rule, and it runs here rather than on delete so a body outlives a
    // tombstone that might still be reversed by a merge.
    this.#sql(
      `DELETE FROM skill_bodies
        WHERE hash NOT IN (SELECT hash FROM skills WHERE deleted = 0)`,
    );
  }
}
