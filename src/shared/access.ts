/**
 * Who may do what.
 *
 * One table, read by both sides: the server enforces it, and the client reads
 * the same table to grey out controls. The client's copy is a courtesy — a
 * hidden button is not a permission, and every handler re-checks here before
 * acting.
 */

import { DEFAULT_PATH_POLICY, sanitizePathPolicy, type PathPolicy } from "./workspace";

export type Role = "owner" | "admin" | "editor" | "viewer";

/** Every role, most powerful first. */
export const ROLES: readonly Role[] = ["owner", "admin", "editor", "viewer"] as const;

export type Capability =
  /** Talk to the agent, and stop it mid-turn. */
  | "speak"
  /** Vote on a tool call the agent wants to make. */
  | "vote"
  /** Compact the conversation. */
  | "compact"
  /** Change the model, workflow and spend configuration. */
  | "settings"
  /**
   * Draw the room's agent graph — who the teammates are and how they relate.
   *
   * Editors get this and not `settings`, which is the whole reason it is a
   * separate capability: shaping the team is design work the people doing the
   * work should be able to do, while choosing which models get billed stays
   * with the owner and admins. The server enforces the split by preserving
   * node models on frames from anyone without `settings` — see `Room#onWorkflow`.
   */
  | "workflow"
  /** Change permission modes and tool policy. Reserved for the next phase. */
  | "policy"
  /** Mint and revoke invite links. */
  | "invite"
  /** Change other people's roles, and remove them. */
  | "manage_members"
  /** Rename the room, change its visibility, transfer or delete it. */
  | "admin_room"
  /** View prior shared-document snapshots. */
  | "view_revisions";

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export const ROLE_CAPS: Record<Role, readonly Capability[]> = {
  owner: [
    "speak", "vote", "compact", "settings", "workflow", "policy", "invite",
    "manage_members", "admin_room",
    "view_revisions",
  ],
  admin: ["speak", "vote", "compact", "settings", "workflow", "policy", "invite", "manage_members", "view_revisions"],
  editor: ["speak", "vote", "compact", "workflow"],
  // A viewer reads the room and nothing else. Deliberately an empty list rather
  // than a short one, so adding a capability is always a decision.
  viewer: [],
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && value in RANK;
}

/** Coerce anything into a role, defaulting to the least powerful one. */
export function asRole(value: unknown): Role {
  return isRole(value) ? value : "viewer";
}

export function roleRank(role: Role): number {
  return RANK[role];
}

/** Whether `actor` is strictly more powerful than `target`. */
export function outranks(actor: Role, target: Role): boolean {
  return RANK[actor] > RANK[target];
}

export function can(role: Role, cap: Capability): boolean {
  return ROLE_CAPS[role].includes(cap);
}

/**
 * Whether this role counts toward an approval threshold.
 *
 * Viewers are excluded from the denominator, not just from voting. Counting
 * someone who cannot vote raises a bar they can never help clear — a room of
 * two editors and a viewer would silently need unanimity.
 */
export function isVoter(role: Role): boolean {
  return can(role, "vote");
}

/* ------------------------------------------------ agent permissions */

/** What the room lets the agent do with one tool. */
export type ToolDecision = "allow" | "ask" | "deny";

export type ToolName =
  | "read_doc" | "write_doc" | "edit_doc" | "delegate" | "web_search" | "web_fetch"
  | "list_files" | "read_file" | "search_files"
  | "semantic_search"
  | "write_file" | "edit_file" | "delete_file"
  | "mcp";

export const TOOL_NAMES: readonly ToolName[] = [
  "read_doc", "write_doc", "edit_doc", "delegate", "web_search", "web_fetch",
  "list_files", "read_file", "search_files",
  "semantic_search",
  "write_file", "edit_file", "delete_file",
  "mcp",
] as const;

/**
 * Named presets over the per-tool matrix, in the shape Claude Code uses.
 * `custom` means the matrix is authoritative and no preset describes it.
 */
export type PermissionMode = "read_only" | "ask" | "auto" | "custom";

/**
 * How many votes settle a proposal.
 *
 * `owner_only` is not a threshold but a restriction on who may vote at all;
 * the room refuses votes from everyone else, so one vote decides.
 */
export type ApprovalPolicy = "majority" | "unanimous" | "any_editor" | "owner_only";

export type AccessPolicy = {
  mode: PermissionMode;
  tools: Record<ToolName, ToolDecision>;
  approval: ApprovalPolicy;
  /** Which paths in the workspace the agent may touch. */
  paths: PathPolicy;
};

const ALL_ALLOW: Record<ToolName, ToolDecision> = {
  read_doc: "allow", write_doc: "allow", edit_doc: "allow",
  delegate: "allow", web_search: "allow", web_fetch: "allow",
  list_files: "allow", read_file: "allow", search_files: "allow",
  semantic_search: "allow",
  write_file: "allow", edit_file: "allow", delete_file: "allow",
  mcp: "allow",
};

