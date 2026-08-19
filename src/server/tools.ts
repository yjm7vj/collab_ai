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
    "Hand independent subtasks to cheaper worker models that run in parallel. " +
    "Use this when the work splits into pieces that do not depend on each " +
    "other — several sources to read, several questions to answer. Send them " +
    "all in one call so they run at the same time.\n\n" +
    "Workers are read-only: they can read the shared document, search, and " +
    "fetch pages, but cannot edit anything. Each starts with no knowledge of " +
    "this conversation, so write every task so it stands completely alone — " +
    "state the question, the constraints, and what to report back. Excess " +
    "tasks beyond the room's worker cap are dropped, so send the important " +
    "ones first.",
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
              description: "Short label shown to the room, e.g. 'Read the Q3 filing'.",
            },
            instructions: {
              type: "string",
              description:
                "The complete self-contained brief: the question, any " +
                "constraints, and the form the answer should take.",
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
 * Anthropic tool definitions. Custom tools first, then server-side tools.
 * Order is stable so the prompt prefix stays cacheable.
 */
export const TOOL_DEFS = [
  {
    name: "read_doc",
    description:
      "Read the room's shared document in full. Always read before editing so " +
      "your edit is based on the current text — other agents' turns and approved " +
      "writes may have changed it since you last looked.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "write_doc",
    description:
      "Replace the entire shared document with new content. Destructive — it " +
      "discards whatever is there now. Prefer edit_doc for targeted changes and " +
      "use this only for the first draft or a full rewrite. Requires approval " +
      "from the room before it takes effect.",
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
      "appear exactly once — if it appears zero times or more than once the edit " +
      "is rejected and nothing changes. Requires approval from the room before it " +
      "takes effect.",
    input_schema: {
      type: "object" as const,
      properties: {
        old_text: {
          type: "string",
          description:
            "Exact text to replace, including whitespace. Include enough " +
            "surrounding context to make it unique.",
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
      "List files and directories in the room's connected workspace. Start " +
      "here before reading — you cannot guess paths. Paths are relative to " +
      "the workspace root; use \"\" for the root itself. Requires a " +
      "connected workspace. Some paths are off-limits and will be refused.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Directory to list, relative to the workspace root. Empty string for the root.",
        },
        depth: {
          type: "integer",
          description: "How many levels to descend. Higher values return far more, and the result is capped.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description:
      "Read one file from the room's connected workspace. Large files are " +
      "truncated, so use offset to page through one if you need the rest. " +
      "Requires a connected workspace. Some paths are off-limits and will be refused.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File to read, relative to the workspace root." },
        offset: {
          type: "integer",
          description: "Byte offset to start from. Use it to continue a truncated read.",
        },
        limit: { type: "integer", description: "Maximum bytes to return." },
      },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description:
      "Search the workspace for a literal substring, case-insensitively. " +
      "Much cheaper than reading many files — use it to find where something " +
      "lives, then read that file. Requires a connected workspace. Some " +
      "paths are off-limits and will be refused.",
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
    name: "write_file",
    description:
      "Replace the entire contents of a file in the connected workspace, " +
      "creating it if it does not exist. Destructive — it discards whatever " +
      "is there. Prefer edit_file for targeted changes. The room votes before " +
      "this takes effect. Requires a connected workspace that allows writes.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File to write, relative to the workspace root." },
        content: { type: "string", description: "The complete new contents of the file." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace one exact span of text in a file in the connected workspace. " +
      "old_text must appear exactly once — if it appears zero times or more " +
      "than once the edit is rejected and nothing changes. The room votes " +
      "before this takes effect. Requires a connected workspace that allows writes.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File to edit, relative to the workspace root." },
        old_text: {
          type: "string",
          description:
            "Exact text to replace, including whitespace. Include enough " +
            "surrounding context to make it unique.",
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
      "Delete a file from the connected workspace. Irreversible. The room " +
      "votes before this takes effect. Requires a connected workspace that allows writes.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File to delete, relative to the workspace root." },
      },
      required: ["path"],
    },
  },
  { type: "web_search_20260209", name: "web_search" },
  { type: "web_fetch_20260209", name: "web_fetch" },
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
 * preserved so the cached prompt prefix stays stable for a given policy.
 */
export function toolsFor(policy: AccessPolicy, workflow: "solo" | "manager"): unknown[] {
  const decisions = resolveTools(policy);
  const base = workflow === "manager" ? MANAGER_TOOLS : AGENT_TOOLS;
  return base.filter((def) => {
    const name = toolName(def);
    const decision = decisions[name as ToolName];
    return decision === undefined ? true : decision !== "deny";
  });
}

/** The tools that require a live round trip to a connected workspace. */
const WORKSPACE_TOOL_NAMES = new Set([
  "list_files", "read_file", "search_files",
  "write_file", "edit_file", "delete_file",
]);

/**
 * Tool definitions for a room, given its policy AND whether a workspace is
 * reachable.
 *
 * The file tools are withheld entirely when there is no workspace online. An
 * agent handed a tool that always fails will keep trying it, so absence is
 * better than a tool that only ever returns an error.
 */
export function toolsForRoom(
  policy: AccessPolicy,
  workflow: "solo" | "manager",
  workspaceOnline: boolean,
): unknown[] {
  const base = toolsFor(policy, workflow);
  if (workspaceOnline) return base;
  return base.filter((def) => !WORKSPACE_TOOL_NAMES.has(toolName(def)));
}

/** Worker tools under this policy. Workers can never write, gated or not. */
export function workerToolsFor(policy: AccessPolicy): unknown[] {
  const decisions = resolveTools(policy);
  return WORKER_TOOLS.filter((def) => {
    const name = toolName(def);
    const decision = decisions[name as ToolName];
    return decision === undefined ? true : decision !== "deny";
  });
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
      const first = doc.indexOf(oldText);
      if (first === -1) {
        return {
          ok: false,
          text:
            "old_text was not found in the document. Call read_doc to get the " +
            "current text, then retry with an exact span from it.",
        };
      }
      if (doc.indexOf(oldText, first + 1) !== -1) {
        return {
          ok: false,
          text:
            "old_text appears more than once, so the target is ambiguous. " +
            "Include more surrounding context to make it unique.",
        };
      }
      ctx.setDoc(doc.slice(0, first) + newText + doc.slice(first + oldText.length));
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
