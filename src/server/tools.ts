/**
 * The agent's tool surface.
 *
 * Custom tools run here in the Worker; the room's shared document is their only
 * side effect. Web search and fetch are Anthropic's server-side tools — they
 * resolve inside the API call and never reach this file.
 *
 * `gatedFor` is the security boundary: those tools do not run until the room votes.
 */

import { resolveTools, type AccessPolicy, type ToolName } from "../shared/access";
import { serverToolsFor, type Workflow } from "../shared/models";
import { delegatesOf, type WorkflowGraph } from "../shared/workflow";
import { findUniqueText, type WorkspaceInfo } from "../shared/workspace";

export type ToolCtx = {
  getDoc(): string;
  setDoc(next: string): void;
};

export type ToolOutcome = { ok: boolean; text: string };

/**
 * Tools the room must vote on, under this policy.
 *
 * This used to be a fixed set of two names. It is now a function of the room's
 * configuration, which is what lets a room choose to auto-accept edits or to
 * put delegation to a vote.
 */
export function gatedFor(policy: AccessPolicy): Set<string> {
  const decisions = resolveTools(policy);
  return new Set(
    (Object.keys(decisions) as ToolName[]).filter((n) => decisions[n] === "ask"),
  );
}

const DELEGATE_DEF = {
  name: "delegate",
  description:
    "Hand independent subtasks to parallel worker models; send them all in " +
    "one call. Workers are read-only: they can read the shared document, " +
    "search, and fetch, but not edit. They share no context, so write self-" +
    "contained tasks — question, constraints, expected report. Tasks beyond " +
    "the worker cap are dropped; send important ones first.",
  input_schema: {
    type: "object" as const,
    properties: {
      tasks: {
        type: "array",
        description: "Independent subtasks to run in parallel.",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Short label shown to the room.",
            },
            instructions: {
              type: "string",
              description: "Self-contained brief: question, constraints, and expected output.",
            },
          },
          required: ["title", "instructions"],
        },
      },
    },
    required: ["tasks"],
  },
};

/**
 * `delegate`, narrowed to the teammates a custom graph actually wired up.
 *
 * The roster goes in as an `enum` rather than as prose in the description: an
 * enum is the only part of a tool definition the model cannot talk itself out
 * of, and a task addressed to a teammate that is not on the canvas has nowhere
 * to run. The per-teammate blurb still goes in the description, because the
 * model needs to know what each one is FOR, not merely that it exists.
 */
export function delegateDefFor(graph: WorkflowGraph) {
  const roster = delegatesOf(graph);
  const names = roster.map((n) => n.name);
  const lines = roster
    .map((n) => `- ${n.name}: ${n.prompt.trim().split("\n")[0] || "no brief given"}`)
    .join("\n");

  return {
    name: "delegate",
    description:
      "Hand independent subtasks to your teammates; send them all in one call " +
      "so they run at the same time. Name the teammate in each task's `agent` " +
      "field. Teammates are read-only and share none of your context, so write " +
      "self-contained briefs. Tasks beyond the room's worker cap are dropped.\n\n" +
      `Your team:\n${lines}`,
    input_schema: {
      type: "object" as const,
      properties: {
        tasks: {
          type: "array",
          description: "Independent subtasks to run in parallel.",
          items: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                enum: names,
                description: "Which teammate takes this task.",
              },
              title: { type: "string", description: "Short label shown to the room." },
              instructions: {
                type: "string",
                description:
                  "Self-contained brief: question, constraints, and expected output.",
              },
            },
            required: ["agent", "title", "instructions"],
          },
        },
      },
      required: ["tasks"],
    },
  };
}

/**
 * Anthropic custom tool definitions.
 *
 * Server-side tools (web_search, web_fetch) are NOT included here — which
 * variant is valid depends on the model (see `serverToolsFor` in
 * shared/models.ts), so they are appended per-model by the functions below
 * rather than baked into this fixed list.
 */
