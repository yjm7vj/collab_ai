/**
 * The session cookie: how a browser proves who it is when it opens a socket.
 *
 * A WebSocket upgrade cannot carry an Authorization header — the browser API
 * has no way to set one — so the room credential used to travel in the URL as
 * `?tk=`. Query strings are recorded in full by Cloudflare's request logs and
 * by anything else in front of the Worker, which put a week-long room
 * credential into log storage on every connect.
 *
 * A cookie is attached to the upgrade by the browser instead, so it never
 * appears in a URL, and — being HttpOnly — is not readable by script either.
 * It also costs nothing per connect: there is no ticket to mint and no round
 * trip in front of a reconnect, which matters because reconnects arrive in
 * storms (a deploy, a colo failover, a laptop waking up) rather than evenly.
 *
 * THE TRADE THIS MAKES. A cookie is attached by the browser to *any* upgrade
 * aimed at this origin, including one opened by a hostile page — a forged
 * `?tk=` was impossible, a forged cookie-bearing handshake is not, and
 * WebSocket handshakes are not covered by CORS. `sameOrigin` below is the
 * mitigation and is not optional; see its use in `onBeforeConnect`.
 */

import { mintToken, verifyToken } from "./auth";
import { IDENTITY_MARKER, UID_RE } from "../shared/protocol";

export const SESSION_COOKIE = "hu_session";

/** Matches the identity token's own life, so neither outlives the other. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Read one cookie out of a request.
 *
 * Deliberately tolerant of the header's shape (spacing, a trailing `;`) and
 * deliberately strict about the name: a prefix match would let `hu_session_x`
 * answer for `hu_session`.
 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value.length ? value : null;
  }
  return null;
}

/**
 * The Set-Cookie value that establishes a session.
 *
 * `Lax` rather than `Strict`: the OAuth callback returns here as a top-level
 * cross-site navigation, and `Strict` would withhold the cookie on exactly
 * that first landing. Lax still withholds it from cross-site subresource
 * requests, and the origin check on the upgrade covers what remains.
 *
 * `Secure` is unconditional. Browsers make an explicit exception for
 * http://localhost, so this does not have to be relaxed for local development.
 */
export function sessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ");
}

/** The Set-Cookie value that ends one. Attributes must match to overwrite. */
export function clearedSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=0"].join("; ");
}

/** Mint the token that goes in the cookie. Same shape as an identity token. */
export function mintSession(
  secret: string,
  identity: { uid: string; name: string; avatar: string },
  /**
   * Latest allowed expiry, in Unix seconds. Passed when the session is being
   * exchanged for a weaker, shorter-lived credential: a session must never
   * outlive the thing that proved it, or the exchange would be a way to turn
   * a week of access into a month of it.
   */
  notAfter?: number,
): Promise<string> {
  const ceiling = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  return mintToken(secret, {
    rid: IDENTITY_MARKER,
    uid: identity.uid,
    // The display name rides in `role` because the token shape is fixed —
    // the same convention the identity token already uses.
    role: identity.name.slice(0, 32),
    avatar: identity.avatar,
    exp: notAfter === undefined ? ceiling : Math.min(ceiling, notAfter),
  });
}

/**
 * The uid a request's session cookie proves, or null.
 *
 * Returns null for a room token presented as a session: `rid` is the identity
 * marker here and a real room id there, so one can never stand in for the
 * other.
 */
export async function sessionUid(request: Request, secret: string): Promise<string | null> {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (!cookie) return null;
  const claims = await verifyToken(secret, cookie);
  if (!claims) return null;
  if (claims.rid !== IDENTITY_MARKER) return null;
  if (!UID_RE.test(claims.uid)) return null;
  return claims.uid;
}

/**
 * Whether a request was made by a page on this deployment.
 *
 * A WebSocket handshake carries `Origin` but is not subject to CORS, so this
 * is the only thing standing between a hostile page and a cookie-authenticated
 * socket. A missing Origin is refused rather than allowed: every browser sends
 * one on a WebSocket handshake, so its absence is not a browser.
 */
export function sameOrigin(request: Request, expected: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin === expected;
}
