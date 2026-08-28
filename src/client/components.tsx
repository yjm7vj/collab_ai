import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  INVITABLE_ROLES,
  REDACTED,
  tally,
  type AgentBlock,
  type Entry,
  type GithubRepo,
  type GithubStatus,
  type InviteSummary,
  type MemberSummary,
  type PendingTool,
  type Presence as PresenceUser,
  type Vote,
  type WorkerStatus,
} from "../shared/protocol";
import type { WorkspaceInfo } from "../shared/workspace";
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

export type ThemeMode = "light" | "dark";

function titleCaseWords(value: string): string {
  return value
    .split(/([_\s-]+)/)
    .map((part) =>
      /^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part,
    )
    .join("");
}

const TOOL_LABELS: Record<string, string> = {
  read_doc: "Review Document",
  write_doc: "Document Update",
  edit_doc: "Document Edit",
  delegate: "Delegate Task",
  web_search: "Search Web",
  web_fetch: "Open Web Page",
  list_files: "Browse Files",
  read_file: "Read File",
  search_files: "Search Files",
  write_file: "Create File",
  edit_file: "Edit File",
  delete_file: "Delete File",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? titleCaseWords(name.replaceAll("_", " "));
}

export function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: ThemeMode;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
      aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
    >
      <span className="theme-toggle-track" aria-hidden="true">
        <span className="theme-toggle-thumb" />
      </span>
      <span>{theme === "light" ? "Light" : "Dark"}</span>
    </button>
  );
}

export function LogoMark() {
  return (
    <img className="logo-mark" src="/collab-logo.svg" alt="Huddle.AI" title="Huddle.AI" />
  );
}

