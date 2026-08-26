/**
 * OAuth provider logic for GitHub and Google sign-in.
 *
 * Today a person's identity is a random id their browser generates and
 * stores in localStorage — the server just signs a room token around
 * whatever uid it is handed. This module is the first half of replacing
 * that with real sign-in: it turns a third-party account into the same
 * kind of stable `uid` the rest of the app already understands (see
 * `deriveUid`), so nothing downstream — rooms, tokens, presence — has to
 * learn what an OAuth provider even is. It builds authorize URLs,
 * exchanges codes, fetches profiles, and derives that id. No routes, no
 * room changes, no UI: wiring this in is a separate task.
 *
 * THE STATE PARAMETER IS A SIGNED TOKEN, NOT A RANDOM VALUE IN A COOKIE
 * The usual OAuth CSRF defence is a random `state` stashed in a session
 * cookie and compared on return. This Worker has no session store — every
 * request is independently handled — so instead `state` is itself a signed
 * token (see `signState`/`verifyState` below, built on `mintToken` and
 * `verifyToken` from ./auth). The signature is the guarantee: only this
 * server could have minted it, and it round-trips the two things the
 * callback needs (which provider, and where to send the browser back)
 * without needing anywhere to store them in between.
 *
 * NEVER THROWS
 * Same discipline as auth.ts and github.ts: every exported function here
 * returns a result or an error value, never a thrown exception. A network
 * failure, a malformed provider response, or an invalid token becomes
 * `{ ok: false, error }` or `null`, not something a caller has to remember
 * to catch.
 */

import { mintToken, verifyToken } from "./auth";

export type OAuthProvider = "github" | "google";

export type OAuthConfig = { clientId: string; clientSecret: string };

/** A signed-in person, normalised across providers. */
export type OAuthProfile = {
  provider: OAuthProvider;
  /** The provider's own immutable id for this account. Never an email. */
  providerId: string;
  /** Display name, best effort — may be empty. */
  name: string;
  /** Avatar URL, or "" when the provider gives none. */
  avatar: string;
};

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * A stable app-level user id derived from the provider and its account id.
 *
 * Derived by hashing, not by concatenation: the raw value goes in a URL and
 * a token, and a provider id is not guaranteed to be URL-safe or to fit
 * UID_RE (GitHub's numeric ids do, but nothing guarantees Google's `sub`
 * stays that friendly forever). Hashing also means the app never stores the
 * provider's id verbatim. The same (provider, providerId) pair always
 * hashes to the same uid — that determinism is the whole point: signing in
 * again must return the same account, not mint a new one.
 */
