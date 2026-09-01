/**
 * The "describe your workflow" chat: turning a tool call into a graph.
 *
 * Two things matter here. First, that a real generation-to-draft round trip
 * works end to end without ever reaching Anthropic — the `apiKey === "mock"`
 * path in `proposeWorkflow` mirrors the mock branches `model.ts` already uses,
 * so this suite never needs the real API either. Second, and more important:
 * whatever the model's tool call contains, `finish` must hand back something a
 * room could safely run. The model is not a trusted input any more than a
 * client frame is — `sanitizeGraph` is the actual boundary, and these tests
 * push the same kind of hostile shapes `library-sync.test.ts` pushes at it.
 */
import { describe, expect, it } from "vitest";

import {
  coalesceTurns,
  describeCurrentGraph,
  finish,
  proposeWorkflow,
  sanitizeChatTurns,
} from "../src/server/workflowChat";
import { DEFAULT_GRAPH, GRAPH_LIMITS, GRAPH_PRESETS, MAX_POS } from "../src/shared/workflow";
import { MODELS } from "../src/shared/models";

const MOCK = { apiKey: "mock" };

describe("sanitizeChatTurns", () => {
  it("drops empty and non-string turns, keeping the rest in order", () => {
    const out = sanitizeChatTurns([
      { role: "user", text: "  build me a team  " },
      { role: "user", text: "" },
      { role: "assistant", text: 42 },
      null,
      "not an object",
      { role: "assistant", text: "what should it do?" },
    ]);
    expect(out).toEqual([
      { role: "user", text: "build me a team" },
      { role: "assistant", text: "what should it do?" },
    ]);
  });

  it("defaults an unrecognized role to user rather than dropping the turn", () => {
    expect(sanitizeChatTurns([{ role: "system", text: "hi" }])).toEqual([
      { role: "user", text: "hi" },
    ]);
  });

  it("caps turn length and conversation length", () => {
    const long = sanitizeChatTurns([{ role: "user", text: "x".repeat(5000) }]);
    expect(long[0]!.text.length).toBeLessThanOrEqual(2000);

    const many = Array.from({ length: 50 }, (_, i) => ({ role: "user", text: `turn ${i}` }));
    const out = sanitizeChatTurns(many);
    expect(out.length).toBeLessThanOrEqual(20);
    // The most recent turns survive, not the oldest.
    expect(out[out.length - 1]!.text).toBe("turn 49");
  });

  it("ignores anything that isn't an array", () => {
    expect(sanitizeChatTurns(null)).toEqual([]);
    expect(sanitizeChatTurns("hello")).toEqual([]);
    expect(sanitizeChatTurns(undefined)).toEqual([]);
  });
});

describe("coalesceTurns", () => {
  it("leaves a clean alternating conversation untouched", () => {
    expect(
      coalesceTurns([
        { role: "user", text: "build me a team" },
        { role: "assistant", text: "what should it do?" },
        { role: "user", text: "write blog posts" },
      ]),
    ).toEqual([
      { role: "user", content: "build me a team" },
      { role: "assistant", content: "what should it do?" },
      { role: "user", content: "write blog posts" },
    ]);
  });

  it("merges a retry left with no assistant turn in between into one message", () => {
    // This is the shape a failed turn leaves behind on the client: a user
    // message, then another user message with no reply in between. The
    // Anthropic API rejects two user turns in a row outright, so this is the
    // difference between the feature working after an error and it staying
    // broken for the rest of the conversation.
    const out = coalesceTurns([
      { role: "user", text: "first attempt" },
      { role: "user", text: "second attempt" },
    ]);
    expect(out).toEqual([{ role: "user", content: "first attempt\n\nsecond attempt" }]);
  });

  it("drops a leading assistant turn so the conversation starts with the user", () => {
    expect(coalesceTurns([{ role: "assistant", text: "stray" }, { role: "user", text: "hi" }])).toEqual([
      { role: "user", content: "hi" },
    ]);
  });
});

