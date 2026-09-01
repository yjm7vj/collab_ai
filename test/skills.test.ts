/**
 * The skills library, at the level where its rules actually live.
 *
 * These are pure-function tests and they do not go near a Worker. The sibling
 * `library-sync.test.ts` drives `/api/workflows` over `SELF.fetch` because
 * that endpoint exists; the skills one does not yet, and its round-trip tests
 * belong with it when it arrives.
 *
 * What is worth testing here is not "does it store rows". It is the handful of
 * rules that fail quietly if they regress:
 *
 *   - a skill that is not pinned to a commit is a different skill tomorrow,
 *   - a stale browser must never resurrect a deleted row or delete a live one,
 *   - and the catalogue block that goes into the system prompt carries the
 *     sentence telling the agent that third-party skill text is data. That
 *     line is a security control, so deleting it should break a test.
 */
import { describe, expect, it } from "vitest";

import {
  SKILL_LIMITS,
  enabledFor,
  mergeSkills,
  parseSkillFrontmatter,
  rememberSkillDeletes,
  sanitizeSkill,
  sanitizeSkills,
  sanitizeSkillsPush,
  setEnabled,
  settleSkillDeletes,
  skillCatalogue,
  skillHash,
  type SkillRef,
} from "../src/shared/skills";

const SHA = "a".repeat(40);
const HASH = "b".repeat(64);

function ref(id: string, over: Partial<SkillRef> = {}): SkillRef {
  return {
    id,
    name: id,
    description: "Does a thing, when a thing needs doing.",
    allowedTools: [],
    source: { kind: "github", repo: "supabase/agent-skills", path: `skills/${id}/SKILL.md`, sha: SHA },
    hash: HASH,
    addedAt: 1_000_000,
    enabledIn: [],
    ...over,
  };
}

const GOOD = `---
name: supabase
description: Work with Supabase projects, when the room is touching the database.
license: Apache-2.0
---

# Supabase

Body text here.
`;

