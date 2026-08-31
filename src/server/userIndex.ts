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
 * Addressed by uid, which is derived from (provider, account id) and is
 * therefore the same on every device the person signs in on — see `deriveUid`
 * in ./oauth. Nothing here is a credential: membership still lives in the Room
 * and is still re-checked on every connect, so a row in this object is a
 * bookmark, not a grant. Deleting one loses a way in, not a right to be there.
 *
 * Only the Worker can reach a Durable Object, so these are plain RPC methods
 * with no internal-auth header of their own — there is no route in or out of
 * this class that a browser could address.
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
  }
}
