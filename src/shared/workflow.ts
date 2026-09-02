/**
 * The room's agent graph: who the agents are, and how they relate.
 *
 * The built-in `solo` and `manager` workflows are two fixed shapes. This module
 * is the third option — a shape the room draws for itself: a lead agent that
 * talks to the room, teammates it can hand work to, and typed links between
 * them that say what each teammate is for.
 *
 * Three of the four link kinds are MECHANICAL: they change what actually runs
 * (see `room.ts#delegate`). The fourth, `custom`, is prose only — it is written
 * into the agents' briefings and nothing more. That distinction is carried on
 * `RELATIONS[].mechanical` and surfaced in the editor, because a link that
 * looks like wiring but only rewords a prompt would be a lie about the system.
 *
 * As with settings and policy, the client's copy of the validation here is a
 * courtesy. `sanitizeGraph` runs on the server and is the real boundary.
 */

import { MODELS, modelInfo } from "./models";

/* ------------------------------------------------------------------ shape */

/** One agent on the canvas. */
export type AgentNode = {
  /** Stable id. Referenced by edges and by the lead pointer. */
  id: string;
  /**
   * Display name, and the handle the lead uses in `delegate`'s `agent` field.
   * Unique within a graph — the sanitizer renames duplicates rather than
   * letting two teammates answer to the same word.
   */
  name: string;
  /** Model this agent runs on. Validated against the catalogue by role. */
  model: string;
  /** Free-text instructions appended to this agent's system prompt. */
  prompt: string;
  /** Canvas position, in graph units. */
  x: number;
  y: number;
  /**
   * Remote MCP servers this agent can call tools on — whether it's talking
   * to the room directly as the lead (see `room.ts#advance`) or running as a
   * delegate (see `room.ts#delegate`). Never carries a credential — a bearer
   * token lives in the room's own storage, keyed by (node id, server id),
   * because this type is synced to every connected client.
   */
  mcpServers: McpServerRef[];
};

/** One remote MCP server wired to an agent. Public — no token here. */
export type McpServerRef = {
  id: string;
  name: string;
  url: string;
};

/**
 * How one agent relates to another. Work always flows from -> to, so the arrow
 * on the canvas means the same thing for every kind.
 */
export type RelationKind = "delegates" | "reviews" | "handoff" | "custom";

export type Relation = {
  id: string;
  from: string;
  to: string;
  kind: RelationKind;
  /**
   * The instruction this link carries. Seeded from the kind's default and
   * editable — this is where a room says what it actually wants out of a
   * review or a handoff, rather than accepting the generic phrasing.
   */
  prompt: string;
};

export type WorkflowGraph = {
  nodes: AgentNode[];
  edges: Relation[];
  /** The agent that talks to the room. Must be a node, and must be a manager model. */
  leadId: string;
};

/* ------------------------------------------------------------------ limits */

/**
 * The size of one agent's card, in the same graph units positions use.
 *
 * Shared rather than kept in the editor because a node's position is its card's
 * top-left corner, so the card's size is what decides which positions are legal
 * — and the server has to agree with the canvas about that or it will hand back
 * a graph whose cards hang off the surface. The editor writes both numbers onto
 * the card as an inline style, so nothing can quietly render at another size.
 */
export const CARD = { w: 216, h: 140 } as const;

export const GRAPH_LIMITS = {
  nodes: 8,
  edges: 16,
  nameChars: 40,
  promptChars: 2000,
  /** Canvas extent in graph units. Positions are clamped into it. */
  width: 1600,
  height: 1000,
  /** How many handoff hops one worker result may travel before it stops. */
  handoffDepth: 2,
  /** Reviewers consulted per worker result. Beyond this they are ignored. */
  reviewers: 2,
  /** Remote MCP servers one agent may hold. */
  mcpServersPerNode: 3,
  mcpNameChars: 40,
  mcpUrlChars: 300,
} as const;