function ArchiveIcon() {
  return (
    <svg className="archive-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.5 5.5h11v7.25a.75.75 0 0 1-.75.75h-9.5a.75.75 0 0 1-.75-.75V5.5Z" />
      <path d="M1.75 2.5h12.5v3H1.75v-3Z" />
      <path d="M6 8.5h4" />
    </svg>
  );
}

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
  // A custom workflow can put every task on a different model, so the header
  // names all of them rather than reporting the first one as if it spoke for
  // the fan-out.
  const models = [...new Set(workers.map((w) => modelInfo(w.model).label))].join(", ");
  const done = workers.filter((w) => w.state !== "running").length;
  return (
    <div className="workers">
      <div className="workers-head">
        {done}/{workers.length} Delegated Tasks
        <span className="hint">Running On {models}</span>
      </div>
      <div className="workers-list">
        {workers.map((w) => (
          <div key={w.id} className={`worker worker-${w.state}`}>
            <span className="worker-dot" />
            {w.agent && <span className="worker-agent">{w.agent}</span>}
            <span className="worker-title">{w.title}</span>
            {w.stage && <span className="worker-stage">{w.stage}</span>}
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
  identityName,
  onSignOut,
  theme,
  onToggleTheme,
}: {
  initialName: string;
  busy: boolean;
  problem: string | null;
  onCreate: (name: string) => void;
  identityName?: string;
  onSignOut?: () => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  const [value, setValue] = useState(initialName);
  return (
    <div className="gate">
      <form
        className="gate-card"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate(identityName ?? value);
        }}
      >
        <div className="gate-top">
          <LogoMark />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
        <p className="gate-sub">
          One agent, many people. Make a room and share the link.
        </p>
        {identityName ? (
          <p className="gate-signed-in">
            Signed in as {identityName}
            {onSignOut && (
              <button type="button" className="linkbtn" onClick={onSignOut}>
                Sign Out
              </button>
            )}
          </p>
        ) : (
          <input
            autoFocus
            value={value}
            maxLength={32}
            placeholder="Your name"
            onChange={(e) => setValue(e.target.value)}
            aria-label="Your name"
          />
        )}
        <button type="submit" disabled={(!identityName && !value.trim()) || busy}>
          {busy ? "Creating..." : "Create a Room"}
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
  identityName,
  onSignOut,
  theme,
  onToggleTheme,
}: {
  roomId: string;
  initialName: string;
  busy: boolean;
  problem: string | null;
  onJoin: (name: string) => void;
  identityName?: string;
  onSignOut?: () => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  const [value, setValue] = useState(initialName);
  return (
    <div className="gate">
      <form
        className="gate-card"
        onSubmit={(e) => {
          e.preventDefault();
          onJoin(identityName ?? value);
        }}
      >
        <div className="gate-top">
          <LogoMark />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
        <p className="gate-sub">
          You've been invited to a room.
          <br />
          Room {roomId.slice(0, 6)}...
        </p>
        {identityName ? (
          <p className="gate-signed-in">
            Signed in as {identityName}
            {onSignOut && (
              <button type="button" className="linkbtn" onClick={onSignOut}>
                Sign Out
              </button>
            )}
          </p>
        ) : (
          <input
            autoFocus
            value={value}
            maxLength={32}
            placeholder="Your name"
            onChange={(e) => setValue(e.target.value)}
            aria-label="Your name"
          />
        )}
        <button type="submit" disabled={(!identityName && !value.trim()) || busy}>
          {busy ? "Joining..." : "Join Room"}
        </button>
        {problem && <p className="gate-error">{problem}</p>}
        <p className="gate-foot">
          Your name is how the room and the agent will refer to you.
        </p>
      </form>
    </div>
  );
}

/* --------------------------------------------------------------- sign-in */

const PROVIDER_LABELS: Record<string, string> = {
  github: "Continue with GitHub",
  google: "Continue with Google",
};

export function SignInGate({
  providers,
  onSignIn,
  problem,
  theme,
  onToggleTheme,
}: {
  providers: string[];
  onSignIn: (p: string) => void;
  problem: string | null;
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-top">
          <LogoMark />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
        <p className="gate-sub">
          One agent, many people. Sign in to create or join a room.
        </p>
        <div className="signin-providers">
          {providers
            .filter((p) => p in PROVIDER_LABELS)
            .map((p) => (
              <button key={p} type="button" onClick={() => onSignIn(p)}>
                {PROVIDER_LABELS[p]}
              </button>
            ))}
        </div>
        {problem && <p className="gate-error">{problem}</p>}
        <p className="gate-foot">
          We only read your name and avatar. Nothing is posted on your behalf.
        </p>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- side pane */

type SideProject = {
  id: string;
  name: string;
  archived: boolean;
  rooms: SideRoom[];
  workspace: WorkspaceInfo;
};

type SideRoom = {
  roomId: string;
  label: string;
  projectId?: string;
  archived: boolean;
  workspace: WorkspaceInfo;
};

export function SidePane({
  activeRoomId,
  busy,
  projects,
  rooms,
  onCreateRoom,
  onCreateProject,
  onOpenRoom,
  onRenameRoom,
  onCopyRoomLink,
  onArchiveRoom,
  onRestoreRoom,
  onDeleteRoom,
  onArchiveProject,
  onRestoreProject,
  onDeleteProject,
}: {
  activeRoomId?: string;
  busy: boolean;
  projects: SideProject[];
  rooms: SideRoom[];
  onCreateRoom: (projectId?: string) => void;
  onCreateProject: (name: string) => void;
  onOpenRoom: (roomId: string) => void;
  onRenameRoom: (roomId: string, label: string) => void;
  onCopyRoomLink: (roomId: string) => void;
  onArchiveRoom: (roomId: string) => void;
  onRestoreRoom: (roomId: string) => void;
  onDeleteRoom: (roomId: string) => void;
  onArchiveProject: (projectId: string) => void;
  onRestoreProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
}) {
  const [addingProject, setAddingProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [openProjectMenu, setOpenProjectMenu] = useState<string | null>(null);
  const archivedRooms = [
    ...rooms.filter((room) => room.archived),
    ...projects.flatMap((project) => project.rooms.filter((room) => room.archived)),
  ];

  const submitProject = () => {
    const name = projectName.trim().slice(0, 42);
    if (!name) return;
    onCreateProject(name);
    setProjectName("");
    setAddingProject(false);
  };

  const promptRename = (room: SideRoom) => {
    const label = window.prompt("Room name", room.label);
    if (label !== null) onRenameRoom(room.roomId, label);
  };

  return (
    <aside className="side-pane" aria-label="Workspace navigation">
      <div className="side-head">
        <LogoMark />
        <div className="side-title">Huddle.AI</div>
      </div>

      <nav className="side-scroll" aria-label="Projects">
        <section className="side-section">
          <div className="side-section-row">
            <div className="side-section-label">Rooms</div>
            <button
              type="button"
              className="side-small-action side-add-room"
              onClick={() => onCreateRoom()}
              disabled={busy}
              title="Create a standalone room"
              aria-label="Create a standalone room"
            >
              +
            </button>
          </div>
          {rooms.length > 0 && (
            <div className="side-room-list">
              {rooms.filter((room) => !room.archived).map((room) => (
                <div className="side-room-row" key={room.roomId}>
                  <button
                    type="button"
                    className={`side-item ${room.roomId === activeRoomId ? "active" : ""}`}
                    onClick={() => onOpenRoom(room.roomId)}
                  >
                    <span className="side-item-title">{room.label}</span>
                    <span className="side-item-detail">
                      {room.workspace.label ? `Workspace: ${room.workspace.label}` : room.roomId}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="side-room-action side-copy-room"
                    onClick={() => onCopyRoomLink(room.roomId)}
                    aria-label={`Copy link for ${room.label}`}
                    title="Copy room link"
                  >
                    ⧉
                  </button>
                  <button
                    type="button"
                    className="side-room-action side-rename-room"
                    onClick={() => promptRename(room)}
                    aria-label={`Rename ${room.label}`}
                    title={`Rename ${room.label}`}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="side-archive-room"
                    onClick={() => onArchiveRoom(room.roomId)}
                    aria-label={`Archive ${room.label}`}
                    title={`Archive ${room.label}`}
                  >
                    <ArchiveIcon />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="side-section">
          <div className="side-section-row">
            <div className="side-section-label">Projects</div>
            <button
              type="button"
              className="side-small-action"
              onClick={() => setAddingProject(true)}
            >
              New
            </button>
          </div>

          {addingProject && (
            <form
              className="side-project-form"
              onSubmit={(e) => {
                e.preventDefault();
                submitProject();
              }}
            >
              <input
                autoFocus
                value={projectName}
                maxLength={42}
                placeholder="Project name"
                onChange={(e) => setProjectName(e.target.value)}
                aria-label="Project name"
              />
              <div className="side-form-actions">
                <button type="button" onClick={() => setAddingProject(false)}>
                  Cancel
                </button>
                <button type="submit" disabled={!projectName.trim()}>
                  Create
                </button>
              </div>
            </form>
          )}

          {projects.length === 0 ? (
            <div className="side-empty">
              <strong>Create a new project to get started.</strong>
              <span>
                Projects will collect rooms, workspace context, and channels for a
                shared effort.
              </span>
              {!addingProject && (
                <button type="button" onClick={() => setAddingProject(true)}>
                  Create Project
                </button>
              )}
            </div>
          ) : (
            projects.filter((project) => !project.archived).map((project) => (
              <div className="side-project" key={project.id}>
                <div className="side-project-head">
                  <span className="side-folder" aria-hidden="true" />
                  <span>{project.name}</span>
                  <div className="side-project-actions">
                    <button
                      type="button"
                      className="side-project-add"
                      onClick={() => onCreateRoom(project.id)}
                      disabled={busy}
                      aria-label={`Create a room in ${project.name}`}
                      title={`Create a room in ${project.name}`}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="side-project-menu-trigger"
                      onClick={() => setOpenProjectMenu((open) => open === project.id ? null : project.id)}
                      aria-label={`Project actions for ${project.name}`}
                      aria-expanded={openProjectMenu === project.id}
                      title={`Project actions for ${project.name}`}
                    >
                      ⋯
                    </button>
                    {openProjectMenu === project.id && (
                      <div className="side-project-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => {
                          setOpenProjectMenu(null);
                          onArchiveProject(project.id);
                        }}>Archive project</button>
                        <button type="button" role="menuitem" onClick={() => {
                          setOpenProjectMenu(null);
                          onDeleteProject(project.id);
                        }}>Delete project</button>
                      </div>
                    )}
                  </div>
                </div>
                <div className="side-channels">
                  {project.rooms.filter((room) => !room.archived).map((room) => (
                    <div className="side-room-row" key={room.roomId}>
                      <button
                        type="button"
                        className={`side-item ${room.roomId === activeRoomId ? "active" : ""}`}
                        onClick={() => onOpenRoom(room.roomId)}
                      >
                        <span className="side-item-title">{room.label}</span>
                        <span className="side-item-detail">
                          {/* The project already names its own workspace below, so a room
                              only spells one out when it differs from what it inherited. */}
                          {room.workspace.label && room.workspace.label !== project.workspace.label
                            ? `Workspace: ${room.workspace.label}`
                            : room.roomId}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="side-room-action side-copy-room"
                        onClick={() => onCopyRoomLink(room.roomId)}
                        aria-label={`Copy link for ${room.label}`}
                        title="Copy room link"
                      >
                        ⧉
                      </button>
                      <button
                        type="button"
                        className="side-room-action side-rename-room"
                        onClick={() => promptRename(room)}
                        aria-label={`Rename ${room.label}`}
                        title={`Rename ${room.label}`}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="side-archive-room"
                        onClick={() => onArchiveRoom(room.roomId)}
                        aria-label={`Archive ${room.label}`}
                        title={`Archive ${room.label}`}
                      >
                        <ArchiveIcon />
                      </button>
                    </div>
                  ))}
                  {project.rooms.filter((room) => !room.archived).length === 0 && (
                    <span className="side-item-detail side-project-empty">No rooms yet · use + to add one</span>
                  )}
                  {project.workspace.label && (
                    <span className="side-item-detail side-project-workspace">
                      Workspace · {project.workspace.label}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </section>

        {archivedRooms.length > 0 && (
          <section className="side-section">
            <div className="side-section-label">Archived</div>
            <div className="side-room-list">
              {archivedRooms.map((room) => (
                <div className="side-room-row" key={room.roomId}>
                  <button
                    type="button"
                    className="side-item side-item-muted"
                    onClick={() => onOpenRoom(room.roomId)}
                  >
                    <span className="side-item-title">{room.label}</span>
                    <span className="side-item-detail">{room.projectId ? "Archived project room" : "Archived standalone room"}</span>
                  </button>
                  <button
                    type="button"
                    className="side-room-action side-copy-room"
                    onClick={() => onCopyRoomLink(room.roomId)}
                    aria-label={`Copy link for ${room.label}`}
                    title="Copy room link"
                  >
                    ⧉
                  </button>
                  <button
                    type="button"
                    className="side-room-action side-rename-room"
                    onClick={() => promptRename(room)}
                    aria-label={`Rename ${room.label}`}
                    title={`Rename ${room.label}`}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="side-restore-room"
                    onClick={() => onRestoreRoom(room.roomId)}
                    aria-label={`Restore ${room.label}`}
                    title={`Restore ${room.label}`}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    className="side-delete-archived-room"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteRoom(room.roomId);
                    }}
                    aria-label={`Delete ${room.label}`}
                    title={`Delete ${room.label}`}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {projects.some((project) => project.archived) && (
          <section className="side-section">
            <div className="side-section-label">Archived projects</div>
            <div className="side-room-list">
              {projects.filter((project) => project.archived).map((project) => (
                <div className="side-room-row" key={project.id}>
                  <span className="side-item side-item-muted">
                    <span className="side-item-title">{project.name}</span>
                    <span className="side-item-detail">{project.rooms.length} archived room{project.rooms.length === 1 ? "" : "s"}</span>
                  </span>
                  <button
                    type="button"
                    className="side-restore-room"
                    onClick={() => onRestoreProject(project.id)}
                    aria-label={`Restore ${project.name}`}
                    title={`Restore ${project.name}`}
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

      </nav>
    </aside>
  );
}

/* -------------------------------------------------------------- presence */

export function Presence({ users, me }: { users: PresenceUser[]; me: string | null }) {
  const visibleUsers = users.filter((u) => u.uid !== me);
  return (
    <div className="presence" title={`${users.length} in the room`}>
      {visibleUsers.map((u) => (
        <span
          key={u.uid}
          className={`chip chip-${u.role} ${u.uid === me ? "chip-me" : ""}`}
          style={{ borderColor: u.color, color: u.color }}
          title={`${u.name} · ${u.role}`}
        >
          {u.name}
        </span>
      ))}
      {users.length === 0 && <span className="chip chip-empty">Nobody Yet</span>}
    </div>
  );
}

/* ------------------------------------------------------------ transcript */

export function Transcript({
  entries,
  me,
  toolDisplay = "compact",
}: {
  entries: Entry[];
  me: string | null;
  toolDisplay?: "hidden" | "compact" | "full";
}) {
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
        <EntryView key={entry.id} entry={entry} me={me} toolDisplay={toolDisplay} />
      ))}
    </div>
  );
}

const EntryView = memo(function EntryView({
  entry,
  me,
  toolDisplay,
}: {
  entry: Entry;
  me: string | null;
  toolDisplay: "hidden" | "compact" | "full";
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

  // In "hidden" mode, tool calls and reasoning aren't rendered individually —
  // each run of consecutive steps collapses into a single one-line summary
  // that expands on click, so the agent's actual prose is what dominates the
  // transcript and the steps stay a click away rather than gone.
  const rendered: ReactElement[] = [];
  let run: AgentBlock[] = [];
  const flushRun = (key: string) => {
    if (run.length > 0) {
      rendered.push(<CollapsedSteps key={key} blocks={run} />);
      run = [];
    }
  };

  if (toolDisplay === "hidden") {
    entry.blocks.forEach((b, i) => {
      if (b.type === "tool" || b.type === "thinking") {
        run.push(b);
        return;
      }
      flushRun(`run-${i}`);
      rendered.push(<BlockView key={i} block={b} toolDisplay={toolDisplay} />);
    });
    flushRun("run-end");
  } else {
    entry.blocks.forEach((b, i) => {
      rendered.push(<BlockView key={i} block={b} toolDisplay={toolDisplay} />);
    });
  }

  return (
    <div className="msg agent">
      <div className="who agent-who">Agent</div>
      <div className="body">
        {entry.blocks.length === 0 && <span className="dots" aria-label="Working" />}
        {rendered}
      </div>
    </div>
  );
});

/** One-line description of a tool call, for the collapsed row. */
function describeCall(name: string, input: unknown): string {
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "delete_file":
      return str(rec.path);
    case "list_files": {
      const path = str(rec.path) || "Workspace Root";
      const depth = rec.depth;
      return typeof depth === "number" ? `${path} · Depth ${depth}` : path;
    }
    case "search_files": {
      const pattern = str(rec.pattern);
      const glob = str(rec.glob);
      const base = pattern ? `"${pattern}"` : "";
      return glob ? `${base} · In ${glob}` : base;
    }
    case "read_doc":
    case "write_doc":
    case "edit_doc":
      return "";
    case "delegate": {
      const tasks = Array.isArray(rec.tasks) ? rec.tasks.length : 0;
      return `${tasks} Tasks`;
    }
    case "web_search": {
      const query = str(rec.query);
      return query ? `"${query}"` : "";
    }
    default:
      return "";
  }
}

/** Human-readable byte size, matching the `18 lines` / `340 B` hint format. */
function sizeHint(result: string): string {
  if (result.includes("\n")) {
    return `${result.split("\n").length} Lines`;
  }
  const bytes = result.length;
  if (bytes < 1000) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function BlockView({
  block,
  toolDisplay,
}: {
  block: AgentBlock;
  toolDisplay: "hidden" | "compact" | "full";
}) {
  if (block.type === "thinking") {
    return <ThinkingBlock block={block} />;
  }

  if (block.type === "text") {
    return <div className="text">{block.text}</div>;
  }

  return <ToolBlock block={block} toolDisplay={toolDisplay} />;
}

/**
 * One-line, click-to-expand face for a run of consecutive tool/reasoning
 * blocks in "hidden" mode. Collapsed by default so the agent's prose reads
 * as the main content; expanding reveals the same per-block views used in
 * compact mode, so nothing is actually lost, just deferred.
 */
function CollapsedSteps({ blocks }: { blocks: AgentBlock[] }) {
  const [open, setOpen] = useState(false);
  const toolCount = blocks.filter((b) => b.type === "tool").length;
  const thoughtCount = blocks.filter((b) => b.type === "thinking").length;
  const parts: string[] = [];
  if (toolCount) parts.push(`${toolCount} ${toolCount === 1 ? "Tool Call" : "Tool Calls"}`);
  if (thoughtCount) parts.push(`${thoughtCount} ${thoughtCount === 1 ? "Thought" : "Thoughts"}`);

  return (
    <div className="steps-collapsed">
      <button
        type="button"
        className="steps-collapsed-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-disclosure">{open ? "▾" : "▸"}</span>
        {parts.join(" · ") || "Steps"}
      </button>
      {open && (
        <div className="steps-collapsed-body">
          {blocks.map((b, i) => (
            <BlockView key={i} block={b} toolDisplay="compact" />
          ))}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ block }: { block: Extract<AgentBlock, { type: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <button className="thinking-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} Reasoning
      </button>
      {open && <div className="thinking-body">{block.text}</div>}
    </div>
  );
}

function ToolBlock({
  block,
  toolDisplay,
}: {
  block: Extract<AgentBlock, { type: "tool" }>;
  toolDisplay: "hidden" | "compact" | "full";
}) {
  // Errors and denials start expanded — the one result the user must not
  // have to hunt for. Every other block starts per the room's toolDisplay
  // mode (or collapsed, when no mode is given).
  const startsOpen =
    block.status === "error" || block.status === "denied" || toolDisplay === "full";
  const [open, setOpen] = useState(startsOpen);

  const summary = describeCall(block.name, block.input);
  const isRedacted = block.result === REDACTED;
  // The size of a withheld file is itself a small leak — how much someone
  // wrote, roughly what shape it is — so a redacted result shows no hint.
  const hint = !open && block.result && !isRedacted ? sizeHint(block.result) : null;

  return (
    <div className={`tool tool-${block.status}`}>
      <div className="tool-head" onClick={() => setOpen((v) => !v)} role="button">
        <span className="tool-disclosure">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{toolLabel(block.name)}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        <span className={`tool-pip tool-pip-${block.status}`} aria-hidden="true" />
        <span className="tool-status">
          {block.status === "running"
            ? "Running"
            : block.status === "denied"
              ? "Denied By The Room"
              : block.status === "error"
                ? "Failed"
                : "Done"}
        </span>
        {hint && <span className="tool-hint">{hint}</span>}
      </div>
      {open &&
        block.result &&
        (isRedacted ? (
          <div className="tool-result hint redacted" style={{ fontStyle: "italic" }}>
            {block.result}
          </div>
        ) : (
          <div className="tool-result">{truncate(block.result, 400)}</div>
        ))}
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
  canDecide,
}: {
  pending: PendingTool;
  me: string | null;
  onVote: (toolUseId: string, vote: Vote) => void;
  canDecide: boolean;
}) {
  const counts = tally(pending);
  const mine = me ? pending.votes[me] : undefined;
  const input = pending.input as Record<string, unknown> | null;

  return (
    <div className="approval">
      <div className="approval-top">
        <span className="approval-tool">{toolLabel(pending.name)}</span>
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
          disabled={!canDecide}
        >
          Approve
          <span className="count">
            {counts.approve}/{pending.threshold}
          </span>
        </button>
        <button
          className={`vote deny ${mine === "deny" ? "cast" : ""}`}
          onClick={() => onVote(pending.toolUseId, "deny")}
          disabled={!canDecide}
        >
          Deny
          <span className="count">
            {counts.deny}/{pending.threshold}
          </span>
        </button>
        {mine && <span className="voted">You Voted To {titleCaseWords(mine)}</span>}
      </div>
      {!canDecide && (
        <div className="hint redacted" style={{ fontStyle: "italic" }}>
          You can't see this file's contents, so an owner or admin has to decide this one.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ doc */

export function DocPanel({
  doc,
  revision,
  onClose,
}: {
  doc: string;
  revision: number;
  onClose?: () => void;
}) {
  const [flash, setFlash] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
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
        <div className="doc-title">
          <span>Shared Document</span>
          <span className="rev">Rev {revision}</span>
        </div>
        {onClose && (
          <button
            type="button"
            className="doc-close"
            onClick={onClose}
            aria-label="Close shared document"
            title="Close Shared Document"
          >
            ×
          </button>
        )}
        <button
          type="button"
          className="doc-download"
          disabled={downloading}
          onClick={() => {
            setDownloading(true);
            setDownloadError(null);
            void import("./docx")
              .then(({ downloadDocx }) => downloadDocx(doc, `shared-document-rev-${revision}.docx`))
              .catch(() => setDownloadError("Could not create the Word document."))
              .finally(() => setDownloading(false));
          }}
        >
          {downloading ? "Preparing..." : "Download .docx"}
        </button>
      </div>
      {downloadError && <div className="doc-download-error">{downloadError}</div>}
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
  modelLabel,
  policyLabel,
  statusLabel,
  quickActions,
  onSend,
  onInterrupt,
}: {
  disabled: boolean;
  busy: boolean;
  readOnly?: boolean;
  modelLabel: string;
  policyLabel: string;
  statusLabel: string;
  quickActions?: ReactNode;
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
      {quickActions && <div className="composer-toolbar">{quickActions}</div>}
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
          <span className="composer-status">{statusLabel}</span>
          <span className="composer-model">{modelLabel}</span>
          <span className="composer-policy">{policyLabel}</span>
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

  const parts: string[] = [`Joins As ${titleCaseWords(i.role)}`];

  // With no cap, "3 used" alone reads as if a limit exists and is unmet, so
  // the absence of one is stated outright rather than implied by omission.
  parts.push(
    i.maxUses > 0 ? `${i.uses} Of ${i.maxUses} Used` : `${i.uses} Used · No Limit`,
  );

  if (i.expiresAt === 0) {
    parts.push("Never Expires");
  } else if (i.expiresAt <= Date.now()) {
    parts.push("Expired");
  } else {
    const hoursLeft = (i.expiresAt - Date.now()) / (1000 * 60 * 60);
    if (hoursLeft > 48) {
      parts.push(`Expires In ${Math.round(hoursLeft / 24)} Days`);
    } else if (hoursLeft < 1) {
      parts.push("Expires Soon");
    } else {
      parts.push(`Expires In ${Math.round(hoursLeft)} Hours`);
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
        aria-label="Invite People"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Invite People</h2>
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
            <h3>Create An Invite</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onCreate(role, maxUses, expiresInHours, label);
                setLabel("");
              }}
            >
              <label className="field">
                <span className="field-label">Joins As</span>
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
                  <option value={1}>One Person</option>
                  <option value={5}>5 People</option>
                  <option value={25}>25 People</option>
                  <option value={0}>No Limit</option>
                </select>
              </label>

              <label className="field">
                <span className="field-label">Expires</span>
                <select
                  value={expiresInHours}
                  onChange={(e) => setExpiresInHours(Number(e.target.value))}
                >
                  <option value={24}>24 Hours</option>
                  <option value={168}>7 Days</option>
                  <option value={720}>30 Days</option>
                  <option value={0}>Never</option>
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
                Create Invite Link
              </button>
            </form>
          </section>

          <section>
            <h3>Active Links</h3>
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
                            {copiedCode === i.code ? "Copied" : "Copy"}
                          </button>
                          {!i.revoked && (
                            <button className="mini" onClick={() => onRevoke(i.code)}>
                              Revoke
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
                      title={m.online ? "Online" : "Offline"}
                    />
                    <span className="member-name">
                      {m.name}
                      {m.uid === me ? " (You)" : ""}
                    </span>
                    <select
                      value={m.role}
                      disabled={!actionable}
                      onChange={(e) => onSetRole(m.uid, e.target.value as Role)}
                    >
                      {(actionable ? selectableRoles : [m.role]).map((r) => (
                        <option key={r} value={r}>
                          {titleCaseWords(r)}
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
    label: "Read-Only",
    desc:
      "The agent can read, search and discuss, but cannot change the document at all. " +
      "Editing tools are withheld entirely, so it proposes in words instead.",
  },
  {
    mode: "ask",
    label: "Ask First",
    desc: "The agent can propose edits, and the room votes on each one before it takes effect.",
  },
  {
    mode: "auto",
    label: "Auto-Accept",
    desc: "The agent edits the document without asking. Every change is still recorded in the transcript.",
  },
  {
    mode: "custom",
    label: "Custom",
    desc: "Choose tool by tool below.",
  },
];

const TOOL_DECISIONS: { value: ToolDecision; label: string }[] = [
  { value: "allow", label: "Always" },
  { value: "ask", label: "Vote" },
  { value: "deny", label: "Never" },
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
        className="modal permissions-modal"
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
                  <span className="policy-tool-name">{toolLabel(name)}</span>
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
              <span className="field-label">When A Vote Is Needed</span>
              <select
                value={draft.approval}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, approval: e.target.value as ApprovalPolicy }))
                }
              >
                <option value="majority">Majority Of Eligible Voters</option>
                <option value="unanimous">Everyone Must Agree</option>
                <option value="any_editor">Any One Editor Can Approve</option>
                <option value="owner_only">Only The Owner Can Approve</option>
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

/* --------------------------------------------------------------- workspace */

/**
 * Connect or disconnect this browser as the room's file server, and see the
 * room's current workspace status. Read-only for now: this panel never
 * offers write, edit or remove, because `performFsRequest` doesn't implement
 * them yet.
 */
export function WorkspacePanel({
  workspace,
  supported,
  hosting,
  canWrite,
  github,
  repos,
  reposLoading,
  onAttach,
  onDetach,
  onConnectGithub,
  onAuthGithub,
  onListRepos,
  onSignOutGithub,
  onClose,
}: {
  workspace: WorkspaceInfo;
  supported: boolean;
  hosting: boolean;
  canWrite: boolean;
  github: GithubStatus;
  repos: GithubRepo[] | null;
  reposLoading: boolean;
  onAttach: (allowWrites: boolean) => void;
  onDetach: () => void;
  onConnectGithub: (repo: string) => void;
  onAuthGithub: () => void;
  onListRepos: () => void;
  onSignOutGithub: () => void;
  onClose: () => void;
}) {
  const attached = workspace.kind !== "none";
  const [allowWrites, setAllowWrites] = useState(false);
  const [repo, setRepo] = useState("");
  const [filter, setFilter] = useState("");

  // Fetch the repository list the moment the panel knows there is an
  // authorised account, rather than making someone click "load" to see the
  // thing they opened this panel for. The ref is what stops a server refusal
  // from becoming a request loop: a failure leaves `repos` null forever, so
  // without it this effect would fire again on every render. A retry stays
  // available as a button below.
  const requestedRepos = useRef(false);
  useEffect(() => {
    if (!github.authorized || repos !== null || requestedRepos.current) return;
    requestedRepos.current = true;
    onListRepos();
  }, [github.authorized, repos, onListRepos]);
  // Signing out clears `repos` back to null, and that must arm the fetch
  // again for whoever authorises next.
  useEffect(() => {
    if (!github.authorized) requestedRepos.current = false;
  }, [github.authorized]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label="Workspace"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Workspace</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          {!attached ? (
            <div className="ws-options">
              {supported ? (
                <section className="ws-option">
                  <h3 className="ws-option-heading">A Folder On Your Computer</h3>
                  <p className="field-note">
                    Connect a real folder from this device. The agent can read
                    files from it and search within it.
                  </p>
                  <label className="ws-write-toggle">
                    <input
                      type="checkbox"
                      checked={allowWrites}
                      onChange={(e) => setAllowWrites(e.target.checked)}
                    />
                    Let the agent change files (every change still goes to a vote)
                  </label>
                  {allowWrites && (
                    <p className="field-warn">
                      Your browser will ask for permission to edit the
                      folder. The agent can then modify real files on your
                      machine — approved by the room, but on your disk.
                    </p>
                  )}
                  <button className="primary" onClick={() => onAttach(allowWrites)}>
                    Choose a Folder...
                  </button>
                  <p className="field-warn ws-warning">
                    Everyone in this room can ask the agent to read files from the
                    folder you pick, and what it reads appears in the transcript.
                    Pick a project folder, never your home directory.
                  </p>
                </section>
              ) : (
                // A button that can't work is worse than an honest message — no
                // disabled picker here, just the reason and a way out.
                <p className="field-note">
                  Your browser can't share a local folder. Chrome or Edge can — or
                  connect a GitHub repository instead, which works everywhere.
                </p>
              )}

              <section className="ws-option">
                <h3 className="ws-option-heading">A GitHub Repository</h3>
                {!github.oauth && !github.app ? (
                  // Nothing is configured on this deployment at all — a
                  // button that can't work is worse than an honest message,
                  // so this tells whoever can fix it exactly how to, rather
                  // than leaving them to guess why "Connect" errors out.
                  <>
                    <p className="field-note">
                      GitHub isn't set up on this server yet, so there's nothing to connect to.
                      Whoever deployed this app can turn it on in about two minutes:
                    </p>
                    <ol className="ws-setup">
                      <li>
                        Create an OAuth App at{" "}
                        <a
                          href="https://github.com/settings/developers"
                          target="_blank"
                          rel="noreferrer"
                        >
                          github.com/settings/developers
                        </a>{" "}
                        → New OAuth App.
                      </li>
                      <li>
                        Set the Callback URL to{" "}
                        <code>{location.origin}/api/auth/github/callback</code>.
                      </li>
                      <li>Run these two commands, pasting the Client ID and Client Secret when asked:</li>
                    </ol>
                    <pre className="ws-setup-code">{"npx wrangler secret put GITHUB_OAUTH_CLIENT_ID\nnpx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET"}</pre>
                    <p className="field-note">
                      The same credentials also switch on signing in with GitHub. Nothing else is needed —
                      no private key, no app installation.
                    </p>
                  </>
                ) : github.oauth && !github.authorized ? (
                  // OAuth is configured but nobody here has authorised yet —
                  // one button starts the round trip.
                  <>
                    <p className="field-note">
                      Connect your GitHub account, then pick a repository from the list. Works in any
                      browser, and the agent's changes arrive as a pull request rather than edits on
                      someone's machine.
                    </p>
                    <button className="primary" onClick={onAuthGithub}>Connect GitHub</button>
                    <p className="field-note">
                      GitHub will ask you to authorise this app. It can then read and open pull requests
                      on repositories you can already reach — the room only ever touches the single
                      repository you pick here.
                    </p>
                  </>
                ) : github.authorized ? (
                  // Authorised: pick a repository from a live, searchable list
                  // instead of typing "owner/repo" from memory.
                  (() => {
                    const filtered = (repos ?? []).filter((r) =>
                      r.fullName.toLowerCase().includes(filter.trim().toLowerCase()),
                    );
                    const shown = filtered.slice(0, 50);
                    return (
                      <>
                        <p className="field-note">
                          Signed In To GitHub{github.login ? ` As ${github.login}` : ""}.{" "}
                          <button className="link" onClick={onSignOutGithub}>
                            Use a Different Account
                          </button>
                        </p>
                        <label className="field">
                          <span className="field-label">Search Repositories</span>
                          <input
                            type="text"
                            placeholder="Filter By Name"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                          />
                        </label>
                        {repos === null && !reposLoading && (
                          <button onClick={onListRepos}>Retry Loading Repositories</button>
                        )}
                        {reposLoading && <p className="field-note">Loading Your Repositories...</p>}
                        {repos !== null && !reposLoading && (
                          shown.length === 0 ? (
                            <p className="field-note">No Repositories Match.</p>
                          ) : (
                            <>
                              <ul className="ws-repos">
                                {shown.map((r) => (
                                  <li key={r.fullName}>
                                    <button className="ws-repo" onClick={() => onConnectGithub(r.fullName)}>
                                      <span className="ws-repo-name">{r.fullName}</span>
                                      {r.private && <span className="ws-repo-tag">Private</span>}
                                      {r.defaultBranch && (
                                        <span className="ws-repo-branch">{r.defaultBranch}</span>
                                      )}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                              {filtered.length > 50 && (
                                <p className="field-note">
                                  Showing the first 50. Use the search box to narrow it down.
                                </p>
                              )}
                            </>
                          )
                        )}
                        <details className="ws-manual">
                          <summary>Enter a Repository By Name Instead</summary>
                          <label className="field">
                            <span className="field-label">Repository</span>
                            <input
                              type="text"
                              placeholder="owner/repo"
                              maxLength={140}
                              value={repo}
                              onChange={(e) => setRepo(e.target.value)}
                            />
                          </label>
                          <p className="field-note">
                            Add a branch with owner/repo@branch. Defaults to the
                            repository's default branch.
                          </p>
                          <button
                            className="primary"
                            disabled={repo.trim().length === 0}
                            onClick={() => onConnectGithub(repo.trim())}
                          >
                            Connect Repository
                          </button>
                        </details>
                      </>
                    );
                  })()
                ) : (
                  // No OAuth, but the GitHub App is configured — the original
                  // install-flow path, unchanged.
                  <>
                    <p className="field-note">
                      Connect a repository instead of a folder. Works in any
                      browser, and the agent's changes arrive as a pull request
                      rather than edits on someone's machine.
                    </p>
                    <label className="field">
                      <span className="field-label">Repository</span>
                      <input
                        type="text"
                        placeholder="owner/repo"
                        maxLength={140}
                        value={repo}
                        onChange={(e) => setRepo(e.target.value)}
                      />
                    </label>
                    <p className="field-note">
                      Add a branch with owner/repo@branch. Defaults to the
                      repository's default branch.
                    </p>
                    <button
                      className="primary"
                      disabled={repo.trim().length === 0}
                      onClick={() => onConnectGithub(repo.trim())}
                    >
                      Connect repository
                    </button>
                    <p className="field-note">
                      GitHub will ask you to choose which repositories to
                      install on. Nothing else in the room can see them.
                    </p>
                  </>
                )}
              </section>
            </div>
          ) : (
            <section>
              <p className="field-note">
                Connected: <strong>{workspace.label}</strong> ·{" "}
                {workspace.online ? "Online" : "Offline"}
              </p>
              <p className="field-note">
                {canWrite ? "The agent can propose changes" : "Read-only"}
              </p>
              {!canWrite && (
                <p className="field-warn">
                  Shared read-only. Disconnect and reconnect with edits
                  allowed to change that.
                </p>
              )}
              <button onClick={onDetach}>Disconnect</button>
              {workspace.kind === "local" && !hosting && (
                <p className="field-warn">
                  This tab isn't serving files. The member who connected
                  the folder has to have it open.
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
