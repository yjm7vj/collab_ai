/**
 * Wire protocol shared by the Worker and the browser client.
 *
 * Two channels carry data to clients:
 *   - Agent state (RoomState), synced automatically by the Agents SDK on setState().
 *     Use it for things that are small, current-value-only, and needed by every client.
 *   - Broadcast messages (ServerMsg), sent explicitly. Use them for the transcript,
 *     which is append-heavy and far too large to resend on every change.
 */

import {
  DEFAULT_SETTINGS,
  EMPTY_LEDGER,
  type CostLedger,
  type RoomSettings,
} from "./models";
import { DEFAULT_POLICY, type AccessPolicy, type Role } from "./access";
import { DEFAULT_GRAPH, type WorkflowGraph } from "./workflow";
import { NO_WORKSPACE, type FsRequest, type FsResponse, type WorkspaceInfo, type WorkspaceKind } from "./workspace";

export type Vote = "approve" | "deny";

/**
 * How a room admits people.
 *
 * `invite` is the default and the safe one. `open` lets anyone holding the
 * room link in as an editor, which is only sensible for a demo. `locked`
 * admits nobody new while leaving existing members untouched.
 */
export type RoomVisibility = "open" | "invite" | "locked";

export function asVisibility(v: unknown): RoomVisibility {
  return v === "open" || v === "locked" ? v : "invite";
}

/** One person in the room. Keyed by durable id, not by socket. */
export type Presence = {
  /** Durable per-person id. Stable across reconnects, reloads and tabs. */
  uid: string;
  name: string;
  /** Provider avatar URL, or empty for local/legacy members. */
  avatar: string;
  color: string;
  /** What this person may do. Enforced on the server; carried here for the UI. */
  role: Role;
  /** How many sockets this person currently has open. */
  connections: number;
};

/**
 * A tool call the agent wants to make that the room has to approve first.
 * This is durable state, not a suspended promise — see Room#advance.
 */
export type PendingTool = {
  toolUseId: string;
  name: string;
  input: unknown;
  /** Human-readable description of the effect, rendered on the vote card. */
  summary: string;
  /** Member uid -> vote. One vote per person, however many tabs they have open. */
  votes: Record<string, Vote>;
  /** Votes needed to decide, fixed when the request was raised. */
  threshold: number;
  /** True when deciding this needs sight of file contents. */
  sensitive?: boolean;
};

export type RoomStatus = "idle" | "thinking" | "awaiting_approval";

/**
 * What this deployment can do with GitHub, and how far this room has got.
 *
 * BOOLEANS AND A PUBLIC LOGIN ONLY. RoomState is synced to every connected
 * client, so this type may never grow a token, a client secret, or anything
 * else that is not already safe for every member of the room to read. The
 * OAuth access tokens and GitHub App installation IDs live in the Durable
 * Object's own storage and are never put on the wire.
 */
export type GithubStatus = {
  /** A GitHub OAuth App is configured, so "Connect GitHub" can work at all. */
  oauth: boolean;
  /** A GitHub App is configured, so the per-repo installation flow can work. */
  app: boolean;
  /** A GitHub App installation is stored for this room. */
  installed: boolean;
  /** A member has authorised GitHub or installed the GitHub App. */
  authorized: boolean;
  /** The GitHub login that authorised, for display. Empty when nobody has. */
  login: string;
};

export const NO_GITHUB: GithubStatus = {
  oauth: false, app: false, installed: false, authorized: false, login: "",
};

/** One repository the authorising member can reach. Never broadcast. */
export type GithubRepo = {
  /** owner/repo. */
  fullName: string;
  private: boolean;
  defaultBranch: string;
};

export type RoomState = {
  status: RoomStatus;
  users: Presence[];
  /** The shared artifact the agent edits. Synced to every client. */
  doc: string;
  docRevision: number;
  pending: PendingTool[];
  /** Model, workflow and scaling config. Shared — everyone sees the same setup. */
  settings: RoomSettings;
  /** What the agent may do unattended. Independent of what people may do. */
  policy: AccessPolicy;
  /**
   * The room's agent graph, used when `settings.workflow` is "custom".
   *
   * Synced to everyone rather than fetched on demand, unlike invites or members:
   * the graph decides which models answer the room, so seeing it is part of
   * knowing what you are talking to. Only holders of the `workflow` capability
   * may change it.
   */
  graph: WorkflowGraph;
  /** How the room admits people. Everyone sees this; only the owner sets it. */
  visibility: RoomVisibility;
  /** The room's connected workspace, if any. Everyone sees this. */
  workspace: WorkspaceInfo;
  /** What this deployment can do with GitHub, and how far this room has got. */
  github: GithubStatus;
  /** Live worker activity, for the manager workflow. Empty when nothing is running. */
  workers: WorkerStatus[];
  /** Size of the conversation as last sent, for the context gauge. */
  context: { messages: number; tokens: number };
  /** Running spend at list price, accumulated from real usage. */
  cost: CostLedger;
};

