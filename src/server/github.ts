/**
 * GitHub-backed workspace: authentication as a GitHub App, a thin REST
 * client over the contents/search APIs, and a read-only WorkspaceProvider.
 *
 * WHY A GITHUB APP AND NOT AN OAUTH APP
 * An OAuth App authenticates as the *user* and, once authorized, can see
 * every repository that user can see — there is no way to scope it to just
 * the one repository a room wants to share, which is a blanket `repo` grant
 * for a feature that only ever needs one. A GitHub App is installed by the
 * user onto specific repositories, mints short-lived installation tokens
 * scoped to exactly those repositories, and can be revoked from GitHub's
 * side (uninstalling the app) independent of anything this server does.
 * That is the right shape for a room: access is opt-in per repository, and
 * the user — not this code — controls when it ends.
 *
 * TOKENS ARE SHORT-LIVED AND MUST NEVER BE PERSISTED
 * Both the App JWT (9 minutes) and the installation token GitHub exchanges
 * it for are minted on demand and held only in memory for the duration of
 * one request. Neither is written to storage, logged, or put anywhere it
 * could end up broadcast to room members — a leaked installation token is a
 * live credential against someone's repository until it naturally expires.
 *
 * NEVER THROWS
 * Every exported function here returns a result or an error value, the
 * same discipline as src/server/auth.ts: a malformed key, a network
 * failure, or an unexpected GitHub response becomes `{ ok: false, error }`,
 * never a thrown exception a caller has to remember to catch. (`appJwt` is
 * the one low-level exception: like `mintToken` in auth.ts, it assumes it
 * has already been handed a valid, already-checked key — callers validate
 * with `pemToPkcs8` first. `installationToken`, which is what actually
 * consumes a caller-supplied config, wraps it so the "never throws"
 * guarantee holds for anything a caller passes in directly.)
 */

import { findUniqueText, FS_LIMITS, matchGlob, type FsRequest, type FsResponse } from "../shared/workspace";
import type { WorkspaceProvider } from "./workspace";

export type GithubConfig = {
  appId: string;
  /** PKCS#8 PEM. See pemToPkcs8 below for why. */
  privateKeyPem: string;
};

/**
 * The runtime's `fetch`, wrapped so it can be stored and passed around.
 *
 * `fetch` is a native global and workerd enforces its receiver: assign it to
 * an object field and call it back as `this.#fetchImpl(url)` and the receiver
 * becomes that object, which fails at runtime with "Illegal invocation:
 * function called with incorrect `this` reference". Every fallback below goes
 * through this wrapper instead of naming `fetch` directly, so it does not
 * matter whether a caller ends up invoking it bare or as a method — the inner
 * call is always a plain global one.
 *
 * Injected test stubs are ordinary functions that ignore `this`, so this class
 * of bug is invisible to any check that supplies its own fetch. See the
 * "receiver safety" section of scripts/check-github.ts, which does not.
 */
const runtimeFetch: typeof fetch = (input, init) => fetch(input, init);

/**
 * Budget for a tree-walk search. Searching by fetching files costs one
 * request per candidate file, and that cost is not this search's alone to
 * spend: a whole agent turn — every model call and every tool call it
 * makes — runs inside a single Worker invocation, and shares that
 * invocation's one subrequest budget, which can be as low as 50 on some
 * plans. A search that fetched a hundred candidate files would exhaust the
 * budget by itself and end the turn before it could even report back, never
 * mind leave room for anything else the turn still needed to do. Twelve
 * candidates costs twelve subrequests and leaves the rest of the budget for
 * the turn.
 */
const SEARCH_MAX_CANDIDATES = 12;
/** How many matching paths to name when there are too many to grep. */
const SEARCH_MAX_LISTED_PATHS = 40;
/** Skip anything larger than this; source files are not this big. */
const SEARCH_MAX_FILE_BYTES = 256_000;
/** Total decoded bytes one search may scan. */
const SEARCH_MAX_TOTAL_BYTES = 2_000_000;
/** How many file fetches are in flight at once. */
const SEARCH_CONCURRENCY = 6;

/**
 * Extensions never worth grepping: binary, or generated blobs that would
 * blow the byte budget without ever containing a useful match.
 */
const SEARCH_SKIP_EXT = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff",
  ".pdf", ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar",
  ".mp3", ".mp4", ".mov", ".avi", ".webm", ".wav", ".ogg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".so", ".dll", ".dylib", ".exe", ".bin", ".wasm",
  ".pyc", ".class", ".jar", ".lock",
];

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

/** Decode a standard (non-url-safe) base64 string to raw bytes. */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encode raw bytes as standard (non-url-safe) base64, the form the contents API wants. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * UTF-8 encode text before base64-encoding it.
 *
 * `btoa` walks a string one UTF-16 code unit at a time and assumes every
 * code unit fits in a byte — anything outside Latin-1 (an emoji, an
 * accented letter) either throws or comes out silently mangled. Routing the
 * text through `TextEncoder` first guarantees the bytes handed to `btoa`
 * are always in range, so committed file content round-trips exactly.
 */
function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/**
 * Convert a PEM private key to the raw PKCS#8 bytes WebCrypto needs.
 *
 * GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"). WebCrypto only imports
 * PKCS#8 ("BEGIN PRIVATE KEY"). This is the single most likely thing to go
 * wrong when someone sets this up, so it is detected explicitly and reported
 * with instructions rather than failing as an opaque crypto error.
 */