/**
 * The furthest a card's top-left may sit and still be wholly on the canvas.
 *
 * Both the drag handler and `sanitizeGraph` clamp to this, so a position that
 * survives the server is one the editor would also have allowed. Clamping to
 * the bare canvas extent instead let a node be saved at the far edge and then
 * drawn a full card-width past it.
 */
export const MAX_POS = {
  x: GRAPH_LIMITS.width - CARD.w,
  y: GRAPH_LIMITS.height - CARD.h,
} as const;

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/* --------------------------------------------------------------- relations */

export type RelationInfo = {
  kind: RelationKind;
  /** Verb phrase, read as "{from} {label} {to}". */
  label: string;
  /** What it does to the run. */
  mechanism: string;
  /** Whether it changes execution, or only what the agents are told. */
  mechanical: boolean;
  defaultPrompt: string;
};

export const RELATIONS: readonly RelationInfo[] = [
  {
    kind: "delegates",
    label: "delegates to",
    mechanism:
      "Puts the target on the lead's roster. The lead names it in a delegate " +
      "call, and several teammates run at the same time.",
    mechanical: true,
    defaultPrompt:
      "Give this teammate work that stands on its own — the question, the " +
      "constraints, and exactly what to report back. It shares none of your context.",
  },
  {
    kind: "reviews",
    label: "is reviewed by",
    mechanism:
      "After the source finishes, the target reads its output once and its " +
      "critique is attached to the result the lead receives.",
    mechanical: true,
    defaultPrompt:
      "Check this work for factual errors, unsupported claims, and parts of the " +
      "brief it did not answer. Be specific and short. Do not rewrite it.",
  },
  {
    kind: "handoff",
    label: "hands off to",
    mechanism:
      "After the source finishes, the target rewrites its output, and the " +
      "rewrite is what the lead receives instead.",
    mechanical: true,
    defaultPrompt:
      "Take the work below and produce the finished version. Keep every factual " +
      "claim and its source; change the shape and the wording, not the substance.",
  },
  {
    kind: "custom",
    label: "relates to",
    mechanism:
      "Written into both agents' briefings and nothing else. Nothing extra runs " +
      "— use it to describe intent the mechanical links do not cover.",
    mechanical: false,
    defaultPrompt: "",
  },
];

export function relationInfo(kind: RelationKind): RelationInfo {
  return RELATIONS.find((r) => r.kind === kind) ?? RELATIONS[3]!;
}

/* ----------------------------------------------------------------- presets */

export type GraphPreset = {
  id: string;
  label: string;
  description: string;
  graph: WorkflowGraph;
};

const node = (
  id: string,
  name: string,
  model: string,
  x: number,
  y: number,
  prompt = "",
): AgentNode => ({ id, name, model, prompt, x, y, mcpServers: [] });

const edge = (
  id: string,
  from: string,
  to: string,
  kind: RelationKind,
  prompt?: string,
): Relation => ({ id, from, to, kind, prompt: prompt ?? relationInfo(kind).defaultPrompt });