/** One delegated subtask, surfaced so the room can watch the fan-out. */
export type WorkerStatus = {
  id: string;
  title: string;
  model: string;
  state: "running" | "done" | "failed";
  /**
   * Which teammate took this task, under a custom workflow. Absent in the
   * built-in manager workflow, where every worker is the same anonymous one.
   */
  agent?: string;
  /** What is happening to this result now — "reviewed by Critic". */
  stage?: string;
};

export const INITIAL_ROOM_STATE: RoomState = {
  status: "idle",
  users: [],
  doc: "",
  docRevision: 0,
  pending: [],
  settings: DEFAULT_SETTINGS,
  policy: DEFAULT_POLICY,
  graph: DEFAULT_GRAPH,
  visibility: "invite",
  workspace: NO_WORKSPACE,
  github: NO_GITHUB,
  workers: [],
  context: { messages: 0, tokens: 0 },
  cost: EMPTY_LEDGER,
};

/** One rendered piece of an agent turn. */
export type AgentBlock =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | {
      type: "tool";
      toolUseId: string;
      name: string;
      input: unknown;
      status: "running" | "ok" | "error" | "denied";
      result?: string;
      /** True when this block's result contains workspace file contents. */
      sensitive?: boolean;
    };

export type Entry =
  | {
      id: string;
      ts: number;
      kind: "user";
      authorUid: string;
      authorName: string;
      color: string;
      text: string;
    }
  | { id: string; ts: number; kind: "agent"; blocks: AgentBlock[] }
  | { id: string; ts: number; kind: "system"; text: string };

/** Shown in place of file contents to anyone not permitted to see them. */
export const REDACTED = "(file contents hidden — ask an owner or admin)";

/**
 * A copy of `entry` safe to send to someone who may not see file contents.
 *
 * Redaction happens on the way out, never on the way in: the full entry is
 * what gets stored, so an owner reconnecting still gets the real transcript.
 * A redacted transcript written to disk would be unrecoverable.
 */
export function redactEntry(entry: Entry, allowed: boolean): Entry {
  if (allowed || entry.kind !== "agent") return entry;
  if (!entry.blocks.some((b) => b.type === "tool" && b.sensitive)) return entry;
  return {
    ...entry,
    blocks: entry.blocks.map((b) =>
      b.type === "tool" && b.sensitive && b.result !== undefined
        ? { ...b, result: REDACTED }
        : b,
    ),
  };
}

export type ServerMsg =
  /** Full transcript, sent once on connect. */
  | { t: "history"; entries: Entry[] }
  /** A new entry was appended. */
  | { t: "entry"; entry: Entry }
  /** An existing entry changed wholesale (agent turns mutate as they stream). */
  | { t: "patch"; entry: Entry }
  /** Token-level append into one block of one agent entry. Not persisted per-token. */
  | { t: "delta"; entryId: string; block: number; text: string }
  /**
   * Tells the client who it is: which member, and at what role. The role is
   * what the UI hides controls on, but it is only a hint — every action is
   * re-checked on the server, which is the actual boundary.
   */
  | { t: "you"; uid: string; role: string }
  | { t: "error"; message: string }
  /** Sent only to the connection that asked. Never broadcast. */
  | { t: "invites"; invites: InviteSummary[] }
  /** Sent only to the connection that asked. */
  | { t: "members"; members: MemberSummary[] }
  /** Document snapshots, sent only to owners and admins. */
  | { t: "revisions"; uid: string; revisions: DocumentRevision[] }
  /** Sent only to the workspace host's socket. Never broadcast. */
  | { t: "fs.req"; id: string; req: FsRequest }
  /** A file request made by the room's code workspace UI. Sent only to its requester. */
  /**
   * Where to send the browser next for GitHub — the OAuth authorise page, or
   * the GitHub App install page. Sent only to the connection that asked.
   * Carries a signed, short-lived state parameter and no other secret.
   */
  | { t: "github.install"; url: string }
  /**
   * Repositories the authorising member can reach. Sent only to that member's
   * connection: which repositories someone can see is their business, not the
   * room's, so this is never broadcast.
   */
  | { t: "github.repos"; repos: GithubRepo[]; source?: GithubRepoSource }
  /** A reply from the "describe your workflow" chat. Sent only to the asker. */
  | { t: "workflow.chat"; reply: WorkflowChatReply };

