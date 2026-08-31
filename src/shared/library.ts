/**
 * The workflow library as something the account owns, rather than something
 * one browser remembers.
 *
 * Saved workflows started out in `localStorage`, next to the sidebar's room
 * list, and had the same flaw for the same reason: signing in on a second
 * machine produced an empty library, because nothing anywhere mapped a uid to
 * the graphs that person had drawn. This module is the shape of that mapping,
 * shared by the client that pushes it and the `UserIndex` Durable Object that
 * keeps it — the same object, the same merge rule and the same tombstones as
 * ../shared/sidebar, because it is the same problem one shape further on.
 *
 * Everything here is pure and total. Per-row last-write-wins on `savedAt`,
 * which is the stamp a save writes, so "the version I saved last" is the
 * version that survives — on either machine, in either order.
 *
 * Deletes are tombstones, not missing rows, for the reason spelled out in
 * ../shared/sidebar: a snapshot from a browser that has been offline is
 * evidence of what that browser last saw, never evidence that a workflow was
 * deleted. Only an explicit delete removes one.
 *
 * Two rules are specific to this library and worth stating out loud:
 *
 *   - A name identifies a workflow. Two machines that saved different graphs
 *     under one name have not made two workflows, they have made a conflict,
 *     and the later save wins it — the same rule as saving over a name on one
 *     machine. The shadowed row is filtered, never tombstoned: this is a merge
 *     resolving a display, and a merge must not delete anybody's work.
 *   - The cap is a ceiling on new rows, not a truncation of stored ones, so a
 *     full library stops growing rather than quietly shedding its oldest.
 */

import { wins } from "./sidebar";
import { SAVED_LIMITS, sanitizeSavedWorkflows, type SavedWorkflow } from "./workflow";

/** What the account holds. Ordered newest save first, as the picker shows it. */
export type LibrarySnapshot = { workflows: SavedWorkflow[] };

/**
 * One browser's whole library, plus the removals it wants applied. Sent whole
 * rather than as a diff, for the reason given in ../shared/sidebar.
 */
export type LibraryPush = LibrarySnapshot & { deleted: string[] };

export type LibrarySyncRequest = LibraryPush & { identity: string };
export type LibrarySyncResponse = LibrarySnapshot;

/**
 * Clamp a client-supplied stamp into the past.
 *
 * Same reasoning as the sidebar's: a browser with a fast clock would otherwise
 * pin a row into the future and win every merge for as long as the skew lasts.
 * Anything ahead of the server's clock becomes "just now", which is the truth
 * about when the push arrived.
 */
function stamp(value: unknown, now: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return now;
  return Math.min(Math.floor(value), now);
}

/** Ids are minted by `newWorkflowId`; this only bounds what will be stored. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Reduce anything that arrived over the wire to a push that is safe to merge.
 *
 * `sanitizeSavedWorkflows` does the load-bearing part — every graph in here
 * has been through `sanitizeGraph`, so a row this Durable Object stores can
 * never be a graph a room would have refused, however it was pushed.
 */
export function sanitizeLibraryPush(value: unknown, now: number): LibraryPush {
  const rec = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const workflows = sanitizeSavedWorkflows(rec.workflows).map((w) => ({
    ...w,
    savedAt: stamp(w.savedAt, now),
  }));
  const deleted = Array.isArray(rec.deleted)
    ? rec.deleted
        .filter((id): id is string => typeof id === "string" && ID_RE.test(id))
        .slice(0, SAVED_LIMITS.count)
    : [];
  return { workflows, deleted };
}

/**
 * The deletes this browser still owes the account.
 *
 * Kept as its own list, and persisted with the library, because a delete is
 * the one intent absence cannot carry: a browser that removed a workflow and
 * was closed before the request landed looks exactly like a browser that never
 * had it, and the row would come back on the next pull.
 *
 * An id that is present in `kept` is dropped from the list. That is the rule
 * that stops a stale tombstone eating live work: if a workflow with that id is
 * in the library again — it came back from another machine and was saved over,
 * or the same entry was updated — then it is not deleted, whatever this
 * browser meant a moment ago.
 */
export function rememberDeletes(
  pending: readonly string[],
  removed: readonly string[],
  kept: readonly SavedWorkflow[],
): string[] {
  const live = new Set(kept.map((w) => w.id));
  const out: string[] = [];
  for (const id of [...pending, ...removed]) {
    if (!ID_RE.test(id) || live.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out.slice(-SAVED_LIMITS.count);
}

/** Drop the deletes a sync has just carried, keeping any made since it left. */
export function settleDeletes(pending: readonly string[], sent: readonly string[]): string[] {
  const done = new Set(sent);
  return pending.filter((id) => !done.has(id));
}

/**
 * What this browser should hold, given what the account just returned.
 *
 * The account is authoritative about what exists and what it is called, but
 * only about what it has actually been told, and only where this browser does
 * not hold a later save. `sent` is what the request that produced `remote`
 * carried, which is how a row's absence is read: sent and not returned means
 * deleted somewhere else, never sent means the account has not heard of it yet
 * — a workflow saved a second ago, while the response was already in the air.
 *
 * The result is sorted newest save first and re-sanitized, which is where the
 * name rule lands: after sorting, the older of two rows sharing a name is the
 * duplicate `sanitizeSavedWorkflows` drops.
 */
export function mergeLibrary(
  remote: SavedWorkflow[],
  local: SavedWorkflow[],
  sent: ReadonlySet<string>,
): SavedWorkflow[] {
  const byId = new Map(local.map((w) => [w.id, w] as const));
  const returned = new Set(remote.map((w) => w.id));

  const merged: SavedWorkflow[] = remote.map((r) => {
    const mine = byId.get(r.id);
    // Ties go to the account, not to this browser: an equal stamp means the
    // same millisecond, and the row that made the round trip is the one both
    // ends already agree on.
    return mine && wins(mine.savedAt, r.savedAt) && mine.savedAt !== r.savedAt ? mine : r;
  });
  for (const mine of local) {
    if (returned.has(mine.id) || sent.has(mine.id)) continue;
    merged.push(mine);
  }

  merged.sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id));
  return sanitizeSavedWorkflows(merged);
}