export const GRAPH_PRESETS: GraphPreset[] = [
  {
    id: "lead-only",
    label: "Lead only",
    description:
      "One agent, no team. The same thing the solo workflow does, drawn out — a " +
      "starting point to add teammates to.",
    graph: {
      leadId: "lead",
      nodes: [node("lead", "Lead", "claude-opus-5", 160, 380)],
      edges: [],
    },
  },
  {
    id: "researchers",
    label: "Lead and researchers",
    description:
      "Two cheap researchers the lead runs in parallel. The classic fan-out — the " +
      "expensive model spends its tokens on judgement, not on reading.",
    graph: {
      leadId: "lead",
      nodes: [
        node(
          "lead",
          "Lead",
          "claude-opus-5",
          140,
          380,
          "You plan the work, split it, and synthesise what comes back. Do not do " +
            "reading yourself that a researcher could do in parallel.",
        ),
        node(
          "res1",
          "Researcher A",
          "claude-haiku-4-5",
          660,
          200,
          "Read sources properly rather than skimming. Quote and cite.",
        ),
        node(
          "res2",
          "Researcher B",
          "claude-haiku-4-5",
          660,
          560,
          "Read sources properly rather than skimming. Quote and cite.",
        ),
      ],
      edges: [edge("e1", "lead", "res1", "delegates"), edge("e2", "lead", "res2", "delegates")],
    },
  },
  {
    id: "researcher-critic",
    label: "Researcher and critic",
    description:
      "Everything the researcher finds is checked by a second model before the lead " +
      "sees it, so a thin or invented answer is flagged rather than absorbed.",
    graph: {
      leadId: "lead",
      nodes: [
        node(
          "lead",
          "Lead",
          "claude-opus-5",
          120,
          380,
          "You plan the work and synthesise what comes back. Read the critic's notes " +
            "before you use a finding.",
        ),
        node(
          "res",
          "Researcher",
          "claude-haiku-4-5",
          620,
          380,
          "Read sources properly rather than skimming. Cite everything.",
        ),
        node(
          "critic",
          "Critic",
          "claude-sonnet-5",
          1120,
          380,
          "You are the room's check on cheap research. Assume nothing is verified.",
        ),
      ],
      edges: [edge("e1", "lead", "res", "delegates"), edge("e2", "res", "critic", "reviews")],
    },
  },
  {
    id: "draft-edit",
    label: "Draft, then edit",
    description:
      "A drafter writes fast and cheap, an editor rewrites what it produced. The lead " +
      "only ever sees the edited version.",
    graph: {
      leadId: "lead",
      nodes: [
        node(
          "lead",
          "Lead",
          "claude-opus-5",
          120,
          380,
          "You brief the drafter and decide what reaches the room.",
        ),
        node(
          "drafter",
          "Drafter",
          "claude-haiku-4-5",
          620,
          380,
          "Get the substance down. Do not polish — someone else does that.",
        ),
        node(
          "editor",
          "Editor",
          "claude-sonnet-5",
          1120,
          380,
          "Cut everything that is not doing work. Keep the argument and the sources.",
        ),
      ],
      edges: [edge("e1", "lead", "drafter", "delegates"), edge("e2", "drafter", "editor", "handoff")],
    },
  },
];

export const DEFAULT_GRAPH: WorkflowGraph = GRAPH_PRESETS.find((p) => p.id === "researchers")!.graph;

/**
 * What this graph *is*, ignoring where its cards happen to sit.
 *
 * Two graphs with the same key run identically — same lead, same team on the
 * same models with the same briefs, same links carrying the same instructions.
 * Node ids are deliberately not part of it: a graph saved in one room and
 * loaded into another keeps its ids, but a graph rebuilt by hand does not, and
 * "the same workflow" should mean the same behaviour rather than the same
 * bookkeeping.
 */
export function graphKey(x: WorkflowGraph): string {
  return JSON.stringify({
    lead: x.nodes.find((n) => n.id === x.leadId)?.name ?? "",
    nodes: x.nodes
      .map((n) => [
        n.name,
        n.model,
        n.prompt,
        // `?? []`: a graph persisted before mcpServers existed has nodes
        // without it — this is read straight off stored/synced state, not
        // sanitizeGraph's output, so the type's guarantee doesn't reach here.
        (n.mcpServers ?? []).map((s) => `${s.name}|${s.url}`).sort().join(","),
      ])
      .sort(),
    edges: x.edges
      .map((e) => [
        x.nodes.find((n) => n.id === e.from)?.name ?? "",
        x.nodes.find((n) => n.id === e.to)?.name ?? "",
        e.kind,
        e.prompt,
      ])
      .sort(),
  });
}

/** Which preset this graph corresponds to, ignoring positions, or null. */
export function matchGraphPreset(g: WorkflowGraph): string | null {
  const mine = graphKey(g);
  return GRAPH_PRESETS.find((p) => graphKey(p.graph) === mine)?.id ?? null;
}

/* ----------------------------------------------------- the saved library */

