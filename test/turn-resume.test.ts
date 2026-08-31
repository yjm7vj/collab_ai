/**
 * A turn that was running when its Durable Object went away.
 *
 * This is not an exotic case: a deploy replaces the code under every live room,
 * so it happens to every room that is mid-response whenever anyone ships.
 * Storage survives, the JavaScript driving the turn does not, and message
 * intake only starts a turn when the room is idle — so without the recovery in
 * `onStart` / `resumeTurn` a room caught mid-response sits at "thinking" for
 * good, with everything said afterwards piling up in the inbox.
 *
 * `evictDurableObject` is the real thing rather than a stand-in: it tears the
 * instance down and leaves storage alone, which is what a deploy does. The wake
 * afterwards is a real request through the Worker, because that is what runs
 * the init path that calls `onStart` — reaching into the object directly skips
 * it, which is worth knowing if these tests ever need changing.
 *
 * The seeded turn is at its resume cap on purpose. The happy path ends in a
 * model call, and no test in this suite may reach the Anthropic API.
 */
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import type { Room } from "../src/server/room";
import { MAX_RESUMES } from "../src/server/room";

const ORIGIN = "https://collab-ai.test";
const ENTRY_ID = "interrupted-entry";

type StoredEntry = { id: string; kind: string; blocks?: unknown[]; text?: string };

let counter = 0;
async function freshRoom() {
  counter += 1;
  const uid = `resume-tester-${counter}`;
  const res = await SELF.fetch(`${ORIGIN}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid, name: "Tester" }),
  });
  expect(res.status).toBe(200);
  const { roomId } = (await res.json()) as { roomId: string };
  return { roomId, uid, stub: await getAgentByName<Env, Room>(env.Room, roomId) };
}

/** A request that only needs to reach the room, so that the room starts. */
async function wake(stub: DurableObjectStub<Room>, roomId: string, uid: string) {
  const res = await SELF.fetch(`${ORIGIN}/api/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId, uid, name: "Tester" }),
  });
  expect(res.status).toBe(200);
  // A zero-delay schedule fires during the wake itself, so this is usually a
  // no-op that answers false. It is here so the test does not depend on that
  // timing: if the alarm is still pending, this runs it.
  await runDurableObjectAlarm(stub);
}

/**
 * Leave the room in the state a killed instance leaves behind: an agent entry
 * with one finished block plus one the interrupted round had only started, a
 * turn marking where that round began, and `running` saying it was mid-flight.
 */
async function seedInterruptedTurn(stub: DurableObjectStub<Room>, resumes: number) {
  await runInDurableObject(stub, (room) => {
    const ts = Date.now();
    room.sql`INSERT INTO entries (id, ts, json) VALUES (${ENTRY_ID}, ${ts}, ${JSON.stringify({
      id: ENTRY_ID,
      ts,
      kind: "agent",
      blocks: [
        { type: "text", text: "a block from a round that finished" },
        { type: "text", text: "half a block nobody" },
      ],
    })})`;
    room.sql`INSERT INTO kv (k, v) VALUES ('turn', ${JSON.stringify({
      entryId: ENTRY_ID,
      carried: [],
      blocks: 1,
      resumes,
      running: true,
    })}) ON CONFLICT(k) DO UPDATE SET v = excluded.v`;
    room.setState({ ...room.state, status: "thinking", pending: [] });
  });
}

describe("a turn interrupted by an eviction", () => {
  it("is picked up on the next wake, and the abandoned round is dropped", async () => {
    const { roomId, uid, stub } = await freshRoom();
    await seedInterruptedTurn(stub, MAX_RESUMES);

    await evictDurableObject(stub);
    await wake(stub, roomId, uid);

    const after = await runInDurableObject(stub, (room) => ({
      status: room.state.status,
      turns: room.sql<{ v: string }>`SELECT v FROM kv WHERE k = 'turn'`.length,
      entries: room
        .sql<{ json: string }>`SELECT json FROM entries ORDER BY ts ASC`
        .map((row) => JSON.parse(row.json) as StoredEntry),
    }));

    // The half-written block is gone; the round that finished is untouched.
    expect(after.entries.find((e) => e.id === ENTRY_ID)?.blocks).toHaveLength(1);
    // Given up on, out loud, rather than retried forever.
    expect(
      after.entries.some((e) => e.kind === "system" && /interrupted/.test(e.text ?? "")),
    ).toBe(true);
    // And back to idle with no turn left, rather than stuck at "thinking".
    expect(after.status).toBe("idle");
    expect(after.turns).toBe(0);
  });

  it("leaves a room that was not mid-turn alone", async () => {
    const { roomId, uid, stub } = await freshRoom();

    await evictDurableObject(stub);
    await wake(stub, roomId, uid);

    const after = await runInDurableObject(stub, (room) => ({
      status: room.state.status,
      entries: room.sql<{ json: string }>`SELECT json FROM entries`.length,
      scheduled: room.sql<{ c: number }>`SELECT COUNT(*) AS c FROM cf_agents_schedules`[0]!.c,
    }));

    expect(after.status).toBe("idle");
    expect(after.scheduled).toBe(0);
    // No "interrupted" note in a room where nothing was interrupted.
    expect(after.entries).toBe(0);
  });
});
