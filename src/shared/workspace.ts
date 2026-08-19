/**
 * Path safety and access policy for a room's workspace.
 *
 * A workspace is a real folder on someone's machine or a real repository. This
 * module decides which paths inside it the agent may touch, and it is the only
 * thing standing between "read the project" and "read ~/.ssh/id_rsa".
 *
 * Everything here is pure and total: no I/O, no throwing, no partial results.
 * A path either normalises to something provably inside the workspace root, or
 * it is rejected outright. There is deliberately no "best effort" path — a
 * function that repairs a suspicious path is a function that can be tricked
 * into repairing it into somewhere else.
 *
 * INVARIANT FOR PROVIDERS: paths are treated as literal text. `%2e%2e/x` stays
 * `%2e%2e/x` and is never decoded, so it names a directory that almost certainly
 * does not exist rather than escaping the root. Any provider that URL-decodes,
 * unescapes, or otherwise rewrites a path AFTER normalisation reintroduces
 * directory traversal. Normalise last, and use the result verbatim.
 */

import type { ToolDecision } from "./access";

/* ---------------------------------------------------------- normalisation */

/**
 * Reduce a client- or model-supplied path to a canonical workspace-relative
 * form, or return null if it cannot be proven safe.
 *
 * Rejects, without exception: absolute paths of any flavour, drive letters,
 * UNC paths, any `..` segment, NUL bytes, and anything that still contains a
 * `..` after normalisation. Accepts `/` and `\` as separators because hosts
 * are both POSIX and Windows, and always returns `/`-separated.
 */
export function normalizePath(input: unknown): string | null {
  if (typeof input !== "string") return null;
  if (input.includes("\u0000")) return null;

  // Backslashes become forward slashes before anything else looks at the
  // string, so every later check only has one separator to reason about.
  const slashed = input.replace(/\\/g, "/");

  // A leading separator is an absolute path (POSIX) or the start of a UNC
  // path (`//server/share`, which is `\\server\share` before conversion) —
  // both are outside any workspace root and are rejected here.
  if (slashed.startsWith("/")) return null;

  // A Windows drive letter, with or without a following separator (`C:/x`,
  // `c:x`), also names something outside the workspace root.
  if (/^[a-zA-Z]:/.test(slashed)) return null;

  const rawSegments = slashed.split("/");
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (segment === "" || segment === ".") {
      // Repeated separators and "." segments collapse away silently.
      continue;
    }
    if (segment === "..") {
      // A literal ".." is rejected outright, never resolved against the
      // segments collected so far — resolving is how traversal bugs happen.
      return null;
    }
    segments.push(segment);
  }

  return segments.join("/");
}

/* ---------------------------------------------------------------- globs */

/**
 * Match one path against one glob.
 *
 * `*` matches within a single segment. `**` crosses segments. `?` matches one
 * character. Matching is case-insensitive, because a deny rule that can be
 * bypassed by capitalising a letter is not a deny rule on a case-insensitive
 * filesystem.
 */
export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

const REGEX_METACHARS = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

function globToRegExp(pattern: string): RegExp {
  let body = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        // "**/" also matches zero directories, so a root-level file matches
        // a pattern written as if it always had a parent directory.
        body += "(?:.*/)?";
        i += 3;
      } else {
        body += ".*";
        i += 2;
      }
    } else if (ch === "*") {
      body += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      body += "[^/]";
      i += 1;
    } else {
      body += REGEX_METACHARS.has(ch!) ? `\\${ch}` : ch;
      i += 1;
    }
  }
  return new RegExp(`^${body}$`, "i");
}

/* -------------------------------------------------------------- policy */

export type WorkspaceKind = "none" | "local" | "github";

/**
 * Which paths the agent may touch, and whether a write needs a vote.
 *
 * Evaluated deny → ask → allow, first match wins, and anything matching nothing
 * falls to `fallback`. Deny is checked first and is absolute: no allow rule can
 * override it, so a broad allow cannot accidentally re-expose a secret.
 */