export function pemToPkcs8(pem: string): { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; error: string } {
  const trimmed = pem.trim();

  if (trimmed.includes("BEGIN RSA PRIVATE KEY")) {
    return {
      ok: false,
      error:
        "That key is in PKCS#1 format. GitHub issues these, but WebCrypto needs PKCS#8. Convert it with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in your-key.pem -out key-pkcs8.pem",
    };
  }

  if (!trimmed.includes("BEGIN PRIVATE KEY")) {
    return { ok: false, error: "That doesn't look like a PEM private key." };
  }

  const body = trimmed
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  if (body.length === 0) {
    return { ok: false, error: "That doesn't look like a PEM private key." };
  }

  try {
    return { ok: true, bytes: base64ToBytes(body) };
  } catch {
    return { ok: false, error: "That doesn't look like a PEM private key." };
  }
}

/**
 * Mint the App-level JWT GitHub requires before anything else.
 * RS256, 9-minute expiry (GitHub rejects more than 10).
 */
export async function appJwt(cfg: GithubConfig, nowSeconds?: number): Promise<string> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    // Backdated 60 seconds to absorb clock skew between us and GitHub.
    iat: now - 60,
    // 9 minutes. GitHub rejects a JWT whose expiry is more than 10 minutes out.
    exp: now + 540,
    iss: cfg.appId,
  };

  const encodedHeader = base64UrlEncodeString(JSON.stringify(header));
  const encodedClaims = base64UrlEncodeString(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedClaims}`;

  // Assumes cfg.privateKeyPem is already PKCS#8 — validate with pemToPkcs8()
  // wherever the key is accepted (e.g. when a room owner saves it), before
  // it ever reaches here. See the "NEVER THROWS" note in the file header.
  const pkcs8 = pemToPkcs8(cfg.privateKeyPem);
  if (!pkcs8.ok) {
    throw new Error(pkcs8.error);
  }

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8.bytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)),
  );
  const signature = base64UrlEncode(signatureBytes);
  return `${signingInput}.${signature}`;
}

/** Resolve the authenticated GitHub App's public URL slug. */
export async function appSlug(
  cfg: GithubConfig,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; slug: string } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? runtimeFetch;
  try {
    const jwt = await appJwt(cfg);
    const res = await doFetch("https://api.github.com/app", {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "collab-ai-github-app",
      },
    });
    if (!res.ok) return { ok: false, error: await ghErrorMessage(res) };

    const data = (await res.json()) as { slug?: unknown };
    if (typeof data.slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(data.slug)) {
      return { ok: false, error: "GitHub's response was missing a valid App slug." };
    }
    return { ok: true, slug: data.slug };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to identify the GitHub App." };
  }
}

/** Exchange the App JWT for an installation token. Short-lived; never store it. */
export async function installationToken(
  cfg: GithubConfig,
  installationId: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; token: string; expiresAt: string } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? runtimeFetch;
  try {
    const jwt = await appJwt(cfg);
    const res = await doFetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        // GitHub rejects requests sent with no User-Agent header.
        "User-Agent": "collab-ai-github-app",
      },
    });

    if (!res.ok) {
      let message = `GitHub returned ${res.status}`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body && typeof body.message === "string") {
          message = `GitHub returned ${res.status}: ${body.message}`;
        }
      } catch {
        // Non-JSON error body; the status-only message stands.
      }
      return { ok: false, error: message };
    }

    const data = (await res.json()) as { token?: string; expires_at?: string };
    if (typeof data.token !== "string" || typeof data.expires_at !== "string") {
      return { ok: false, error: "GitHub's response was missing a token." };
    }
    return { ok: true, token: data.token, expiresAt: data.expires_at };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to request an installation token." };
  }
}

export type RepoRef = { owner: string; repo: string; ref: string };

const OWNER_OR_REPO_RE = /^[A-Za-z0-9._-]+$/;
// A ref is interpolated straight into a GitHub API URL path, so it gets the
// same scrutiny as a filesystem path: only characters that cannot break out
// of the path, and no ".." segment.
const REF_RE = /^[A-Za-z0-9._/-]+$/;

/** Parse "owner/repo" or "owner/repo@branch". Returns null if malformed. */
export function parseRepoRef(input: unknown): RepoRef | null {
  if (typeof input !== "string") return null;

  const at = input.indexOf("@");
  const ownerRepo = at === -1 ? input : input.slice(0, at);
  const ref = at === -1 ? "HEAD" : input.slice(at + 1);

  const parts = ownerRepo.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  if (owner.length > 100 || !OWNER_OR_REPO_RE.test(owner)) return null;
  if (repo.length > 100 || !OWNER_OR_REPO_RE.test(repo)) return null;

  if (ref.length === 0 || !REF_RE.test(ref)) return null;
  if (ref.split("/").some((segment) => segment === "..")) return null;

  return { owner, repo, ref };
}

function ghHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    // GitHub rejects requests sent with no User-Agent header.
    "User-Agent": "collab-ai-github-provider",
  };
}

/** Extract GitHub's `message` field from an error response body, if present. */
async function ghErrorMessage(res: Response): Promise<string> {
  let message = `GitHub returned ${res.status}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body && typeof body.message === "string") {
      message = `GitHub returned ${res.status}: ${body.message}`;
    }
  } catch {
    // Non-JSON error body; the status-only message stands.
  }
  return message;
}

