import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://collab-ai.test";
let counter = 0;
const uid = (label: string) => `${label}-${Date.now().toString(36)}-${++counter}`;

async function createRoom(ownerUid: string) {
  const response = await SELF.fetch(`${ORIGIN}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: ownerUid, name: "Owner" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { roomId: string };
}

async function projectInvite(body: Record<string, unknown>) {
  return SELF.fetch(`${ORIGIN}/api/project-invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("project invites", () => {
  it("grants the selected rooms and no unselected rooms", async () => {
    const owner = uid("owner");
    const first = await createRoom(owner);
    const second = await createRoom(owner);
    const third = await createRoom(owner);
    const projectId = `project-${counter}`;

    const create = await projectInvite({
      action: "create", uid: owner, projectId, projectName: "Research", role: "viewer",
      rooms: [
        { roomId: first.roomId, label: "First" },
        { roomId: second.roomId, label: "Second" },
      ],
    });
    expect(create.status).toBe(200);
    const invite = (await create.json()) as { invite: { code: string; rooms: unknown[] } };
    expect(invite.invite.code).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(invite.invite.rooms).toHaveLength(2);

    const redeem = await SELF.fetch(`${ORIGIN}/api/project-invites/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: invite.invite.code, uid: uid("guest"), name: "Guest" }),
    });
    expect(redeem.status).toBe(200);
    const joined = (await redeem.json()) as { rooms: Array<{ roomId: string; role: string; token: string }> };
    expect(joined.rooms.map((room) => room.roomId)).toEqual([first.roomId, second.roomId]);
    expect(joined.rooms.every((room) => room.role === "viewer" && room.token.length > 0)).toBe(true);
    expect(third.roomId).not.toBe(first.roomId);
  });

  it("allows an owner to edit and revoke an invite, but blocks another room's owner", async () => {
    const owner = uid("owner");
    const otherOwner = uid("other");
    const first = await createRoom(owner);
    const second = await createRoom(otherOwner);
    const projectId = `project-${counter}`;
    const base = { action: "create", uid: owner, projectId, projectName: "Shared", role: "viewer", rooms: [{ roomId: first.roomId, label: "First" }] };

    const create = await projectInvite(base);
    expect(create.status).toBe(200);
    const code = ((await create.json()) as { invite: { code: string } }).invite.code;

    const forbidden = await projectInvite({ action: "update", uid: otherOwner, projectId, code, projectName: "Shared", role: "viewer", rooms: [{ roomId: second.roomId, label: "Second" }] });
    expect(forbidden.status).toBe(403);
    await forbidden.text();

    const update = await projectInvite({ action: "update", uid: owner, projectId, code, projectName: "Shared", role: "editor", rooms: [{ roomId: first.roomId, label: "First" }, { roomId: second.roomId, label: "Second" }] });
    expect(update.status).toBe(403);
    await update.text();

    const revoke = await projectInvite({ action: "revoke", uid: owner, projectId, code, rooms: [{ roomId: first.roomId, label: "First" }] });
    expect(revoke.status).toBe(200);
    const redeem = await SELF.fetch(`${ORIGIN}/api/project-invites/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, uid: uid("guest"), name: "Guest" }) });
    expect(redeem.status).toBe(403);
    await redeem.text();
  });
});
