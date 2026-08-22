/**
 * Integration tests for connecting a GitHub repository over OAuth.
 *
 * The interesting surface is the callback, because ONE registered callback URL
 * serves two different flows — signing in, and authorising repository access —
 * told apart by nothing but the signed `state` parameter. That makes the
 * question "can one flow's state be replayed as the other's?" the whole
 * security story, and it is what most of this file asks.
 *
 * Nothing here reaches the network. Every case is arranged so the Worker
 * refuses before it would ever call GitHub, which is also why there is no test
 * for a *successful* exchange: that one cannot be written without either a live
 * credential or a stub the Worker has no seam for.
 */
import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mintToken } from "../src/server/auth";

const ORIGIN = "https://collab-ai.test";
const ROOM_ID = "A".repeat(22);

/** Mirrors GITHUB_REPO_STATE_ROLE in src/server/oauth.ts. Part of the wire contract. */
const REPO_STATE_ROLE = "gh-repo";

function future(): number {
  return Math.floor(Date.now() / 1000) + 600;
}

/**
 * Turn GitHub sign-in on for this file only.
 *
 * The rest of the suite deliberately runs with no provider configured, because
 * that is the shape of a fresh deployment. These tests need the opposite, so
 * they set the two secrets up front and put them back afterwards rather than
 * changing the pool's bindings for everyone.
 */
const saved: Record<string, unknown> = {};
beforeAll(() => {
  saved.id = (env as Record<string, unknown>).GITHUB_OAUTH_CLIENT_ID;
  saved.secret = (env as Record<string, unknown>).GITHUB_OAUTH_CLIENT_SECRET;
  (env as Record<string, unknown>).GITHUB_OAUTH_CLIENT_ID = "test-client-id";
  (env as Record<string, unknown>).GITHUB_OAUTH_CLIENT_SECRET = "test-client-secret";
});
afterAll(() => {
  (env as Record<string, unknown>).GITHUB_OAUTH_CLIENT_ID = saved.id;
  (env as Record<string, unknown>).GITHUB_OAUTH_CLIENT_SECRET = saved.secret;
});

describe("configuring repository access does not gate the whole app", () => {
  /**
   * The GitHub OAuth credentials do double duty: they power the in-room
   * "Connect GitHub" repository flow. Counting their presence as a sign-in
   * provider forced everyone through a GitHub login before they could so
   * much as create a room, purely because some room wanted repository
   * access. These two assertions are what stop that coming back.
   */
  it("does not advertise github as a sign-in provider", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/auth/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [] });
  });

  it("still lets someone create a room without signing in", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid: "anon-abcdef12", name: "Anon" }),
    });
    expect(res.status).toBe(200);
    await res.json();
  });

  /**
   * The single most important assertion about this feature. Repository access
   * needs the broad `repo` scope; sign-in must never ask for it, or every
   * person who ever signed in would have handed this app read and write access
   * to all of their repositories as a side effect.
   */
  it("still asks only for read:user when starting sign-in", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/auth/github/start?returnTo=/`, { redirect: "manual" });
    expect(res.status).toBe(302);

    const target = new URL(res.headers.get("location") ?? "");
    expect(`${target.origin}${target.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(target.searchParams.get("scope")).toBe("read:user");
  });
});

describe("the shared callback keeps the two flows apart", () => {
  it("refuses a callback with no code", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/auth/github/callback?state=whatever`);
    expect(res.status).toBe(400);
    await res.text();
  });

  it("refuses an unsigned state", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/auth/github/callback?code=abc&state=not-a-token`);
    expect(res.status).toBe(400);
    await res.text();
  });

  /**
   * A room token is minted by the same signing function, with the same key,
   * and carries a real room id in `rid` — exactly the field a repository
   * connect uses. Only the `role` field separates them. If that ever stopped
   * being checked, any member could replay their own room credential here and
   * have a GitHub token filed against the room in their name.
   */
  it("refuses a genuine room token replayed as state", async () => {
    for (const role of ["owner", "admin", "editor", "viewer"]) {
      const roomToken = await mintToken(env.ROOM_SECRET, {
        rid: ROOM_ID,
        uid: "member-abcdef12",
        role,
        exp: future(),
      });
      const res = await SELF.fetch(`${ORIGIN}/api/auth/github/callback?code=abc&state=${roomToken}`);
      expect(res.status).toBe(400);
      await res.text();
    }
  });

  /**
   * The room id in a repository-connect state decides which Durable Object
   * receives the access token, so a state carrying something that is not a
   * room id must be refused outright rather than used to address a stub.
   */
  it("refuses a repo-connect state whose room id is malformed", async () => {
    for (const rid of ["not-a-room", "oauth", "", "../../etc", "A".repeat(23)]) {
      const state = await mintToken(env.ROOM_SECRET, {
        rid,
        uid: "member-abcdef12",
        role: REPO_STATE_ROLE,
        exp: future(),
      });
      const res = await SELF.fetch(`${ORIGIN}/api/auth/github/callback?code=abc&state=${state}`);
      expect(res.status).toBe(400);
      await res.text();
    }
  });

  it("refuses an expired repo-connect state", async () => {
    const state = await mintToken(env.ROOM_SECRET, {
      rid: ROOM_ID,
      uid: "member-abcdef12",
      role: REPO_STATE_ROLE,
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const res = await SELF.fetch(`${ORIGIN}/api/auth/github/callback?code=abc&state=${state}`);
    expect(res.status).toBe(400);
    await res.text();
  });

  /**
   * Signed with a different key, so the signature check must reject it before
   * anything in the payload is read.
   */
  it("refuses a repo-connect state signed with the wrong secret", async () => {
    const state = await mintToken("a-completely-different-secret", {
      rid: ROOM_ID,
      uid: "member-abcdef12",
      role: REPO_STATE_ROLE,
      exp: future(),
    });
    const res = await SELF.fetch(`${ORIGIN}/api/auth/github/callback?code=abc&state=${state}`);
    expect(res.status).toBe(400);
    await res.text();
  });
});

/**
 * The route that receives the access token is internal: it exists so the Worker
 * can hand the Durable Object something it fetched, and nothing else may reach
 * it. Anyone who could would be able to plant a credential of their choosing
 * into someone else's room.
 */
describe("the internal token-handoff route is not reachable from outside", () => {
  it("refuses a direct POST", async () => {
    const res = await SELF.fetch(`${ORIGIN}/agents/room/${ROOM_ID}/github-oauth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid: "attacker-1234", token: "ghp_planted", login: "attacker" }),
    });
    expect(res.status).not.toBe(200);
    await res.text();
  });

  it("refuses a direct POST that guesses at an internal-auth header", async () => {
    const res = await SELF.fetch(`${ORIGIN}/agents/room/${ROOM_ID}/github-oauth`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-auth": "guess" },
      body: JSON.stringify({ uid: "attacker-1234", token: "ghp_planted", login: "attacker" }),
    });
    expect(res.status).not.toBe(200);
    await res.text();
  });
});