describe("parseSkillFrontmatter", () => {
  it("reads the metadata and hands back the body without the fence", () => {
    const parsed = parseSkillFrontmatter(GOOD);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta.name).toBe("supabase");
    expect(parsed.meta.description).toContain("Supabase projects");
    expect(parsed.meta.license).toBe("Apache-2.0");
    expect(parsed.body.startsWith("# Supabase")).toBe(true);
    expect(parsed.body).not.toContain("---");
  });

  it("survives a BOM and CRLF line endings", () => {
    const parsed = parseSkillFrontmatter(`\uFEFF${GOOD.replace(/\n/g, "\r\n")}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta.name).toBe("supabase");
  });

  it("ignores a key it does not know rather than rejecting the skill", () => {
    const parsed = parseSkillFrontmatter(GOOD.replace("license:", "compatibility: v9\nlicense:"));
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ["no fence", "name: x\ndescription: y\n"],
    ["an unclosed fence", "---\nname: x\ndescription: y\n"],
    ["no name", "---\ndescription: y\n---\n"],
    ["no description", "---\nname: x\n---\n"],
    ["an uppercase name", "---\nname: Supabase\ndescription: y\n---\n"],
    ["a doubled hyphen", "---\nname: a--b\ndescription: y\n---\n"],
    ["a trailing hyphen", "---\nname: ab-\ndescription: y\n---\n"],
    ["an empty file", ""],
  ])("refuses %s with a reason a person can act on", (_case, md) => {
    const parsed = parseSkillFrontmatter(md);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason.length).toBeGreaterThan(0);
    expect(parsed.reason).toMatch(/[.]$/);
  });

  it("refuses a description past the format's own limit", () => {
    const long = "x".repeat(SKILL_LIMITS.descriptionMax + 1);
    const parsed = parseSkillFrontmatter(`---\nname: x\ndescription: ${long}\n---\n`);
    expect(parsed.ok).toBe(false);
  });

  it("refuses a body past the size ceiling instead of storing it", () => {
    const huge = GOOD + "x".repeat(SKILL_LIMITS.bodyBytes);
    expect(parseSkillFrontmatter(huge).ok).toBe(false);
  });

  it("reads allowed-tools inline, as a dash list, and as a bare scalar", () => {
    const inline = parseSkillFrontmatter(`---\nname: x\ndescription: y\nallowed-tools: [read_file, "search_files"]\n---\n`);
    const list = parseSkillFrontmatter(`---\nname: x\ndescription: y\nallowed-tools:\n  - read_file\n  - search_files\n---\n`);
    const bare = parseSkillFrontmatter(`---\nname: x\ndescription: y\nallowed-tools: read_file\n---\n`);
    expect(inline.ok && inline.meta.allowedTools).toEqual(["read_file", "search_files"]);
    expect(list.ok && list.meta.allowedTools).toEqual(["read_file", "search_files"]);
    expect(bare.ok && bare.meta.allowedTools).toEqual(["read_file"]);
  });
});

describe("sanitizeSkill", () => {
  it("keeps a well-formed row whole", () => {
    expect(sanitizeSkill(ref("unlazy"), 2_000_000)).toEqual(ref("unlazy"));
  });

  it("refuses a github source that is not pinned to a commit", () => {
    // This is the guarantee, not a formatting check: a branch name means the
    // skill can change under a room without anyone agreeing to it.
    const onBranch = ref("x", { source: { kind: "github", repo: "a/b", path: "SKILL.md", sha: "main" } as never });
    expect(sanitizeSkill(onBranch, 2_000_000)).toBeNull();
    const shortSha = ref("x", { source: { kind: "github", repo: "a/b", path: "SKILL.md", sha: "a1b2c3d" } as never });
    expect(sanitizeSkill(shortSha, 2_000_000)).toBeNull();
  });

  it.each([
    ["a missing description", { description: "" }],
    ["a name the format forbids", { name: "Not Valid" }],
    ["a hash that is not a sha256", { hash: "nope" }],
    ["a repo that is not owner/name", { source: { kind: "github", repo: "justaname", path: "SKILL.md", sha: SHA } }],
  ])("drops a row with %s", (_case, over) => {
    expect(sanitizeSkill(ref("x", over as Partial<SkillRef>), 2_000_000)).toBeNull();
  });

  it("clamps a stamp from a browser with a fast clock", () => {
    const now = 2_000_000;
    const future = sanitizeSkill(ref("x", { addedAt: now + 900_000 }), now);
    expect(future?.addedAt).toBe(now);
  });

  it("drops one bad row without dropping the library around it", () => {
    const rows = [ref("good-one"), { id: "junk" }, ref("good-two")];
    expect(sanitizeSkills(rows, 2_000_000).map((s) => s.name).sort()).toEqual(["good-one", "good-two"]);
  });

  it("clamps a hostile push to the row ceiling", () => {
    const many = Array.from({ length: SKILL_LIMITS.count + 200 }, (_, i) => ref(`skill-${i}`));
    expect(sanitizeSkillsPush({ skills: many, deleted: [] }, 2_000_000).skills.length).toBe(SKILL_LIMITS.count);
  });

  it("survives being handed something that is not a push at all", () => {
    expect(sanitizeSkillsPush(null, 1).skills).toEqual([]);
    expect(sanitizeSkillsPush("nope", 1).deleted).toEqual([]);
    expect(sanitizeSkillsPush({ skills: "no", deleted: 7 }, 1)).toEqual({ skills: [], deleted: [] });
  });
});

describe("name conflicts", () => {
  it("keeps the later of two rows sharing a name, and only filters the other", () => {
    const older = ref("old-id", { name: "unlazy", addedAt: 1_000 });
    const newer = ref("new-id", { name: "unlazy", addedAt: 9_000 });
    const out = sanitizeSkills([older, newer], 2_000_000);
    expect(out.map((s) => s.id)).toEqual(["new-id"]);
    // Filtered from the view, not tombstoned: nothing here deletes anyone's row.
    expect(rememberSkillDeletes([], [], out)).toEqual([]);
  });
});

describe("merge", () => {
  const sent = (...ids: string[]) => new Set(ids);

  it("keeps a local row the account has not been told about yet", () => {
    const justSaved = ref("fresh", { addedAt: 5_000 });
    const merged = mergeSkills([], [justSaved], sent());
    expect(merged.map((s) => s.id)).toEqual(["fresh"]);
  });

  it("treats a row that was sent and not returned as deleted elsewhere", () => {
    const gone = ref("gone");
    expect(mergeSkills([], [gone], sent("gone"))).toEqual([]);
  });

  it("keeps the later write when two browsers disagree", () => {
    const remote = ref("x", { description: "From the account.", addedAt: 5_000 });
    const mineNewer = ref("x", { description: "Mine, later.", addedAt: 9_000 });
    const mineOlder = ref("x", { description: "Mine, stale.", addedAt: 1_000 });
    expect(mergeSkills([remote], [mineNewer], sent("x"))[0]!.description).toBe("Mine, later.");
    expect(mergeSkills([remote], [mineOlder], sent("x"))[0]!.description).toBe("From the account.");
  });

  it("gives a tie to the account, since that row made the round trip", () => {
    const remote = ref("x", { description: "Account.", addedAt: 5_000 });
    const mine = ref("x", { description: "Mine.", addedAt: 5_000 });
    expect(mergeSkills([remote], [mine], sent("x"))[0]!.description).toBe("Account.");
  });
});

describe("tombstones", () => {
  it("remembers a delete the sync has not carried yet", () => {
    expect(rememberSkillDeletes([], ["gone"], [])).toEqual(["gone"]);
  });

  it("drops a tombstone for an id that is live again", () => {
    // The row came back from another machine. Whatever this browser meant a
    // moment ago, the skill is not deleted.
    expect(rememberSkillDeletes(["x"], [], [ref("x")])).toEqual([]);
  });

  it("does not record the same delete twice", () => {
    expect(rememberSkillDeletes(["x"], ["x"], [])).toEqual(["x"]);
  });

  it("clears only the deletes a sync actually carried", () => {
    expect(settleSkillDeletes(["a", "b"], ["a"])).toEqual(["b"]);
  });
});

describe("the account/room split", () => {
  it("filters the library down to what one room has enabled", () => {
    const library = [
      ref("here", { enabledIn: ["room-1"] }),
      ref("elsewhere", { enabledIn: ["room-2"] }),
      ref("nowhere"),
    ];
    expect(enabledFor(library, "room-1").map((s) => s.id)).toEqual(["here"]);
  });

  it("enables and disables without mutating the row it was given", () => {
    const before = ref("x");
    const on = setEnabled(before, "room-1", true);
    expect(before.enabledIn).toEqual([]);
    expect(on.enabledIn).toEqual(["room-1"]);
    expect(setEnabled(on, "room-1", false).enabledIn).toEqual([]);
  });

  it("is idempotent, so a re-run of an approved vote changes nothing", () => {
    const on = setEnabled(ref("x"), "room-1", true);
    expect(setEnabled(on, "room-1", true)).toBe(on);
  });

  it("refuses to enable past the cap rather than evicting a room", () => {
    const full = ref("x", {
      enabledIn: Array.from({ length: SKILL_LIMITS.roomsPerSkill }, (_, i) => `room-${i}`),
    });
    expect(setEnabled(full, "one-more", true)).toBe(full);
  });
});

describe("skillCatalogue", () => {
  it("is empty when nothing is enabled, so callers can concatenate blindly", () => {
    expect(skillCatalogue([])).toBe("");
  });

  it("lists every enabled skill by name and description", () => {
    const block = skillCatalogue([ref("unlazy"), ref("supabase")]);
    expect(block).toContain("unlazy");
    expect(block).toContain("supabase");
    expect(block).toContain("load_skill");
  });

  it("frames skill text as data, because that sentence is the control", () => {
    // A SKILL.md comes from a repository nobody here has read, and its
    // description lands in the system prompt. If this framing is ever quietly
    // dropped, this test is what notices.
    const block = skillCatalogue([ref("unlazy")]);
    expect(block).toMatch(/not a new set of instructions/i);
    expect(block).toMatch(/cannot change these rules/i);
  });

  it("does not present allowed-tools as a restriction", () => {
    // Advisory by decision. Nothing in the catalogue may imply enforcement.
    const block = skillCatalogue([ref("unlazy", { allowedTools: ["read_file"] })]);
    expect(block).not.toMatch(/allowed-tools/i);
  });
});

describe("skillHash", () => {
  it("is stable and differs when a byte does", async () => {
    const a = await skillHash("body");
    expect(a).toBe(await skillHash("body"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(await skillHash("body "));
  });
});