export async function deriveUid(provider: OAuthProvider, providerId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${provider}:${providerId}`));
  return bytesToHex(new Uint8Array(digest)).slice(0, 32);
}

/** Where to send the browser to begin sign-in. */
export function authorizeUrl(provider: OAuthProvider, clientId: string, redirectUri: string, state: string): string {
  if (provider === "github") {
    // read:user is the narrowest scope that yields a stable id and a
    // display name. Deliberately not `user:email` (no email needed) and
    // deliberately no repository scope — this is sign-in, not the GitHub
    // App installation flow in github.ts.
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: "read:user",
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  // Google: openid gives a stable `sub`, profile gives a display name.
  // Deliberately not `email` — same reasoning as GitHub above.
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    scope: "openid profile",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** The scope that lets the agent read and write a repository the person picks. */
export const GITHUB_REPO_SCOPE = "repo";

/**
 * Where to send the browser to authorise repository access.
 *
 * Deliberately separate from `authorizeUrl` above: sign-in asks for
 * `read:user` and nothing else, so merely signing in to this app never
 * grants anyone access to a person's repositories. The broader `repo` scope
 * is requested only at the moment somebody actually clicks "Connect GitHub"
 * on a room, and (per the caller in index.ts) only when that person is a
 * room owner or admin — never as a side effect of signing in.
 */
export function repoAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: GITHUB_REPO_SCOPE,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/** Pull a human-readable error out of a provider's token/error response body. */
function extractError(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  if (typeof body.error_description === "string" && body.error_description.length > 0) {
    return body.error_description;
  }
  if (typeof body.error === "string" && body.error.length > 0) {
    return body.error;
  }
  return null;
}

/** Exchange the authorization code for an access token. */
export async function exchangeCode(
  provider: OAuthProvider,
  cfg: OAuthConfig,
  code: string,
  redirectUri: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? fetch;
  try {
    const url =
      provider === "github" ? "https://github.com/login/oauth/access_token" : "https://oauth2.googleapis.com/token";

    const form = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    if (provider === "google") {
      form.set("grant_type", "authorization_code");
    }

    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Without this GitHub returns form-encoded (not JSON) on success,
        // and the JSON parse below would fail — the classic trap.
        Accept: "application/json",
      },
      body: form.toString(),
    });

    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }

    if (!res.ok) {
      return { ok: false, error: extractError(body) ?? `${provider} returned ${res.status}` };
    }

    // A 200 whose body carries an `error` field is ALSO a failure — GitHub
    // does this (e.g. a reused or expired code comes back as HTTP 200 with
    // {"error":"bad_verification_code",...}), so res.ok alone is not enough.
    const bodyError = extractError(body);
    if (bodyError) {
      return { ok: false, error: bodyError };
    }

    const accessToken = body && typeof body.access_token === "string" ? body.access_token : null;
    if (!accessToken) {
      return { ok: false, error: `${provider} did not return an access token.` };
    }
    return { ok: true, accessToken };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to exchange the authorization code." };
  }
}

/** Fetch the signed-in user's profile. */
export async function fetchProfile(
  provider: OAuthProvider,
  accessToken: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; profile: OAuthProfile } | { ok: false; error: string }> {
  const doFetch = fetchImpl ?? fetch;
  try {
    if (provider === "github") {
      const res = await doFetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          // GitHub rejects requests sent with no User-Agent header.
          "User-Agent": "collab-ai-oauth",
        },
      });
      if (!res.ok) return { ok: false, error: `GitHub returned ${res.status}` };

      const body = (await res.json()) as { id?: unknown; name?: unknown; login?: unknown; avatar_url?: unknown };
      // A response missing the id is a failure, not a profile with an empty
      // id — an empty provider id would collapse every user who hit this
      // path onto the same derived uid.
      if (typeof body.id !== "number") {
        return { ok: false, error: "GitHub did not return a user id." };
      }
      const name = typeof body.name === "string" && body.name.length > 0
        ? body.name
        : typeof body.login === "string"
          ? body.login
          : "";
      const avatar = typeof body.avatar_url === "string" ? body.avatar_url : "";
      return {
        ok: true,
        profile: { provider, providerId: String(body.id), name, avatar },
      };
    }

    const res = await doFetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { ok: false, error: `Google returned ${res.status}` };

    const body = (await res.json()) as { sub?: unknown; name?: unknown; picture?: unknown };
    if (typeof body.sub !== "string" || body.sub.length === 0) {
      return { ok: false, error: "Google did not return a user id." };
    }
    const name = typeof body.name === "string" ? body.name : "";
    const avatar = typeof body.picture === "string" ? body.picture : "";
    return {
      ok: true,
      profile: { provider, providerId: body.sub, name, avatar },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to fetch the user profile." };
  }
}

/** Whether a provider is configured on this deployment. */
export function isConfigured(cfg: Partial<OAuthConfig> | undefined): boolean {
  if (!cfg || typeof cfg.clientId !== "string" || typeof cfg.clientSecret !== "string") {
    return false;
  }

  // Treat the values from .dev.vars.example as unset. Otherwise a fresh local
  // checkout advertises an OAuth button that can only fail at the provider.
  const placeholders = new Set([
    "replace-with-github-oauth-client-id",
    "replace-with-github-oauth-client-secret",
    "replace-with-google-oauth-client-id",
    "replace-with-google-oauth-client-secret",
  ]);
  return cfg.clientId.length > 0 && cfg.clientSecret.length > 0
    && !placeholders.has(cfg.clientId)
    && !placeholders.has(cfg.clientSecret);
}

// Marks a state token so it can never be mistaken for a room token even
// though both are minted by the same mintToken/verifyToken machinery — a
// room token always carries a real room id here, and no room id can ever
// equal this constant (room ids are newId(22): unpunctuated base62).
const OAUTH_STATE_MARKER = "oauth";

// 10 minutes: long enough to cover a real sign-in round trip (redirect to
// the provider, the person authenticating there, redirect back) and short
// enough to bound how long a captured state parameter could be replayed.
const STATE_TTL_SECONDS = 600;

const RETURN_TO_RE = /^\/(?!\/)(?!.*\/\/).*$/;

/**
 * A relative path is safe to redirect to; anything else is an open
 * redirect waiting to happen — an attacker-controlled absolute URL (or a
 * protocol-relative "//evil.example") in `returnTo` would send a browser
 * that just proved its identity straight off this site.
 */
function isSafeReturnTo(returnTo: string): boolean {
  return RETURN_TO_RE.test(returnTo);
}

/**
 * Mint the signed `state` for an authorization request.
 *
 * Built on mintToken/verifyToken from ./auth rather than a separate signing
 * scheme, so this reuses the one HMAC implementation in the codebase. It
 * piggybacks on TokenClaims's existing fields rather than inventing a new
 * payload shape: `role` carries the provider (it's just a string field to
 * TokenClaims) and `uid` carries `returnTo` (also just a string). `rid` is
 * set to the constant OAUTH_STATE_MARKER instead of a real room id — that
 * is the security-relevant bit: verifyState rejects anything whose `rid`
 * isn't that marker, so a genuine room token (which always carries a real
 * room id in `rid`) can never be replayed as if it were sign-in state, and
 * vice versa. The two token namespaces stay disjoint even though they share
 * one signing function.
 */
export async function signState(
  secret: string,
  provider: OAuthProvider,
  returnTo: string,
  nowSeconds?: number,
): Promise<string> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  return mintToken(secret, {
    rid: OAUTH_STATE_MARKER,
    uid: returnTo,
    role: provider,
    exp: now + STATE_TTL_SECONDS,
  });
}

export async function verifyState(
  secret: string,
  state: string,
  nowSeconds?: number,
): Promise<{ provider: OAuthProvider; returnTo: string } | null> {
  const claims = await verifyToken(secret, state, nowSeconds);
  if (!claims) return null;
  // The namespace check described in signState's comment: only a token
  // minted by signState ever carries this marker in rid.
  if (claims.rid !== OAUTH_STATE_MARKER) return null;
  if (claims.role !== "github" && claims.role !== "google") return null;
  if (!isSafeReturnTo(claims.uid)) return null;
  return { provider: claims.role, returnTo: claims.uid };
}

/** Marks an OAuth state token as a repository connect for a specific room. */
export const GITHUB_REPO_STATE_ROLE = "gh-repo";

/**
 * Whether a set of verified token claims is a repository-connect state
 * rather than a room token or a sign-in state.
 *
 * The repository-connect round trip reuses the same mintToken/verifyToken
 * claims shape as everything else here, but with a different meaning for
 * each field: the room id being connected rides in `rid`, and the uid of
 * the member who clicked "Connect GitHub" rides in `uid` (the Durable
 * Object mints this token itself, via mintToken — there is no separate
 * signing path in this file). `role` is set to GITHUB_REPO_STATE_ROLE so the
 * callback can tell this apart from a genuine room token: a real room token
 * always carries one of the actual room roles (owner/admin/editor/viewer) in
 * `role`, and "gh-repo" is never one of them, so the two can never be
 * confused for one another even though both are minted by the same HMAC
 * machinery.
 */
export function isRepoConnectState(claims: { rid: string; uid: string; role: string }): boolean {
  return claims.role === GITHUB_REPO_STATE_ROLE;
}
