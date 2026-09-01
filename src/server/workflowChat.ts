/**
 * "Describe your workflow" — turning prose into a draft agent graph.
 *
 * One rule matters more than the prompt wording: nothing this module returns
 * is trusted just because a tool schema shaped it. The model's tool call is
 * parsed defensively and every graph it proposes is run through the exact same
 * `sanitizeGraph` an Apply is checked by, so a hostile or malformed completion
 * can produce a boring graph but never an unrunnable or unbounded one.
 *
 * Positions are never asked of the model — it has no reason to be good at
 * canvas layout, and asking for numbers it will guess badly just spends tokens
 * on noise. `layout` places nodes with the same lead-then-fan-out shape the
 * built-in presets use, before the graph goes through `sanitizeGraph`.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { MODELS } from "../shared/models";
import type { ModelConfig } from "./model";
import {
  CARD,
  GRAPH_LIMITS,
  MAX_POS,
  RELATIONS,
  graphWarnings,
  sanitizeGraph,
  summarizeGraph,
} from "../shared/workflow";
import type { WorkflowChatReply, WorkflowChatTurn } from "../shared/protocol";

/** How many turns of conversation the model ever sees, oldest dropped first. */
export const MAX_CHAT_TURNS = 20;
/** Characters kept from one turn's text. */
export const MAX_TURN_CHARS = 2000;

/** Coerce anything a client sends into a bounded, model-safe conversation. */
export function sanitizeChatTurns(input: unknown): WorkflowChatTurn[] {
  const out: WorkflowChatTurn[] = [];
  for (const item of Array.isArray(input) ? input : []) {
    const r = (item ?? {}) as Partial<WorkflowChatTurn>;
    const role = r.role === "assistant" ? "assistant" : "user";
    const text = typeof r.text === "string" ? r.text.trim().slice(0, MAX_TURN_CHARS) : "";
    if (!text) continue;
    out.push({ role, text });
  }
  return out.slice(-MAX_CHAT_TURNS);
}

const roster = MODELS.map((m) => {
  const role = m.canManage && m.canWork ? "lead or teammate" : m.canManage ? "lead only" : "teammate only";
  return `- ${m.id} — ${role}, ${m.blurb}`;
}).join("\n");

const kinds = RELATIONS.map((r) => `- ${r.kind}: ${r.mechanism}`).join("\n");

const SYSTEM_PROMPT = `You turn a room's plain-English description of a team into a draft agent graph for our editor. Call propose_workflow exactly once — never reply in plain text.

A graph is a lead agent (the only one the room talks to) plus up to ${GRAPH_LIMITS.nodes - 1} teammates, connected by typed links (up to ${GRAPH_LIMITS.edges} total):
${kinds}

Only "delegates" links from the lead actually run work — a teammate the lead never delegates to never runs. "reviews" and "handoff" links originate at a teammate the lead delegates to, not at the lead itself.

Models available, by id:
${roster}

Rules:
- If the description is workable, call propose_workflow with kind "graph": a lead node, however many teammates the task genuinely needs (favor fewer, focused teammates over many), and the links between them. Give every node a short "prompt" (its brief) written in the second person ("You research...", "You check..."). Node ids must be short lowercase slugs, unique. leadId must match one node's id.
- If the description is too vague to draft anything reasonable (e.g. "make me a workflow" with no subject), call propose_workflow with kind "question" and ask exactly one short, concrete question — never more than one, and never when you could instead make a reasonable default choice.
- When refining a graph you already proposed (the conversation will summarize it), change only what the new message asks for and keep the rest.
- Do not invent positions — none are asked for.`;

type ProposeInput = {
  kind: "graph" | "question";
  question?: string;
  note?: string;
  leadId?: string;
  nodes?: { id: string; name: string; model: string; prompt: string }[];
  edges?: { id: string; from: string; to: string; kind: string; prompt?: string }[];
};

const TOOL = {
  name: "propose_workflow",
  description: "Report either a clarifying question or a drafted agent graph.",
  input_schema: {
    type: "object" as const,
    properties: {
      kind: { type: "string" as const, enum: ["graph", "question"] },
      question: { type: "string" as const, description: "One short question. Required when kind is 'question'." },
      note: { type: "string" as const, description: "One short sentence describing the draft, shown to the room. Required when kind is 'graph'." },
      leadId: { type: "string" as const },
      nodes: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const },
            name: { type: "string" as const },
            model: { type: "string" as const },
            prompt: { type: "string" as const },
          },
          required: ["id", "name", "model", "prompt"],
        },
      },
      edges: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const },
            from: { type: "string" as const },
            to: { type: "string" as const },
            kind: { type: "string" as const, enum: RELATIONS.map((r) => r.kind) },
            prompt: { type: "string" as const },
          },
          required: ["id", "from", "to", "kind"],
        },
      },
    },
    required: ["kind"],
  },
};

/**
 * Place nodes the model did not (and should not) supply coordinates for.
 *
 * Same shape the hand-built presets use: the lead on the left, its teammates
 * fanned out in a column to the right, anything left over (a teammate of a
 * teammate, or an orphan) cascading below. `sanitizeGraph` clamps whatever
 * comes out of this into bounds regardless, so a bad layout here is cosmetic,
 * never a validity hole.
 */