/**
 * Where a repository list came from, so the picker can say so.
 *
 * A short list has several very different causes — the App is installed on
 * one account, an organisation never installed it, a whole installation went
 * unreadable — and they are indistinguishable from the list itself. Naming
 * the route and the accounts it covered turns "my repository is missing" from
 * a guess into something checkable.
 */
/** One turn of the "describe your workflow" chat. */
export type WorkflowChatTurn = { role: "user" | "assistant"; text: string };

/**
 * What the assistant sends back for one chat turn.
 *
 * `graph` always carries an already-`sanitizeGraph`d graph — the client never
 * receives anything from this path that the server has not already checked by
 * the same rule an Apply would be checked by.
 */
export type WorkflowChatReply =
  | { kind: "question"; text: string }
  | { kind: "graph"; graph: WorkflowGraph; note: string; warnings: string[] }
  | { kind: "error"; message: string };

export type GithubRepoSource = {
  /**
   * `installations` enumerated every installation the account belongs to.
   * `account` is the plain per-account listing, used when this deployment's
   * credentials cannot enumerate installations at all. `installation` is the
   * single stored installation a room falls back to when nobody has
   * authorised an account.
   */
  via: "installations" | "account" | "installation";
  /** Which accounts' installations answered, for the `installations` route. */
  accounts?: string[];
  /** Installations that refused, and so may be hiding repositories. */
  unreadable?: number;
  /** Why the wider route was unavailable, when one was tried and failed. */
  note?: string;
};

export type ClientMsg =
  /** Change your display name. Identity itself comes from the socket's token. */
  | { t: "rename"; name: string }
  | { t: "say"; text: string }
  | { t: "vote"; toolUseId: string; vote: Vote }
  | { t: "interrupt" }
  /** Replace the room's configuration. Server re-validates before applying. */
  | { t: "settings"; settings: RoomSettings }
  /** Replace the room's agent-permission policy. Server re-validates. */
  | { t: "policy"; policy: AccessPolicy }
  /**
   * Replace the room's agent graph, and say whether the room should run on it.
   *
   * Carries `useCustom` rather than a whole RoomSettings because editors may
   * hold `workflow` without holding `settings`: this frame can turn the custom
   * workflow on and off and redraw the team, and can change nothing else.
   */
  | { t: "workflow"; graph: WorkflowGraph; useCustom: boolean }
  /** Compact the conversation now, rather than waiting for a threshold. */
  | { t: "compact" }
  /** Mint an invite. Owners and admins only; the server re-checks. */
  | { t: "invite.create"; role: string; maxUses: number; expiresInHours: number; label: string }
  | { t: "invite.revoke"; code: string }
  | { t: "invite.list" }
  | { t: "member.list" }
  | { t: "revision.list"; uid: string }
  /** Change someone's role. The server re-checks that the actor outranks them. */
  | { t: "member.role"; uid: string; role: Role }
  /** Remove someone from the room and close their sockets. */
  | { t: "member.remove"; uid: string }
  /** A provider's reply to an earlier "fs.req". Only the host's answer counts. */
  | { t: "fs.res"; id: string; res: FsResponse }
  /** Request files through the room's authorized workspace provider. */
  /** Connect a workspace to this room. Owners and admins only. */
  | { t: "workspace.attach"; kind: WorkspaceKind; label: string; repo?: string }
  /** Disconnect the room's workspace. Owners and admins only. */
  | { t: "workspace.detach" }
  /** Change how the room admits people. Owner only; the server re-checks. */
  | { t: "room.visibility"; visibility: RoomVisibility }
  /** Connect a GitHub repository by name. Owners and admins only. */
  | { t: "github.connect"; repo: string }
  /**
   * Begin GitHub authorisation for repository access. Owners and admins only.
   * Answered with "github.install" carrying the URL to send the browser to.
   */
  | { t: "github.auth" }
  /** List the repositories the authorising member can reach. Answered with "github.repos". */
  | { t: "github.repos" }
  /** Forget this room's stored GitHub authorisation. Owners and admins only. */
  | { t: "github.signout" }
  /**
   * One turn of describing a workflow in prose, for the assistant to draft as a
   * graph. `turns` is the whole conversation so far, ending with the new user
   * message — the room holds none of it, so the client is the one source of
   * truth for a conversation that never touches `RoomState`.
   */
  | { t: "workflow.chat"; turns: WorkflowChatTurn[]; graph: WorkflowGraph };