export const TOOL_DEFS = [
  {
    name: "read_doc",
    description:
      "Read the shared document in full. Read before editing — other turns or " +
      "approved writes may have changed it since you last looked.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "write_doc",
    description:
      "Replace the entire shared document. Destructive — discards existing " +
      "content. Prefer edit_doc for targeted changes; use this only for a " +
      "first draft or full rewrite.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The complete new contents of the document (Markdown).",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "edit_doc",
    description:
      "Replace one exact span of text in the shared document. old_text must " +
      "match exactly once; zero or multiple matches reject the edit.",
    input_schema: {
      type: "object" as const,
      properties: {
        old_text: {
          type: "string",
          description:
            "Exact text to replace, including whitespace. Include enough " +
            "context to make it unique.",
        },
        new_text: {
          type: "string",
          description: "Text to put in its place. Empty string deletes the span.",
        },
      },
      required: ["old_text", "new_text"],
    },
  },
  {
    name: "list_files",
    description:
      "List files and directories in the workspace. Start here before " +
      "reading — paths cannot be guessed. Relative to workspace root; use " +
      "\"\" for root. Some paths are off-limits and refused.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Directory to list, relative to workspace root. Empty string for root.",
        },
        depth: {
          type: "integer",
          description: "Levels to descend; result is capped.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description:
      "Read one file from the workspace. Large files are truncated; use " +
      "offset to page through the rest. Some paths are off-limits and refused.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File to read, relative to workspace root." },
        offset: {
          type: "integer",
          description: "Byte offset to resume a truncated read.",
        },
        limit: { type: "integer", description: "Maximum bytes to return." },
      },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description:
      "Search the workspace for a literal substring, case-insensitive. Some " +
      "paths are off-limits and refused.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Literal substring to search for." },
        glob: {
          type: "string",
          description: "Restrict to matching paths, e.g. src/**/*.ts. Empty means everywhere.",
        },
        max: { type: "integer", description: "Maximum matches to return." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "semantic_search",
    description:
      "Search the indexed repository by meaning and related code concepts. " +
      "Use this to find relevant files in a large codebase without repeatedly " +
      "listing and rereading the repository. The IDE must index the workspace first.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Concept, behavior, symbol, or bug to find." },
        max: { type: "integer", description: "Maximum indexed passages to return." },
      },
      required: ["query"],
    },
  },
  {
    name: "write_file",
    description:
      "Replace a file's entire contents, creating it if missing. Destructive " +
      "— discards existing content. Prefer edit_file for targeted changes. " +
      "Workspace must allow writes.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File to write, relative to workspace root." },
        content: { type: "string", description: "The complete new contents of the file." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace one exact span of text in a file. old_text must match exactly " +
      "once; zero or multiple matches reject the edit. Workspace must allow writes.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File to edit, relative to workspace root." },
        old_text: {
          type: "string",
          description:
            "Exact text to replace, including whitespace. Include enough " +
            "context to make it unique.",
        },
        new_text: {
          type: "string",
          description: "Text to put in its place. Empty string deletes the span.",
        },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "delete_file",
    description:
      "Delete a file from the workspace. Irreversible. Workspace must allow writes.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File to delete, relative to workspace root." },
      },
      required: ["path"],
    },
  },
  {
    name: "ask_room",
    description:
      "Ask the room to decide between options, when the direction genuinely " +
      "forks and it isn't yours to pick. Always goes to a vote — use it for " +
      "real decisions, sparingly, not for routine confirmations or anything " +
      "already covered by a gated write.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description: "The question, framed so any option below answers it.",
        },
        options: {
          type: "array",
          description: "At least two choices the room can pick from.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short label for this choice." },
              description: { type: "string", description: "One line of detail, optional." },
            },
            required: ["label"],
          },
        },
      },
      required: ["question", "options"],
    },
  },
];

/** Solo workflow: the full set, no delegation. */
export const AGENT_TOOLS = TOOL_DEFS;

/** Manager workflow: everything the solo agent has, plus a team to hand work to. */
export const MANAGER_TOOLS = [...TOOL_DEFS, DELEGATE_DEF];

/**
 * What a worker gets. Read-only by construction — no document writes, and no
 * delegate, so a worker cannot spawn workers of its own. This is why worker
 * output never needs the room's approval: it cannot change anything.
 */
// Not derived from a policy: workers are read-only unconditionally, by
// construction, regardless of what the room's agent permission policy allows.
// Workers are read-only by construction, which is why their output never needs
// the room's approval. Every tool that changes something is withheld — the
// workspace writes as much as the document ones, since a worker offered a tool
// it cannot use will spend a turn discovering that.
const WORKER_EXCLUDED = new Set([
  "write_doc",
  "edit_doc",
  "write_file",
  "edit_file",
  "delete_file",
  // Workers report their findings back to the lead, not the room directly —
  // they have no channel to put a question to a vote.
  "ask_room",
]);
export const WORKER_TOOLS = TOOL_DEFS.filter(
  (t) => !("name" in t) || !WORKER_EXCLUDED.has(t.name as string),
);

/** The name a tool definition is known by, whether custom or server-side. */
function toolName(def: unknown): string {
  return (def as { name?: string }).name ?? "";
}

/**
 * The tool definitions this room's agent actually gets.
 *
 * A denied tool is removed from the list rather than gated: the agent should
 * not spend a turn proposing something the room has already refused. Order is
 * preserved (custom tools first, then the model's server tools last) so the
 * cached prompt prefix stays stable for a given model + policy.
 *
 * The policy filter runs AFTER the server tools are appended, so a denial of
 * `web_search` (say) drops it regardless of which variant `serverToolsFor`
 * picked for this model.
 */
