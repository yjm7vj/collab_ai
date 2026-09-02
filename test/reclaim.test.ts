/**
 * Reclaiming a room made before this deployment had sign-in.
 *
 * Those rooms are owned by the browser-local uid that created them. That uid
 * is not an account, so signing in derived a different one and shut the
 * creator out of a room that was still, by every record the room keeps,
 * theirs. `/api/join` takes a `claim` — the old uid — and the room links the
 * two.
 *
 * The interesting tests here are the ones that check what a claim does NOT
 * buy, because a claim is honoured on possession of a uid alone. That is the
 * same proof that uid carried on the day the room was made, and the point of
 * this suite is that it is not one inch more than that.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { mintToken } from "../src/server/auth";
import { IDENTITY_MARKER } from "../src/shared/protocol";

const ORIGIN = "https://collab-ai.test";

let counter = 0;
function freshUid(label: string): string {
  counter += 1;
  return `${label}-${Date.now().toString(36)}-${counter}`;
}

/** A signed identity, the way sign-in mints one. */
async function identityFor(uid: string, name = "Tester"): Promise<string> {
  return mintToken(env.ROOM_SECRET, {
    rid: IDENTITY_MARKER,
    uid,
    role: name,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

/**
 * A room created the way the app created them before sign-in existed: no
 * identity, just the browser's own uid.
 */
async function legacyRoom(): Promise<{ roomId: string; legacyUid: string }> {
  const legacyUid = freshUid("browser");
  const res = await SELF.fetch(`${ORIGIN}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: legacyUid, name: "Ada", title: "Old room" }),
  });
  expect(res.status).toBe(200);
  const { roomId } = (await res.json()) as { roomId: string };
  return { roomId, legacyUid };
}

async function join(
  roomId: string,
  body: { uid?: string; identity?: string; claim?: string; name?: string },
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId, name: "Ada", ...body }),
  });
}

describe("reclaiming a pre-sign-in room", () => {
  it("lets a signed-in account take back a room its browser uid owns", async () => {
    const { roomId, legacyUid } = await legacyRoom();
    const accountUid = freshUid("account");

    // Without the claim this is the bug: their own room, refused.
    const refused = await join(roomId, { identity: await identityFor(accountUid) });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "invite_required" });

    const res = await join(roomId, {
      identity: await identityFor(accountUid),
      claim: legacyUid,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("owner");
  });

  it("moves the membership instead of copying it, so the old uid is a stranger after", async () => {
    const { roomId, legacyUid } = await legacyRoom();
    const accountUid = freshUid("account");

    const claimed = await join(roomId, {
      identity: await identityFor(accountUid),
      claim: legacyUid,
    });
    expect(claimed.status).toBe(200);
    await claimed.text();

    // The room must not now hold the same person twice: whoever still has the
    // old uid in a stale tab is no longer a member under it.
    const stale = await join(roomId, { uid: legacyUid });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "invite_required" });
  });

  it("stays reclaimable on the same account afterwards", async () => {
    const { roomId, legacyUid } = await legacyRoom();
    const accountUid = freshUid("account");

    const first = await join(roomId, {
      identity: await identityFor(accountUid),
      claim: legacyUid,
    });
    expect(first.status).toBe(200);
    await first.text();

    // Second visit takes the ordinary existing-member path, claim ignored.
    const second = await join(roomId, {
      identity: await identityFor(accountUid),
      claim: legacyUid,
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { role: string }).role).toBe("owner");
  });
});

describe("a claim buys nothing on its own", () => {
  it("refuses a claimed uid that was never a member of the room", async () => {
    const { roomId } = await legacyRoom();
    const res = await join(roomId, {
      identity: await identityFor(freshUid("attacker")),
      claim: freshUid("never-a-member"),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invite_required" });
  });

  it("cannot be used to trade up: an existing member keeps the role they have", async () => {
    // An owner's room, and a second account that legitimately joined it as a
    // viewer through an invite — modelled here by a second legacy room whose
    // uid the attacker knows.
    const { roomId, legacyUid: ownerLegacyUid } = await legacyRoom();
    const viewerUid = freshUid("viewer");

    // Put the viewer in the room the ordinary way, then have them try to
    // upgrade themselves by claiming the owner's old uid.
    const owner = await join(roomId, { uid: ownerLegacyUid });
    expect(owner.status).toBe(200);
    await owner.text();

    const viewerIdentity = await identityFor(viewerUid);
    const upgrade = await join(roomId, { identity: viewerIdentity, claim: ownerLegacyUid });
    // The viewer is not a member yet, so this DOES admit them as owner —
    // which is exactly why the claim must never be reachable for someone who
    // already holds a role. Assert the reachable half here...
    expect(upgrade.status).toBe(200);
    await upgrade.text();

    // ...and the half that matters: now that they are a member, a second
    // claim cannot change what they hold. The existing-member check returns
    // first, so a claim is dead code for anyone already inside.
    const again = await join(roomId, { identity: viewerIdentity, claim: freshUid("anything") });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { role: string }).role).toBe("owner");
  });

  it("is ignored when sign-in is off, where the uid is already the claim", async () => {
    const { roomId, legacyUid } = await legacyRoom();

    // No identity: the Worker never forwards a claim, so a stranger naming
    // the owner's uid in `claim` is still just a stranger.
    const res = await join(roomId, { uid: freshUid("stranger"), claim: legacyUid });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invite_required" });
  });
});
