/**
 * Rooms saved before a field existed must still open.
 *
 * This suite exists because the same bug shipped twice. `AgentNode.mcpServers`
 * and then `RoomState.grants` were each added as required fields to a shape
 * that is *persisted* rather than rebuilt — so rooms stored before the change
 * came back without them, the browser called an array method on `undefined`,
 * and the whole room rendered as a black screen. Types did not catch it: the
 * type says the field is there, and the stored JSON simply is not the type.
 *
 * The checks below fail if that can happen again, for any field, including
 * ones nobody has written yet.
 */
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import type { Room } from "../src/server/room";
import {
  INITIAL_ROOM_STATE,
  completeRoomState,
  grantFor,
  liveGrants,
  missingRoomStateKeys,
  type RoomState,
} from "../src/shared/protocol";

const ORIGIN = "https://collab-ai.test";

let counter = 0;
async function newRoom() {
  counter += 1;
  const response = await SELF.fetch(`${ORIGIN}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: `schema-owner-${counter}`, name: "Ada" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { roomId: string; token: string };
}

/**
 * Every field of RoomState, taken from the value TypeScript forces to be
 * complete. A field added tomorrow is in this list tomorrow, with nobody
 * having to remember to add it here — which is the only reason this suite can
 * claim to cover fields that do not exist yet.
 */
const ALL_FIELDS = Object.keys(INITIAL_ROOM_STATE) as (keyof RoomState)[];

describe("room state that predates a field", () => {
  it("has fields to check, so an empty list can never pass this suite", () => {
    expect(ALL_FIELDS.length).toBeGreaterThan(10);
  });

  it("fills in every field a stored state is missing", () => {
    for (const field of ALL_FIELDS) {
      const legacy = { ...INITIAL_ROOM_STATE };
      delete (legacy as Record<string, unknown>)[field];

      const completed = completeRoomState(legacy);
      expect(missingRoomStateKeys(completed), `after completing without ${field}`).toEqual([]);
      expect(completed[field], `${field} should be filled from the template`).toBeDefined();
    }
  });

  it("keeps stored values, including falsy ones, rather than resetting them", () => {
    const stored = {
      ...INITIAL_ROOM_STATE,
      doc: "",
      docRevision: 0,
      visibility: "locked" as const,
    };
    const completed = completeRoomState(stored);

    expect(completed.doc).toBe("");
    expect(completed.docRevision).toBe(0);
    expect(completed.visibility).toBe("locked");
  });

  it("treats an explicit undefined as absent rather than carrying it through", () => {
    // This is the exact shape that caused the black screen: the key is present
    // on the object but its value is undefined.
    const completed = completeRoomState({ grants: undefined, mcpTokensSet: undefined });
    expect(completed.grants).toEqual([]);
    expect(completed.mcpTokensSet).toEqual([]);
  });

  it("survives state that is empty, null or undefined entirely", () => {
    for (const input of [{}, null, undefined]) {
      expect(missingRoomStateKeys(completeRoomState(input))).toEqual([]);
    }
  });

  /**
   * The readers that actually threw. They are called with whatever synced
   * state holds, so they take the absence directly rather than trusting a
   * caller to have filled it in first.
   */
  it("reads grants off state that never had them without throwing", () => {
    expect(() => liveGrants(undefined, Date.now())).not.toThrow();
    expect(liveGrants(undefined, Date.now())).toEqual([]);
    expect(() => grantFor(undefined, "edit_file", Date.now())).not.toThrow();
    expect(grantFor(undefined, "edit_file", Date.now())).toBeUndefined();
  });

  it("completes a live room whose stored state is missing fields", async () => {
    const { roomId } = await newRoom();
    const stub = await getAgentByName<Env, Room>(env.Room, roomId);

    // Put the room into the state a room saved before these fields would be
    // in, then make it do the thing every wake does.
    await runInDurableObject(stub, async (room) => {
      const legacy = { ...room.state } as Record<string, unknown>;
      delete legacy.grants;
      delete legacy.mcpTokensSet;
      room.setState(legacy as RoomState);

      expect(missingRoomStateKeys(room.state).sort()).toEqual(["grants", "mcpTokensSet"]);

      await room.onStart();
    });

    const after = await runInDurableObject(stub, (room) => room.state);
    expect(missingRoomStateKeys(after)).toEqual([]);
    expect(after.grants).toEqual([]);
    expect(after.mcpTokensSet).toEqual([]);
  });
});