/**
 * A workflow someone kept, to start another room from.
 *
 * The built-in presets above are the shapes we ship; these are the shapes a
 * person built and wants again. They are stored with the person rather than
 * with a room — a room's graph belongs to everyone in it, but a library of
 * team designs is the property of whoever drew them, and its whole point is to
 * outlive the room it was drawn in.
 *
 * `graph` is a complete, already-sanitized graph, not a diff against a preset:
 * loading a saved workflow years later must not depend on what the built-in
 * presets happen to say by then.
 */
export type SavedWorkflow = {
  /** Stable id, minted where the library is stored. */
  id: string;
  /** What the person called it. Unique within a library, case-insensitively. */
  label: string;
  /** Unix ms. The library is ordered newest first. */
  savedAt: number;
  graph: WorkflowGraph;
};

export const SAVED_LIMITS = {
  /** How many workflows one library holds. Oldest fall off the end. */
  count: 24,
  labelChars: 40,
} as const;

const SAVED_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function savedLabel(v: unknown): string {
  return text(v, SAVED_LIMITS.labelChars).trim();
}

/**
 * Coerce a stored library into something loadable.
 *
 * This runs on data that has sat in a browser's storage across who knows how
 * many versions of the app, and that anyone with devtools can rewrite by hand,
 * so it is treated exactly like a frame off the wire: every graph goes through
 * `sanitizeGraph`, so a library entry can never load a graph the room itself
 * would have refused.
 */
export function sanitizeSavedWorkflows(input: unknown): SavedWorkflow[] {
  const out: SavedWorkflow[] = [];
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();

  for (const item of Array.isArray(input) ? input : []) {
    if (out.length >= SAVED_LIMITS.count) break;
    const r = (item ?? {}) as Partial<SavedWorkflow>;

    // An entry with no usable id or name is not repairable into anything
    // meaningful — a nameless workflow in a picker is a button nobody can
    // choose deliberately — so it is dropped rather than invented.
    const id = typeof r.id === "string" && SAVED_ID_RE.test(r.id) ? r.id : "";
    const label = savedLabel(r.label);
    if (!id || !label || seenIds.has(id) || seenLabels.has(label.toLowerCase())) continue;
    seenIds.add(id);
    seenLabels.add(label.toLowerCase());

    out.push({
      id,
      label,
      savedAt: typeof r.savedAt === "number" && Number.isFinite(r.savedAt) ? Math.max(0, Math.round(r.savedAt)) : 0,
      graph: sanitizeGraph(r.graph),
    });
  }

  return out;
}

/**
 * Put one workflow into a library, newest first.
 *
 * Saving over a name that is already taken replaces that entry rather than
 * making a second one wearing the same label: the picker shows names, so two
 * rows reading "Research team" would be a coin toss. Saving under the same id
 * is an update of that entry, whatever it is now called.
 */
export function saveWorkflow(
  library: SavedWorkflow[],
  entry: { id: string; label: string; graph: WorkflowGraph; savedAt?: number },
): SavedWorkflow[] {
  const label = savedLabel(entry.label);
  if (!label || !SAVED_ID_RE.test(entry.id)) return sanitizeSavedWorkflows(library);

  const saved: SavedWorkflow = {
    id: entry.id,
    label,
    savedAt: entry.savedAt ?? Date.now(),
    graph: sanitizeGraph(entry.graph),
  };
  const rest = sanitizeSavedWorkflows(library).filter(
    (w) => w.id !== saved.id && w.label.toLowerCase() !== label.toLowerCase(),
  );
  return [saved, ...rest].slice(0, SAVED_LIMITS.count);
}

/** Rename one entry, dropping anything the new name collides with. */
export function renameSavedWorkflow(
  library: SavedWorkflow[],
  id: string,
  label: string,
): SavedWorkflow[] {
  const clean = savedLabel(label);
  const list = sanitizeSavedWorkflows(library);
  const target = list.find((w) => w.id === id);
  if (!clean || !target) return list;
  return list
    .filter((w) => w.id === id || w.label.toLowerCase() !== clean.toLowerCase())
    .map((w) => (w.id === id ? { ...w, label: clean } : w));
}