/** A branch name in a URL *path* keeps its slashes as segments (unlike a query value). */
function encodeBranchPathSegments(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function encodeContentsPath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

function repoUrl(ref: RepoRef, suffix: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}${suffix}`;
}

/**
 * Resolve "HEAD" to the repository's actual default branch name.
 *
 * A repo's default branch is not always `main` — plenty of older
 * repositories still use `master`, or something else entirely — so assuming
 * it is would silently target the wrong branch. When the ref is already a
 * concrete branch name this is a no-op with no network call.
 */
async function resolveBranchName(
  token: string,
  ref: RepoRef,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; branch: string } | { ok: false; error: string }> {
  if (ref.ref !== "HEAD") return { ok: true, branch: ref.ref };
  const doFetch = fetchImpl ?? runtimeFetch;
  try {
    const res = await doFetch(repoUrl(ref, ""), { headers: ghHeaders(token) });
    if (!res.ok) return { ok: false, error: await ghErrorMessage(res) };
    const body = (await res.json()) as { default_branch?: string };
    if (typeof body.default_branch !== "string") {
      return { ok: false, error: "GitHub did not return a default branch for this repository." };
    }
    return { ok: true, branch: body.default_branch };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to resolve the repository's default branch.",
    };
  }
}

/** What a token may actually do with a repository, as GitHub reports it. */
export type RepoAccess = { defaultBranch: string; canPush: boolean };

/**
 * Ask GitHub what this token is allowed to do with a repository, rather than
 * assuming it may do anything.
 *
 * The `permissions` block comes back on the repository object for any
 * authenticated request, and it already accounts for whichever kind of
 * credential is asking: a member's role for a user token, the installation's
 * granted permissions for an app token. That matters because the two fail
 * differently and look identical from here — an account with full write
 * access still gets 403 on every commit if the App installation carrying the
 * request only holds `Contents: Read`.
 *
 * Short of attempting a write, this is the only thing that separates a
 * repository the room can propose changes to from one it can merely read.
 */
export async function repoAccess(
  token: string,
  ref: RepoRef,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; access: RepoAccess } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? runtimeFetch;
  try {
    const res = await doFetch(repoUrl(ref, ""), { headers: ghHeaders(token) });
    if (!res.ok) return { ok: false, error: await ghErrorMessage(res) };

    const body = (await res.json()) as {
      default_branch?: unknown;
      permissions?: { push?: unknown } | null;
    };
    return {
      ok: true,
      access: {
        defaultBranch: typeof body.default_branch === "string" ? body.default_branch : "",
        // Absent permissions means the token was not told it may push, which
        // is treated as "may not" — the safe reading, and the one that stops
        // the room promising an edit it cannot land.
        canPush: body.permissions?.push === true,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to read the repository.",
    };
  }
}

/** The commit a ref currently points at, and (implicitly) the tree it carries. */
export async function refHead(
  token: string,
  ref: RepoRef,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? runtimeFetch;
  try {
    const branchRes = await resolveBranchName(token, ref, fetchImpl);
    if (!branchRes.ok) return branchRes;

    const res = await doFetch(repoUrl(ref, `/git/ref/heads/${encodeBranchPathSegments(branchRes.branch)}`), {
      headers: ghHeaders(token),
    });
    if (!res.ok) return { ok: false, error: await ghErrorMessage(res) };

    const body = (await res.json()) as { object?: { sha?: string } };
    if (typeof body.object?.sha !== "string") {
      return { ok: false, error: "GitHub did not return a commit sha for that ref." };
    }
    return { ok: true, sha: body.object.sha };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to resolve the ref." };
  }
}

/** Create a branch at `fromSha`, or report that it already exists. */
export async function ensureBranch(
  token: string,
  ref: RepoRef,
  branch: string,
  fromSha: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? runtimeFetch;
  try {
    const res = await doFetch(repoUrl(ref, "/git/refs"), {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
    });
    if (res.ok) return { ok: true, created: true };

    if (res.status === 422) {
      const message = await ghErrorMessage(res);
      // GitHub reports a ref collision as a 422 with a message mentioning
      // this — that is success (the branch this call wanted already exists),
      // not a failure.
      if (message.toLowerCase().includes("already exists")) {
        return { ok: true, created: false };
      }
      return { ok: false, error: message };
    }
    return { ok: false, error: await ghErrorMessage(res) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to create the branch." };
  }
}

/** Current blob sha for a path on a branch, or null when the file is new. */
export async function fileSha(
  token: string,
  ref: RepoRef,
  path: string,
  branch: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; sha: string | null } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? runtimeFetch;
  try {
    const url = repoUrl(ref, `/contents/${encodeContentsPath(path)}?ref=${encodeURIComponent(branch)}`);
    const res = await doFetch(url, { headers: ghHeaders(token) });

    // Distinguishing "missing" from "failed" matters here: creating a file
    // and updating one are the same PUT endpoint, and the only thing that
    // tells them apart is whether a `sha` is sent. A 404 is not an error
    // this caller needs to handle — it is the answer "this write will
    // create a new file."
    if (res.status === 404) return { ok: true, sha: null };
    if (!res.ok) return { ok: false, error: await ghErrorMessage(res) };

    const body = (await res.json()) as { sha?: string };
    if (typeof body.sha !== "string") {
      return { ok: false, error: `GitHub did not return a sha for ${path}.` };
    }
    return { ok: true, sha: body.sha };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : `Failed to look up ${path}.` };
  }
}

/** Create or update one file on a branch. */
export async function commitFile(
  token: string,
  ref: RepoRef,
  branch: string,
  path: string,
  content: string,
  message: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; commitSha: string } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? runtimeFetch;
  try {
    const shaRes = await fileSha(token, ref, path, branch, fetchImpl);
    if (!shaRes.ok) return shaRes;

    const body: { message: string; branch: string; content: string; sha?: string } = {
      message,
      branch,
      content: utf8ToBase64(content),
    };
    if (shaRes.sha !== null) body.sha = shaRes.sha;

    const res = await doFetch(repoUrl(ref, `/contents/${encodeContentsPath(path)}`), {
      method: "PUT",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: await ghErrorMessage(res) };

    const resBody = (await res.json()) as { commit?: { sha?: string } };
    if (typeof resBody.commit?.sha !== "string") {
      return { ok: false, error: "GitHub did not return a commit sha." };
    }
    return { ok: true, commitSha: resBody.commit.sha };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : `Failed to commit ${path}.` };
  }
}

/** Delete one file from a branch. */
export async function deleteFile(
  token: string,
  ref: RepoRef,
  branch: string,
  path: string,
  message: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? runtimeFetch;
  try {
    const shaRes = await fileSha(token, ref, path, branch, fetchImpl);
    if (!shaRes.ok) return shaRes;
    if (shaRes.sha === null) {
      return { ok: false, error: `${path} does not exist on ${branch}.` };
    }

    const res = await doFetch(repoUrl(ref, `/contents/${encodeContentsPath(path)}`), {
      method: "DELETE",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ message, branch, sha: shaRes.sha }),
    });
    if (!res.ok) return { ok: false, error: await ghErrorMessage(res) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : `Failed to delete ${path}.` };
  }
}

/** Open a pull request. */
export async function openPullRequest(
  token: string,
  ref: RepoRef,
  head: string,
  base: string,
  title: string,
  body: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; url: string; number: number } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? runtimeFetch;
  try {
    const res = await doFetch(repoUrl(ref, "/pulls"), {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, head, base }),
    });

    if (res.ok) {
      const data = (await res.json()) as { html_url?: string; number?: number };
      if (typeof data.html_url !== "string" || typeof data.number !== "number") {
        return { ok: false, error: "GitHub did not return a pull request URL and number." };
      }
      return { ok: true, url: data.html_url, number: data.number };
    }

    if (res.status === 422) {
      const message = await ghErrorMessage(res);
      if (message.toLowerCase().includes("a pull request already exists")) {
        // A real failure, but a clear one: name the branch so whoever reads
        // this knows which pull request to go look at instead of opening
        // a new one.
        return { ok: false, error: `${message} (head branch: ${head})` };
      }
      return { ok: false, error: message };
    }
    return { ok: false, error: await ghErrorMessage(res) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to open the pull request." };
  }
}

/** Whether any of the room's deny globs covers this path. Mirrors the local provider. */
function isDenied(path: string, deny: readonly string[]): boolean {
  for (const pattern of deny) {
    if (matchGlob(pattern, path)) return true;
    // A directory probe arrives as "dir/"; also test the bare name so a
    // pattern written without a trailing slash still prunes it.
    if (path.endsWith("/") && matchGlob(pattern, path.slice(0, -1))) return true;
  }
  return false;
}

type FetchResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; error: string };

/**
 * A provider over the GitHub contents API. Reads go straight against
 * `#ref`; writes never touch it — they land on a working branch (see
 * `#branch` below) so nothing this provider does can change the default
 * branch without a human reviewing a pull request first.
 */
