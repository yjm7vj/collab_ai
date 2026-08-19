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

import { FS_LIMITS, matchGlob, type FsRequest, type FsResponse } from "../shared/workspace";
import type { WorkspaceProvider } from "./workspace";

export type GithubConfig = {
  appId: string;
  /** PKCS#8 PEM. See pemToPkcs8 below for why. */
  privateKeyPem: string;
};

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

/** Exchange the App JWT for an installation token. Short-lived; never store it. */
export async function installationToken(
  cfg: GithubConfig,
  installationId: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; token: string; expiresAt: string } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? fetch;
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

/** A read-only provider over the GitHub contents API. */
export class GithubProvider implements WorkspaceProvider {
  readonly kind = "github" as const;
  readonly label: string;

  #token: string;
  #ref: RepoRef;
  #deny: readonly string[];
  #fetchImpl: typeof fetch;

  constructor(token: string, ref: RepoRef, deny: readonly string[], fetchImpl?: typeof fetch) {
    this.#token = token;
    this.#ref = ref;
    this.#deny = deny;
    this.#fetchImpl = fetchImpl ?? fetch;
    this.label = `${ref.owner}/${ref.repo}`;
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
    return `https://api.github.com/repos/${encodeURIComponent(this.#ref.owner)}/${encodeURIComponent(this.#ref.repo)}/contents${suffix}?ref=${encodeURIComponent(this.#ref.ref)}`;
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
    const q = `${pattern} repo:${this.#ref.owner}/${this.#ref.repo}`;
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}`;
    const res = await this.#fetchJson(url);

    if (!res.ok) {
      if (res.status === 403) {
        return {
          ok: false,
          error:
            "GitHub rate-limited or refused this code search (403). Code search has strict rate limits — wait a bit and try a narrower query.",
        };
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
        case "edit":
        case "remove":
          return { ok: false, error: "This workspace is read-only." };
        default:
          return { ok: false, error: "Unsupported operation." };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "GitHub request failed unexpectedly." };
    }
  }
}
