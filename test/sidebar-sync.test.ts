/**
 * The sidebar as an account-level thing, not a browser-level one.
 *
 * The bug these guard: rooms and projects lived only in `localStorage`, so
 * signing in on a second browser produced an empty sidebar even though the
 * account was still a member of every one of those rooms. The fix is the
 * `UserIndex` Durable Object behind `/api/sidebar`, and the interesting part
 * of it is not "does it store rows" but what it does when two browsers
 * disagree — which is what almost all of this file is about.
 *
 * "Browser A" and "browser B" below are two `fetch` calls carrying the same
 * identity token. That is exactly what two signed-in devices are from the
 * Worker's side, so nothing here is a stand-in.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { mintToken } from "../src/server/auth";
import { IDENTITY_MARKER } from "../src/shared/protocol";
import type { SidebarSnapshot, SyncRoom } from "../src/shared/sidebar";

const ORIGIN = "https://collab-ai.test";

let counter = 0;
async function freshIdentity() {
  counter += 1;
  const uid = `sidebar-tester-${counter}`.replace(/[^A-Za-z0-9_-]/g, "-");
  const identity = await mintToken(env.ROOM_SECRET, {
    rid: IDENTITY_MARKER,
    uid,
    role: "Tester",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return { uid, identity };
}

type Push = {
  rooms?: Partial<SyncRoom>[];
  projects?: { id: string; name: string; archived?: boolean; updatedAt?: number }[];
  deletedRooms?: string[];
  deletedProjects?: string[];
};

async function sync(identity: string, push: Push): Promise<SidebarSnapshot> {
  const res = await SELF.fetch(`${ORIGIN}/api/sidebar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      identity,
      rooms: [],
      projects: [],
      deletedRooms: [],
      deletedProjects: [],
      ...push,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SidebarSnapshot;
}

/** A real room, created the way the app creates one. */
async function createRoom(identity: string, title?: string): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, name: "Tester", title }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { roomId: string }).roomId;
}

function room(roomId: string, over: Partial<SyncRoom> = {}): Partial<SyncRoom> {
  return { roomId, label: "Design", projectId: null, archived: false, updatedAt: Date.now(), ...over };
}

/**
 * A room id that is well-formed but belongs to no room.
 *
 * The merge tests below are about which of two edits survives, and a room made
 * through /api/rooms arrives already stamped by the Worker at creation time —
 * which would silently decide those comparisons for them. A bookmark to a room
 * that does not exist is stored all the same: this index is a list of ways
 * back into rooms, never a grant of access to one, and membership is still
 * checked by the room itself on every connect.
 */
function fakeRoomId(): string {
  counter += 1;
  return `sidebarfake${String(counter).padStart(11, "0")}`;
}