export class GithubProvider implements WorkspaceProvider {
  readonly kind = "github" as const;
  readonly label: string;

  #token: string;
  #ref: RepoRef;
  #deny: readonly string[];
  #branch: string;
  #fetchImpl: typeof fetch;
  /**
   * Whether reads should come from the working branch rather than the
   * base branch.
   *
   * Writes land on `#branch` so nothing here can change a repository's
   * default branch without a pull request a human reviews. That is
   * right, but it means that once a room has approved an edit, reading
   * the base branch shows content that is out of date with what the
   * room itself just did — the agent re-reads a file it has already
   * changed, sees the old text, and reasonably concludes the change
   * never happened. The room sets this once a write has actually
   * created the working branch, so from then on the room reads what it
   * has accumulated.
   */
  #readWorking: boolean;

  constructor(
    token: string,
    ref: RepoRef,
    deny: readonly string[],
    branch?: string,
    fetchImpl?: typeof fetch,
    readWorkingBranch?: boolean,
  ) {
    this.#token = token;
    this.#ref = ref;
    this.#deny = deny;
    // A fixed branch name, rather than one derived fresh per write, means
    // every change the room approves accumulates onto the same branch and
    // therefore the same pull request, instead of each edit opening its
    // own — which is what a human reviewer actually wants to look at.
    this.#branch = branch && branch.length > 0 ? branch : "collab-ai";
    this.#fetchImpl = fetchImpl ?? runtimeFetch;
    this.#readWorking = readWorkingBranch === true;
    this.label = `${ref.owner}/${ref.repo}`;
  }

