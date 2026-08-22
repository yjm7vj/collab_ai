/**
 * Integration tests for the access-control surface: room creation, admission,
 * the /init ownership grant, and the websocket token gate.
 *
 * These run through `SELF.fetch`, which is the real Worker entrypoint — the
 * exact same `fetch()` that routing config decides whether to call at all.
 * A change that makes `/api/*` or `/agents/*` stop reaching the Worker (the
 * bug this suite exists to catch) fails every test in this file, not just a
 * routing unit test that could itself be wrong about what "correct" means.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://collab-ai.test";

// Mirrors src/shared/protocol.ts UID_RE / ROOM_ID_RE. Not imported from there
// on purpose: another agent is actively editing that file, and this suite
// should keep testing the wire contract even if the exported names change
// mid-edit. The values themselves are part of the wire protocol, so they are
// effectively fixed regardless of internal refactors.
const ROOM_ID_RE = /^[A-Za-z0-9]{22}$/;

let uidCounter = 0;
/** A fresh, valid-shaped uid (8-64 chars of [A-Za-z0-9_-]), unique per call. */
function freshUid(label: string): string {
  uidCounter += 1;
  return `${label}-${Date.now().toString(36)}-${uidCounter}`;
}

type CreateRoomResponse = { roomId: string; token: string; role: string };
type JoinRoomResponse = { token: string; role: string };
type JoinErrorResponse = { error: string };

async function createRoom(
  uid: string,
  opts: { name?: string; title?: string } = {},
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, name: opts.name ?? "Tester", title: opts.title }),
  });
}

async function joinRoom(
  roomId: string,
  uid: string,
  opts: { name?: string; code?: string } = {},
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId, uid, name: opts.name ?? "Tester", code: opts.code }),
  });
}

async function newOwnedRoom(): Promise<{ roomId: string; token: string; ownerUid: string }> {
  const ownerUid = freshUid("owner");
  const res = await createRoom(ownerUid);
  expect(res.status).toBe(200);
  const body = (await res.json()) as CreateRoomResponse;
  return { roomId: body.roomId, token: body.token, ownerUid };
}

function connect(roomId: string, tk?: string): Promise<Response> {
  const url = new URL(`${ORIGIN}/agents/room/${roomId}`);
  if (tk !== undefined) url.searchParams.set("tk", tk);
  return SELF.fetch(url, { headers: { Upgrade: "websocket" } });
}

describe("room creation", () => {
  it('returns a 22-character roomId, a token, and role "owner"', async () => {
    const res = await createRoom(freshUid("owner"), { name: "Ada", title: "Ada's room" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as CreateRoomResponse;
    expect(body.roomId).toMatch(ROOM_ID_RE);
    expect(body.roomId).toHaveLength(22);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.role).toBe("owner");
  });

  it("two rooms created in a row get different ids", async () => {
    const first = await createRoom(freshUid("owner"));
    const second = await createRoom(freshUid("owner"));

    const firstBody = (await first.json()) as CreateRoomResponse;
    const secondBody = (await second.json()) as CreateRoomResponse;

    expect(firstBody.roomId).not.toBe(secondBody.roomId);
  });

  it('rejects a malformed uid (e.g. "short") with 400', async () => {
    const res = await createRoom("short");
    expect(res.status).toBe(400);
  });

  it("rejects a GET to /api/rooms with 405", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/rooms`, { method: "GET" });
    expect(res.status).toBe(405);
  });
});

describe("admission", () => {
  // This is the core privacy guarantee: a room is invite-only from the
  // moment it is created, not opt-in later. A stranger with nothing but the
  // room id must be refused, not silently admitted as a viewer.
  it('refuses a stranger joining a freshly created room with 403 { error: "invite_required" }', async () => {
    const { roomId } = await newOwnedRoom();
    const res = await joinRoom(roomId, freshUid("stranger"));

    expect(res.status).toBe(403);
    const body = (await res.json()) as JoinErrorResponse;
    expect(body).toEqual({ error: "invite_required" });
  });

  it("still gives the room's creator role \"owner\" when they re-join their own room", async () => {
    const { roomId, ownerUid } = await newOwnedRoom();
    const res = await joinRoom(roomId, ownerUid, { name: "Ada again" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JoinRoomResponse;
    expect(body.role).toBe("owner");
  });

  it('returns 404 { error: "not_found" } for a room id that was never created', async () => {
    // Well-formed (22 alphanumeric chars) but never minted by /api/rooms.
    const neverCreatedRoomId = "Z".repeat(22);
    const res = await joinRoom(neverCreatedRoomId, freshUid("nobody"));

    expect(res.status).toBe(404);
    const body = (await res.json()) as JoinErrorResponse;
    expect(body).toEqual({ error: "not_found" });
  });

  it("rejects a malformed roomId with 400", async () => {
    const res = await joinRoom("not-a-valid-room-id!!", freshUid("someone"));
    expect(res.status).toBe(400);
  });
});

describe("ownership cannot be stolen", () => {
  // /init grants ownership outright, so this is the highest-severity path in
  // the app: anyone who could reach it unauthenticated could mint themselves
  // ownership of any room.
  it("a direct POST to /agents/room/<realRoomId>/init does not return 200 and does not grant ownership", async () => {
    const { roomId } = await newOwnedRoom();
    const attackerUid = freshUid("attacker");

    const initRes = await SELF.fetch(`${ORIGIN}/agents/room/${roomId}/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid: attackerUid, name: "Attacker" }),
    });
    expect(initRes.status).not.toBe(200);
    // The test pool tracks Durable Object storage per test and needs every
    // response body that touched it fully read before the test ends, or it
    // fails to tear down isolated storage afterwards. See
    // https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#isolated-storage
    await initRes.text();

    // The real check: did the attempt actually grant membership/ownership?
    // Join normally afterwards and confirm the attacker is still a complete
    // stranger to the room, refused exactly like anyone else.
    const joinRes = await joinRoom(roomId, attackerUid);
    expect(joinRes.status).toBe(403);
    const body = (await joinRes.json()) as JoinErrorResponse;
    expect(body).toEqual({ error: "invite_required" });
  });
});

