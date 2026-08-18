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
