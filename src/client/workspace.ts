/**
 * The host-side half of a room's workspace.
 *
 * A Durable Object cannot reach into anyone's filesystem — it can only talk to
 * sockets. So when a room wants to read a real folder, one member's browser tab
 * volunteers to act as the file server: it holds a `FileSystemDirectoryHandle`
 * the user explicitly picked, and this module answers the room's `fs.req`
 * messages against it, replying over the same WebSocket the room already has
 * open. See `RoomView.tsx` for the wiring (attach/detach, the `fs.req`
 * handler) and `src/shared/protocol.ts` for the message shapes.
 *
 * READ-ONLY FOR NOW. `write`, `edit` and `remove` are wired into the protocol
 * but not implemented here — they always return a "read-only" error. Writes
 * arrive in a later phase, behind a room vote; there is no reason to let a
 * message from the wire touch disk before that vote exists.
 *
 * `src/shared/workspace.ts` already normalises and policy-checks every path
 * before a request is ever sent to a host. This module re-validates the path
 * anyway (see `normalizePath` below), on the assumption that a client which
 * trusts "the server already checked it" is one server bug — or one hand-built
 * `fs.req` from a browser devtools console — away from serving anything on
 * the picker's disk. Defense in depth, not a vote of no confidence in the
 * server.
 */

import {
  FS_LIMITS,
  matchGlob,
  normalizePath,
  type FsRequest,
  type FsResponse,
} from "../shared/workspace";

/* -------------------------------------------- non-standard DOM typings */

// TypeScript's bundled DOM lib already knows `FileSystemDirectoryHandle`,
// `getDirectoryHandle`, `getFileHandle` and friends, but two corners of the
// File System Access API are still missing: `window.showDirectoryPicker`
// itself, and the permission methods on a handle. Both are declared narrowly
// here — augmenting only the members this module actually calls — rather
// than casting whole objects to `any`, so a typo in an unrelated property
// still gets caught everywhere else in the app.
declare global {
  interface Window {
    showDirectoryPicker?(options?: {
      mode?: "read" | "readwrite";
    }): Promise<FileSystemDirectoryHandle>;
  }
}

/** The permission methods a handle has at runtime but TS doesn't know about. */
interface FsPermissionHandle {
  queryPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
}

/* ------------------------------------------------------------- support */

/** Whether this browser can host a local folder at all. */
export function isFileAccessSupported(): boolean {
  return typeof (window as any).showDirectoryPicker === "function";
}

/** Ask the user to choose a folder. Returns null if they cancel. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const picker = window.showDirectoryPicker;
    if (!picker) return null;
    return await picker({ mode: "read" });
  } catch (err) {
    // The user closing the native picker throws AbortError — that's a normal
    // "no thanks", not a failure worth surfacing. Anything else (a permission
    // policy blocking the call, etc.) is real and gets rethrown.
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
}

/** Confirm we still hold read permission, prompting if needed. */
export async function ensureReadPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const withPerms = handle as unknown as FsPermissionHandle;
  let state = await withPerms.queryPermission({ mode: "read" });
  if (state !== "granted") {
    state = await withPerms.requestPermission({ mode: "read" });
  }
  return state === "granted";
}

/* ----------------------------------------------------- handle persistence */

