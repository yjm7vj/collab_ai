import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  tally,
  type AgentBlock,
  type Entry,
  type PendingTool,
  type Presence as PresenceUser,
  type Vote,
  type WorkerStatus,
} from "../shared/protocol";
import { modelInfo, type CostLedger, type RoomSettings } from "../shared/models";

/* --------------------------------------------------- context + spend */

/**
 * Live context usage against the room's configured limit, plus running spend.
 * Both are read from real `usage` on every response, not estimated.
 */
export function ContextGauge({
  context,
  settings,
  cost,
}: {
  context: { messages: number; tokens: number };
  settings: RoomSettings;
  cost: CostLedger;
}) {
  const limit = settings.context.maxContextTokens;
  const pct = limit > 0 ? Math.min(100, (context.tokens / limit) * 100) : 0;
  const near = pct >= 80;

  const title =
    `${context.tokens.toLocaleString()} tokens across ${context.messages} messages` +
    (limit > 0 ? ` · compacts at ${limit.toLocaleString()}` : " · no token limit") +
    (settings.context.compactAfterMessages > 0
      ? ` or ${settings.context.compactAfterMessages} messages`
      : "");

  return (
    <div className="gauge" title={title}>
      <div className="gauge-track" aria-hidden>
        <div
          className={`gauge-fill ${near ? "gauge-hot" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="gauge-text">
        {limit > 0 ? `${Math.round(pct)}%` : `${context.messages}m`}
        <span className="gauge-cost">${cost.usd.toFixed(3)}</span>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------ workers */

/** Delegated subtasks in flight, so the room can watch the fan-out. */
export function WorkerStrip({ workers }: { workers: WorkerStatus[] }) {
  const model = workers[0] ? modelInfo(workers[0].model).label : "";
  const done = workers.filter((w) => w.state !== "running").length;
  return (
    <div className="workers">
      <div className="workers-head">
        {done}/{workers.length} delegated tasks
        <span className="hint">running on {model}</span>
      </div>
      <div className="workers-list">
        {workers.map((w) => (
          <div key={w.id} className={`worker worker-${w.state}`}>
            <span className="worker-dot" />
            <span className="worker-title">{w.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ join */

export function JoinGate({
  room,
  initialName,
  onJoin,
}: {
  room: string;
  initialName: string;
  onJoin: (name: string) => void;
}) {
  const [value, setValue] = useState(initialName);
  return (
    <div className="gate">
      <form
        className="gate-card"
        onSubmit={(e) => {
          e.preventDefault();
          onJoin(value);
        }}
      >
        <h1>collab_ai</h1>
        <p className="gate-sub">
          One agent, many people. You're joining <strong>#{room}</strong>.
        </p>
        <input
          autoFocus
          value={value}
          maxLength={32}
          placeholder="Your name"
          onChange={(e) => setValue(e.target.value)}
          aria-label="Your name"
        />
        <button type="submit" disabled={!value.trim()}>
          Join room
        </button>
        <p className="gate-foot">
          Share this page's URL to bring someone else into the same room.
        </p>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------- presence */

export function Presence({ users, me }: { users: PresenceUser[]; me: string | null }) {
  return (
    <div className="presence" title={`${users.length} in the room`}>
      {users.map((u) => (
        <span
          key={u.id}
          className={`chip ${u.id === me ? "chip-me" : ""}`}
          style={{ borderColor: u.color, color: u.color }}
        >
          {u.name}
        </span>
      ))}
      {users.length === 0 && <span className="chip chip-empty">nobody yet</span>}
    </div>
  );
}

/* ------------------------------------------------------------ transcript */

export function Transcript({ entries, me }: { entries: Entry[]; me: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Only auto-scroll when the reader is already at the bottom, so streaming
  // output never yanks the view away from someone reading back.
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div className="transcript" ref={ref} onScroll={onScroll}>
      {entries.length === 0 && (
        <div className="empty">
          <p>Nothing said yet.</p>
          <p className="empty-sub">
            Everyone here talks to the same agent. It sees who said what, and any
            edit it makes to the shared document goes to a vote first.
          </p>
        </div>
      )}
      {entries.map((entry) => (
        <EntryView key={entry.id} entry={entry} me={me} />
      ))}
    </div>
  );
}

const EntryView = memo(function EntryView({
  entry,
  me,
}: {
  entry: Entry;
  me: string | null;
}) {
  if (entry.kind === "system") {
    return <div className="sys">{entry.text}</div>;
  }

  if (entry.kind === "user") {
    return (
      <div className={`msg user ${entry.authorId === me ? "mine" : ""}`}>
        <div className="who" style={{ color: entry.color }}>
          {entry.authorName}
        </div>
        <div className="body">{entry.text}</div>
      </div>
    );
  }

  return (
    <div className="msg agent">
      <div className="who agent-who">agent</div>
      <div className="body">
        {entry.blocks.length === 0 && <span className="dots" aria-label="working" />}
        {entry.blocks.map((b, i) => (
          <BlockView key={i} block={b} />
        ))}
      </div>
    </div>
  );
});

function BlockView({ block }: { block: AgentBlock }) {
  const [open, setOpen] = useState(false);

  if (block.type === "thinking") {
    return (
      <div className="thinking">
        <button className="thinking-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} reasoning
        </button>
        {open && <div className="thinking-body">{block.text}</div>}
      </div>
    );
  }

  if (block.type === "text") {
    return <div className="text">{block.text}</div>;
  }

  return (
    <div className={`tool tool-${block.status}`}>
      <div className="tool-head">
        <code>{block.name}</code>
        <span className="tool-status">
          {block.status === "running"
            ? "running"
            : block.status === "denied"
              ? "denied by the room"
              : block.status === "error"
                ? "failed"
                : "done"}
        </span>
      </div>
      {block.result && <div className="tool-result">{truncate(block.result, 400)}</div>}
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/* --------------------------------------------------------------- voting */

export function ApprovalCard({
  pending,
  me,
  onVote,
}: {
  pending: PendingTool;
  me: string | null;
  onVote: (toolUseId: string, vote: Vote) => void;
}) {
  const counts = tally(pending);
  const mine = me ? pending.votes[me] : undefined;
  const input = pending.input as Record<string, unknown> | null;

  return (
    <div className="approval">
      <div className="approval-top">
        <code className="approval-tool">{pending.name}</code>
        <span className="approval-summary">{pending.summary}</span>
      </div>

      {pending.name === "edit_doc" && input && (
        <div className="diff">
          <div className="diff-row diff-old">
            <span>−</span>
            <pre>{truncate(String(input.old_text ?? ""), 500)}</pre>
          </div>
          <div className="diff-row diff-new">
            <span>+</span>
            <pre>{truncate(String(input.new_text ?? ""), 500)}</pre>
          </div>
        </div>
      )}
      {pending.name === "write_doc" && input && (
        <pre className="proposed">{truncate(String(input.content ?? ""), 900)}</pre>
      )}

      <div className="approval-actions">
        <button
          className={`vote approve ${mine === "approve" ? "cast" : ""}`}
          onClick={() => onVote(pending.toolUseId, "approve")}
        >
          Approve
          <span className="count">
            {counts.approve}/{pending.threshold}
          </span>
        </button>
        <button
          className={`vote deny ${mine === "deny" ? "cast" : ""}`}
          onClick={() => onVote(pending.toolUseId, "deny")}
        >
          Deny
          <span className="count">
            {counts.deny}/{pending.threshold}
          </span>
        </button>
        {mine && <span className="voted">you voted to {mine}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ doc */

export function DocPanel({ doc, revision }: { doc: string; revision: number }) {
  const [flash, setFlash] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 900);
    return () => clearTimeout(t);
  }, [revision]);

  return (
    <aside className={`doc ${flash ? "doc-flash" : ""}`}>
      <div className="doc-head">
        <span>Shared document</span>
        <span className="rev">rev {revision}</span>
      </div>
      {doc.trim() ? (
        <pre className="doc-body">{doc}</pre>
      ) : (
        <div className="doc-empty">
          Empty. Ask the agent to draft something — it will propose the write and
          the room votes on it.
        </div>
      )}
    </aside>
  );
}

/* ------------------------------------------------------------- composer */

export function Composer({
  disabled,
  busy,
  onSend,
  onInterrupt,
}: {
  disabled: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}) {
  const [value, setValue] = useState("");

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue("");
  };

  return (
    <div className="composer">
      <textarea
        value={value}
        disabled={disabled}
        rows={2}
        placeholder={
          busy
            ? "The agent is working — anything you send now joins its next turn"
            : "Say something to the room"
        }
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-actions">
        {busy && (
          <button className="stop" onClick={onInterrupt} title="Stop the current turn">
            Stop
          </button>
        )}
        <button className="send" onClick={submit} disabled={disabled || !value.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