export const MODE_PRESETS: Record<Exclude<PermissionMode, "custom">, Record<ToolName, ToolDecision>> = {
  // Claude Code's plan mode. The writing tools are not merely gated, they are
  // withheld entirely, so the agent proposes in prose instead of burning turns
  // on calls it will never be allowed to make. The file tools are reads, and
  // reading is exactly what read-only mode is for, so all three stay "allow".
  // The workspace write tools are withheld the same way — read-only means
  // those tools are not offered at all, which is the entire point of the mode.
  // `mcp` is denied outright here, unlike the file reads above, because an MCP
  // server's tools are arbitrary and this room has no way to tell a read from a
  // write among them: the names and descriptions come from the server. A mode
  // whose promise is "nothing changes" cannot keep that promise while calling
  // tools it cannot classify.
  read_only: {
    ...ALL_ALLOW,
    write_doc: "deny", edit_doc: "deny",
    write_file: "deny", edit_file: "deny", delete_file: "deny",
    mcp: "deny",
  },
  // A vote per file read would be unusable — the path policy is the real
  // control for reads, not the vote — so the file tools stay "allow" here too.
  // `mcp` is gated here for the same reason the writes are: a tool on somebody
  // else's server can do anything, and this is the mode where the room decides
  // before that happens. It is also the default mode, so an MCP server wired up
  // without anyone thinking about permissions is supervised by default.
  ask: {
    ...ALL_ALLOW,
    write_doc: "ask", edit_doc: "ask",
    write_file: "ask", edit_file: "ask", delete_file: "ask",
    mcp: "ask",
  },
  // Auto-accept skips the vote for routine writes so the agent doesn't stall
  // out the flow, but deleting someone's file is not symmetric with editing
  // it: an edit can be undone by another edit, a delete cannot. So delete_file
  // stays "ask" even in auto — auto-accept is about not interrupting a flow,
  // not about removing the last check on an irreversible action.
  auto: { ...ALL_ALLOW, delete_file: "ask" },
};

export const DEFAULT_POLICY: AccessPolicy = {
  mode: "ask",
  tools: MODE_PRESETS.ask,
  approval: "majority",
  paths: DEFAULT_PATH_POLICY,
};

/** The effective matrix: a preset when one is named, else the stored matrix. */
export function resolveTools(policy: AccessPolicy): Record<ToolName, ToolDecision> {
  return policy.mode === "custom" ? policy.tools : MODE_PRESETS[policy.mode];
}

export function isToolName(v: unknown): v is ToolName {
  return typeof v === "string" && (TOOL_NAMES as readonly string[]).includes(v);
}

/**
 * Coerce anything a client sends into a usable policy.
 *
 * Unknown values fall back to the most restrictive option, never the most
 * permissive — a malformed frame must not be a way to turn approval off.
 */
export function sanitizeAccessPolicy(input: unknown): AccessPolicy {
  const raw = (input ?? {}) as Partial<AccessPolicy>;
  const mode: PermissionMode =
    raw.mode === "read_only" || raw.mode === "auto" || raw.mode === "custom" ? raw.mode : "ask";
  const approval: ApprovalPolicy =
    raw.approval === "unanimous" || raw.approval === "any_editor" || raw.approval === "owner_only"
      ? raw.approval
      : "majority";

  const incoming = (raw.tools ?? {}) as Record<string, unknown>;
  const tools = {} as Record<ToolName, ToolDecision>;
  for (const name of TOOL_NAMES) {
    const v = incoming[name];
    tools[name] = v === "allow" || v === "deny" ? v : v === "ask" ? "ask" : MODE_PRESETS.ask[name];
  }
  // sanitizePathPolicy always unions the default deny list back into whatever
  // arrives, so this can never be used to widen access beyond what the room
  // already forbids — only to narrow it further or add ask rules.
  const paths = sanitizePathPolicy(raw.paths);
  return { mode, tools, approval, paths };
}

/**
 * Votes needed to settle a proposal, given how many voting-eligible people are
 * present. Never returns 0 — a proposal must always need at least one person.
 */
export function approvalThreshold(policy: ApprovalPolicy, voters: number): number {
  switch (policy) {
    case "unanimous":
      return Math.max(1, voters);
    case "any_editor":
    case "owner_only":
      return 1;
    case "majority":
    default:
      return Math.max(1, Math.floor(voters / 2) + 1);
  }
}

/** Short human summary for the transcript audit line. */
export function describePolicy(policy: AccessPolicy): string {
  const t = resolveTools(policy);
  const gated = TOOL_NAMES.filter((n) => t[n] === "ask");
  const denied = TOOL_NAMES.filter((n) => t[n] === "deny");
  const label =
    policy.mode === "read_only" ? "read-only"
      : policy.mode === "auto" ? "auto-accept"
      : policy.mode === "custom" ? "custom" : "ask first";
  const parts = [`${label} · ${policy.approval.replace("_", " ")}`];
  if (gated.length) parts.push(`votes on ${gated.join(", ")}`);
  if (denied.length) parts.push(`no ${denied.join(", ")}`);
  return parts.join(" · ");
}

/**
 * Whether a role may see file contents pulled from a workspace.
 *
 * A room's transcript is shared, but a workspace is one person's disk or one
 * team's repository. Owners and admins see what the agent read; editors and
 * viewers see that a file was read, and its path, but not what was in it.
 */
export function canSeeFileContents(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** Tools whose results contain workspace file contents. */
export const FILE_CONTENT_TOOLS: readonly ToolName[] = [
  "read_file", "search_files", "semantic_search", "write_file", "edit_file",
] as const;

export function isFileContentTool(name: string): boolean {
  return (FILE_CONTENT_TOOLS as readonly string[]).includes(name);
}