// A FileSystemDirectoryHandle is structured-cloneable, which is exactly what
// IndexedDB stores values with — this is why IndexedDB works here and
// localStorage (strings only) would not. No library needed: one database,
// one object store, keyed by room id so each room remembers its own folder.
const DB_NAME = "collab_ai_workspace";
const STORE_NAME = "handles";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Remember the chosen folder across reloads, keyed by room. */
export async function saveHandle(roomId: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(handle, roomId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Recall the folder chosen for this room, if any. */
export async function loadHandle(roomId: string): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb();
  try {
    return await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(roomId);
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Forget the folder chosen for this room. */
export async function forgetHandle(roomId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(roomId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------ fs requests */

type Handle = FileSystemDirectoryHandle | FileSystemFileHandle;

/**
 * Descend one segment at a time from `root` to the directory named by
 * `segments`. Never passes a string containing "/" to `getDirectoryHandle` —
 * each call can only descend exactly one level and has no way to express
 * "..", which is what keeps the walk inside the picked folder no matter what
 * the path claims. A malicious or malformed path can name a directory that
 * doesn't exist (and this throws), but it cannot name anything outside root.
 */
async function walkTo(
  root: FileSystemDirectoryHandle,
  segments: readonly string[],
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment);
  }
  return dir;
}

async function sortedEntries(dir: FileSystemDirectoryHandle): Promise<[string, Handle][]> {
  const entries: [string, Handle][] = [];
  for await (const entry of dir.entries()) entries.push(entry);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries;
}

/**
 * List a directory, omitting anything the room's deny list covers.
 *
 * A denied file is hidden entirely rather than shown-but-unreadable. Knowing
 * that `.ssh/id_rsa` or `client-acme-contract.pdf` exists is itself worth
 * protecting, and "denied" reads more honestly as "not there" than as a name
 * the agent can see but never open.
 */
async function doList(
  root: FileSystemDirectoryHandle,
  path: string,
  depth: number,
  deny: readonly string[],
): Promise<FsResponse> {
  const normalized = normalizePath(path);
  if (normalized === null) return { ok: false, error: "That path isn't allowed." };

  const segments = normalized === "" ? [] : normalized.split("/");
  const dir = await walkTo(root, segments);

  const lines: string[] = [];
  let shown = 0;
  let overflow = 0;

  async function recurse(handle: FileSystemDirectoryHandle, prefix: string, remainingDepth: number) {
    for (const [name, h] of await sortedEntries(handle)) {
      const entryPath = prefix ? `${prefix}/${name}` : name;
      const line = h.kind === "directory" ? `${entryPath}/` : entryPath;

      // Skipped before it is counted, so a hidden entry does not even show up
      // in the "(N more entries not shown)" tally.
      if (isDenied(line, deny)) continue;

      // Every entry is counted, even past the cap, so the "(N more entries
      // not shown)" footer is an accurate count rather than a guess.
      if (shown < FS_LIMITS.listEntries) {
        lines.push(line);
        shown++;
      } else {
        overflow++;
      }

      if (h.kind === "directory" && remainingDepth > 0) {
        await recurse(h, entryPath, remainingDepth - 1);
      }
    }
  }

  await recurse(dir, normalized, depth);

  if (overflow > 0) lines.push(`(${overflow} more entries not shown)`);
  return { ok: true, data: lines.join("\n") };
}

async function doRead(root: FileSystemDirectoryHandle, path: string, offset: number, limit: number): Promise<FsResponse> {
  const normalized = normalizePath(path);
  if (normalized === null) return { ok: false, error: "That path isn't allowed." };
  if (normalized === "") return { ok: false, error: `No such file: ${path}` };

  const segments = normalized.split("/");
  const fileName = segments[segments.length - 1]!;
  const dirSegments = segments.slice(0, -1);

  let file: File;
  try {
    const dir = await walkTo(root, dirSegments);
    const fileHandle = await dir.getFileHandle(fileName);
    file = await fileHandle.getFile();
  } catch {
    return { ok: false, error: `No such file: ${path}` };
  }

  const end = offset + limit;
  const text = await file.slice(offset, end).text();
  const truncated = end < file.size;

  return truncated
    ? { ok: true, data: `${text}\n(truncated at ${end} bytes)` }
    : { ok: true, data: text };
}

// Opening and reading thousands of files is what turns "search my project"
// into a hung tab. This is a hard ceiling independent of `max` matches —
// a search for a rare string across a huge tree still has to open every
// file to find out it doesn't match, so the match count alone doesn't bound
// the work.
const SEARCH_FILE_OPEN_CAP = 2000;

/** Whether any of the room's deny globs covers this path. */
function isDenied(path: string, deny: readonly string[]): boolean {
  for (const pattern of deny) {
    if (matchGlob(pattern, path)) return true;
    // A directory probe arrives as "dir/"; also test the bare name so a
    // pattern written without a trailing slash still prunes it.
    if (path.endsWith("/") && matchGlob(pattern, path.slice(0, -1))) return true;
  }
  return false;
}

/**
 * Search the tree for a substring.
 *
 * `deny` comes from the room, not from the model, and is the ONLY thing
 * keeping a search inside the same bounds as a read. Every other operation
 * names a path the server can police before the request is sent; a search
 * names none, so without this filter `search("PASSWORD")` would return the
 * contents of exactly the files the deny list exists to protect.
 */
async function doSearch(
  root: FileSystemDirectoryHandle,
  pattern: string,
  glob: string,
  max: number,
  deny: readonly string[],
): Promise<FsResponse> {
  const needle = pattern.toLowerCase();
  const results: string[] = [];
  let filesOpened = 0;

  // Returns true once the caller should stop walking entirely (max matches
  // reached, or the file-open cap hit).
  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<boolean> {
    for (const [name, h] of await sortedEntries(dir)) {
      const entryPath = prefix ? `${prefix}/${name}` : name;

      if (h.kind === "directory") {
        // Prune a denied directory rather than descending into it. Patterns
        // like **/.ssh/** only match what is inside, so the directory itself
        // is tested with a trailing slash to catch it before the walk.
        if (isDenied(entryPath + "/", deny)) continue;
        // The glob matches file paths, not directory paths — a directory is
        // always walked so a match inside it can be found, even one that
        // itself wouldn't match the glob.
        if (await walk(h, entryPath)) return true;
        continue;
      }

      // Checked before the glob and before opening: a denied file must never
      // be read, whatever the caller asked for.
      if (isDenied(entryPath, deny)) continue;
      if (glob && !matchGlob(glob, entryPath)) continue;
      if (filesOpened >= SEARCH_FILE_OPEN_CAP) return true;
      filesOpened++;

      try {
        const file = await h.getFile();
        const text = await file.text();
        const fileLines = text.split("\n");
        for (let i = 0; i < fileLines.length; i++) {
          if (fileLines[i]!.toLowerCase().includes(needle)) {
            results.push(`${entryPath}:${i + 1}: ${fileLines[i]}`);
            if (results.length >= max) return true;
          }
        }
      } catch {
        // Permission denied, binary content that fails to decode, a file
        // that vanished mid-walk — whatever the cause, one bad file skips
        // rather than aborting the whole search.
      }
    }
    return false;
  }

  await walk(root, "");
  return { ok: true, data: results.join("\n") };
}

/** Answer one request against the picked folder. Never throws. */
export async function performFsRequest(
  root: FileSystemDirectoryHandle,
  req: FsRequest,
): Promise<FsResponse> {
  try {
    switch (req.op) {
      case "list":
        return await doList(root, req.path, req.depth, req.deny ?? []);
      case "read":
        return await doRead(root, req.path, req.offset, req.limit);
      case "search":
        return await doSearch(root, req.pattern, req.glob, req.max, req.deny ?? []);
      case "write":
      case "edit":
      case "remove":
        return { ok: false, error: "This workspace is read-only." };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