export type PathPolicy = {
  deny: string[];
  ask: string[];
  allow: string[];
  fallback: ToolDecision;
};

/**
 * Paths that are never readable unless someone deliberately removes them.
 *
 * These are the files that turn a code-reading feature into a credential leak.
 * The list is deliberately broad: the cost of denying something harmless is one
 * annoyed user, and the cost of missing something is somebody's production keys
 * in a chat transcript that every member of the room can read.
 */
export const DEFAULT_DENY: readonly string[] = [
  // Environment and dev-vars files — the single most common place secrets
  // end up, including every dotenv-style variant of the base name.
  "**/.env", "**/.env.*", "**/.dev.vars", "**/.dev.vars.*",

  // Private keys and certificates, in every common file extension.
  "**/*.pem", "**/*.key", "**/*.pfx", "**/*.p12", "**/*.jks", "**/*.keystore",

  // SSH key files, by their conventional names, regardless of algorithm.
  "**/id_rsa*", "**/id_dsa*", "**/id_ecdsa*", "**/id_ed25519*",

  // Whole directories that only ever hold credentials.
  "**/.ssh/**", "**/.aws/**", "**/.gnupg/**", "**/.kube/**",

  // .git itself is readable — history, refs and branches are legitimately
  // useful — but not the files that carry credentials. A remote URL of the
  // form https://user:token@host lives in .git/config, and
  // `credential.helper store` writes plaintext tokens to .git-credentials.
  "**/.git/config", "**/.git/credentials", "**/.git-credentials",

  // Package manager and other tool credential files.
  "**/.npmrc", "**/.netrc", "**/.pypirc",

  // Generic credential/secret file names, and the service-account JSON that
  // cloud providers hand out for machine identities.
  "**/credentials", "**/credentials.*", "**/secrets.*", "**/service-account*.json",

  // Terraform state commonly embeds plaintext secrets and resource
  // credentials pulled from providers — treat it the same as a secrets file.
  "**/*.tfstate", "**/*.tfstate.*",

  // Exported PGP/GPG key material, and Docker's registry auth store.
  "**/*.asc", "**/.docker/config.json",

  // Shell history files routinely contain secrets that were pasted or typed
  // on the command line (curl with a bearer token, export KEY=..., etc).
  "**/.bash_history", "**/.zsh_history", "**/.python_history", "**/.psql_history",

];

export const DEFAULT_PATH_POLICY: PathPolicy = {
  deny: [...DEFAULT_DENY],
  ask: [],
  allow: ["**"],
  fallback: "ask",
};

/**
 * What the room permits for one path.
 *
 * `write` selects the stricter treatment: a path that is readable is not
 * automatically writable, so a write to something matched only by an allow rule
 * still returns "ask" unless the policy explicitly allows writes there.
 */
export function pathDecision(policy: PathPolicy, path: string, write: boolean): ToolDecision {
  const normalized = normalizePath(path);
  // A path that cannot be proven safe is denied, never asked about — "ask"
  // would put an unprovable path in front of a human as if it were a normal
  // judgment call, when it is actually a malformed or hostile input.
  if (normalized === null) return "deny";

  if (policy.deny.some((glob) => matchGlob(glob, normalized))) return "deny";
  if (policy.ask.some((glob) => matchGlob(glob, normalized))) return "ask";
  if (policy.allow.some((glob) => matchGlob(glob, normalized))) {
    // A read allow-rule never silently allows a write.
    return write ? "ask" : "allow";
  }
  return write && policy.fallback === "allow" ? "ask" : policy.fallback;
}

function sanitizeGlobList(input: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(input)) return [...fallback];
  return input.filter((v): v is string => typeof v === "string" && v.length < 200);
}

/**
 * Coerce anything a client sends into a usable policy.
 *
 * Non-array fields fall back to the default for that field. Every surviving
 * entry must be a string under 200 characters.
 */
