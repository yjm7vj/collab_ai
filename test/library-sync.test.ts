/**
 * The workflow library as an account-level thing, not a browser-level one.
 *
 * The bug these guard is the one the sidebar had: saved workflows lived only in
 * `localStorage`, so signing in on a second machine produced an empty library
 * even though the person had drawn those teams and meant to keep them. The fix
 * is the `UserIndex` Durable Object behind `/api/workflows`, and — as with the
 * sidebar — the interesting part is not "does it store rows" but what it does
 * when two browsers disagree, and what it does with a graph it is handed.
 *
 * That second half matters more here than it does for a bookmark. A row in this
 * table is an agent graph: apply it and it decides which models get called and
 * how many times. So these tests push graphs that a room must never run, and
 * assert that what comes back is something it can.
 *
 * "Browser A" and "browser B" are two `fetch` calls carrying the same identity
 * token, which is exactly what two signed-in devices are from the Worker's side.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { mintToken } from "../src/server/auth";
import { IDENTITY_MARKER } from "../src/shared/protocol";
import type { LibrarySnapshot } from "../src/shared/library";
import {
  DEFAULT_GRAPH,
  GRAPH_LIMITS,
  GRAPH_PRESETS,
  SAVED_LIMITS,
  graphKey,
  type SavedWorkflow,
  type WorkflowGraph,
} from "../src/shared/workflow";
import { MODELS } from "../src/shared/models";

const ORIGIN = "https://collab-ai.test";

let counter = 0;
async function freshIdentity() {
  counter += 1;
  const uid = `library-tester-${counter}`;
  const identity = await mintToken(env.ROOM_SECRET, {
    rid: IDENTITY_MARKER,
    uid,
    role: "Tester",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return { uid, identity };
}

type Push = { workflows?: unknown[]; deleted?: string[] };

async function sync(identity: string, push: Push = {}): Promise<LibrarySnapshot> {
  const res = await SELF.fetch(`${ORIGIN}/api/workflows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, workflows: [], deleted: [], ...push }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as LibrarySnapshot;
}

const other = GRAPH_PRESETS.find((p) => p.id === "draft-edit")!.graph;

function saved(id: string, label: string, over: Partial<SavedWorkflow> = {}): SavedWorkflow {
  return { id, label, savedAt: Date.now(), graph: DEFAULT_GRAPH, ...over };
}

describe("workflow library sync", () => {
  it("hands a second browser the workflows the first one saved", async () => {
    const { identity } = await freshIdentity();

    await sync(identity, { workflows: [saved("w1", "Research team")] });

    // Browser B has never seen it and says so by pushing nothing at all.
    const onB = await sync(identity);
    expect(onB.workflows.map((w) => [w.id, w.label])).toEqual([["w1", "Research team"]]);
    expect(graphKey(onB.workflows[0]!.graph)).toBe(graphKey(DEFAULT_GRAPH));
  });

  it("keeps the later save when two browsers save the same workflow", async () => {
    const { identity } = await freshIdentity();
    const base = Date.now();

    await sync(identity, { workflows: [saved("w1", "Team", { savedAt: base, graph: DEFAULT_GRAPH })] });
    // Browser B, holding a stale copy, saves an older version of the same row.
    const stale = await sync(identity, {
      workflows: [saved("w1", "Old name", { savedAt: base - 5_000, graph: other })],
    });
    expect(stale.workflows.map((w) => w.label)).toEqual(["Team"]);

    const fresh = await sync(identity, {
      workflows: [saved("w1", "New name", { savedAt: base + 5_000, graph: other })],
    });
    expect(fresh.workflows.map((w) => w.label)).toEqual(["New name"]);
    expect(graphKey(fresh.workflows[0]!.graph)).toBe(graphKey(other));
  });

  it("a delete sticks, and a stale browser cannot resurrect it", async () => {
    const { identity } = await freshIdentity();
    const row = saved("w1", "Doomed");
    await sync(identity, { workflows: [row] });

    const afterDelete = await sync(identity, { workflows: [], deleted: ["w1"] });
    expect(afterDelete.workflows).toEqual([]);

    // Browser B has been offline and still holds the row. Pushing it back is
    // evidence of what B last saw, not of the workflow existing.
    const stale = await sync(identity, { workflows: [row] });
    expect(stale.workflows).toEqual([]);
  });

  it("keeps one account's library away from another's", async () => {
    const mine = await freshIdentity();
    const yours = await freshIdentity();

    await sync(mine.identity, { workflows: [saved("w1", "Mine")] });
    expect((await sync(yours.identity)).workflows).toEqual([]);
  });

  it("refuses a push with no identity", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflows: [saved("w1", "Nobody's")], deleted: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a room token in place of an identity", async () => {
    // A room token is minted by the same machinery and carries a uid. If it
    // were accepted here it would name the Durable Object holding somebody's
    // library, so this is the check that keeps the two credentials apart.
    const roomToken = await mintToken(env.ROOM_SECRET, {
      rid: "aaaaaaaaaaaaaaaaaaaaaa",
      uid: "library-tester-room",
      role: "owner",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await SELF.fetch(`${ORIGIN}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: roomToken, workflows: [], deleted: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("never stores a graph a room would refuse to run", async () => {
    const { identity } = await freshIdentity();
    // Forty agents, an unknown model, a lead that is not in the graph, and a
    // card parked far off the canvas — every one of which the sanitizer has a
    // rule for. What comes back has to be runnable, whatever went in.
    const hostile = {
      leadId: "nobody",
      nodes: Array.from({ length: 40 }, (_, i) => ({
        id: `n${i}`,
        name: "Same name",
        model: "gpt-9",
        prompt: "x".repeat(9_000),
        x: 99_999,
        y: -400,
      })),
      edges: [{ id: "e1", from: "n0", to: "n0", kind: "delegates", prompt: "" }],
    } as unknown as WorkflowGraph;

    const back = await sync(identity, { workflows: [saved("w1", "Hostile", { graph: hostile })] });
    const graph = back.workflows[0]!.graph;

    expect(graph.nodes.length).toBeLessThanOrEqual(GRAPH_LIMITS.nodes);
    expect(graph.nodes.every((n) => MODELS.some((m) => m.id === n.model))).toBe(true);
    expect(graph.nodes.some((n) => n.id === graph.leadId)).toBe(true);
    expect(graph.nodes.every((n) => n.x >= 0 && n.y >= 0)).toBe(true);
    // A self-link is not a relationship; the sanitizer drops it rather than
    // storing an edge that would make an agent delegate to itself.
    expect(graph.edges).toEqual([]);
    // Names are the handle the lead delegates by, so duplicates are renamed.
    expect(new Set(graph.nodes.map((n) => n.name)).size).toBe(graph.nodes.length);
  });

  it("stops a full library growing, without freezing what is in it", async () => {
    const { identity } = await freshIdentity();
    const base = Date.now();
    const full = Array.from({ length: SAVED_LIMITS.count }, (_, i) =>
      saved(`w${i}`, `Team ${i}`, { savedAt: base }),
    );
    expect((await sync(identity, { workflows: full })).workflows).toHaveLength(SAVED_LIMITS.count);

    const overflowed = await sync(identity, {
      workflows: [...full, saved("extra", "One too many", { savedAt: base + 1_000 })],
    });
    expect(overflowed.workflows).toHaveLength(SAVED_LIMITS.count);
    expect(overflowed.workflows.some((w) => w.id === "extra")).toBe(false);

    // A full library is not a frozen one: an existing row still updates.
    const renamed = await sync(identity, {
      workflows: [saved("w0", "Renamed", { savedAt: base + 2_000 })],
    });
    expect(renamed.workflows.find((w) => w.id === "w0")?.label).toBe("Renamed");
  });

  it("hands back the newest save first", async () => {
    const { identity } = await freshIdentity();
    const base = Date.now();
    await sync(identity, {
      workflows: [
        saved("old", "Older", { savedAt: base - 10_000 }),
        saved("new", "Newer", { savedAt: base }),
      ],
    });
    expect((await sync(identity)).workflows.map((w) => w.id)).toEqual(["new", "old"]);
  });

  it("drops junk rows without dropping the library around them", async () => {
    const { identity } = await freshIdentity();
    const back = await sync(identity, {
      workflows: [
        { id: "", label: "No id", graph: DEFAULT_GRAPH },
        { id: "w2", label: "   ", graph: DEFAULT_GRAPH },
        "not an object",
        saved("w3", "Real one"),
      ],
    });
    expect(back.workflows.map((w) => w.id)).toEqual(["w3"]);
  });
});
