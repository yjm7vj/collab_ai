/**
 * Guard checks for the agent graph.
 *
 * `sanitizeGraph` is the only thing between a crafted WebSocket frame and a
 * run that calls whatever models it likes, as many times as it likes — so the
 * caps, the model-by-role rules and the cycle bounds are all checked here. The
 * briefing builders are checked too: the lead is told what its team is, and a
 * prompt that describes links the runtime ignores would be a lie the room has
 * no way to catch.
 *
 * Run: npm run check:workflow
 */
import {
  DEFAULT_GRAPH,
  GRAPH_LIMITS,
  GRAPH_PRESETS,
  RELATIONS,
  delegatesOf,
  describeGraph,
  graphWarnings,
  handoffChain,
  leadOf,
  matchGraphPreset,
  promptOf,
  relationInfo,
  reviewersOf,
  sanitizeGraph,
  type WorkflowGraph,
} from "../src/shared/workflow";
import { MODELS, modelInfo, sanitizeSettings, DEFAULT_SETTINGS } from "../src/shared/models";
import { ROLE_CAPS, can, DEFAULT_POLICY, type Role } from "../src/shared/access";
import { INITIAL_ROOM_STATE } from "../src/shared/protocol";
import { leadPlanFor, leadSystemFor, stageSystemFor, workerSystemFor } from "../src/server/model";
import { delegateDefFor, toolsFor } from "../src/server/tools";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** Key-order-independent deep compare — object literal order is not meaning. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const toolNames = (defs: unknown[]) =>
  defs.map((d) => (d as { name?: string }).name ?? (d as { type?: string }).type ?? "");

console.log("\nsanitizeGraph — structure");

// Nothing usable in, something runnable out. A room whose graph failed to parse
// still has to have an agent to talk to.
const empty = sanitizeGraph({});
check("empty input falls back to a real graph", empty.nodes.length > 0, empty.nodes.length);
check(
  "the fallback lead exists",
  empty.nodes.some((n) => n.id === empty.leadId),
  empty.leadId,
);
check("garbage input does not throw", sanitizeGraph("nonsense").nodes.length > 0);
check("null input does not throw", sanitizeGraph(null).nodes.length > 0);

const overflow = sanitizeGraph({
  leadId: "n0",
  nodes: Array.from({ length: 40 }, (_, i) => ({
    id: `n${i}`,
    name: `A${i}`,
    model: "claude-haiku-4-5",
    prompt: "",
    x: 0,
    y: 0,
  })),
  edges: Array.from({ length: 60 }, (_, i) => ({
    id: `e${i}`,
    from: "n0",
    to: `n${(i % 39) + 1}`,
    kind: "delegates",
    prompt: "",
  })),
});
check("node count is capped", overflow.nodes.length === GRAPH_LIMITS.nodes, overflow.nodes.length);
check("edge count is capped", overflow.edges.length <= GRAPH_LIMITS.edges, overflow.edges.length);

const oversize = sanitizeGraph({
  leadId: "a",
  nodes: [
    {
      id: "a",
      name: "x".repeat(500),
      model: "claude-opus-5",
      prompt: "y".repeat(9000),
      x: 99999,
      y: -400,
    },
  ],
  edges: [],
});
const only = oversize.nodes[0]!;
check("name is truncated", only.name.length === GRAPH_LIMITS.nameChars, only.name.length);
check("prompt is truncated", only.prompt.length === GRAPH_LIMITS.promptChars, only.prompt.length);
check("x is clamped into the canvas", only.x <= GRAPH_LIMITS.width && only.x >= 0, only.x);
check("y is clamped into the canvas", only.y >= 0 && only.y <= GRAPH_LIMITS.height, only.y);

