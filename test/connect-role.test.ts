import { env, runInDurableObject, SELF } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import { mintToken } from "../src/server/auth";
import type { Room } from "../src/server/room";

const ORIGIN = "https://collab-ai.test";

let counter = 0;
async function newRoom() {
  counter += 1;
  const uid = `connect-owner-${counter}`;
  const response = await SELF.fetch(`${ORIGIN}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, name: "Ada" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { roomId: string; token: string };
}

/** Add a member directly, standing in for an invite that was accepted earlier. */
async function addMember(roomId: string, uid: string, role: string) {
  const stub = await getAgentByName<Env, Room>(env.Room, roomId);
  await runInDurableObject(stub, (room) => {
    const now = Date.now();
    room.sql`INSERT INTO members (uid, name, avatar, joined_at, last_seen, role)
             VALUES (${uid}, ${"Grace"}, ${""}, ${now}, ${now}, ${role})`;
  });
}

async function setStoredRole(roomId: string, uid: string, role: string) {
  const stub = await getAgentByName<Env, Room>(env.Room, roomId);
  await runInDurableObject(stub, (room) => {
    room.sql`UPDATE members SET role = ${role} WHERE uid = ${uid}`;
  });
}

/** Open a socket and read the role the room binds to it. */
async function connectedRole(
  roomId: string,
  token: string,
): Promise<{ role?: string; code?: number }> {
  const response = await SELF.fetch(`${ORIGIN}/agents/room/${roomId}?tk=${token}`, {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (!socket) return { code: response.status };
  socket.accept();

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({}), 2000);
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ code: event.code });
    });
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as { t: string; role?: string };
      if (msg.t !== "you") return;
      clearTimeout(timer);
      socket.close();
      resolve({ role: msg.role });
    });
  });
}

describe("role bound at connect", () => {
  it("uses the demoted role when the token still claims the old one", async () => {
    const { roomId } = await newRoom();
    const uid = "connect-demoted";
    await addMember(roomId, uid, "admin");

    // Minted while they were still an admin, and valid for a week.
    const stale = await mintToken(env.ROOM_SECRET, {
      rid: roomId,
      uid,
      role: "admin",
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    });

    // Demoted with no socket open, so there is nothing for #rebind to reach.
    await setStoredRole(roomId, uid, "viewer");

    expect(await connectedRole(roomId, stale)).toEqual({ role: "viewer" });
  });

  it("refuses a token for someone who is no longer a member", async () => {
    const { roomId } = await newRoom();
    const token = await mintToken(env.ROOM_SECRET, {
      rid: roomId,
      uid: "connect-stranger",
      role: "owner",
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    });

    expect(await connectedRole(roomId, token)).toEqual({ code: 4403 });
  });

  it("ignores a role the token claims but the member record never had", async () => {
    const { roomId } = await newRoom();
    const uid = "connect-forged";
    await addMember(roomId, uid, "viewer");

    const forged = await mintToken(env.ROOM_SECRET, {
      rid: roomId,
      uid,
      role: "owner",
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    });

    expect(await connectedRole(roomId, forged)).toEqual({ role: "viewer" });
  });
});