export function toolsFor(
  policy: AccessPolicy,
  workflow: Workflow,
  modelId: string,
  graph?: WorkflowGraph,
): unknown[] {
  const decisions = resolveTools(policy);
  // A custom graph with nothing wired to the lead is a solo room, and a lead
  // handed a delegate tool with an empty roster would keep trying to use it.
  const base =
    workflow === "custom"
      ? graph && delegatesOf(graph).length > 0
        ? [...TOOL_DEFS, delegateDefFor(graph)]
        : AGENT_TOOLS
      : workflow === "manager"
        ? MANAGER_TOOLS
        : AGENT_TOOLS;
  const withServerTools = [...base, ...serverToolsFor(modelId)];
  return withServerTools.filter((def) => {
    const name = toolName(def);
    const decision = decisions[name as ToolName];
    return decision === undefined ? true : decision !== "deny";
  });
}

/**
 * Whether a room's workspace state grants the file tools.
 *
 * Reads `kind` and deliberately ignores `online` — see `toolsForRoom`. Named
 * and exported rather than written inline at the call site so the invariant has
 * somewhere to be tested: a workspace that is connected but unreachable must
 * still grant the tools.
 */
export function workspaceGrantsFileTools(ws: WorkspaceInfo): boolean {
  return ws.kind !== "none";
}

/** The tools that require a live round trip to a connected workspace. */
const WORKSPACE_TOOL_NAMES = new Set([
  "list_files", "read_file", "search_files",
  "semantic_search",
  "write_file", "edit_file", "delete_file",
]);

/**
 * Tool definitions for a room, given its policy AND whether a workspace is
 * attached to it.
 *
 * The file tools are withheld from a room that has no workspace at all: an
 * agent handed a tool that can never work will keep trying it, so absence is
 * better than a tool that only ever returns an error.
 *
 * Note the condition is *connected*, not *reachable*. A room whose relay has
 * momentarily dropped keeps its file tools and gets an error from `#fs`
 * instead. Tools render at position 0 of the prompt, so adding or removing one
 * invalidates the entire cached prefix — system and the whole conversation with
 * it. Keying tool presence on `online` meant a browser tab closing re-billed
 * the room's full context at cold prices; keying it on `kind` means that
 * happens only when someone deliberately connects or disconnects a workspace,
 * which is rare and worth one rebuild.
 */
export function toolsForRoom(
  policy: AccessPolicy,
  workflow: Workflow,
  workspaceConnected: boolean,
  modelId: string,
  graph?: WorkflowGraph,
): unknown[] {
  const base = toolsFor(policy, workflow, modelId, graph);
  if (workspaceConnected) return base;
  return base.filter((def) => !WORKSPACE_TOOL_NAMES.has(toolName(def)));
}

/**
 * Worker tools under this policy, for the given worker model. Workers can
 * never write, gated or not. Server tools are appended last (same ordering
 * intent as `toolsFor`) and the policy filter runs after that append, so a
 * denial reaches them whichever variant `serverToolsFor` picked.
 */
export function workerToolsFor(policy: AccessPolicy, modelId: string): unknown[] {
  const decisions = resolveTools(policy);
  const withServerTools = [...WORKER_TOOLS, ...serverToolsFor(modelId)];
  return withServerTools.filter((def) => {
    const name = toolName(def);
    const decision = decisions[name as ToolName];
    return decision === undefined ? true : decision !== "deny";
  });
}

export type AskRoomOption = { id: string; label: string; description?: string };

/**
 * Validates and normalizes an `ask_room` call's input into option records
 * with a stable id (the option's position), or null if the call is malformed
 * — a missing question, or fewer than two labeled options.
 */
export function parseAskRoomOptions(input: any): AskRoomOption[] | null {
  const question = input?.question;
  if (typeof question !== "string" || question.trim() === "") return null;

  const raw = input?.options;
  if (!Array.isArray(raw) || raw.length < 2) return null;

  const options: AskRoomOption[] = [];
  for (let i = 0; i < raw.length; i++) {
    const label = raw[i]?.label;
    if (typeof label !== "string" || label.trim() === "") return null;
    const description = typeof raw[i]?.description === "string" ? raw[i].description : undefined;
    options.push({ id: String(i), label, description });
  }
  return options;
}

/**
 * What an MCP call will do, for the card the room votes on.
 *
 * The arguments are shown, not just the tool name: the MCP spec asks clients to
 * "show tool inputs to the user before calling the server, to avoid malicious
 * or accidental data exfiltration", and a vote on a call whose arguments nobody
 * saw is not really a safeguard.
 */
