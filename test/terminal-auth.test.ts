import { env, runInDurableObject, SELF } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import type { Room } from "../src/server/room";
import {
  terminalSandboxId,
  terminalTicketMatches,
  terminalTicketRole,
} from "../src/server/terminal";

const ORIGIN = "https://collab-ai.test";

async function newOwner() {
  const uid = `terminal-owner-${crypto.randomUUID()}`;
  const response = await SELF.fetch(`${ORIGIN}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, name: "Terminal Owner" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { roomId: string; token: string };
}

describe("terminal authorization", () => {
  it("rejects an invalid room credential before starting a sandbox", async () => {
    const { roomId } = await newOwner();
    const response = await SELF.fetch(`${ORIGIN}/api/rooms/${roomId}/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-a-token" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("re-checks the current room role instead of trusting the token's old role", async () => {
    const { roomId, token } = await newOwner();
    const stub = await getAgentByName<Env, Room>(env.Room, roomId);
    await runInDurableObject(stub, (room) => {
      room.sql`UPDATE members SET role = 'editor'`;
    });

    const response = await SELF.fetch(`${ORIGIN}/api/rooms/${roomId}/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("derives room isolation and terminal scope from verified server claims", () => {
    const roomId = "A".repeat(22);
    const terminalId = "term_123";
    const claims = {
      rid: roomId,
      uid: "terminal-user-123",
      role: terminalTicketRole(terminalId),
      exp: Math.floor(Date.now() / 1000) + 60,
    };

    expect(terminalSandboxId(roomId)).toBe(`room-${roomId}`);
    expect(terminalTicketMatches(claims, terminalId)).toBe(true);
    expect(terminalTicketMatches(claims, "term_other")).toBe(false);
  });
});