export function sanitizePathPolicy(input: unknown): PathPolicy {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<PathPolicy>;

  const deny = sanitizeGlobList(raw.deny, []);
  const ask = sanitizeGlobList(raw.ask, []);
  const allow = sanitizeGlobList(raw.allow, DEFAULT_PATH_POLICY.allow);
  const fallback: ToolDecision =
    raw.fallback === "allow" || raw.fallback === "deny" || raw.fallback === "ask" ? raw.fallback : "ask";

  return {
    // DEFAULT_DENY is always unioned into deny, whatever the client sent —
    // a policy that omits it, or sends an empty array, must not be a way to
    // shrink the deny list. This line is load-bearing; do not remove it.
    deny: [...new Set([...DEFAULT_DENY, ...deny])],
    ask,
    allow,
    fallback,
  };
}

/** One-line human summary, for the transcript audit line. */
export function describePathPolicy(policy: PathPolicy): string {
  const parts = [`${policy.deny.length} deny rule${policy.deny.length === 1 ? "" : "s"}`];
  if (policy.ask.length) parts.push(`${policy.ask.length} ask`);
  parts.push(`${policy.allow.length} allow`);
  parts.push(`fallback ${policy.fallback}`);
  return parts.join(" · ");
}

/* ------------------------------------------------------------ fs requests */

/** One filesystem operation the agent can ask a provider to perform. */
export type FsRequest =
  | { op: "list"; path: string; depth: number }
  | { op: "read"; path: string; offset: number; limit: number }
  | { op: "search"; pattern: string; glob: string; max: number }
  | { op: "write"; path: string; content: string }
  | { op: "edit"; path: string; oldText: string; newText: string }
  | { op: "remove"; path: string };

export type FsResponse = { ok: true; data: string } | { ok: false; error: string };

/** Whether an operation changes the workspace. Writes are policed harder. */
export function isWriteOp(op: FsRequest["op"]): boolean {
  return op === "write" || op === "edit" || op === "remove";
}

/**
 * Hard limits, applied by the room rather than trusted to the caller.
 *
 * A repository is not a document. One unbounded listing of a project with a
 * node_modules directory returns tens of thousands of entries and exhausts the
 * model's context in a single tool call, so these are the real control — not a
 * suggestion the agent is expected to respect.
 */
export const FS_LIMITS = {
  /** Maximum directory entries returned by one list. */
  listEntries: 400,
  /** Maximum directory depth one list may descend. */
  listDepth: 4,
  /** Maximum bytes returned by one read. */
  readBytes: 64_000,
  /** Maximum matches returned by one search. */
  searchMatches: 100,
  /** Maximum bytes accepted for one write. */
  writeBytes: 512_000,
  /** How long the room waits for a provider before giving up, in ms. */
  timeoutMs: 5_000,
} as const;

function clampInt(value: unknown, min: number, max: number, whenInvalid: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return whenInvalid;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Clamp a request's numeric fields to FS_LIMITS. Never throws. */
export function clampRequest(req: FsRequest): FsRequest {
  switch (req.op) {
    case "list":
      return { ...req, depth: clampInt(req.depth, 0, FS_LIMITS.listDepth, FS_LIMITS.listDepth) };
    case "read":
      return {
        ...req,
        offset: clampInt(req.offset, 0, Number.MAX_SAFE_INTEGER, 0),
        limit: clampInt(req.limit, 1, FS_LIMITS.readBytes, FS_LIMITS.readBytes),
      };
    case "search":
      return { ...req, max: clampInt(req.max, 1, FS_LIMITS.searchMatches, FS_LIMITS.searchMatches) };
    default:
      return req;
  }
}

/** What the room shows everyone about its workspace. */
export type WorkspaceInfo = {
  kind: WorkspaceKind;
  /** Whether the provider can currently be reached. */
  online: boolean;
  /** The member hosting it, or null when there is no workspace. */
  hostUid: string | null;
  /** Human label — a folder name or owner/repo. Never a full path. */
  label: string;
};

export const NO_WORKSPACE: WorkspaceInfo = {
  kind: "none", online: false, hostUid: null, label: "",
};
