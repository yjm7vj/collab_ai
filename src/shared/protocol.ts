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

export type Vote = "approve" | "deny";

export type Presence = {
  /** Connection id. Stable for the life of one browser tab's socket. */
  id: string;
  name: string;
  color: string;
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
  /** Connection id -> vote. One vote per connection. */
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
      authorId: string;
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
  /** Tells the client which connection it is, so it can highlight its own messages. */
  | { t: "you"; id: string }
  | { t: "error"; message: string };

export type ClientMsg =
  | { t: "join"; name: string }
  | { t: "say"; text: string }
  | { t: "vote"; toolUseId: string; vote: Vote }
  | { t: "interrupt" }
  /** Replace the room's configuration. Server re-validates before applying. */
  | { t: "settings"; settings: RoomSettings }
  /** Compact the conversation now, rather than waiting for a threshold. */
  | { t: "compact" };

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

export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

/**
 * Votes needed to decide, given how many people are in the room.
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
