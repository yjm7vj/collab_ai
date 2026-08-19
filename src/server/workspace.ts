/**
 * The provider abstraction and request/response correlation for a room's
 * workspace.
 *
 * A workspace provider is not necessarily local to this Worker. The real one,
 * coming in a later phase, lives in a member's browser: a folder on their
 * machine that only their tab can read, proxied over the WebSocket they
 * already have open to the room. The room cannot call into that browser — it
 * can only send a message down the socket and wait for a reply — so the flow
 * inverts from a normal function call into a request the room posts and a
 * response it correlates back by id. `PendingRequests` is that correlation
 * layer, kept separate from any one provider so a future real provider and
 * the `MockProvider` below share the exact same waiting behaviour.
 *
 * The important thing to get right is what happens while a request is
 * outstanding. An in-flight request here is a live JavaScript promise held in
 * memory, and a Durable Object can be evicted between any two turns of the
 * event loop — so unlike a vote, which is parked in SQLite and survives
 * eviction because `Room#advance` reads it back from storage, a pending
 * filesystem request does NOT survive eviction. That asymmetry is a deliberate
 * trade rather than an oversight: a vote can legitimately take minutes, so it
 * has to be durable, but a filesystem read over an open WebSocket is a
 * sub-second round trip. Making that durable too would mean persisting and
 * replaying a request the browser may have already answered, for a wait that
 * is never supposed to be long in the first place. A hard timeout is the
 * right trade instead — if the object is evicted or the host simply never
 * answers, the request times out and the caller sees an ordinary failed tool
 * result, not a hang. The agent can read that and retry or say something to
 * the room; it never sits blocked on a promise that nothing will ever settle.
 */

import { FS_LIMITS, matchGlob, type FsRequest, type FsResponse, type WorkspaceKind } from "../shared/workspace";

export interface WorkspaceProvider {
  readonly kind: WorkspaceKind;
  /** Human label shown to the room. */
  readonly label: string;
  /** Perform one already-normalised, already-clamped request. */
  perform(req: FsRequest): Promise<FsResponse>;
}

type PendingEntry = {
  resolve: (res: FsResponse) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * A provider backed by a browser over the WebSocket.
 *
 * The room cannot call the browser, so the flow inverts: the room sends a
 * numbered request to the host's socket and waits for a matching reply.
 */
export class PendingRequests {
  #entries = new Map<string, PendingEntry>();

  /** Register a request and get a promise plus the id to send. */
  open(timeoutMs: number): { id: string; promise: Promise<FsResponse> } {
    const id = crypto.randomUUID();
    // No promise this class returns may ever reject: a rejection here would
    // escape into the agent turn loop and abort it (an unhandled throw deep
    // inside a tool call), whereas an { ok: false } response is something the
    // model can read and react to like any other failed tool result. So every
    // path below — settle, timeout, failAll — resolves, never rejects.
    const promise = new Promise<FsResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.#entries.delete(id);
        resolve({ ok: false, error: "The workspace host did not respond in time." });
      }, timeoutMs);
      this.#entries.set(id, { resolve, timer });
    });
    return { id, promise };
  }

  /** Resolve a request by id. Unknown or already-settled ids are ignored. */
  settle(id: string, res: FsResponse): void {
    const entry = this.#entries.get(id);
    if (!entry) return; // unknown, or already settled — a no-op either way
    clearTimeout(entry.timer);
    this.#entries.delete(id);
    entry.resolve(res);
  }

  /**
   * Fail every outstanding request, e.g. when the host disconnects.
   *
   * This is what turns "the host closed their laptop" into a clean tool error
   * instead of a hang: every promise this class handed out settles right now,
   * with a reason the model can surface, rather than waiting out its full
   * timeout one by one.
   */
  failAll(error: string): void {
    for (const [id, entry] of this.#entries) {
      clearTimeout(entry.timer);
      this.#entries.delete(id);
      entry.resolve({ ok: false, error });
    }
  }

  /** How many requests are outstanding. */
  get size(): number {
    return this.#entries.size;
  }
}

/* ---------------------------------------------------------- mock provider */

