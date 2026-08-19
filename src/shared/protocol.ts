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
import { NO_WORKSPACE, type FsRequest, type FsResponse, type WorkspaceInfo, type WorkspaceKind } from "./workspace";

export type Vote = "approve" | "deny";

/** One person in the room. Keyed by durable id, not by socket. */
export type Presence = {
  /** Durable per-person id. Stable across reconnects, reloads and tabs. */
  uid: string;
  name: string;
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
};

export type RoomStatus = "idle" | "thinking" | "awaiting_approval";

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
  /** The room's connected workspace, if any. Everyone sees this. */
  workspace: WorkspaceInfo;
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
};

export const INITIAL_ROOM_STATE: RoomState = {
  status: "idle",
  users: [],
  doc: "",
  docRevision: 0,
  pending: [],
  settings: DEFAULT_SETTINGS,
  policy: DEFAULT_POLICY,
  workspace: NO_WORKSPACE,
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
  /** Sent only to the workspace host's socket. Never broadcast. */
  | { t: "fs.req"; id: string; req: FsRequest }
  /** Sent only to the connection that asked. Carries no secret. */
  | { t: "github.install"; url: string };

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
  /** Compact the conversation now, rather than waiting for a threshold. */
  | { t: "compact" }
  /** Mint an invite. Owners and admins only; the server re-checks. */
  | { t: "invite.create"; role: string; maxUses: number; expiresInHours: number; label: string }
  | { t: "invite.revoke"; code: string }
  | { t: "invite.list" }
  | { t: "member.list" }
  /** Change someone's role. The server re-checks that the actor outranks them. */
  | { t: "member.role"; uid: string; role: Role }
  /** Remove someone from the room and close their sockets. */
  | { t: "member.remove"; uid: string }
  /** A provider's reply to an earlier "fs.req". Only the host's answer counts. */
  | { t: "fs.res"; id: string; res: FsResponse }
  /** Connect a workspace to this room. Owners and admins only. */
  | { t: "workspace.attach"; kind: WorkspaceKind; label: string; repo?: string }
  /** Disconnect the room's workspace. Owners and admins only. */
  | { t: "workspace.detach" }
  /** Start connecting a GitHub repository. Owners and admins only. */
  | { t: "github.connect"; repo: string };

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
export type CreateRoomRequest = { uid: string; name: string; title?: string };
export type CreateRoomResponse = { roomId: string; token: string; role: string };

export type JoinRoomRequest = { roomId: string; uid: string; name: string; code?: string };
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
  | "code_revoked";

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
  role: Role;
  joinedAt: number;
  lastSeen: number;
  /** Whether they have at least one socket open right now. */
  online: boolean;
};

/** Roles an invite may grant. Owner is deliberately not one of them. */
export const INVITABLE_ROLES = ["admin", "editor", "viewer"] as const;

/** Room ids are generated by `newId(22)`, so this is what a valid one looks like. */
export const ROOM_ID_RE = /^[A-Za-z0-9]{22}$/;