  /**
   * The ref reads resolve against. Deliberately NOT used by
   * `resolveBranchName`, `ensureBranch` or `openPr`: those need the
   * BASE branch, and a pull request whose base was the working branch
   * would be a pull request from a branch into itself.
   */
  #readRef(): RepoRef {
    return this.#readWorking ? { ...this.#ref, ref: this.#branch } : this.#ref;
  }

  #headers(): HeadersInit {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.#token}`,
      // GitHub rejects requests sent with no User-Agent header.
      "User-Agent": "collab-ai-github-provider",
    };
  }

  async #fetchJson(url: string): Promise<FetchResult> {
    const res = await this.#fetchImpl(url, { headers: this.#headers() });
    if (!res.ok) {
      let message = `GitHub returned ${res.status}`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body && typeof body.message === "string") {
          message = `GitHub returned ${res.status}: ${body.message}`;
        }
      } catch {
        // Non-JSON error body; the status-only message stands.
      }
      return { ok: false, status: res.status, error: message };
    }
    const body = await res.json();
    return { ok: true, status: res.status, body };
  }

  #contentsUrl(path: string): string {
    const encoded = path
      .split("/")
      .filter((segment) => segment.length > 0)
      .map(encodeURIComponent)
      .join("/");
    const suffix = encoded ? `/${encoded}` : "";
    return `https://api.github.com/repos/${encodeURIComponent(this.#ref.owner)}/${encodeURIComponent(this.#ref.repo)}/contents${suffix}?ref=${encodeURIComponent(this.#readRef().ref)}`;
  }

  async #list(path: string, depth: number, deny: readonly string[]): Promise<FsResponse> {
    const out: string[] = [];
    let overflow = 0;

    const walk = async (p: string, remainingDepth: number): Promise<FsResponse | null> => {
      const res = await this.#fetchJson(this.#contentsUrl(p));
      if (!res.ok) return { ok: false, error: res.error };

      const items = res.body;
      if (!Array.isArray(items)) {
        return { ok: false, error: `${p || "/"} is a file, not a directory.` };
      }

      const sorted = [...(items as Array<{ name: unknown; path: unknown; type: unknown }>)].sort((a, b) =>
        String(a.name).localeCompare(String(b.name)),
      );

      for (const item of sorted) {
        const itemPath = String(item.path);
        const isDir = item.type === "dir";
        const line = isDir ? `${itemPath}/` : itemPath;

        // Skip before counting, same as the local provider: a denied entry
        // is hidden entirely, not shown-and-refused — a room member should
        // not even learn that the path exists.
        if (isDenied(line, deny)) continue;

        if (out.length < FS_LIMITS.listEntries) {
          out.push(line);
        } else {
          overflow++;
        }

        if (isDir && remainingDepth > 0) {
          const sub = await walk(itemPath, remainingDepth - 1);
          if (sub && !sub.ok) return sub;
        }
      }
      return null;
    };

    const failure = await walk(path, depth);
    if (failure) return failure;
    if (overflow > 0) out.push(`(${overflow} more entries not shown)`);
    return { ok: true, data: out.join("\n") };
  }

  async #read(path: string, offset: number, limit: number): Promise<FsResponse> {
    // A read names one path the deny list can check before any request is
    // made — refuse it here, not after asking GitHub for it.
    if (isDenied(path, this.#deny)) {
      return { ok: false, error: "The room's rules don't allow access to that path." };
    }

    const res = await this.#fetchJson(this.#contentsUrl(path));
    if (!res.ok) return { ok: false, error: res.error };

    const body = res.body;
    if (Array.isArray(body)) {
      return { ok: false, error: `${path} is a directory, not a file.` };
    }

    const file = body as { content?: unknown };
    if (typeof file.content !== "string") {
      return { ok: false, error: `GitHub did not return file content for ${path}.` };
    }

    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(file.content.replace(/\s+/g, ""));
    } catch {
      return { ok: false, error: `GitHub returned content that could not be decoded for ${path}.` };
    }

    const end = offset + limit;
    const text = new TextDecoder().decode(bytes.slice(offset, end));
    const truncated = end < bytes.length;
    return truncated ? { ok: true, data: `${text}\n(truncated at ${end} bytes)` } : { ok: true, data: text };
  }

  async #search(pattern: string, glob: string, max: number, deny: readonly string[]): Promise<FsResponse> {
    // GitHub's code search index only ever covers the default branch. A room
    // that named an explicit branch would get results from the wrong code —
    // confidently, with no indication anything was off — so skip the index
    // entirely and walk the tree instead.
    //
    // "HEAD" is not an explicit branch: parseRepoRef puts it there for a
    // plain "owner/repo" with no @branch suffix, so `ref` is never empty and
    // testing for emptiness would treat every room as having named a branch,
    // quietly retiring the code-search path altogether.
    const explicitBranch = this.#ref.ref.length > 0 && this.#ref.ref !== "HEAD";
    if (explicitBranch) {
      return this.#searchByTree(pattern, glob, max, deny);
    }

    const q = `${pattern} repo:${this.#ref.owner}/${this.#ref.repo}`;
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}`;
    const res = await this.#fetchJson(url);

    if (!res.ok) {
      // 403 is code search's strict 10-requests-per-minute limit (far
      // tighter than the normal 5000/hour), or an unindexed repository
      // (a fork, or one too new to have been indexed yet). 422 is a query
      // the code-search index refuses to run at all. Both are exactly the
      // cases the tree walk handles, and it isn't subject to that limit, so
      // fall back to it instead of surfacing either as a dead end.
      if (res.status === 403 || res.status === 422) {
        return this.#searchByTree(pattern, glob, max, deny);
      }
      return { ok: false, error: res.error };
    }

    const body = res.body as { items?: Array<{ path?: unknown }> };
    const items = Array.isArray(body.items) ? body.items : [];

    // GitHub's code search does not return line numbers for every match, so
    // the output is one `path` per line rather than `path:line: text`.
    const results: string[] = [];
    for (const item of items) {
      const p = typeof item.path === "string" ? item.path : null;
      if (!p) continue;
      if (isDenied(p, deny)) continue;
      if (glob && !matchGlob(glob, p)) continue;
      results.push(p);
      if (results.length >= max) break;
    }
    return { ok: true, data: results.join("\n") };
  }

  /**
   * Fallback search used when code search is unavailable: fetch the tree in
   * one request, filter it down to candidate files, then fetch and grep
   * each candidate directly. This costs one ordinary API request per
   * candidate file rather than one search-index query, so it is bounded by
   * the normal 5000/hour rate limit instead of code search's 10/minute —
   * and, unlike the index, it can be pointed at any branch and covers
   * repositories the index has not (or will not) crawl.
   */
  async #searchByTree(pattern: string, glob: string, max: number, deny: readonly string[]): Promise<FsResponse> {
    const base = await resolveBranchName(this.#token, this.#readRef(), this.#fetchImpl);
    if (!base.ok) return { ok: false, error: base.error };

    const treeUrl = `https://api.github.com/repos/${encodeURIComponent(this.#ref.owner)}/${encodeURIComponent(this.#ref.repo)}/git/trees/${encodeURIComponent(base.branch)}?recursive=1`;
    const treeRes = await this.#fetchJson(treeUrl);
    if (!treeRes.ok) return { ok: false, error: treeRes.error };

    // Read the body defensively: an unexpected shape here becomes an empty
    // tree, never a thrown TypeError.
    const treeBody = treeRes.body as { tree?: unknown; truncated?: unknown };
    const rawTree = Array.isArray(treeBody.tree) ? treeBody.tree : [];
    const treeTruncated = treeBody.truncated === true;

    type Candidate = { path: string; sha: string };
    const candidates: Candidate[] = [];
    for (const raw of rawTree) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as { path?: unknown; type?: unknown; sha?: unknown; size?: unknown };
      if (entry.type !== "blob") continue;
      if (typeof entry.path !== "string" || entry.path.length === 0) continue;
      // SECURITY: apply the deny list before any content is fetched, the
      // same as every other read path in this provider — a denied file
      // must never even be requested, let alone grepped.
      if (isDenied(entry.path, deny)) continue;
      if (glob.length > 0 && !matchGlob(glob, entry.path)) continue;
      const lowerPath = entry.path.toLowerCase();
      if (SEARCH_SKIP_EXT.some((ext) => lowerPath.endsWith(ext))) continue;
      if (typeof entry.size === "number" && entry.size > SEARCH_MAX_FILE_BYTES) continue;
      if (typeof entry.sha !== "string" || entry.sha.length === 0) continue;
      candidates.push({ path: entry.path, sha: entry.sha });
    }

    // Refusing outright would throw away work already paid for: the tree
    // request above already told us exactly which paths match the glob, and
    // naming them costs nothing further. Returning those paths is strictly
    // more useful than a bare refusal — but the wording has to be explicit
    // that these are NOT confirmed matches for `pattern`, only files that
    // matched the glob, so the agent does not go on to report them as hits.
    if (candidates.length > SEARCH_MAX_CANDIDATES) {
      const listed = candidates.slice(0, SEARCH_MAX_LISTED_PATHS).map((c) => c.path);
      const note =
        `${candidates.length} files match, too many to search inside ` +
        `(each one costs a request against a budget the whole turn shares). ` +
        `Showing paths only — narrow with a glob such as "src/**/*.ts", or read one of these directly.`;
      return { ok: true, data: `${note}\n${listed.join("\n")}` };
    }

    if (candidates.length === 0) {
      return { ok: true, data: "" };
    }

    const lowerPattern = pattern.toLowerCase();
    const matches: string[] = [];
    let totalBytes = 0;
    let byteBudgetExhausted = false;

    for (let i = 0; i < candidates.length && matches.length < max && !byteBudgetExhausted; i += SEARCH_CONCURRENCY) {
      const batch = candidates.slice(i, i + SEARCH_CONCURRENCY);
      const texts = await Promise.all(
        batch.map(async (candidate): Promise<{ path: string; text: string; byteLength: number } | null> => {
          const blobUrl = `https://api.github.com/repos/${encodeURIComponent(this.#ref.owner)}/${encodeURIComponent(this.#ref.repo)}/git/blobs/${encodeURIComponent(candidate.sha)}`;
          // A failing fetch for one file is not fatal to the whole search —
          // skip it and carry on with the rest of the batch.
          const blobRes = await this.#fetchJson(blobUrl);
          if (!blobRes.ok) return null;

          const blobBody = blobRes.body as { content?: unknown; encoding?: unknown };
          if (blobBody.encoding !== "base64" || typeof blobBody.content !== "string") return null;

          try {
            // GitHub's blob API wraps its base64 with embedded newlines;
            // strip all whitespace before decoding.
            const bytes = base64ToBytes(blobBody.content.replace(/\s+/g, ""));
            return { path: candidate.path, text: new TextDecoder().decode(bytes), byteLength: bytes.length };
          } catch {
            // A binary file that slipped past the extension filter — skip
            // it rather than let a decode failure throw.
            return null;
          }
        }),
      );

      for (const result of texts) {
        if (!result) continue;
        totalBytes += result.byteLength;

        const lines = result.text.split("\n");
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          if (matches.length >= max) break;
          const line = lines[lineIndex]!;
          // Literal substring match, deliberately not a regular expression:
          // `pattern` comes from a model, and compiling model-supplied text
          // as a regex is both a correctness surprise (accidental regex
          // metacharacters) and a denial-of-service risk (catastrophic
          // backtracking), for no benefit a plain literal search doesn't
          // already give a room member.
          if (line.toLowerCase().includes(lowerPattern)) {
            matches.push(`${result.path}:${lineIndex + 1}: ${line.trim().slice(0, 200)}`);
          }
        }
        if (matches.length >= max) break;
      }

      if (totalBytes > SEARCH_MAX_TOTAL_BYTES) {
        byteBudgetExhausted = true;
      }
    }

    const matchCapHit = matches.length >= max;
    if (treeTruncated || byteBudgetExhausted || matchCapHit) {
      matches.push("(results truncated — narrow the glob or the search term for more)");
    }
    return { ok: true, data: matches.join("\n") };
  }

  /** Read one file's text off a specific ref. */
  async #readOnBranch(path: string, branch: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const url = `https://api.github.com/repos/${encodeURIComponent(this.#ref.owner)}/${encodeURIComponent(this.#ref.repo)}/contents/${encodeContentsPath(path)}?ref=${encodeURIComponent(branch)}`;
    const res = await this.#fetchJson(url);
    if (!res.ok) return { ok: false, error: res.error };

    const body = res.body;
    if (Array.isArray(body)) {
      return { ok: false, error: `${path} is a directory, not a file.` };
    }
    const file = body as { content?: unknown };
    if (typeof file.content !== "string") {
      return { ok: false, error: `GitHub did not return file content for ${path}.` };
    }

    try {
      const bytes = base64ToBytes(file.content.replace(/\s+/g, ""));
      return { ok: true, text: new TextDecoder().decode(bytes) };
    } catch {
      return { ok: false, error: `GitHub returned content that could not be decoded for ${path}.` };
    }
  }

  /**
   * Make sure the working branch exists, branched off the current head of
   * `#ref`. Every write op does this first: nothing is ever committed
   * straight to the default branch, only to `#branch`, which later becomes
   * a pull request a human reviews.
   */
  async #ensureWorkingBranch(): Promise<{ ok: true } | { ok: false; error: string }> {
    const head = await refHead(this.#token, this.#ref, this.#fetchImpl);
    if (!head.ok) return head;
    const branch = await ensureBranch(this.#token, this.#ref, this.#branch, head.sha, this.#fetchImpl);
    if (!branch.ok) return branch;
    return { ok: true };
  }

  async #write(path: string, content: string): Promise<FsResponse> {
    // Same discipline as the read path: the deny list is checked before any
    // network call, not after.
    if (isDenied(path, this.#deny)) {
      return { ok: false, error: "The room's rules don't allow access to that path." };
    }

    const branch = await this.#ensureWorkingBranch();
    if (!branch.ok) return branch;

    const res = await commitFile(
      this.#token,
      this.#ref,
      this.#branch,
      path,
      content,
      `Update ${path} via collab_ai`,
      this.#fetchImpl,
    );
    if (!res.ok) return res;
    return { ok: true, data: `Wrote ${path} on branch ${this.#branch} (commit ${res.commitSha}).` };
  }

  async #edit(path: string, oldText: string, newText: string): Promise<FsResponse> {
    if (isDenied(path, this.#deny)) {
      return { ok: false, error: "The room's rules don't allow access to that path." };
    }

    // Match against the same ref that `read_file` exposes. Before this room
    // has created a working branch, that is the connected repository ref. If
    // a prior write succeeded, #readRef() follows the working branch instead.
    // Reading the working branch unconditionally here made a freshly-read
    // base-branch span look missing to edit_file.
    const current = await this.#readOnBranch(path, this.#readRef().ref);
    if (!current.ok) return current;

    // Same unique-match-or-reject contract as the local provider (and
    // edit_doc in src/server/tools.ts): the span must appear exactly once,
    // or nothing changes.
    const match = findUniqueText(current.text, oldText);
    if (!match.ok && match.reason === "empty") {
      return { ok: false, error: "old_text must contain the exact text to replace." };
    }
    if (!match.ok && match.reason === "missing") {
      return {
        ok: false,
        error:
          "old_text was not found in the file. Read it again to get the current " +
          "text, then retry with an exact span from it.",
      };
    }
    if (!match.ok) {
      return {
        ok: false,
        error:
          "old_text appears more than once, so the target is ambiguous. Include " +
          "more surrounding context to make it unique.",
      };
    }

    const branch = await this.#ensureWorkingBranch();
    if (!branch.ok) return branch;

    const updated = current.text.slice(0, match.index) + newText + current.text.slice(match.index + oldText.length);

    const res = await commitFile(
      this.#token,
      this.#ref,
      this.#branch,
      path,
      updated,
      `Update ${path} via collab_ai`,
      this.#fetchImpl,
    );
    if (!res.ok) return res;
    return { ok: true, data: `Edited ${path} on branch ${this.#branch} (commit ${res.commitSha}).` };
  }

  async #remove(path: string): Promise<FsResponse> {
    if (isDenied(path, this.#deny)) {
      return { ok: false, error: "The room's rules don't allow access to that path." };
    }

    const branch = await this.#ensureWorkingBranch();
    if (!branch.ok) return branch;

    const res = await deleteFile(
      this.#token,
      this.#ref,
      this.#branch,
      path,
      `Remove ${path} via collab_ai`,
      this.#fetchImpl,
    );
    if (!res.ok) return res;
    return { ok: true, data: `Removed ${path} on branch ${this.#branch}.` };
  }

  async perform(req: FsRequest): Promise<FsResponse> {
    try {
      switch (req.op) {
        case "list":
          return await this.#list(req.path, req.depth, req.deny ?? []);
        case "read":
          return await this.#read(req.path, req.offset, req.limit);
        case "search":
          return await this.#search(req.pattern, req.glob, req.max, req.deny ?? []);
        case "write":
          return await this.#write(req.path, req.content);
        case "edit":
          return await this.#edit(req.path, req.oldText, req.newText);
        case "remove":
          return await this.#remove(req.path);
        default:
          return { ok: false, error: "Unsupported operation." };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "GitHub request failed unexpectedly." };
    }
  }

  /**
   * Open a pull request from the working branch into `#ref`'s branch.
   *
   * Not part of `WorkspaceProvider` — nothing in the normal read/write flow
   * calls this. A room calls it directly once it wants to ship what has
   * accumulated on the working branch: the room's vote is the approval, and
   * this is what turns that approval into something a human reviews on
   * GitHub.
   */
  async openPr(title: string, body: string): Promise<FsResponse> {
    const base = await resolveBranchName(this.#token, this.#ref, this.#fetchImpl);
    if (!base.ok) return base;

    const pr = await openPullRequest(this.#token, this.#ref, this.#branch, base.branch, title, body, this.#fetchImpl);
    if (!pr.ok) return pr;
    return { ok: true, data: `Opened pull request #${pr.number}: ${pr.url}` };
  }
}

export type UserRepo = { fullName: string; private: boolean; defaultBranch: string };

export type UserInstallation = {
  id: string;
  accountId: string;
  accountLogin: string;
  targetType: "User" | "Organization";
};

/**
 * Narrow GitHub's installation entries, dropping anything malformed.
 *
 * Shared by the two listings below because they return the same objects
 * through different envelopes — an installation is an installation whether
 * the App or a person asked for it.
 */
function mapInstallations(items: unknown[]): UserInstallation[] {
  const installations: UserInstallation[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as {
      id?: unknown;
      target_type?: unknown;
      account?: { id?: unknown; login?: unknown } | null;
    };
    if (typeof entry.id !== "number" || !Number.isSafeInteger(entry.id) || entry.id <= 0) continue;
    if (entry.target_type !== "User" && entry.target_type !== "Organization") continue;
    if (typeof entry.account?.id !== "number" || !Number.isSafeInteger(entry.account.id)) continue;
    if (typeof entry.account.login !== "string" || entry.account.login.length === 0) continue;
    installations.push({
      id: String(entry.id),
      accountId: String(entry.account.id),
      accountLogin: entry.account.login,
      targetType: entry.target_type,
    });
  }
  return installations;
}

/**
 * List this GitHub App's installations that the authenticated user may access.
 *
 * Only a GitHub App user-to-server token may call this. A deployment whose
 * OAuth credentials belong to a classic OAuth App cannot mint one and gets a
 * 403 here whoever is signed in — see listAppInstallations for the route that
 * still answers in that case.
 */
export async function listUserInstallations(
  token: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; installations: UserInstallation[] } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? runtimeFetch;
  const installations: UserInstallation[] = [];
  try {
    for (let page = 1; page <= 100; page++) {
      const res = await doFetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
        headers: ghHeaders(token),
      });
      if (!res.ok) return { ok: false, error: await ghErrorMessage(res) };
      const body = (await res.json()) as { installations?: unknown };
      const items = Array.isArray(body.installations) ? body.installations : [];
      installations.push(...mapInstallations(items));
      if (items.length < 100) break;
    }
    return { ok: true, installations };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to list GitHub App installations." };
  }
}