/**
 * An in-memory stand-in for a real filesystem.
 *
 * Backed by a flat `path -> contents` map so the transport, the correlation
 * and the room-level plumbing can all be exercised without a real disk or a
 * real browser on the other end.
 */
export class MockProvider implements WorkspaceProvider {
  readonly kind: WorkspaceKind = "local";
  readonly label = "mock";

  #files: Map<string, string>;

  constructor(files: Record<string, string>) {
    this.#files = new Map(Object.entries(files));
  }

  async perform(req: FsRequest): Promise<FsResponse> {
    switch (req.op) {
      case "list":
        return this.#list(req.path, req.depth);
      case "read":
        return this.#read(req.path, req.offset, req.limit);
      case "search":
        return this.#search(req.pattern, req.glob, req.max);
      case "write":
        return this.#write(req.path, req.content);
      case "edit":
        return this.#edit(req.path, req.oldText, req.newText);
      case "remove":
        return this.#remove(req.path);
      default:
        return { ok: false, error: `Unknown operation: ${(req as FsRequest).op}` };
    }
  }

  #list(base: string, depth: number): FsResponse {
    const prefix = base === "" ? "" : `${base}/`;
    const all: string[] = [];
    for (const path of this.#files.keys()) {
      if (base !== "" && path !== base && !path.startsWith(prefix)) continue;
      if (base !== "" && path === base) continue; // the base itself is not an entry under it
      const rest = base === "" ? path : path.slice(prefix.length);
      const slashes = (rest.match(/\//g) ?? []).length;
      if (slashes > depth) continue;
      all.push(path);
    }
    all.sort();

    const { listEntries } = FS_LIMITS;
    const shown = all.slice(0, listEntries);
    const hidden = all.length - shown.length;
    const lines = [...shown];
    if (hidden > 0) lines.push(`(${hidden} more entries not shown)`);
    return { ok: true, data: lines.join("\n") };
  }

  #read(path: string, offset: number, limit: number): FsResponse {
    const contents = this.#files.get(path);
    if (contents === undefined) return { ok: false, error: `No such file: ${path}` };
    return { ok: true, data: contents.slice(offset, offset + limit) };
  }

  #search(pattern: string, glob: string, max: number): FsResponse {
    const needle = pattern.toLowerCase();
    const matcher = glob ? (p: string) => matchGlob(glob, p) : () => true;
    const out: string[] = [];
    const paths = [...this.#files.keys()].sort();
    outer: for (const path of paths) {
      if (!matcher(path)) continue;
      const contents = this.#files.get(path)!;
      const lines = contents.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.toLowerCase().includes(needle)) continue;
        out.push(`${path}:${i + 1}: ${lines[i]}`);
        if (out.length >= max) break outer;
      }
    }
    return { ok: true, data: out.join("\n") };
  }

  #write(path: string, content: string): FsResponse {
    this.#files.set(path, content);
    return { ok: true, data: `Wrote ${content.length} characters to ${path}.` };
  }

  #edit(path: string, oldText: string, newText: string): FsResponse {
    const contents = this.#files.get(path);
    if (contents === undefined) return { ok: false, error: `No such file: ${path}` };

    // Same unique-match-or-reject contract as edit_doc in src/server/tools.ts:
    // the span must appear exactly once, or nothing changes.
    const first = contents.indexOf(oldText);
    if (first === -1) {
      return {
        ok: false,
        error:
          "old_text was not found in the file. Read it again to get the current " +
          "text, then retry with an exact span from it.",
      };
    }
    if (contents.indexOf(oldText, first + 1) !== -1) {
      return {
        ok: false,
        error:
          "old_text appears more than once, so the target is ambiguous. Include " +
          "more surrounding context to make it unique.",
      };
    }
    this.#files.set(path, contents.slice(0, first) + newText + contents.slice(first + oldText.length));
    return { ok: true, data: "Edit applied." };
  }

  #remove(path: string): FsResponse {
    if (!this.#files.has(path)) return { ok: false, error: `No such file: ${path}` };
    this.#files.delete(path);
    return { ok: true, data: `Removed ${path}.` };
  }
}