/** Deterministic per-connection colour so the same person looks the same to everyone. */
export const PALETTE = [
  "#e0684d",
  "#3d9a8b",
  "#c9a227",
  "#6b7fd7",
  "#c05fa8",
  "#5a9e4c",
  "#d17f38",
  "#8a72d0",
];

/**
 * Shape a client-supplied uid must have before the server will record it.
 * This is a sanity check on the wire format, not an authentication check.
 */
export const UID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

/**
 * Votes needed to decide, given how many voting-eligible people are present.
 *
 * Strict majority — more than half, not half. With two people present that means
 * both must agree, so nobody can push a change through over a colleague's
 * objection simply by clicking first. Approve and deny use the same bar, so a
 * lone holdout cannot block the room either.
 *
 * This is the room's governance policy; it is the one line to change if you want
 * unanimity, a single-approver fast path, or veto power for any one member.
 */
export function thresholdFor(userCount: number): number {
  return Math.max(1, Math.floor(userCount / 2) + 1);
}

export function tally(p: PendingTool): { approve: number; deny: number } {
  let approve = 0;
  let deny = 0;
  for (const v of Object.values(p.votes)) {
    if (v === "approve") approve++;
    else deny++;
  }
  return { approve, deny };
}

/* ------------------------------------------------- room creation and joining */

/**
 * The HTTP surface that runs before a socket exists.
 *
 * A client cannot open the WebSocket until it holds a token, and it cannot get a
 * token without being admitted to the room — so admission is decided here, over
 * plain HTTP, and the socket is authenticated from its first byte.
 */
/** Providers a deployment has configured. Empty means sign-in is off. */
export type AuthConfigResponse = { providers: ("github" | "google")[] };

/**
 * A signed identity, minted after sign-in and held by the browser.
 *
 * The payload is readable (it is signed, not encrypted) so the client can show
 * who it is without another round trip. It is not a room credential: it proves
 * who you are, and `/api/join` still decides which rooms that gets you into.
 */
export const IDENTITY_MARKER = "identity";

export type CreateRoomRequest = { uid: string; name: string; title?: string; identity?: string };
export type CreateRoomResponse = { roomId: string; token: string; role: string };

export type JoinRoomRequest = { roomId: string; uid: string; name: string; code?: string; identity?: string };
export type JoinRoomResponse = { token: string; role: string };

/** Why admission was refused. Shown to the person trying to get in. */
export type JoinRefusal =
  | "not_found"
  | "invite_required"
  | "locked"
  | "bad_request"
  | "bad_code"
  | "code_expired"
  | "code_used_up"
  | "code_revoked"
  | "sign_in_required";

export type JoinErrorResponse = { error: JoinRefusal };

/**
 * An invite as shown to whoever manages the room.
 *
 * This is deliberately never part of `RoomState`: state is synced to every
 * client, and a code visible to everyone in the room is not an invite. It is
 * sent only to the connection that asked for it.
 */
export type InviteSummary = {
  code: string;
  /** Role this invite grants when redeemed. */
  role: string;
  /** 0 means unlimited. */
  maxUses: number;
  uses: number;
  /** Unix ms. 0 means it never expires. */
  expiresAt: number;
  createdAt: number;
  revoked: boolean;
  /** Free-text note, e.g. "design team". */
  label: string;
};

/** A member of the room, present or not. Sent only to whoever manages members. */
export type MemberSummary = {
  uid: string;
  name: string;
  avatar: string;
  role: Role;
  joinedAt: number;
  lastSeen: number;
  /** Whether they have at least one socket open right now. */
  online: boolean;
};

export type DocumentRevision = {
  revision: number;
  doc: string;
  ts: number;
  author: string;
  authorUid: string;
};

/** Roles an invite may grant. Owner is deliberately not one of them. */
export const INVITABLE_ROLES = ["admin", "editor", "viewer"] as const;

/** Room ids are generated by `newId(22)`, so this is what a valid one looks like. */
export const ROOM_ID_RE = /^[A-Za-z0-9]{22}$/;