function layout(nodes: { id: string }[], edges: { from: string; to: string }[], leadId: string) {
  const positions = new Map<string, { x: number; y: number }>();
  const laneX = (col: number) => Math.min(MAX_POS.x, 140 + col * (CARD.w + 100));
  const laneY = (row: number) => Math.min(MAX_POS.y, 100 + row * (CARD.h + 40));

  positions.set(leadId, { x: laneX(0), y: laneY(1) });

  const directTeam = [...new Set(edges.filter((e) => e.from === leadId).map((e) => e.to))].filter(
    (id) => id !== leadId,
  );
  directTeam.forEach((id, i) => positions.set(id, { x: laneX(1), y: laneY(i) }));

  let overflowRow = directTeam.length;
  for (const n of nodes) {
    if (positions.has(n.id)) continue;
    positions.set(n.id, { x: laneX(2), y: laneY(overflowRow) });
    overflowRow++;
  }

  return positions;
}

function client(cfg: ModelConfig) {
  return new Anthropic({ apiKey: cfg.apiKey });
}

/**
 * Merge consecutive same-role turns into one message.
 *
 * The API requires strict user/assistant alternation. The client's turn list
 * does not guarantee that on its own — a turn that errored leaves no assistant
 * reply in between, so a retry lands as two "user" turns in a row — and a
 * violation here is a 400 that would otherwise read as "could not reach the
 * model" no matter how good the conversation looks. Merging is the fix that
 * holds regardless of what shape the client's turns arrive in.
 */
export function coalesceTurns(turns: WorkflowChatTurn[]): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content += `\n\n${t.text}`;
    else out.push({ role: t.role, content: t.text });
  }
  // The API requires the first message to be from the user.
  while (out.length && out[0]!.role !== "user") out.shift();
  return out;
}

export type ProposeResult = { reply: WorkflowChatReply };

/**
 * One call: read the conversation, produce either a clarifying question or a
 * sanitized graph. Never throws — every failure mode becomes an "error" reply
 * so the caller can hand it straight to the client.
 */
export async function proposeWorkflow(
  cfg: ModelConfig,
  model: string,
  turns: WorkflowChatTurn[],
): Promise<ProposeResult> {
  if (turns.length === 0) {
    return { reply: { kind: "error", message: "Describe what you want the team to do first." } };
  }

  if (cfg.apiKey === "mock") return mockPropose(turns);

  let message: Message;
  try {
    message = (await client(cfg).messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: coalesceTurns(turns) as never,
    } as never)) as Message;
  } catch (err) {
    // Logged rather than surfaced: the message the user sees must never carry
    // API error detail, but a silent catch here would leave every failure
    // indistinguishable from a network blip.
    console.error("workflowChat: model call failed", err);
    return { reply: { kind: "error", message: "Could not reach the model. Try again." } };
  }

  const call = message.content.find((b) => b.type === "tool_use");
  if (!call || call.type !== "tool_use") {
    return { reply: { kind: "error", message: "The model did not return a usable answer. Try rephrasing." } };
  }

  return finish(call.input);
}

/** Turn one raw tool call into a reply, running any graph through `sanitizeGraph`. Exported for direct testing of the validation path against hostile or malformed model output. */
export function finish(input: unknown): ProposeResult {
  const raw = (input ?? {}) as Partial<ProposeInput>;

  if (raw.kind === "question") {
    const text = typeof raw.question === "string" ? raw.question.trim().slice(0, 300) : "";
    if (!text) {
      return { reply: { kind: "error", message: "The model asked nothing usable. Try rephrasing." } };
    }
    return { reply: { kind: "question", text } };
  }

  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const edges = Array.isArray(raw.edges) ? raw.edges : [];
  const leadId =
    (typeof raw.leadId === "string" && nodes.some((n) => n?.id === raw.leadId) && raw.leadId) ||
    nodes[0]?.id ||
    "";

  if (!leadId) {
    return { reply: { kind: "error", message: "The model proposed no agents. Try describing the team again." } };
  }

  const positioned = layout(
    nodes.filter((n): n is NonNullable<typeof n> => !!n && typeof n.id === "string"),
    edges.filter((e): e is NonNullable<typeof e> => !!e && typeof e.from === "string" && typeof e.to === "string"),
    leadId,
  );

  const graph = sanitizeGraph({
    leadId,
    nodes: nodes
      .filter((n): n is NonNullable<typeof n> => !!n)
      .map((n) => ({ ...n, ...(positioned.get(n.id) ?? { x: 100, y: 100 }) })),
    edges,
  });

  const note = (typeof raw.note === "string" ? raw.note.trim() : "").slice(0, 300) || summarizeGraph(graph);
  const warnings = graphWarnings(graph);

  return { reply: { kind: "graph", graph, note, warnings } };
}

/** Deterministic stand-in for tests and offline dev, mirroring model.ts's own mock branches. */
function mockPropose(turns: WorkflowChatTurn[]): ProposeResult {
  const last = turns[turns.length - 1]!.text.toLowerCase();
  if (last.length < 8) {
    return finish({
      kind: "question",
      question: "What should this team actually work on?",
    });
  }
  return finish({
    kind: "graph",
    note: "(mock) A lead and one researcher.",
    leadId: "lead",
    nodes: [
      { id: "lead", name: "Lead", model: "claude-opus-5", prompt: "You plan and synthesise." },
      { id: "res", name: "Researcher", model: "claude-haiku-4-5", prompt: "You research and cite sources." },
    ],
    edges: [{ id: "e1", from: "lead", to: "res", kind: "delegates" }],
  });
}
