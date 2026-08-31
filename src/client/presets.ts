/**
 * The workflow library: the graphs this person keeps, across every room and
 * now across every machine they sign in on.
 *
 * A room's graph belongs to the room — it is in `RoomState`, everyone in the
 * room sees it, and changing it changes what answers them. A library is the
 * other thing: the shapes someone built and wants again, so the next room can
 * start from one instead of being drawn from scratch.
 *
 * Storage is two-layered, and the order matters:
 *
 *   - `localStorage` is the copy on this machine. It is what the panel renders
 *     the instant it opens, it is what a signed-out deployment has always had,
 *     and it is what survives being offline.
 *   - The account's `UserIndex` Durable Object is the copy that follows the
 *     person. Every change is pushed there and the merged result is adopted
 *     back — see /api/workflows and ../shared/library for the merge rule.
 *
 * Nothing blocks on the network. A save is written locally and published to
 * the UI first, then synced; a failed sync loses the round trip, never the
 * save. Deletes are held until a sync actually succeeds and are stored beside
 * the library while they wait — a delete that fails to send would otherwise be
 * undone by the next reply, and closing the tab before it landed would bring
 * the workflow back. See `rememberDeletes` for what stops a stale one from
 * eating a workflow that has since come back to life.
 *
 * Everything read back — from storage or from the account — is re-sanitized.
 * Neither is a trust boundary: local storage survives across versions and is
 * editable by hand, and a graph that reaches a room without passing
 * `sanitizeGraph` is exactly what that function exists to prevent.
 */

import { identityUid, storedIdentity } from "./identity";
import {
  mergeLibrary,
  rememberDeletes,
  settleDeletes,
  type LibraryPush,
  type LibrarySyncRequest,
  type LibrarySyncResponse,
} from "../shared/library";
import { sanitizeSavedWorkflows, type SavedWorkflow } from "../shared/workflow";

const LIBRARY_KEY = "collab_ai:workflows";
/**
 * Which account the local copy belongs to.
 *
 * Signing out deliberately leaves this browser's data in place — see App's
 * signOut — so on a shared machine the next person to sign in would otherwise
 * push the previous one's saved workflows straight into their own account.
 * The local copy is a cache of one account's library, and a cache for the
 * wrong account is dropped rather than merged.
 */
const OWNER_KEY = "collab_ai:workflows:owner";
/** Deletes made here that the account has not accepted yet. */
const DELETES_KEY = "collab_ai:workflows:deleted";

/** How long the library settles before a change is pushed to the account. */
const SYNC_DEBOUNCE_MS = 600;

type Listener = (library: SavedWorkflow[]) => void;

let cache: SavedWorkflow[] | null = null;
const listeners = new Set<Listener>();

/**
 * Deletes that have not yet been accepted by the account. Held rather than
 * sent-and-forgotten: absence never deletes anything, so a delete only takes
 * effect when it is said out loud and heard.
 *
 * Outlives the tab, because the window between removing a workflow and the
 * push landing is exactly where a delete gets lost — offline, a closed laptop,
 * a failed request — and a delete that is lost does not stay lost quietly, it
 * puts the workflow back.
 */
let pendingDeletes: string[] = [];
let deletesLoaded = false;

/** The last body sent, so a change that is not a change costs nothing. */
let pushed: string | null = null;
/**
 * What the request in flight carried, which is how a reply that omits a row is
 * read: sent and not returned means deleted on another machine, never sent
 * means the account has not heard of it yet.
 */
let sent = new Set<string>();
/** Syncs run one at a time; two in flight could return in either order. */
let queue: Promise<void> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | null = null;

/* ------------------------------------------------------------ local copy */

function readStore(): SavedWorkflow[] {
  try {
    return sanitizeSavedWorkflows(JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "[]"));
  } catch {
    // Unparseable storage is an empty library, never an error someone has to
    // clear before the workflow screen will open.
    return [];
  }
}

function writeStore(library: SavedWorkflow[]): void {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
  } catch {
    // A full or blocked store loses the local copy, not the session — and not
    // the account's copy, which the sync below is on its way to update.
  }
}

function readDeletes(): string[] {
  if (!deletesLoaded) {
    deletesLoaded = true;
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(DELETES_KEY) ?? "[]");
      pendingDeletes = rememberDeletes(
        Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [],
        [],
        [],
      );
    } catch {
      pendingDeletes = [];
    }
  }
  return pendingDeletes;
}

function writeDeletes(next: string[]): void {
  pendingDeletes = next;
  deletesLoaded = true;
  try {
    localStorage.setItem(DELETES_KEY, JSON.stringify(next));
  } catch {
    // Same reasoning as writeStore: the in-memory list still carries this
    // session's deletes, and losing the durable copy costs one reload.
  }
}

