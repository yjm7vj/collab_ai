/**
 * Who may do what.
 *
 * One table, read by both sides: the server enforces it, and the client reads
 * the same table to grey out controls. The client's copy is a courtesy — a
 * hidden button is not a permission, and every handler re-checks here before
 * acting.
 */

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
  /** Change permission modes and tool policy. Reserved for the next phase. */
  | "policy"
  /** Mint and revoke invite links. */
  | "invite"
  /** Change other people's roles, and remove them. */
  | "manage_members"
  /** Rename the room, change its visibility, transfer or delete it. */
  | "admin_room";

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export const ROLE_CAPS: Record<Role, readonly Capability[]> = {
  owner: ["speak", "vote", "compact", "settings", "policy", "invite", "manage_members", "admin_room"],
  admin: ["speak", "vote", "compact", "settings", "policy", "invite", "manage_members"],
  editor: ["speak", "vote", "compact"],
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
  | "read_doc" | "write_doc" | "edit_doc" | "delegate" | "web_search" | "web_fetch";

export const TOOL_NAMES: readonly ToolName[] = [
  "read_doc", "write_doc", "edit_doc", "delegate", "web_search", "web_fetch",
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
};

const ALL_ALLOW: Record<ToolName, ToolDecision> = {
  read_doc: "allow", write_doc: "allow", edit_doc: "allow",
  delegate: "allow", web_search: "allow", web_fetch: "allow",
};

export const MODE_PRESETS: Record<Exclude<PermissionMode, "custom">, Record<ToolName, ToolDecision>> = {
  // Claude Code's plan mode. The writing tools are not merely gated, they are
  // withheld entirely, so the agent proposes in prose instead of burning turns
  // on calls it will never be allowed to make.
  read_only: { ...ALL_ALLOW, write_doc: "deny", edit_doc: "deny" },
  ask: { ...ALL_ALLOW, write_doc: "ask", edit_doc: "ask" },
  auto: { ...ALL_ALLOW },
};

export const DEFAULT_POLICY: AccessPolicy = {
  mode: "ask",
  tools: MODE_PRESETS.ask,
  approval: "majority",
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
  return { mode, tools, approval };
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
