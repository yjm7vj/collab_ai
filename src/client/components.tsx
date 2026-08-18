import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  INVITABLE_ROLES,
  tally,
  type AgentBlock,
  type Entry,
  type InviteSummary,
  type MemberSummary,
  type PendingTool,
  type Presence as PresenceUser,
  type Vote,
  type WorkerStatus,
} from "../shared/protocol";
import { modelInfo, type CostLedger, type RoomSettings } from "../shared/models";
import { ROLES, outranks, type Role } from "../shared/access";
import {
  MODE_PRESETS,
  TOOL_NAMES,
  describePolicy,
  resolveTools,
  type AccessPolicy,
  type ApprovalPolicy,
  type PermissionMode,
  type ToolDecision,
  type ToolName,
} from "../shared/access";

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

/* -------------------------------------------------------------- landing */

export function Landing({
  initialName,
  busy,
  problem,
  onCreate,
}: {
  initialName: string;
  busy: boolean;
  problem: string | null;
  onCreate: (name: string) => void;
}) {
  const [value, setValue] = useState(initialName);
  return (
    <div className="gate">
      <form
        className="gate-card"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate(value);
        }}
      >
        <h1>collab_ai</h1>
        <p className="gate-sub">
          One agent, many people. Make a room and share the link.
        </p>
        <input
          autoFocus
          value={value}
          maxLength={32}
          placeholder="Your name"
          onChange={(e) => setValue(e.target.value)}
          aria-label="Your name"
        />
        <button type="submit" disabled={!value.trim() || busy}>
          {busy ? "creating…" : "Create a room"}
        </button>
        {problem && <p className="gate-error">{problem}</p>}
        <p className="gate-foot">
          Rooms are private. Only people you send the link to can get in.
        </p>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ join */