function publish(next: SavedWorkflow[]): void {
  cache = next;
  writeStore(next);
  for (const fn of listeners) fn(next);
}

/* --------------------------------------------------------------- reading */

export function getLibrary(): SavedWorkflow[] {
  if (!cache) cache = readStore();
  return cache;
}

/**
 * Watch the library — for saves made here, and for saves made in this
 * browser's other tabs.
 *
 * `storage` fires in every tab but the one that wrote, which is the case this
 * exists for: saving a workflow in one room and reaching for it in the room
 * open next door. The writing tab is already pushing that change to the
 * account, so this side only adopts it.
 */
export function subscribeLibrary(fn: Listener): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== LIBRARY_KEY) return;
    cache = readStore();
    for (const listener of listeners) listener(cache);
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

/* --------------------------------------------------------------- writing */

/**
 * Replace the library, and say which ids are being removed.
 *
 * `deleted` is not derivable from the difference between the two lists: a row
 * this browser never had is missing for a reason that has nothing to do with
 * deletion, which is the whole point of the tombstone rule.
 */
export function setLibrary(next: SavedWorkflow[], deleted: string[] = []): void {
  const library = sanitizeSavedWorkflows(next);
  // `library` rather than `next`, so an id that survived sanitizing is what
  // counts as still alive — and a row that is back in the library is not
  // deleted, however recently this browser said otherwise.
  writeDeletes(rememberDeletes(readDeletes(), deleted, library));
  publish(library);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncLibrary();
  }, SYNC_DEBOUNCE_MS);
}

/** A fresh library id. Local bookkeeping until the account hears about it. */
export function newWorkflowId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/* ------------------------------------------------------------------ sync */

/**
 * Forget a library cached for somebody else.
 *
 * A library saved while signed out has no owner recorded and belongs to
 * whoever signs in next — carrying it up is the point of syncing at all. A
 * library that was last synced as another account is a different matter, and
 * is dropped before anything can be pushed under the new one's name.
 */
function claimCache(uid: string | null): void {
  let owner: string | null = null;
  try {
    owner = localStorage.getItem(OWNER_KEY);
  } catch {
    // Unreadable storage: treat the cache as unowned rather than refusing to
    // sync. The merge below is safe either way.
  }
  if (owner && owner !== uid) {
    writeDeletes([]);
    pushed = null;
    publish([]);
  }
  try {
    if (uid) localStorage.setItem(OWNER_KEY, uid);
  } catch {
    // Same reasoning as writeStore: losing the marker costs a merge, not data.
  }
}

/**
 * Push this browser's library to the account and adopt what comes back.
 *
 * Call it with `force` when opening the workflow screen: that is the moment
 * someone is about to reach for a workflow they may have saved on another
 * machine, and it is the only moment worth spending a request on for a library
 * that has not changed.
 */
export function syncLibrary(options?: { force?: boolean }): Promise<void> {
  const run = async () => {
    const identity = storedIdentity();
    // No identity, no account to sync with: a deployment with sign-in off
    // keeps exactly the browser-local library it has always had.
    if (!identity) return;
    claimCache(identityUid());

    const workflows = getLibrary();
    const deleted = [...readDeletes()];
    const push: LibraryPush = { workflows, deleted };
    const body = JSON.stringify(push);
    if (!options?.force && deleted.length === 0 && body === pushed) return;

    pushed = body;
    sent = new Set(workflows.map((w) => w.id));

    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity, ...push } satisfies LibrarySyncRequest),
      });
      // Nothing is surfaced on failure and nothing local is thrown away. The
      // library someone is looking at still works offline, and a banner about
      // a background sync would be noise about a problem they cannot act on.
      if (!res.ok) {
        pushed = null;
        return;
      }
      const remote = (await res.json()) as LibrarySyncResponse;
      const merged = mergeLibrary(
        Array.isArray(remote?.workflows) ? remote.workflows : [],
        getLibrary(),
        sent,
      );
      // Only the deletes this request carried are settled. One made while it
      // was in flight is still owed, and stays pending for the next push.
      writeDeletes(settleDeletes(readDeletes(), deleted));
      publish(merged);
      // Recorded against what was adopted, not against what was sent, so the
      // merge itself does not read as a fresh edit and bounce straight back.
      pushed = JSON.stringify({ workflows: merged, deleted: [] } satisfies LibraryPush);
    } catch {
      pushed = null;
    }
  };
  queue = queue.then(run, run);
  return queue;
}