describe("websocket token gate", () => {
  it("rejects a connection with no token with 401", async () => {
    const { roomId } = await newOwnedRoom();
    const res = await connect(roomId);
    expect(res.status).toBe(401);
  });

  it("rejects a connection with a garbage token with 401", async () => {
    const { roomId } = await newOwnedRoom();
    const res = await connect(roomId, "not-a-real-token");
    expect(res.status).toBe(401);
  });

  /**
   * Tampers with the MIDDLE of the signature, deliberately, not the end.
   *
   * An HMAC-SHA-256 signature is 32 bytes, which base64url-encodes to 43
   * characters — and that final character carries only 2 significant bits.
   * Three other characters decode to the identical 32 bytes, so altering the
   * last character is a no-op about 5% of the time: the "tampered" token is
   * byte-for-byte the original, verifies correctly, and the connection is
   * accepted. That is exactly what this test is supposed to catch, so an
   * earlier version of it failed intermittently while looking merely flaky.
   *
   * Every character away from the end carries all 6 bits, so changing one
   * always changes the decoded bytes.
   */
  it("rejects a connection with a tampered signature, 401", async () => {
    const { roomId, token } = await newOwnedRoom();
    const dot = token.indexOf(".");
    // Halfway into the signature segment: no padding bits, no ambiguity.
    const target = dot + 1 + Math.floor((token.length - dot - 1) / 2);
    const swapped = token[target] === "A" ? "B" : "A";
    const tampered = token.slice(0, target) + swapped + token.slice(target + 1);

    expect(tampered).not.toBe(token);
    const res = await connect(roomId, tampered);
    expect(res.status).toBe(401);
  });

  // This is why the token carries the room id: a token is proof of
  // admission to one specific room, not a general-purpose bearer credential
  // that would let a member of any room connect to any other room.
  it("rejects a valid token for room A used on room B with 401", async () => {
    const roomA = await newOwnedRoom();
    const roomB = await newOwnedRoom();

    const res = await connect(roomB.roomId, roomA.token);
    expect(res.status).toBe(401);
  });

  it("accepts a valid token used on its own room (101)", async () => {
    const { roomId, token } = await newOwnedRoom();
    const res = await connect(roomId, token);
    expect(res.status).toBe(101);
  });
});

/**
 * Sign-in is optional per deployment. With no provider secrets set — which is
 * the case in this test environment — the app must behave exactly as it did
 * before OAuth existed, and the auth routes must not half-exist.
 */
describe("sign-in when no provider is configured", () => {
  it("reports no providers", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/auth/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [] });
  });

  it("does not expose a start route for an unconfigured provider", async () => {
    for (const p of ["github", "google"]) {
      const res = await SELF.fetch(`${ORIGIN}/api/auth/${p}/start?returnTo=/`);
      expect(res.status).toBe(404);
      await res.text();
    }
  });

  it("still lets an anonymous caller create a room", async () => {
    // The open path is deliberate: a deployment that has not configured a
    // provider keeps working with no setup, so local dev and the mock model
    // are unaffected.
    const { roomId } = await newOwnedRoom();
    expect(roomId).toMatch(/^[A-Za-z0-9]{22}$/);
  });

  it("rejects an unknown auth path as JSON, not the SPA", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/auth/nonsense/start`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

/**
 * A room token and an identity token are minted by the same signing function
 * and differ only in their `rid` field. If that distinction ever stopped being
 * enforced, a room credential would authenticate as a person — so this asserts
 * it end to end through the real Worker rather than in isolation.
 */
describe("a room token cannot masquerade as an identity", () => {
  it("is refused where an identity is expected", async () => {
    const { roomId, token } = await newOwnedRoom();

    const res = await SELF.fetch(`${ORIGIN}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // A genuine, currently-valid room token offered as proof of identity.
      body: JSON.stringify({ roomId, identity: token, name: "Impostor" }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "sign_in_required" });
  });

  it("is refused for room creation too", async () => {
    const { token } = await newOwnedRoom();
    const res = await SELF.fetch(`${ORIGIN}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: token, name: "Impostor" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "sign_in_required" });
  });

  it("refuses a syntactically valid but unsigned identity", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "bm90LWEtdG9rZW4.c2ln", name: "Impostor" }),
    });
    expect(res.status).toBe(401);
    await res.json();
  });
});