describe("proposeWorkflow (mock path)", () => {
  it("asks a clarifying question for a near-empty description", async () => {
    const result = await proposeWorkflow(
      MOCK,
      "claude-opus-5",
      [{ role: "user", text: "hi" }],
      DEFAULT_GRAPH,
    );
    expect(result.reply.kind).toBe("question");
    if (result.reply.kind === "question") {
      expect(result.reply.text.length).toBeGreaterThan(0);
    }
  });

  it("drafts a sanitized, runnable graph for a real description", async () => {
    const result = await proposeWorkflow(
      MOCK,
      "claude-opus-5",
      [{ role: "user", text: "A lead and a researcher who finds sources for it." }],
      DEFAULT_GRAPH,
    );
    expect(result.reply.kind).toBe("graph");
    if (result.reply.kind !== "graph") return;
    const { graph, note, warnings } = result.reply;

    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.nodes.some((n) => n.id === graph.leadId)).toBe(true);
    expect(graph.nodes.every((n) => MODELS.some((m) => m.id === n.model))).toBe(true);
    // Positions were computed, not left at whatever the model omitted.
    expect(graph.nodes.every((n) => n.x >= 0 && n.x <= MAX_POS.x && n.y >= 0 && n.y <= MAX_POS.y)).toBe(true);
    expect(new Set(graph.nodes.map((n) => n.x + "," + n.y)).size).toBe(graph.nodes.length);
    expect(typeof note).toBe("string");
    expect(Array.isArray(warnings)).toBe(true);
  });

  it("refuses an empty conversation without touching the model", async () => {
    const result = await proposeWorkflow(MOCK, "claude-opus-5", [], DEFAULT_GRAPH);
    expect(result.reply).toEqual({
      kind: "error",
      message: "Describe what you want the team to do first.",
    });
  });

  it("edits the graph already on the canvas instead of replacing it", async () => {
    // The mock's "add" branch stands in for what a real edit should do: the
    // existing team survives, and something new joins it — this is the
    // behavior "add a critic" is supposed to produce against a real model too.
    const current = GRAPH_PRESETS.find((p) => p.id === "researcher-critic")!.graph;
    const result = await proposeWorkflow(
      MOCK,
      "claude-opus-5",
      [{ role: "user", text: "please add one more teammate" }],
      current,
    );
    expect(result.reply.kind).toBe("graph");
    if (result.reply.kind !== "graph") return;
    const { graph } = result.reply;

    expect(graph.leadId).toBe(current.leadId);
    for (const n of current.nodes) {
      expect(graph.nodes.some((g) => g.id === n.id && g.name === n.name)).toBe(true);
    }
    expect(graph.nodes.length).toBe(current.nodes.length + 1);
  });
});

describe("describeCurrentGraph", () => {
  it("lists every node and link, marking the lead", () => {
    const text = describeCurrentGraph(
      GRAPH_PRESETS.find((p) => p.id === "researcher-critic")!.graph,
    );
    expect(text).toContain("(lead)");
    expect(text).toContain("Researcher");
    expect(text).toContain("Critic");
    expect(text).toContain("-reviews->");
  });

  it("says there are no links rather than an empty list", () => {
    const text = describeCurrentGraph(GRAPH_PRESETS.find((p) => p.id === "lead-only")!.graph);
    expect(text).toContain("Links: none");
  });
});

describe("finish (validating a raw tool call)", () => {
  it("turns a well-formed graph call into a sanitized graph", () => {
    const result = finish({
      kind: "graph",
      note: "A drafter and an editor.",
      leadId: "lead",
      nodes: [
        { id: "lead", name: "Lead", model: "claude-opus-5", prompt: "You plan." },
        { id: "ed", name: "Editor", model: "claude-sonnet-5", prompt: "You edit." },
      ],
      edges: [{ id: "e1", from: "lead", to: "ed", kind: "handoff" }],
    });
    expect(result.reply.kind).toBe("graph");
    if (result.reply.kind !== "graph") return;
    expect(result.reply.graph.leadId).toBe("lead");
    expect(result.reply.graph.edges).toHaveLength(1);
  });

  it("passes a hostile tool call through the same rules a client frame gets", () => {
    // Forty agents, an unknown model, self-links, and a lead that names a node
    // that doesn't exist — every one of these is `sanitizeGraph`'s job, not
    // this module's, so the only thing worth asserting is that nothing here
    // bypasses it.
    const result = finish({
      kind: "graph",
      leadId: "nobody",
      nodes: Array.from({ length: 40 }, (_, i) => ({
        id: `n${i}`,
        name: "Same name",
        model: "gpt-9-turbo",
        prompt: "x".repeat(9000),
      })),
      edges: [{ id: "e1", from: "n0", to: "n0", kind: "delegates" }],
    });
    expect(result.reply.kind).toBe("graph");
    if (result.reply.kind !== "graph") return;
    const { graph } = result.reply;
    expect(graph.nodes.length).toBeLessThanOrEqual(GRAPH_LIMITS.nodes);
    expect(graph.nodes.every((n) => MODELS.some((m) => m.id === n.model))).toBe(true);
    expect(graph.nodes.some((n) => n.id === graph.leadId)).toBe(true);
    expect(graph.edges).toEqual([]);
    expect(new Set(graph.nodes.map((n) => n.name)).size).toBe(graph.nodes.length);
  });

  it("errors out on a graph call with no nodes rather than inventing one", () => {
    const result = finish({ kind: "graph", nodes: [], edges: [] });
    expect(result.reply.kind).toBe("error");
  });

  it("errors out on a question call with no question text", () => {
    const result = finish({ kind: "question", question: "" });
    expect(result.reply.kind).toBe("error");
  });

  it("treats a missing or unrecognized kind as a graph call rather than crashing", () => {
    // The model is expected to always pass `kind`, but nothing here should
    // throw if a completion is missing it — a caught, reported error, not a
    // 500, is what happens instead.
    expect(() => finish({})).not.toThrow();
    expect(() => finish(null)).not.toThrow();
    expect(() => finish("not an object")).not.toThrow();
  });
});
