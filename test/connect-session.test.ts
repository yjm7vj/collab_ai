import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://collab-ai.test";

let counter = 0;
async function newRoom() {
  counter += 1;
  const uid = `session-owner-${counter}`;
  const response = await SELF.fetch(`${ORIGIN}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, name: "Ada" }),
  });
  expect(response.status).toBe(200);
  return { uid, ...((await response.json()) as { roomId: string; token: string }) };
}

/** Exchange a room token for the session cookie, as the client does on open. */
async function establishSession(token: string): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Lax");
  return setCookie.split(";")[0]!;
}

type Upgrade = { headers?: Record<string, string>; query?: string };
async function upgrade(roomId: string, { headers = {}, query = "" }: Upgrade) {
  return SELF.fetch(`${ORIGIN}/agents/room/${roomId}${query}`, {
    headers: { Upgrade: "websocket", Origin: ORIGIN, ...headers },
  });
}

/** Read the identity the room binds, or the status that refused the upgrade. */
async function connectedUid(
  roomId: string,
  init: Upgrade,
): Promise<{ uid?: string; status?: number; code?: number }> {
  const response = await upgrade(roomId, init);
  const socket = response.webSocket;
  if (!socket) return { status: response.status };
  socket.accept();

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({}), 2000);
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ code: event.code });
    });
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as { t: string; uid?: string };
      if (msg.t !== "you") return;
      clearTimeout(timer);
      socket.close();
      resolve({ uid: msg.uid });
    });
  });
}

describe("session cookie on the upgrade", () => {
  it("opens a socket with no credential in the URL", async () => {
    const { roomId, uid, token } = await newRoom();
    const cookie = await establishSession(token);

    expect(await connectedUid(roomId, { headers: { Cookie: cookie } })).toEqual({ uid });
  });

  it("still accepts the room token while tabs age out", async () => {
    const { roomId, uid, token } = await newRoom();

    expect(await connectedUid(roomId, { query: `?tk=${token}` })).toEqual({ uid });
  });

  it("refuses a cookie-bearing upgrade from another origin", async () => {
    const { roomId, token } = await newRoom();
    const cookie = await establishSession(token);

    const response = await upgrade(roomId, {
      headers: { Cookie: cookie, Origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });

  it("refuses a cookie-bearing upgrade that sends no Origin at all", async () => {
    const { roomId, token } = await newRoom();
    const cookie = await establishSession(token);
    const response = await SELF.fetch(`${ORIGIN}/agents/room/${roomId}`, {
      headers: { Upgrade: "websocket", Cookie: cookie },
    });

    expect(response.status).toBe(403);
  });

  it("leaves the token fallback usable without an Origin", async () => {
    const { roomId, uid, token } = await newRoom();
    const response = await SELF.fetch(`${ORIGIN}/agents/room/${roomId}?tk=${token}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(101);
    expect(uid).toBeTruthy();
  });

  it("refuses a session for a room its holder never joined", async () => {
    const mine = await newRoom();
    const theirs = await newRoom();
    const cookie = await establishSession(mine.token);

    // The cookie is valid and proves a real person — membership is what stops
    // it, and that check lives in the room, not in the credential.
    expect(await connectedUid(theirs.roomId, { headers: { Cookie: cookie } })).toEqual({
      code: 4403,
    });
  });

  it("refuses a room token presented as a session cookie", async () => {
    const { roomId, token } = await newRoom();

    expect(
      await connectedUid(roomId, { headers: { Cookie: `hu_session=${token}` } }),
    ).toEqual({ status: 401 });
  });

  it("clears the cookie on sign-out", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/session`, { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