export function JoinGate({
  roomId,
  initialName,
  busy,
  problem,
  onJoin,
}: {
  roomId: string;
  initialName: string;
  busy: boolean;
  problem: string | null;
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
          You've been invited to a room.
          <br />
          room {roomId.slice(0, 6)}…
        </p>
        <input
          autoFocus
          value={value}
          maxLength={32}
          placeholder="Your name"
          onChange={(e) => setValue(e.target.value)}
          aria-label="Your name"
        />
        <button type="submit" disabled={!value.trim() || busy}>
          {busy ? "joining…" : "Join room"}
        </button>
        {problem && <p className="gate-error">{problem}</p>}
        <p className="gate-foot">
          Your name is how the room and the agent will refer to you.
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
          key={u.uid}
          className={`chip chip-${u.role} ${u.uid === me ? "chip-me" : ""}`}
          style={{ borderColor: u.color, color: u.color }}
          title={`${u.name} · ${u.role}`}
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
      <div className={`msg user ${entry.authorUid === me ? "mine" : ""}`}>
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
  readOnly,
  onSend,
  onInterrupt,
}: {
  disabled: boolean;
  busy: boolean;
  readOnly?: boolean;
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
        disabled={disabled || readOnly}
        rows={2}
        placeholder={
          readOnly
            ? "You're a viewer in this room — you can read along, but can't post."
            : busy
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
      {!readOnly && (
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
      )}
    </div>
  );
}

/* --------------------------------------------------------------- invites */

/**
 * Plain-English status line for one invite. If the invite has no use limit
 * and nobody has used it yet, "0 used" reads oddly next to "unlimited", so
 * that case collapses to "unlimited" on its own.
 */
function describeInvite(i: InviteSummary): string {
  if (i.revoked) return "Revoked";

  const parts: string[] = [`Joins as ${i.role}`];

  // With no cap, "3 used" alone reads as if a limit exists and is unmet, so
  // the absence of one is stated outright rather than implied by omission.
  parts.push(
    i.maxUses > 0 ? `${i.uses} of ${i.maxUses} used` : `${i.uses} used · no limit`,
  );

  if (i.expiresAt === 0) {
    parts.push("never expires");
  } else if (i.expiresAt <= Date.now()) {
    parts.push("expired");
  } else {
    const hoursLeft = (i.expiresAt - Date.now()) / (1000 * 60 * 60);
    if (hoursLeft > 48) {
      parts.push(`expires in ${Math.round(hoursLeft / 24)} days`);
    } else if (hoursLeft < 1) {
      parts.push("expires soon");
    } else {
      parts.push(`expires in ${Math.round(hoursLeft)} hours`);
    }
  }

  return parts.join(" · ");
}

export function InvitePanel({
  invites,
  roomId,
  onCreate,
  onRevoke,
  onClose,
}: {
  invites: InviteSummary[];
  roomId: string;
  onCreate: (role: string, maxUses: number, expiresInHours: number, label: string) => void;
  onRevoke: (code: string) => void;
  onClose: () => void;
}) {
  const [role, setRole] = useState<string>("editor");
  const [maxUses, setMaxUses] = useState(1);
  const [expiresInHours, setExpiresInHours] = useState(168);
  const [label, setLabel] = useState("");
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const copy = (code: string, url: string) => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopiedCode(code);
      setTimeout(() => setCopiedCode((c) => (c === code ? null : c)), 1500);
    });
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label="Invite people"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Invite people</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <p className="field-note">
            Anyone with an invite link can join this room at the role you choose.
            Revoking a link stops it working immediately.
          </p>

          <section>
            <h3>Create an invite</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onCreate(role, maxUses, expiresInHours, label);
                setLabel("");
              }}
            >
              <label className="field">
                <span className="field-label">Joins as</span>
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  {INVITABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="field-label">Uses</span>
                <select value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
                  <option value={1}>one person</option>
                  <option value={5}>5 people</option>
                  <option value={25}>25 people</option>
                  <option value={0}>no limit</option>
                </select>
              </label>

              <label className="field">
                <span className="field-label">Expires</span>
                <select
                  value={expiresInHours}
                  onChange={(e) => setExpiresInHours(Number(e.target.value))}
                >
                  <option value={24}>24 hours</option>
                  <option value={168}>7 days</option>
                  <option value={720}>30 days</option>
                  <option value={0}>never</option>
                </select>
              </label>

              <label className="field">
                <span className="field-label">Label</span>
                <input
                  value={label}
                  maxLength={48}
                  placeholder="What's this link for? (optional)"
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>

              <button type="submit" className="primary">
                Create invite link
              </button>
            </form>
          </section>

          <section>
            <h3>Active links</h3>
            {invites.length === 0 ? (
              <p className="invite-empty">
                No invite links yet. Create one to let someone in.
              </p>
            ) : (
              <div className="invite-list">
                {invites.map((i) => {
                  const url = `${location.origin}/#/j/${roomId}/${i.code}`;
                  const dead = i.revoked || (i.expiresAt !== 0 && i.expiresAt <= Date.now());
                  return (
                    <div key={i.code} className={`invite-row ${dead ? "invite-dead" : ""}`}>
                      <code className="invite-url">{url}</code>
                      <div className="invite-meta">
                        <span>{describeInvite(i)}</span>
                        <div className="invite-actions">
                          <button className="mini" onClick={() => copy(i.code, url)}>
                            {copiedCode === i.code ? "copied" : "copy"}
                          </button>
                          {!i.revoked && (
                            <button className="mini" onClick={() => onRevoke(i.code)}>
                              revoke
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- members */

/**
 * Whether `myRole` may change or remove this member. False when the target is
 * the acting person, the room's owner, or simply not outranked.
 */
function canActOn(myRole: Role, m: MemberSummary, me: string | null): boolean {
  if (m.uid === me) return false;
  if (m.role === "owner") return false;
  if (!outranks(myRole, m.role)) return false;
  return true;
}

function memberRowTitle(myRole: Role, m: MemberSummary, me: string | null): string | undefined {
  if (m.uid === me) return "This is you.";
  if (m.role === "owner") return "The room's owner can't be changed here.";
  if (!outranks(myRole, m.role)) return "You can only manage people below your own role.";
  return undefined;
}

export function MembersPanel({
  members,
  myRole,
  me,
  onSetRole,
  onRemove,
  onClose,
}: {
  members: MemberSummary[];
  myRole: Role;
  me: string | null;
  onSetRole: (uid: string, role: Role) => void;
  onRemove: (uid: string) => void;
  onClose: () => void;
}) {
  // An admin can offer editor and viewer but not admin: owner is never
  // selectable here, and neither is any role the acting person doesn't outrank.
  const selectableRoles = ROLES.filter((r) => r !== "owner" && outranks(myRole, r));

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label="Members"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Members</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <p className="field-note">
            Roles decide what someone can do here. Changes take effect
            immediately, even for people already connected.
          </p>

          {members.length === 0 ? (
            <p className="invite-empty">Nobody here yet.</p>
          ) : (
            <div className="member-list">
              {members.map((m) => {
                const actionable = canActOn(myRole, m, me);
                const title = memberRowTitle(myRole, m, me);
                return (
                  <div key={m.uid} className="member-row" title={title}>
                    <span
                      className={m.online ? "dot-online" : "dot-offline"}
                      title={m.online ? "online" : "offline"}
                    />
                    <span className="member-name">
                      {m.name}
                      {m.uid === me ? " (you)" : ""}
                    </span>
                    <select
                      value={m.role}
                      disabled={!actionable}
                      onChange={(e) => onSetRole(m.uid, e.target.value as Role)}
                    >
                      {(actionable ? selectableRoles : [m.role]).map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    {actionable && (
                      <button className="mini" onClick={() => onRemove(m.uid)}>
                        Remove
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- permissions */

const MODE_OPTIONS: { mode: PermissionMode; label: string; desc: string }[] = [
  {
    mode: "read_only",
    label: "Read-only",
    desc:
      "The agent can read, search and discuss, but cannot change the document at all. " +
      "Editing tools are withheld entirely, so it proposes in words instead.",
  },
  {
    mode: "ask",
    label: "Ask first",
    desc: "The agent can propose edits, and the room votes on each one before it takes effect.",
  },
  {
    mode: "auto",
    label: "Auto-accept",
    desc: "The agent edits the document without asking. Every change is still recorded in the transcript.",
  },
  {
    mode: "custom",
    label: "Custom",
    desc: "Choose tool by tool below.",
  },
];

const TOOL_DECISIONS: { value: ToolDecision; label: string }[] = [
  { value: "allow", label: "always" },
  { value: "ask", label: "vote" },
  { value: "deny", label: "never" },
];

/**
 * What the agent may do, unattended. Independent of `MembersPanel`, which
 * governs what people may do — this is the second axis, gating tool calls
 * rather than roles.
 */
export function PermissionsPanel({
  policy,
  busy,
  onApply,
  onClose,
}: {
  policy: AccessPolicy;
  busy: boolean;
  onApply: (next: AccessPolicy) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AccessPolicy>(policy);
  const custom = draft.mode === "custom";
  // Resolved matrix for display: the stored one in custom mode, else whatever
  // the chosen preset actually grants — so the rows below never lie about
  // what's in effect.
  const effective = resolveTools(draft);

  const chooseMode = (mode: PermissionMode) => {
    setDraft((d) => (mode === "custom" ? { ...d, mode } : { ...d, mode, tools: MODE_PRESETS[mode] }));
  };

  const chooseTool = (name: ToolName, decision: ToolDecision) => {
    setDraft((d) => ({ ...d, tools: { ...d.tools, [name]: decision } }));
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label="What the agent may do"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>What the agent may do</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {busy && (
          <div className="notice">
            The agent is working. Permissions can only change while it's idle.
          </div>
        )}

        <div className="modal-body">
          <p className="field-note">
            This is separate from what people may do. It controls how much the agent can change
            on its own.
          </p>

          <section>
            <h3>Mode</h3>
            <div className="policy-modes">
              {MODE_OPTIONS.map((opt) => (
                <label
                  key={opt.mode}
                  className={`policy-mode-opt ${draft.mode === opt.mode ? "on" : ""}`}
                >
                  <input
                    type="radio"
                    name="policy-mode"
                    checked={draft.mode === opt.mode}
                    onChange={() => chooseMode(opt.mode)}
                  />
                  <span>
                    <span className="policy-mode-name">{opt.label}</span>
                    <span className="field-note">{opt.desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section>
            <h3>Tools</h3>
            <div className="policy-tools">
              {TOOL_NAMES.map((name) => (
                <div key={name} className="policy-tool-row">
                  <code>{name}</code>
                  <div className="policy-tool-options">
                    {TOOL_DECISIONS.map((d) => (
                      <label key={d.value} className="policy-tool-opt">
                        <input
                          type="radio"
                          name={`policy-tool-${name}`}
                          disabled={!custom}
                          checked={effective[name] === d.value}
                          onChange={() => chooseTool(name, d.value)}
                        />
                        {d.label}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3>Approval rule</h3>
            <label className="field">
              <span className="field-label">When a vote is needed</span>
              <select
                value={draft.approval}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, approval: e.target.value as ApprovalPolicy }))
                }
              >
                <option value="majority">Majority of eligible voters</option>
                <option value="unanimous">Everyone must agree</option>
                <option value="any_editor">Any one editor can approve</option>
                <option value="owner_only">Only the owner can approve</option>
              </select>
              <span className="field-note">Viewers are never counted, because they cannot vote.</span>
            </label>
          </section>

          <p className="field-note policy-summary">{describePolicy(draft)}</p>
        </div>

        <footer className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={() => onApply(draft)}>
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