export function removeSavedWorkflow(library: SavedWorkflow[], id: string): SavedWorkflow[] {
  return sanitizeSavedWorkflows(library).filter((w) => w.id !== id);
}

/** Which saved workflow this graph is, ignoring positions, or null. */
export function matchSavedWorkflow(library: SavedWorkflow[], g: WorkflowGraph): string | null {
  const mine = graphKey(g);
  return library.find((w) => graphKey(w.graph) === mine)?.id ?? null;
}

/* -------------------------------------------------------------- validation */

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.round(Math.min(hi, Math.max(lo, v)));
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function cloneGraph(g: WorkflowGraph): WorkflowGraph {
  return JSON.parse(JSON.stringify(g)) as WorkflowGraph;
}

/**
 * Coerce a node's `mcpServers` into something safe to run. Only remote,
 * https-reachable servers are accepted — this app has no way to run a local
 * stdio MCP server, and accepting a non-https URL here would just produce a
 * server that always fails when the agent tries to use it.
 */
function sanitizeMcpServers(value: unknown): McpServerRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: McpServerRef[] = [];
  for (const item of value) {
    if (out.length >= GRAPH_LIMITS.mcpServersPerNode) break;
    const r = (item ?? {}) as Partial<McpServerRef>;
    const id = typeof r.id === "string" && ID_RE.test(r.id) ? r.id : "";
    if (!id || seen.has(id)) continue;
    const url = text(r.url, GRAPH_LIMITS.mcpUrlChars).trim();
    if (!url.startsWith("https://")) continue;
    const name = text(r.name, GRAPH_LIMITS.mcpNameChars).trim() || "MCP Server";
    seen.add(id);
    out.push({ id, name, url });
  }
  return out;
}

/**
 * Coerce anything a client sends into a runnable graph.
 *
 * Every rule here exists because the graph decides which models get called and
 * how many times. A malformed frame must be able to produce a boring graph, and
 * must never be able to produce an unbounded one: node and edge counts are
 * capped, cycles are harmless because traversal is depth-bounded, and every
 * model id is re-checked against the catalogue by the role it is being put in.
 */
