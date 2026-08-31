/**
 * Which of the two hostnames this bundle is being served from.
 *
 * One Worker and one build answer both huddleai.org and app.huddleai.org (see
 * the routes in wrangler.jsonc). The apex is the waitlist: the same landing
 * page, ending in an email form instead of a sign-in. The subdomain is the
 * product. Nothing about the split is a build flag, so a preview of either can
 * be opened from the same dev server.
 */
const WAITLIST_HOSTS = new Set(["huddleai.org", "www.huddleai.org"]);

export function isWaitlistHost(): boolean {
  if (typeof location === "undefined") return false;
  // `?waitlist=1` is how the apex page is opened against localhost or a
  // *.workers.dev preview, where the hostname cannot say which site this is.
  if (new URLSearchParams(location.search).get("waitlist") === "1") return true;
  return WAITLIST_HOSTS.has(location.hostname);
}

/** Where a gated app host sends someone who has no way in yet. */
export const WAITLIST_URL = "https://huddleai.org/";

// The deployed app. Local dev and *.workers.dev are deliberately absent: the
// gate below is a product decision about the public address, not something that
// should stand between anyone and a dev server.
const GATED_APP_HOSTS = new Set(["app.huddleai.org"]);

/**
 * Whether a signed-out visitor to this host's root belongs on the waitlist
 * instead of in front of a sign-in.
 *
 * `?app=1` opts out, which is how someone who is meant to be let in reaches the
 * sign-in before they have an identity stored.
 */
export function isAppGated(): boolean {
  if (typeof location === "undefined") return false;
  if (new URLSearchParams(location.search).get("app") === "1") return false;
  return GATED_APP_HOSTS.has(location.hostname);
}
