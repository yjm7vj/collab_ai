import { env, runInDurableObject, SELF } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import type { Room } from "../src/server/room";

const ORIGIN = "https://collab-ai.test";

type Entry = { kind: string; text?: string };

let counter = 0;
async function newRoom() {
  counter += 1;
  const uid = `presence-owner-${counter}`;
  const response = await SELF.fetch(`${ORIGIN}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, name: "Ada" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { roomId: string; token: string };
}

async function exitRoom(roomId: string, token: string) {
  return SELF.fetch(`${ORIGIN}/api/rooms/${roomId}/exit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

async function transcript(roomId: string): Promise<Entry[]> {
  const stub = await getAgentByName<Env, Room>(env.Room, roomId);
  return runInDurableObject(stub, (room) =>
    room.sql<{ json: string }>`SELECT json FROM entries ORDER BY ts ASC`.map(
      (row) => JSON.parse(row.json) as Entry,
    ),
  );
}

describe("application exit presence", () => {
  it("rejects an exit carrying a token for another room", async () => {
    const first = await newRoom();
    const second = await newRoom();

    const response = await exitRoom(second.roomId, first.token);

    expect(response.status).toBe(401);
    expect(await transcript(second.roomId)).toHaveLength(0);
  });

  it("records duplicate exit beacons once and announces the next return", async () => {
    const { roomId, token } = await newRoom();

    expect((await exitRoom(roomId, token)).status).toBe(204);
    expect((await exitRoom(roomId, token)).status).toBe(204);

    let entries = await transcript(roomId);
    expect(entries.filter((entry) => entry.text === "Ada exited")).toHaveLength(1);

    const url = new URL(`${ORIGIN}/agents/room/${roomId}`);
    url.searchParams.set("tk", token);
    const connection = await SELF.fetch(url, { headers: { Upgrade: "websocket" } });
    expect(connection.status).toBe(101);
    connection.webSocket?.accept();

    entries = await transcript(roomId);
    expect(entries.filter((entry) => entry.text === "Ada entered the chat")).toHaveLength(1);
    connection.webSocket?.close();
  });
});
