/**
 * The skills library as an account-level thing, over the wire.
 *
 * `skills.test.ts` covers the rules in isolation; this covers the round trip:
 * `/api/skills`, the `UserIndex` tables behind it, and what happens when two
 * browsers signed into one account disagree. "Browser A" and "browser B" are
 * two `fetch` calls carrying the same identity token, which is exactly what two
 * signed-in devices are from the Worker's side.
 *
 * What makes this worth testing beyond the workflow library it is modelled on:
 * a row here ends up as text in a system prompt, and its body is fetched from a
 * repository nobody in this codebase has read. So the tests care about two
 * things in particular — that a skill which is not pinned to a commit never
 * reaches storage, and that a body is reclaimed when the last row pointing at
 * it goes.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { mintToken } from "../src/server/auth";
import { IDENTITY_MARKER } from "../src/shared/protocol";
import type { SkillRef, SkillsSnapshot } from "../src/shared/skills";

const ORIGIN = "https://collab-ai.test";
const SHA = "a".repeat(40);
const HASH = "b".repeat(64);
const OTHER_HASH = "c".repeat(64);

let counter = 0;
async function freshIdentity() {
  counter += 1;
  const uid = `skills-tester-${counter}`;
  const identity = await mintToken(env.ROOM_SECRET, {
    rid: IDENTITY_MARKER,
    uid,
    role: "Tester",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return { uid, identity };
}

type Push = { skills?: unknown[]; deleted?: string[] };

async function sync(identity: string, push: Push = {}): Promise<SkillsSnapshot> {
  const res = await SELF.fetch(`${ORIGIN}/api/skills`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, skills: [], deleted: [], ...push }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SkillsSnapshot;
}

/** The Durable Object behind the route, for the parts that are RPC not HTTP. */
function index(uid: string) {
  return env.UserIndex.get(env.UserIndex.idFromName(uid));
}

function skill(id: string, over: Partial<SkillRef> = {}): SkillRef {
  return {
    id,
    name: id,
    description: "Does a thing, when a thing needs doing.",
    allowedTools: [],
    source: { kind: "github", repo: "supabase/agent-skills", path: `skills/${id}/SKILL.md`, sha: SHA },
    hash: HASH,
    addedAt: Date.now(),
    enabledIn: [],
    ...over,
  };
}

describe("skills library sync", () => {
  it("hands a second browser the skills the first one installed", async () => {
    const { identity } = await freshIdentity();

    await sync(identity, { skills: [skill("unlazy")] });

    // Browser B has never seen it and says so by pushing nothing at all.
    const onB = await sync(identity);
    expect(onB.skills.map((s) => s.name)).toEqual(["unlazy"]);
    expect(onB.skills[0]!.source).toEqual({
      kind: "github",
      repo: "supabase/agent-skills",
      path: "skills/unlazy/SKILL.md",
      sha: SHA,
    });
  });

  it("keeps the later write when two browsers change the same skill", async () => {
    const { identity } = await freshIdentity();
    const base = Date.now();

    await sync(identity, { skills: [skill("unlazy", { description: "Current.", addedAt: base })] });

    // Browser B, holding a stale copy, pushes an older version of the row.
    const stale = await sync(identity, {
      skills: [skill("unlazy", { description: "Stale.", addedAt: base - 5_000 })],
    });
    expect(stale.skills[0]!.description).toBe("Current.");

    const fresh = await sync(identity, {
      skills: [skill("unlazy", { description: "Updated.", addedAt: base - 1, hash: OTHER_HASH })],
    });
    expect(fresh.skills[0]!.description).toBe("Updated.");
    expect(fresh.skills[0]!.hash).toBe(OTHER_HASH);
  });

  it("a delete sticks, and a stale browser cannot resurrect it", async () => {
    const { identity } = await freshIdentity();
    const row = skill("unlazy");
    await sync(identity, { skills: [row] });

    expect((await sync(identity, { skills: [], deleted: ["unlazy"] })).skills).toEqual([]);

    // Browser B has been offline and still holds the row. Pushing it back is
    // evidence of what B last saw, not of the skill existing.
    expect((await sync(identity, { skills: [row] })).skills).toEqual([]);
  });

  it("carries which rooms a skill is enabled in", async () => {
    const { identity } = await freshIdentity();
    await sync(identity, { skills: [skill("unlazy", { enabledIn: ["room-a", "room-b"] })] });
    const onB = await sync(identity);
    expect(onB.skills[0]!.enabledIn.sort()).toEqual(["room-a", "room-b"]);
  });

  it("refuses a skill that is not pinned to a commit", async () => {
    const { identity } = await freshIdentity();
    // The guarantee the whole feature rests on: an unpinned skill is a
    // different skill tomorrow, so it must not reach storage at all.
    const unpinned = skill("drifty", {
      source: { kind: "github", repo: "a/b", path: "SKILL.md", sha: "main" } as never,
    });
    const after = await sync(identity, { skills: [unpinned, skill("solid")] });
    expect(after.skills.map((s) => s.name)).toEqual(["solid"]);
  });

  it("keeps one account's library away from another's", async () => {
    const mine = await freshIdentity();
    const yours = await freshIdentity();

    await sync(mine.identity, { skills: [skill("unlazy")] });
    expect((await sync(yours.identity)).skills).toEqual([]);
  });

  it("refuses a push with no identity, rather than answering with an empty library", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills: [], deleted: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a GET", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/skills`);
    expect(res.status).toBe(405);
  });

  it("survives a body that is not a push at all", async () => {
    const { identity } = await freshIdentity();
    const res = await SELF.fetch(`${ORIGIN}/api/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity, skills: "nope", deleted: 7 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SkillsSnapshot).skills).toEqual([]);
  });
});

describe("skill bodies", () => {
  it("stores text under its digest and reads it back", async () => {
    const { uid } = await freshIdentity();
    const stub = index(uid);
    await stub.putSkillBody(HASH, "# Unlazy\n\nBody text.");
    expect(await stub.skillBody(HASH)).toContain("Body text.");
  });

  it("ignores a hash that is not a sha256, and a body that is empty", async () => {
    const { uid } = await freshIdentity();
    const stub = index(uid);
    await stub.putSkillBody("not-a-hash", "text");
    await stub.putSkillBody(HASH, "");
    expect(await stub.skillBody("not-a-hash")).toBeNull();
    expect(await stub.skillBody(HASH)).toBeNull();
  });

  it("keeps a body while any live row still points at it", async () => {
    const { uid, identity } = await freshIdentity();
    const stub = index(uid);
    // Two refs, same content — installing the same skill twice is one body.
    await sync(identity, { skills: [skill("one"), skill("two")] });
    await stub.putSkillBody(HASH, "shared text");

    await sync(identity, { skills: [], deleted: ["one"] });
    expect(await stub.skillBody(HASH)).toBe("shared text");
  });

  it("reclaims a body once the last row pointing at it is gone", async () => {
    const { uid, identity } = await freshIdentity();
    const stub = index(uid);
    await sync(identity, { skills: [skill("only")] });
    await stub.putSkillBody(HASH, "lonely text");

    await sync(identity, { skills: [], deleted: ["only"] });
    // Gone immediately rather than at the tombstone TTL: nothing live refers
    // to it, and re-installing re-fetches from source.
    expect(await stub.skillBody(HASH)).toBeNull();
  });
});