/**
 * List every installation of this GitHub App, authenticated as the App itself.
 *
 * Asks what listUserInstallations asks, but with the App's own JWT — which
 * always works, because an App may always enumerate its own installations
 * whatever kind of credential the connecting person happens to hold.
 *
 * It answers a weaker question, and the difference is the whole reason this
 * needs a warning: "does this installation exist", not "may this person use
 * it". Every installation of the App is in this list, including other
 * people's. A caller has to supply the missing half by checking the
 * installation's account against whoever authorised — see the caller in
 * room.ts, the only place entitled to read this as an authorization answer.
 */
export async function listAppInstallations(
  cfg: GithubConfig,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; installations: UserInstallation[] } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? runtimeFetch;
  const installations: UserInstallation[] = [];
  try {
    const jwt = await appJwt(cfg);
    for (let page = 1; page <= 100; page++) {
      const res = await doFetch(`https://api.github.com/app/installations?per_page=100&page=${page}`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          // GitHub rejects requests sent with no User-Agent header.
          "User-Agent": "collab-ai-github-app",
        },
      });
      if (!res.ok) return { ok: false, error: await ghErrorMessage(res) };
      // Unlike /user/installations, this route returns a bare array.
      const body = (await res.json()) as unknown;
      const items = Array.isArray(body) ? body : [];
      installations.push(...mapInstallations(items));
      if (items.length < 100) break;
    }
    return { ok: true, installations };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to list GitHub App installations." };
  }
}