export function summarizeMcpCall(serverName: string, toolName: string, input: unknown): string {
  const tool = toolName.replace(/^mcp__[^_]*(?:_[^_]+)*?__/, "") || toolName;
  let args = "";
  try {
    const json = JSON.stringify(input ?? {});
    args = json === "{}" ? "" : ` with ${preview(json, 160)}`;
  } catch {
    args = " with arguments that could not be displayed";
  }
  return `Call ${tool} on ${serverName}${args}`;
}

/** One-line description of what a gated call will do, shown on the vote card. */
export function summarize(name: string, input: any): string {
  switch (name) {
    case "write_doc": {
      const len = String(input?.content ?? "").length;
      return `Replace the entire document (${len.toLocaleString()} characters)`;
    }
    case "edit_doc": {
      const from = preview(input?.old_text);
      const to = preview(input?.new_text);
      return to === '""' ? `Delete ${from}` : `Replace ${from} with ${to}`;
    }
    case "list_files": {
      const path = String(input?.path ?? "");
      const depth = input?.depth;
      const where = path === "" ? "the workspace root" : path;
      return depth === undefined ? `List ${where}` : `List ${where} (depth ${depth})`;
    }
    case "read_file":
      return `Read ${String(input?.path ?? "")}`;
    case "search_files": {
      const pattern = String(input?.pattern ?? "");
      const glob = String(input?.glob ?? "");
      return glob ? `Search for "${pattern}" in ${glob}` : `Search for "${pattern}"`;
    }
    case "write_file": {
      const path = String(input?.path ?? "");
      const len = String(input?.content ?? "").length;
      return `Replace ${path} (${len.toLocaleString()} characters)`;
    }
    case "edit_file": {
      const path = String(input?.path ?? "");
      const from = preview(input?.old_text);
      const to = preview(input?.new_text);
      return `Edit ${path}: replace ${from} with ${to}`;
    }
    case "delete_file":
      return `Delete ${String(input?.path ?? "")}`;
    case "ask_room": {
      const question = String(input?.question ?? "");
      return question ? `Ask the room: ${preview(question, 80)}` : "Ask the room";
    }
    case "delegate": {
      const tasks: any[] = Array.isArray(input?.tasks) ? input.tasks : [];
      if (tasks.length === 0) return "Delegate nothing";
      // Names the teammate as well as the task: under a custom graph the choice
      // of who does the work is the interesting half of what is being approved.
      const shown = tasks
        .slice(0, 3)
        .map((t) =>
          t?.agent ? `${String(t.agent)}: ${String(t?.title ?? "")}` : String(t?.title ?? ""),
        );
      const more = tasks.length - shown.length;
      return `Delegate ${tasks.length} task${tasks.length === 1 ? "" : "s"} — ${shown.join(
        "; ",
      )}${more > 0 ? `; +${more} more` : ""}`;
    }
    default:
      return `Run ${name}`;
  }
}

function preview(s: unknown, max = 60): string {
  const t = String(s ?? "");
  if (t.length === 0) return '""';
  const flat = t.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > max ? flat.slice(0, max) + "…" : flat);
}

export function execute(name: string, input: any, ctx: ToolCtx): ToolOutcome {
  switch (name) {
    case "read_doc": {
      const doc = ctx.getDoc();
      return doc.trim().length === 0
        ? { ok: true, text: "(the shared document is empty)" }
        : { ok: true, text: doc };
    }

    case "write_doc": {
      const content = input?.content;
      if (typeof content !== "string") {
        return { ok: false, text: "write_doc requires a string `content`." };
      }
      ctx.setDoc(content);
      return { ok: true, text: `Document replaced (${content.length} characters).` };
    }

    case "edit_doc": {
      const oldText = input?.old_text;
      const newText = input?.new_text;
      if (typeof oldText !== "string" || typeof newText !== "string") {
        return {
          ok: false,
          text: "edit_doc requires string `old_text` and `new_text`.",
        };
      }
      const doc = ctx.getDoc();
      const match = findUniqueText(doc, oldText);
      if (!match.ok && match.reason === "empty") {
        return { ok: false, text: "old_text must contain the exact text to replace." };
      }
      if (!match.ok && match.reason === "missing") {
        return {
          ok: false,
          text:
            "old_text was not found in the document. Call read_doc to get the " +
            "current text, then retry with an exact span from it.",
        };
      }
      if (!match.ok) {
        return {
          ok: false,
          text:
            "old_text appears more than once, so the target is ambiguous. " +
            "Include more surrounding context to make it unique.",
        };
      }
      ctx.setDoc(doc.slice(0, match.index) + newText + doc.slice(match.index + oldText.length));
      return { ok: true, text: "Edit applied." };
    }

    default:
      // list_files, read_file and search_files are not handled here: they are
      // async and go through the room's workspace provider rather than this
      // synchronous doc-buffer path, so room.ts dispatches them directly —
      // they require a round trip to the workspace host's browser.
      return { ok: false, text: `Unknown tool: ${name}` };
  }
}