export function sanitizeGraph(input: unknown): WorkflowGraph {
  const raw = (input ?? {}) as Partial<WorkflowGraph>;

  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const nodes: AgentNode[] = [];

  for (const item of Array.isArray(raw.nodes) ? raw.nodes : []) {
    if (nodes.length >= GRAPH_LIMITS.nodes) break;
    const r = (item ?? {}) as Partial<AgentNode>;
    const id = typeof r.id === "string" && ID_RE.test(r.id) ? r.id : "";
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    // Names are the handle the lead delegates by, so two teammates answering to
    // one word would make a task ambiguous. Rename rather than drop.
    let name = text(r.name, GRAPH_LIMITS.nameChars).trim() || "Agent";
    if (seenNames.has(name.toLowerCase())) {
      let n = 2;
      while (seenNames.has(`${name} ${n}`.toLowerCase())) n++;
      name = `${name} ${n}`;
    }
    seenNames.add(name.toLowerCase());

    nodes.push({
      id,
      name,
      model: typeof r.model === "string" ? r.model : "",
      prompt: text(r.prompt, GRAPH_LIMITS.promptChars),
      x: clamp(r.x, 0, MAX_POS.x, 100),
      y: clamp(r.y, 0, MAX_POS.y, 100),
      mcpServers: sanitizeMcpServers(r.mcpServers),
    });
  }

  // A graph with no agents is not a graph. Fall back rather than leaving a room
  // pointed at a lead that does not exist.
  if (nodes.length === 0) return cloneGraph(DEFAULT_GRAPH);

  // The lead is whichever node claims it, else the first that could manage, else
  // the first node — which the model check below then forces onto a manager.
  const leadId =
    (typeof raw.leadId === "string" && nodes.some((n) => n.id === raw.leadId) && raw.leadId) ||
    nodes.find((n) => n.model && modelInfo(n.model).canManage)?.id ||
    nodes[0]!.id;

  // Models are checked by the role the node is actually in: a lead has to be a
  // model that can plan and drive tools, a teammate has to be one we are willing
  // to fan out to. An unknown id falls back rather than reaching the API.
  const fallbackLead = MODELS.find((m) => m.canManage)!.id;
  const fallbackWorker = MODELS.find((m) => m.canWork)!.id;
  for (const n of nodes) {
    const wantManager = n.id === leadId;
    const ok = MODELS.find((m) => m.id === n.model && (wantManager ? m.canManage : m.canWork));
    n.model = ok?.id ?? (wantManager ? fallbackLead : fallbackWorker);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seenEdges = new Set<string>();
  const edges: Relation[] = [];

  for (const item of Array.isArray(raw.edges) ? raw.edges : []) {
    if (edges.length >= GRAPH_LIMITS.edges) break;
    const r = (item ?? {}) as Partial<Relation>;
    const id = typeof r.id === "string" && ID_RE.test(r.id) ? r.id : "";
    const from = typeof r.from === "string" ? r.from : "";
    const to = typeof r.to === "string" ? r.to : "";
    if (!id || !byId.has(from) || !byId.has(to) || from === to) continue;

    const kind: RelationKind = RELATIONS.some((k) => k.kind === r.kind)
      ? (r.kind as RelationKind)
      : "custom";
    // One relationship per ordered pair per kind. A duplicate would double the
    // work a mechanical link causes without saying anything new.
    const key = `${from}>${to}:${kind}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);

    edges.push({ id, from, to, kind, prompt: text(r.prompt, GRAPH_LIMITS.promptChars) });
  }

  return { nodes, edges, leadId };
}

/* ------------------------------------------------------------- traversal */

export function leadOf(g: WorkflowGraph): AgentNode {
  return g.nodes.find((n) => n.id === g.leadId) ?? g.nodes[0]!;
}

export function nodeById(g: WorkflowGraph, id: string): AgentNode | undefined {
  return g.nodes.find((n) => n.id === id);
}

/**
 * Teammates the lead may hand tasks to.
 *
 * Only the lead's own `delegates` links count. Workers are handed a tool list
 * without `delegate` on it (see `WORKER_TOOLS`), so a teammate cannot fan out
 * again however the canvas is drawn — a graph that says otherwise is describing
 * something the runtime will not do, which is what `graphWarnings` reports.
 */
export function delegatesOf(g: WorkflowGraph): AgentNode[] {
  const out: AgentNode[] = [];
  for (const e of g.edges) {
    if (e.kind !== "delegates" || e.from !== g.leadId) continue;
    const n = nodeById(g, e.to);
    if (n && n.id !== g.leadId && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Reviewers of one node's output, capped. */
export function reviewersOf(g: WorkflowGraph, nodeId: string): AgentNode[] {
  return g.edges
    .filter((e) => e.kind === "reviews" && e.from === nodeId)
    .map((e) => nodeById(g, e.to))
    .filter((n): n is AgentNode => !!n && n.id !== g.leadId)
    .slice(0, GRAPH_LIMITS.reviewers);
}

/**
 * The handoff chain starting at one node, depth-bounded and cycle-free.
 *
 * The bound is not decoration: a graph is drawn by hand and may well contain a
 * cycle, and every hop is a paid model call. Both the visited set and the depth
 * limit have to hold for this to be safe to run on a graph nobody reviewed.
 */
export function handoffChain(g: WorkflowGraph, nodeId: string): AgentNode[] {
  const chain: AgentNode[] = [];
  const seen = new Set<string>([nodeId]);
  let current = nodeId;
  for (let hop = 0; hop < GRAPH_LIMITS.handoffDepth; hop++) {
    const next = g.edges.find((e) => e.kind === "handoff" && e.from === current);
    if (!next || seen.has(next.to)) break;
    const n = nodeById(g, next.to);
    if (!n || n.id === g.leadId) break;
    chain.push(n);
    seen.add(n.id);
    current = n.id;
  }
  return chain;
}

/** The instruction one link carries, falling back to its kind's default. */
export function promptOf(e: Relation): string {
  return e.prompt.trim() || relationInfo(e.kind).defaultPrompt;
}

/** Custom links touching a node, in both directions, for its briefing. */
export function customLinksFor(g: WorkflowGraph, nodeId: string): string[] {
  return g.edges
    .filter((e) => e.kind === "custom" && (e.from === nodeId || e.to === nodeId))
    .map((e) => {
      const other = nodeById(g, e.from === nodeId ? e.to : e.from);
      const line = promptOf(e).trim();
      if (!other || !line) return "";
      return e.from === nodeId ? `Toward ${other.name}: ${line}` : `From ${other.name}: ${line}`;
    })
    .filter(Boolean);
}

/* -------------------------------------------------------------- warnings */

/**
 * Everything about this graph that will not do what it looks like it does.
 *
 * Shown in the editor rather than fixed silently. A link the runtime ignores is
 * worth saying out loud — quietly deleting someone's arrow teaches them nothing,
 * and quietly keeping it teaches them something false.
 */
export function graphWarnings(g: WorkflowGraph): string[] {
  const out: string[] = [];
  const lead = leadOf(g);
  const roster = delegatesOf(g);

  if (roster.length === 0 && g.nodes.length > 1) {
    out.push(
      `Nothing is delegated. Draw a "delegates to" link from ${lead.name} to a teammate, ` +
        `or the room runs ${lead.name} alone.`,
    );
  }

  for (const e of g.edges) {
    if (e.kind !== "delegates" || e.from === g.leadId) continue;
    const from = nodeById(g, e.from);
    const to = nodeById(g, e.to);
    out.push(
      `${from?.name ?? "?"} cannot delegate to ${to?.name ?? "?"} — only the lead has the ` +
        `delegate tool, so this link does nothing.`,
    );
  }

  // A review or handoff pointing back at the lead reads like wiring and is not:
  // the lead runs the room's own turn, and there is no teammate output for it to
  // take a second pass over. Reported rather than blocked, so the arrow someone
  // drew is explained instead of vanishing under their cursor.
  for (const e of g.edges) {
    if (e.to !== g.leadId || e.kind === "custom" || e.kind === "delegates") continue;
    const from = nodeById(g, e.from);
    out.push(
      `${from?.name ?? "?"} ${relationInfo(e.kind).label} ${lead.name}, but the lead answers ` +
        `the room directly rather than passing work on, so this link does nothing.`,
    );
  }

  // reviewersOf slices to the cap, so the count has to come off the raw edges.
  for (const n of g.nodes) {
    const asked = g.edges.filter((e) => e.kind === "reviews" && e.from === n.id).length;
    if (asked > GRAPH_LIMITS.reviewers) {
      out.push(
        `${n.name} has ${asked} reviewers, and only the first ${GRAPH_LIMITS.reviewers} run.`,
      );
    }
  }

  const reachable = new Set<string>([g.leadId, ...roster.map((n) => n.id)]);
  for (const n of roster) {
    for (const r of reviewersOf(g, n.id)) reachable.add(r.id);
    for (const h of handoffChain(g, n.id)) reachable.add(h.id);
  }
  for (const n of g.nodes) {
    if (!reachable.has(n.id)) out.push(`${n.name} is never reached, so it will never run.`);
  }

  return out;
}

/** Who runs this graph and how much of it is wiring. One line, no verdict. */
export function summarizeGraph(g: WorkflowGraph): string {
  const lead = leadOf(g);
  const roster = delegatesOf(g);
  const mech = g.edges.filter((e) => relationInfo(e.kind).mechanical).length;
  const team = roster.length
    ? `${roster.length} teammate${roster.length === 1 ? "" : "s"} (${roster
        .map((n) => n.name)
        .join(", ")})`
    : "no teammates";
  return `${lead.name} on ${modelInfo(lead.model).label} · ${team} · ${mech} link${
    mech === 1 ? "" : "s"
  }`;
}

/** Short human summary for the transcript audit line. */
export function describeGraph(g: WorkflowGraph): string {
  return `custom · ${summarizeGraph(g)}`;
}