function mapUserRepos(body: unknown): UserRepo[] {
  const items = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null && Array.isArray((body as { repositories?: unknown }).repositories)
      ? (body as { repositories: unknown[] }).repositories
      : [];
  const repos: UserRepo[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as { full_name?: unknown; private?: unknown; default_branch?: unknown };
    if (typeof entry.full_name !== "string" || entry.full_name.length === 0) continue;
    repos.push({
      fullName: entry.full_name,
      private: entry.private === true,
      defaultBranch: typeof entry.default_branch === "string" && entry.default_branch.length > 0
        ? entry.default_branch
        : "",
    });
  }
  return repos;
}

async function listRepoPages(
  token: string,
  endpoint: (page: number) => string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; repos: UserRepo[] } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? runtimeFetch;
  const repos: UserRepo[] = [];
  try {
    for (let page = 1; page <= 100; page++) {
      const res = await doFetch(endpoint(page), { headers: ghHeaders(token) });
      if (!res.ok) return { ok: false, error: await ghErrorMessage(res) };
      const pageRepos = mapUserRepos(await res.json());
      repos.push(...pageRepos);
      if (pageRepos.length < 100) break;
    }
    return { ok: true, repos };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to list repositories." };
  }
}

/**
 * List repositories the OAuth-connecting person can see, to populate a
 * picker on the client.
 *
 * This is used only to fill that one picker for the person who just
 * authorised: the result is sent to that one person's socket and never
 * broadcast to the rest of the room. The 100-result cap is deliberately not
 * paginated — a picker with a search box over the 100 most recently updated
 * repositories is enough for someone choosing which one to connect; nobody
 * is scrolling through their entire account here.
 */
export async function listUserRepos(
  token: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; repos: UserRepo[] } | { ok: false; error: string }> {
  return listRepoPages(
    token,
    (page) => `https://api.github.com/user/repos?sort=updated&per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`,
    fetchImpl,
  );
}

/** List repositories granted to a GitHub App installation, including private repositories. */
export async function listInstallationRepos(
  token: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; repos: UserRepo[] } | { ok: false; error: string }> {
  return listRepoPages(
    token,
    (page) => `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
    fetchImpl,
  );
}