const junkIds = sanitizeGraph({
  leadId: "ok",
  nodes: [
    { id: "ok", name: "Lead", model: "claude-opus-5", prompt: "", x: 0, y: 0 },
    { id: "bad id!", name: "Nope", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
    { id: "ok", name: "Dup", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
  ],
  edges: [],
});
check("malformed ids are dropped", junkIds.nodes.length === 1, junkIds.nodes.map((n) => n.id));

const dupNames = sanitizeGraph({
  leadId: "a",
  nodes: [
    { id: "a", name: "Lead", model: "claude-opus-5", prompt: "", x: 0, y: 0 },
    { id: "b", name: "Twin", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
    { id: "c", name: "twin", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
  ],
  edges: [],
});
// Names are the delegate handle, so two teammates answering to one word would
// make a task ambiguous. They are renamed, never dropped.
check("duplicate names are renamed, not dropped", dupNames.nodes.length === 3, dupNames.nodes.length);
check(
  "renamed teammates are unique",
  new Set(dupNames.nodes.map((n) => n.name.toLowerCase())).size === 3,
  dupNames.nodes.map((n) => n.name),
);

console.log("\nsanitizeGraph — models by role");

const badModels = sanitizeGraph({
  leadId: "lead",
  nodes: [
    { id: "lead", name: "Lead", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
    { id: "w", name: "W", model: "claude-opus-5", prompt: "", x: 0, y: 0 },
    { id: "z", name: "Z", model: "gpt-4o", prompt: "", x: 0, y: 0 },
  ],
  edges: [],
});
const fixedLead = badModels.nodes.find((n) => n.id === "lead")!;
check("a non-manager lead is corrected", modelInfo(fixedLead.model).canManage, fixedLead.model);
check(
  "a non-worker teammate is corrected",
  modelInfo(badModels.nodes.find((n) => n.id === "w")!.model).canWork,
  badModels.nodes.find((n) => n.id === "w")!.model,
);
check(
  "an unknown model never survives",
  MODELS.some((m) => m.id === badModels.nodes.find((n) => n.id === "z")!.model),
  badModels.nodes.find((n) => n.id === "z")!.model,
);

const noLead = sanitizeGraph({
  leadId: "missing",
  nodes: [{ id: "a", name: "A", model: "claude-sonnet-5", prompt: "", x: 0, y: 0 }],
  edges: [],
});
check(
  "a lead pointer at nothing is repaired",
  noLead.nodes.some((n) => n.id === noLead.leadId),
  noLead.leadId,
);

console.log("\nsanitizeGraph — edges");

const badEdges = sanitizeGraph({
  leadId: "a",
  nodes: [
    { id: "a", name: "A", model: "claude-opus-5", prompt: "", x: 0, y: 0 },
    { id: "b", name: "B", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
  ],
  edges: [
    { id: "e1", from: "a", to: "a", kind: "delegates", prompt: "" },
    { id: "e2", from: "a", to: "ghost", kind: "delegates", prompt: "" },
    { id: "e3", from: "a", to: "b", kind: "delegates", prompt: "" },
    { id: "e4", from: "a", to: "b", kind: "delegates", prompt: "again" },
    { id: "e5", from: "a", to: "b", kind: "nonsense", prompt: "" },
  ],
});
check("self-edges are dropped", !badEdges.edges.some((e) => e.from === e.to));
check("edges to unknown nodes are dropped", !badEdges.edges.some((e) => e.to === "ghost"));
check(
  "duplicate edges of one kind are dropped",
  badEdges.edges.filter((e) => e.kind === "delegates").length === 1,
  badEdges.edges.length,
);
check(
  "an unknown kind degrades to the prose-only one",
  badEdges.edges.some((e) => e.id === "e5" && e.kind === "custom"),
  badEdges.edges.map((e) => e.kind),
);

console.log("\ntraversal is bounded");

// A graph drawn with a loop in it is not a bug report, it is Tuesday. Every hop
// is a paid model call, so the walk has to terminate on its own.
const cyclic: WorkflowGraph = sanitizeGraph({
  leadId: "a",
  nodes: [
    { id: "a", name: "A", model: "claude-opus-5", prompt: "", x: 0, y: 0 },
    { id: "b", name: "B", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
    { id: "c", name: "C", model: "claude-sonnet-5", prompt: "", x: 0, y: 0 },
  ],
  edges: [
    { id: "e1", from: "a", to: "b", kind: "delegates", prompt: "" },
    { id: "e2", from: "b", to: "c", kind: "handoff", prompt: "" },
    { id: "e3", from: "c", to: "b", kind: "handoff", prompt: "" },
  ],
});
const chain = handoffChain(cyclic, "b");
check("a handoff cycle terminates", chain.length <= GRAPH_LIMITS.handoffDepth, chain.length);
check("a handoff cycle visits each node once", new Set(chain.map((n) => n.id)).size === chain.length);

const manyReviewers = sanitizeGraph({
  leadId: "a",
  nodes: [
    { id: "a", name: "A", model: "claude-opus-5", prompt: "", x: 0, y: 0 },
    { id: "w", name: "W", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
    { id: "r1", name: "R1", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
    { id: "r2", name: "R2", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
    { id: "r3", name: "R3", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
    { id: "r4", name: "R4", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
  ],
  edges: [
    { id: "e0", from: "a", to: "w", kind: "delegates", prompt: "" },
    { id: "e1", from: "w", to: "r1", kind: "reviews", prompt: "" },
    { id: "e2", from: "w", to: "r2", kind: "reviews", prompt: "" },
    { id: "e3", from: "w", to: "r3", kind: "reviews", prompt: "" },
    { id: "e4", from: "w", to: "r4", kind: "reviews", prompt: "" },
  ],
});
check(
  "reviewers per node are capped",
  reviewersOf(manyReviewers, "w").length === GRAPH_LIMITS.reviewers,
  reviewersOf(manyReviewers, "w").length,
);

// Only the lead holds a delegate tool, so a teammate-to-teammate delegate link
// must not put anything on the roster.
const sideways = sanitizeGraph({
  leadId: "a",
  nodes: [
    { id: "a", name: "A", model: "claude-opus-5", prompt: "", x: 0, y: 0 },
    { id: "b", name: "B", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
    { id: "c", name: "C", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
  ],
  edges: [{ id: "e1", from: "b", to: "c", kind: "delegates", prompt: "" }],
});
check("only the lead's delegate links count", delegatesOf(sideways).length === 0);
check(
  "an ignored delegate link is reported, not hidden",
  graphWarnings(sideways).some((w) => w.includes("cannot delegate")),
  graphWarnings(sideways),
);
check(
  "an unreachable agent is reported",
  graphWarnings(sideways).some((w) => w.includes("never reached")),
  graphWarnings(sideways),
);

// A review or handoff aimed back at the lead is inert — the lead answers the
// room, it does not take a second pass over a teammate's output. Left on the
// canvas and explained, rather than deleted under the person who drew it.
const intoLead = sanitizeGraph({
  leadId: "a",
  nodes: [
    { id: "a", name: "Lead", model: "claude-opus-5", prompt: "", x: 0, y: 0 },
    { id: "b", name: "B", model: "claude-haiku-4-5", prompt: "", x: 0, y: 0 },
  ],
  edges: [
    { id: "e0", from: "a", to: "b", kind: "delegates", prompt: "" },
    { id: "e1", from: "b", to: "a", kind: "reviews", prompt: "" },
    { id: "e2", from: "b", to: "a", kind: "handoff", prompt: "" },
  ],
});
check("a link into the lead is kept", intoLead.edges.length === 3, intoLead.edges.length);
check("the lead never reviews", reviewersOf(intoLead, "b").length === 0);
check("the lead never takes a handoff", handoffChain(intoLead, "b").length === 0);
check(
  "both inert links into the lead are reported",
  graphWarnings(intoLead).filter((w) => w.includes("answers the room directly")).length === 2,
  graphWarnings(intoLead),
);
check(
  "an over-cap reviewer count is reported",
  graphWarnings(manyReviewers).some((w) => w.includes("only the first")),
  graphWarnings(manyReviewers),
);

console.log("\npresets");

for (const p of GRAPH_PRESETS) {
  const clean = sanitizeGraph(p.graph);
  check(
    `preset "${p.id}" survives sanitizing unchanged`,
    stable(clean) === stable(p.graph),
    p.id,
  );
  check(`preset "${p.id}" is recognised by matchGraphPreset`, matchGraphPreset(p.graph) === p.id);
}
check(
  "presets other than lead-only wire something up",
  GRAPH_PRESETS.filter((p) => p.id !== "lead-only").every((p) => delegatesOf(p.graph).length > 0),
);
check(
  "presets carry no warnings",
  GRAPH_PRESETS.every((p) => graphWarnings(p.graph).length === 0),
  GRAPH_PRESETS.map((p) => [p.id, graphWarnings(p.graph)]),
);
check("the default graph is a preset", matchGraphPreset(DEFAULT_GRAPH) !== null);
check("the room starts with a valid graph", INITIAL_ROOM_STATE.graph.nodes.length > 0);

console.log("\ntool surface");

const team = GRAPH_PRESETS.find((p) => p.id === "researchers")!.graph;
const def = delegateDefFor(team);
const agentField = (def.input_schema.properties.tasks as any).items.properties.agent;
check(
  "the delegate roster is an enum, not a suggestion",
  Array.isArray(agentField.enum) && agentField.enum.length === delegatesOf(team).length,
  agentField.enum,
);
check(
  "every roster name is a real teammate",
  (agentField.enum as string[]).every((n) => team.nodes.some((x) => x.name === n)),
  agentField.enum,
);

const customTools = toolsFor(DEFAULT_POLICY, "custom", leadOf(team).model, team);
check("a wired graph gets delegate", toolNames(customTools).includes("delegate"));

// A lead handed a delegate tool with an empty roster would keep trying to use
// it, so an unwired graph must not get one at all.
const lonely = GRAPH_PRESETS.find((p) => p.id === "lead-only")!.graph;
const lonelyTools = toolsFor(DEFAULT_POLICY, "custom", leadOf(lonely).model, lonely);
check("an unwired graph gets no delegate", !toolNames(lonelyTools).includes("delegate"));
check(
  "custom mode with no graph gets no delegate",
  !toolNames(toolsFor(DEFAULT_POLICY, "custom", "claude-opus-5")).includes("delegate"),
);
check(
  "the built-in workflows are untouched",
  toolNames(toolsFor(DEFAULT_POLICY, "manager", "claude-opus-5")).includes("delegate") &&
    !toolNames(toolsFor(DEFAULT_POLICY, "solo", "claude-opus-5")).includes("delegate"),
);

console.log("\nbriefings");

const critic = GRAPH_PRESETS.find((p) => p.id === "researcher-critic")!.graph;
const brief = leadSystemFor(critic);
for (const n of delegatesOf(critic)) {
  check(`the lead is told about ${n.name}`, brief.includes(n.name));
}
check("the lead is told who reviews", brief.includes("Reviewed by Critic"));
check(
  "the lead is not told it is the one delegating to itself",
  !brief.includes(`## ${leadOf(critic).name} —`),
);
check(
  "an unwired graph tells the lead to work alone",
  leadSystemFor(lonely).includes("No teammates are wired up"),
);

const drafted = GRAPH_PRESETS.find((p) => p.id === "draft-edit")!.graph;
check("the lead is told a handoff replaces the output", leadSystemFor(drafted).includes("Handed off to"));

const worker = workerSystemFor(critic, critic.nodes.find((n) => n.id === "res")!);
check("a teammate is told its own name", worker.includes("Researcher"));
check("a teammate is told it is being reviewed", worker.includes("Critic"));
check(
  "a teammate keeps its own brief",
  worker.includes("Read sources properly rather than skimming"),
);

const stage = stageSystemFor(
  "reviews",
  critic.nodes.find((n) => n.id === "critic")!,
  critic.nodes.find((n) => n.id === "res")!,
  "look for invented citations",
);
check("a reviewer is told not to rewrite", stage.includes("not rewriting"));
check("a reviewer carries the link's instruction", stage.includes("look for invented citations"));

// An emptied instruction must not produce an empty prompt — the kind's own
// wording is the floor.
check(
  "an empty link instruction falls back to its default",
  promptOf({ id: "x", from: "a", to: "b", kind: "reviews", prompt: "   " }) ===
    relationInfo("reviews").defaultPrompt,
);

console.log("\nthe lead plan picks the right model");

const customSettings = sanitizeSettings({ ...DEFAULT_SETTINGS, workflow: "custom" });
check("custom is an accepted workflow", customSettings.workflow === "custom");
const plan = leadPlanFor(customSettings, critic);
check("custom mode runs the lead node's model", plan.model === leadOf(critic).model, plan.model);
check("custom mode uses the graph briefing", plan.system.includes("# Your team"));
check(
  "the built-in manager still runs agentModel",
  leadPlanFor(sanitizeSettings({ ...DEFAULT_SETTINGS, workflow: "manager" }), critic).model ===
    DEFAULT_SETTINGS.agentModel,
);
check(
  "solo gets no delegation briefing",
  !leadPlanFor(sanitizeSettings({ ...DEFAULT_SETTINGS, workflow: "solo" }), null).system.includes(
    "Delegating",
  ),
);

console.log("\nwho may draw the workflow");

// The point of the separate capability: editors shape the team, owners and
// admins decide what it costs.
check("editors may change the workflow", can("editor", "workflow"));
check("editors may not change models", !can("editor", "settings"));
check("viewers may not change the workflow", !can("viewer", "workflow"));
for (const role of ["owner", "admin"] as Role[]) {
  check(`${role} may change the workflow`, can(role, "workflow"));
}
check(
  "nobody holds settings without workflow",
  (Object.keys(ROLE_CAPS) as Role[]).every((r) => !can(r, "settings") || can(r, "workflow")),
);

console.log("\ndescriptions");
check("describeGraph names the lead", describeGraph(critic).includes(leadOf(critic).name));
check("describeGraph counts the team", describeGraph(critic).includes("1 teammate"));
check(
  "every relation kind has a mechanism sentence",
  RELATIONS.every((r) => r.mechanism.trim().length > 0),
);
check(
  "exactly one relation kind is prose-only",
  RELATIONS.filter((r) => !r.mechanical).length === 1,
  RELATIONS.filter((r) => !r.mechanical).map((r) => r.kind),
);

console.log(failures === 0 ? "\nAll workflow checks passed.\n" : `\n${failures} check(s) failed.\n`);
if (failures > 0) process.exit(1);
