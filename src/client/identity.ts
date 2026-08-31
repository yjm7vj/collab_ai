/**
 * Where the signed identity token lives in this browser.
 *
 * One line of shared truth, because two things now need it: App, which mints
 * it at sign-in and sends it with every sidebar sync, and the workflow library,
 * which syncs from inside a room. A second copy of this key string would be a
 * bug waiting for someone to change one of them.
 *
 * The token is signed, not secret to the person holding it — but it is their
 * identity, so it goes nowhere except this app's own /api routes.
 */
export const IDENTITY_KEY = "collab_ai:identity";

export function storedIdentity(): string | null {
  return localStorage.getItem(IDENTITY_KEY);
}

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return atob(padded + pad);
}

/**
 * Decode the display fields from an identity token.
 *
 * The token is signed, not encrypted, so reading it for display is safe.
 * This is NOT an authorisation check — the server verifies the signature on
 * every request, and nothing decoded here may decide what a user can do.
 */
export function readIdentity(token: string): { uid: string; name: string } | null {
  try {
    const payload = token.split(".")[0];
    if (!payload) return null;
    const parsed = JSON.parse(base64UrlDecode(payload)) as { uid?: unknown; role?: unknown };
    if (typeof parsed.uid !== "string" || typeof parsed.role !== "string") return null;
    return { uid: parsed.uid, name: parsed.role };
  } catch {
    return null;
  }
}

/**
 * Which account this browser is currently signed in as, or null.
 *
 * Used to tell one person's cached data apart from the next person's on a
 * shared browser — never to decide what anybody may do.
 */
export function identityUid(): string | null {
  const token = storedIdentity();
  return token ? readIdentity(token)?.uid ?? null : null;
}