describe("sidebar sync", () => {
  it("hands a second browser the rooms the first one knows", async () => {
    const { identity } = await freshIdentity();
    const roomId = await createRoom(identity);

    // Browser A names the room and pushes.
    await sync(identity, { rooms: [room(roomId, { label: "Launch plan" })] });

    // Browser B has never seen it and says so by pushing nothing at all.
    const onB = await sync(identity, {});
    expect(onB.rooms.map((r) => [r.roomId, r.label])).toEqual([[roomId, "Launch plan"]]);
  });

  it("puts a room in the sidebar at the moment it is created, with no push at all", async () => {
    const { identity } = await freshIdentity();
    const roomId = await createRoom(identity, "Roadmap");

    // No sync call has carried this room anywhere — the Worker recorded it on
    // creation, which is what keeps a room that was made and then abandoned
    // mid-session from being lost.
    const snapshot = await sync(identity, {});
    expect(snapshot.rooms.map((r) => [r.roomId, r.label])).toEqual([[roomId, "Roadmap"]]);
  });

  it("records a room joined from an invite link", async () => {
    const owner = await freshIdentity();
    const joiner = await freshIdentity();
    const roomId = await createRoom(owner.identity, "Shared");

    // The room is invite-only, so this is refused — and must leave nothing
    // behind in the sidebar of someone who never got in.
    const refused = await SELF.fetch(`${ORIGIN}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, identity: joiner.identity, name: "Guest" }),
    });
    expect(refused.status).toBe(403);
    expect((await sync(joiner.identity, {})).rooms).toEqual([]);

    // The owner rejoining is the admitted path: an existing member is let
    // straight back in, which is also how a second device gets its token.
    const admitted = await SELF.fetch(`${ORIGIN}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, identity: owner.identity, name: "Tester" }),
    });
    expect(admitted.status).toBe(200);
    expect((await sync(owner.identity, {})).rooms.map((r) => r.roomId)).toEqual([roomId]);
  });

  it("keeps the later edit when two browsers disagree", async () => {
    const { identity } = await freshIdentity();
    const roomId = fakeRoomId();
    const t = Date.now() - 10_000;

    await sync(identity, { rooms: [room(roomId, { label: "Old name", updatedAt: t })] });
    await sync(identity, { rooms: [room(roomId, { label: "New name", updatedAt: t + 5_000 })] });

    // The stale browser pushes its own copy back, unaware of the rename.
    const after = await sync(identity, { rooms: [room(roomId, { label: "Old name", updatedAt: t })] });
    expect(after.rooms.map((r) => r.label)).toEqual(["New name"]);
  });

  it("does not let a browser with a fast clock win forever", async () => {
    const { identity } = await freshIdentity();
    const roomId = fakeRoomId();

    // A year into the future — clamped to now on arrival, so an ordinary edit
    // made a moment later still beats it.
    await sync(identity, {
      rooms: [room(roomId, { label: "Skewed", updatedAt: Date.now() + 365 * 24 * 3600 * 1000 })],
    });
    const after = await sync(identity, { rooms: [room(roomId, { label: "Corrected", updatedAt: Date.now() })] });
    expect(after.rooms.map((r) => r.label)).toEqual(["Corrected"]);
  });

  it("does not resurrect a deleted room from a stale browser", async () => {
    const { identity } = await freshIdentity();
    const roomId = fakeRoomId();
    const t = Date.now() - 10_000;
    await sync(identity, { rooms: [room(roomId, { updatedAt: t })] });

    await sync(identity, { deletedRooms: [roomId] });
    expect((await sync(identity, {})).rooms).toEqual([]);

    // The other browser still has it and pushes it back. Absence is not a
    // delete, but a delete is, and it stays deleted.
    const after = await sync(identity, { rooms: [room(roomId, { updatedAt: t })] });
    expect(after.rooms).toEqual([]);
  });

  it("carries project grouping, and outlives the project itself", async () => {
    const { identity } = await freshIdentity();
    const inProject = fakeRoomId();
    const loose = fakeRoomId();

    const merged = await sync(identity, {
      projects: [{ id: "project-1", name: "Q3", updatedAt: Date.now() }],
      rooms: [room(inProject, { projectId: "project-1" }), room(loose)],
    });
    expect(merged.projects.map((p) => p.name)).toEqual(["Q3"]);
    expect(merged.rooms.find((r) => r.roomId === inProject)?.projectId).toBe("project-1");
    expect(merged.rooms.find((r) => r.roomId === loose)?.projectId).toBe(null);

    // Deleting a project does not take its rooms with it. Nothing here infers
    // a delete it was not told about; the client sends the rooms explicitly
    // when someone deletes a project, and a room left naming a project that is
    // gone is shown loose rather than vanishing with it.
    const orphaned = await sync(identity, { deletedProjects: ["project-1"] });
    expect(orphaned.projects).toEqual([]);
    expect(orphaned.rooms.map((r) => r.roomId).sort()).toEqual([inProject, loose].sort());

    // What the client actually sends: the project and every room in it.
    const after = await sync(identity, { deletedRooms: [inProject], deletedProjects: ["project-1"] });
    expect(after.rooms.map((r) => r.roomId)).toEqual([loose]);
  });

  it("drops junk without dropping the sidebar around it", async () => {
    const { identity } = await freshIdentity();
    const roomId = fakeRoomId();

    const merged = await sync(identity, {
      rooms: [
        { roomId: "not-a-room-id", label: "Nope", updatedAt: Date.now() } as Partial<SyncRoom>,
        room(roomId, { label: "x".repeat(200) }),
      ],
      projects: [{ id: "project-2", name: "   ", updatedAt: Date.now() }],
    });
    expect(merged.rooms.map((r) => r.roomId)).toEqual([roomId]);
    expect(merged.rooms[0]?.label.length).toBe(42);
    expect(merged.projects).toEqual([]);
  });

  it("refuses a sidebar request with no identity, and one carrying a room token", async () => {
    const { uid } = await freshIdentity();
    const roomToken = await mintToken(env.ROOM_SECRET, {
      rid: "aaaaaaaaaaaaaaaaaaaaaa",
      uid,
      role: "owner",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    for (const body of [{}, { identity: "not-a-token" }, { identity: roomToken }]) {
      const res = await SELF.fetch(`${ORIGIN}/api/sidebar`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(401);
    }
  });

  it("keeps one account's sidebar out of another's", async () => {
    const mine = await freshIdentity();
    const theirs = await freshIdentity();
    const roomId = fakeRoomId();
    await sync(mine.identity, { rooms: [room(roomId, { label: "Private" })] });

    expect((await sync(theirs.identity, {})).rooms).toEqual([]);
  });
});
