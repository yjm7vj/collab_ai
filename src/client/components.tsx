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
  optionTally,
  tally,
  type AgentBlock,
  type Entry,
  type GithubRepo,
  type GithubRepoSource,
  type GithubStatus,
  type InviteSummary,
  type MemberSummary,
  type DocumentRevision,
  type DecisionRecord,
  type Grant,
  grantIsLive,
  type PendingTool,
  type Presence as PresenceUser,
  type Vote,
  type WorkerStatus,
} from "../shared/protocol";
import { inlineMarkdown } from "./markdown";
import type { WorkspaceInfo } from "../shared/workspace";
import type { FsRequest, FsResponse } from "../shared/workspace";
import type { ProjectInviteRole, ProjectInviteSummary } from "../shared/project-invites";
import { IdePanel } from "./IdePanel";
import { modelInfo, type CostLedger, type RoomSettings } from "../shared/models";
import { contextUsage } from "../shared/context";
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
  ask_room: "Ask The Room",
  mcp: "MCP Server Tools",
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
 * Live main-prompt usage against the room's configured limit, plus running spend.
 * The count comes from API usage and is recounted after compaction.
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
  const usage = contextUsage(context.tokens, settings.context.maxContextTokens);
  const near = usage.percent >= 80;

  const title =
    `${usage.used.toLocaleString()} tokens used across ${context.messages} messages` +
    (usage.available !== null
      ? ` · ${usage.available.toLocaleString()} available before compaction`
      : " · no token limit") +
    (settings.context.compactAfterMessages > 0
      ? ` or ${settings.context.compactAfterMessages} messages`
      : "");

  return (
    <div className="gauge" title={title}>
      <div className="gauge-track" aria-hidden>
        <div
          className={`gauge-fill ${near ? "gauge-hot" : ""}`}
          style={{ transform: `translateX(-${100 - usage.percent}%)` }}
        />
      </div>
      <span className="gauge-text">
        <span className="gauge-token-count">
          {usage.limit > 0
            ? `${usage.used.toLocaleString()} / ${usage.limit.toLocaleString()} tokens`
            : `${usage.used.toLocaleString()} tokens`}
        </span>
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
  projectInvite = false,
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
  projectInvite?: boolean;
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
          {projectInvite ? "You've been invited to a project." : "You've been invited to a room."}
          <br />
          {projectInvite ? "Choose the rooms you have access to." : `Room ${roomId.slice(0, 6)}...`}
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
          {busy ? "Joining..." : projectInvite ? "Join Project" : "Join Room"}
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

// Renaming happens in the row itself: the title turns into an input, Enter or
// a click away commits, Escape reverts. Names get the same trim and 42-character
// clamp that creating one does, and an empty name reverts instead of saving.
function InlineRename({
  value,
  label,
  onCommit,
  onCancel,
}: {
  value: string;
  label: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const settled = useRef(false);

  const settle = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const name = draft.trim().slice(0, 42);
    if (commit && name) onCommit(name);
    else onCancel();
  };

  return (
    <form
      className="side-rename-form"
      onSubmit={(e) => {
        e.preventDefault();
        settle(true);
      }}
    >
      <input
        autoFocus
        value={draft}
        maxLength={42}
        aria-label={label}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            settle(true);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            settle(false);
          }
        }}
        onBlur={() => settle(true)}
      />
    </form>
  );
}

/**
 * Which projects are collapsed, per browser rather than per room.
 *
 * This is a view preference, not shared state: it says nothing about the
 * project itself, so it stays out of the synced snapshot and lives beside the
 * other `collab_ai:` keys instead. Reads and writes are wrapped because a
 * browser with site data blocked throws on access rather than returning null,
 * and a sidebar that cannot remember a caret is still a working sidebar.
 */
const COLLAPSED_PROJECTS_KEY = "collab_ai:projects-collapsed";

function storedCollapsedProjects(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function persistCollapsedProjects(collapsed: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* storage unavailable — the collapse still works for this session */
  }
}

export function SidePane({
  activeRoomId,
  busy,
  open,
  onToggle,
  projects,
  rooms,
  onCreateRoom,
  onCreateProject,
  onRenameProject,
  onOpenRoom,
  onRenameRoom,
  onCopyRoomLink,
  onArchiveRoom,
  onRestoreRoom,
  onDeleteRoom,
  onArchiveProject,
  onRestoreProject,
  onDeleteProject,
  onInviteProject,
}: {
  activeRoomId?: string;
  busy: boolean;
  /**
   * Whether the rooms list is showing. It always is on a wide screen — the
   * pane is a column there and this is ignored. On a phone the list is a
   * drawer over the room, and this is what opens it.
   */
  open: boolean;
  onToggle: () => void;
  projects: SideProject[];
  rooms: SideRoom[];
  onCreateRoom: (projectId?: string) => void;
  onCreateProject: (name: string) => void;
  onRenameProject: (projectId: string, name: string) => void;
  onOpenRoom: (roomId: string) => void;
  onRenameRoom: (roomId: string, label: string) => void;
  onCopyRoomLink: (roomId: string) => void;
  onArchiveRoom: (roomId: string) => void;
  onRestoreRoom: (roomId: string) => void;
  onDeleteRoom: (roomId: string) => void;
  onArchiveProject: (projectId: string) => void;
  onRestoreProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onInviteProject: (project: SideProject) => void;
}) {
  const [addingProject, setAddingProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [openProjectMenu, setOpenProjectMenu] = useState<string | null>(null);
  const [renamingRoom, setRenamingRoom] = useState<string | null>(null);
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(storedCollapsedProjects);
  const openProjectActionsRef = useRef<HTMLDivElement | null>(null);
  const archivedRooms = [
    ...rooms.filter((room) => room.archived),
    ...projects.flatMap((project) => project.rooms.filter((room) => room.archived)),
  ];

  useEffect(() => {
    if (!openProjectMenu) return;
    const closeWhenOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !openProjectActionsRef.current?.contains(target)) {
        setOpenProjectMenu(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenProjectMenu(null);
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openProjectMenu]);

  const toggleProject = (projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (!next.delete(projectId)) next.add(projectId);
      persistCollapsedProjects(next);
      return next;
    });
  };

  /**
   * Opening a room reveals it. Without this, following an invite or a copied
   * link into a room inside a project someone collapsed weeks ago lands them
   * in a conversation whose own row is hidden behind a caret, with the sidebar
   * showing nothing selected.
   *
   * It fires once per room actually opened, not once per render. `projects` is
   * rebuilt on every sidebar sync, so an effect that merely depended on it
   * would re-expand the project holding the current room seconds after someone
   * deliberately collapsed it — the caret would not stay shut. The ref is only
   * marked once the room's project is known, so a sync that has not delivered
   * the projects yet leaves the reveal owed rather than spent.
   */
  const revealedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeRoomId || revealedFor.current === activeRoomId) return;
    const owner = projects.find((project) =>
      project.rooms.some((room) => room.roomId === activeRoomId),
    );
    if (!owner) return;
    revealedFor.current = activeRoomId;
    setCollapsedProjects((prev) => {
      if (!prev.has(owner.id)) return prev;
      const next = new Set(prev);
      next.delete(owner.id);
      persistCollapsedProjects(next);
      return next;
    });
  }, [activeRoomId, projects]);

  const submitProject = () => {
    const name = projectName.trim().slice(0, 42);
    if (!name) return;
    onCreateProject(name);
    setProjectName("");
    setAddingProject(false);
  };

  const commitRoomRename = (room: SideRoom, label: string) => {
    setRenamingRoom(null);
    if (label !== room.label) onRenameRoom(room.roomId, label);
  };

  const commitProjectRename = (project: SideProject, name: string) => {
    setRenamingProject(null);
    if (name !== project.name) onRenameProject(project.id, name);
  };

  return (
    <aside
      className="side-pane"
      data-open={open ? "true" : "false"}
      aria-label="Workspace navigation"
    >
      <div className="side-head">
        <button
          type="button"
          className="side-drawer-toggle"
          aria-expanded={open}
          aria-controls="side-nav"
          aria-label={open ? "Hide rooms and projects" : "Show rooms and projects"}
          onClick={onToggle}
        >
          <span aria-hidden="true">{open ? "✕" : "☰"}</span>
        </button>
        <LogoMark />
        <div className="side-title">Huddle.AI</div>
      </div>

      <nav className="side-scroll" id="side-nav" aria-label="Projects">
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
                  {renamingRoom === room.roomId ? (
                    <InlineRename
                      value={room.label}
                      label="Room name"
                      onCommit={(label) => commitRoomRename(room, label)}
                      onCancel={() => setRenamingRoom(null)}
                    />
                  ) : (
                    <>
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
                        onClick={() => setRenamingRoom(room.roomId)}
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
                    </>
                  )}
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
            projects.filter((project) => !project.archived).map((project) => {
              const openRooms = project.rooms.filter((room) => !room.archived);
              const collapsed = collapsedProjects.has(project.id);
              const roomsId = `project-rooms-${project.id}`;
              return (
              <div className="side-project" key={project.id}>
                <div className="side-project-head">
                  {renamingProject === project.id ? (
                    <>
                      <span className="side-folder" aria-hidden="true" />
                      <InlineRename
                        value={project.name}
                        label="Project name"
                        onCommit={(name) => commitProjectRename(project, name)}
                        onCancel={() => setRenamingProject(null)}
                      />
                    </>
                  ) : (
                    <button
                      type="button"
                      className="side-project-toggle"
                      onClick={() => toggleProject(project.id)}
                      aria-expanded={!collapsed}
                      aria-controls={roomsId}
                    >
                      <span className="disclosure" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
                      <span className="side-folder" aria-hidden="true" />
                      <span className="side-project-name">{project.name}</span>
                      {/* Collapsed, the caret is the only thing left saying this
                          project has anything in it — so it says how much. */}
                      {collapsed && openRooms.length > 0 && (
                        <span className="side-project-count">{openRooms.length}</span>
                      )}
                    </button>
                  )}
                  <div
                    className="side-project-actions"
                    ref={openProjectMenu === project.id ? openProjectActionsRef : undefined}
                  >
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
                      onClick={() => setOpenProjectMenu((open) => (open === project.id ? null : project.id))}
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
                          setRenamingProject(project.id);
                        }}>Rename project</button>
                        <button type="button" role="menuitem" onClick={() => {
                          setOpenProjectMenu(null);
                          onInviteProject(project);
                        }}>Invite to project</button>
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
                <div className="side-channels" id={roomsId} hidden={collapsed}>
                  {openRooms.map((room) => (
                    <div className="side-room-row" key={room.roomId}>
                      {renamingRoom === room.roomId ? (
                        <InlineRename
                          value={room.label}
                          label="Room name"
                          onCommit={(label) => commitRoomRename(room, label)}
                          onCancel={() => setRenamingRoom(null)}
                        />
                      ) : (
                        <>
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
                            onClick={() => setRenamingRoom(room.roomId)}
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
                        </>
                      )}
                    </div>
                  ))}
                  {openRooms.length === 0 && (
                    <span className="side-item-detail side-project-empty">No rooms yet · use + to add one</span>
                  )}
                  {project.workspace.label && (
                    <span className="side-item-detail side-project-workspace">
                      Workspace · {project.workspace.label}
                    </span>
                  )}
                </div>
              </div>
              );
            })
          )}
        </section>

        {archivedRooms.length > 0 && (
          <section className="side-section">
            <div className="side-section-label">Archived</div>
            <div className="side-room-list">
              {archivedRooms.map((room) => (
                <div className="side-room-row" key={room.roomId}>
                  {renamingRoom === room.roomId ? (
                    <InlineRename
                      value={room.label}
                      label="Room name"
                      onCommit={(label) => commitRoomRename(room, label)}
                      onCancel={() => setRenamingRoom(null)}
                    />
                  ) : (
                    <>
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
                        onClick={() => setRenamingRoom(room.roomId)}
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
                    </>
                  )}
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

export function ProjectInvitePanel({
  project,
  onCreate,
  onList,
  onUpdate,
  onRevoke,
  onClose,
}: {
  project: SideProject;
  onCreate: (rooms: string[], role: ProjectInviteRole) => Promise<ProjectInviteSummary | null>;
  onList: () => Promise<ProjectInviteSummary[]>;
  onUpdate: (code: string, rooms: string[], role: ProjectInviteRole) => Promise<ProjectInviteSummary | null>;
  onRevoke: (code: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const availableRooms = project.rooms.filter((room) => !room.archived);
  const [selectedRooms, setSelectedRooms] = useState<string[]>(availableRooms.map((room) => room.roomId));
  const [role, setRole] = useState<ProjectInviteRole>("viewer");
  const [editing, setEditing] = useState<string | null>(null);
  const [invites, setInvites] = useState<ProjectInviteSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try { setInvites(await onList()); } catch { setError("Could not load project invites."); }
    setBusy(false);
  };
  useEffect(() => { void refresh(); }, []);

  const toggleRoom = (roomId: string) => setSelectedRooms((current) => current.includes(roomId) ? current.filter((id) => id !== roomId) : [...current, roomId]);
  const beginCreate = () => {
    setEditing(null);
    setRole("viewer");
    setSelectedRooms(availableRooms.map((room) => room.roomId));
    setCreatedLink(null);
    setError(null);
  };
  const editInvite = (invite: ProjectInviteSummary) => {
    setEditing(invite.code);
    setRole(invite.role);
    setSelectedRooms(invite.rooms.map((room) => room.roomId));
    setCreatedLink(null);
    setError(null);
  };
  const submit = async () => {
    if (selectedRooms.length === 0) { setError("Select at least one room."); return; }
    setBusy(true);
    setError(null);
    const result = editing ? await onUpdate(editing, selectedRooms, role) : await onCreate(selectedRooms, role);
    if (!result) setError("The project invite could not be saved.");
    else {
      setInvites((current) => editing ? current.map((invite) => invite.code === result.code ? result : invite) : [result, ...current]);
      if (!editing) setCreatedLink(`${location.origin}/#/p/${result.code}`);
      setEditing(null);
    }
    setBusy(false);
  };
  const revoke = async (code: string) => {
    if (!window.confirm("Revoke this project invite? Existing members will keep their access.")) return;
    setBusy(true);
    if (await onRevoke(code)) setInvites((current) => current.map((invite) => invite.code === code ? { ...invite, revoked: true } : invite));
    else setError("The project invite could not be revoked.");
    setBusy(false);
  };
  const copy = (code: string) => { void navigator.clipboard.writeText(`${location.origin}/#/p/${code}`); };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal project-invite-modal" role="dialog" aria-label={`Invite to ${project.name}`} onClick={(event) => event.stopPropagation()}>
        <header className="modal-head"><div><h2>Invite to {project.name}</h2><p className="field-note">Choose the rooms this link can open. You can edit or revoke it later.</p></div><button className="icon" onClick={onClose} aria-label="Close">✕</button></header>
        <div className="modal-body project-invite-body">
          {availableRooms.length === 0 ? <div className="side-empty"><strong>Add a room before inviting someone.</strong><span>Project invites need at least one room to grant access to.</span></div> : <>
            <section className="project-invite-form">
              <div className="field-label">Rooms this invite can access</div>
              <div className="project-invite-rooms">{availableRooms.map((room) => <label key={room.roomId}><input type="checkbox" checked={selectedRooms.includes(room.roomId)} onChange={() => toggleRoom(room.roomId)} />{room.label}</label>)}</div>
              <label className="field-label">Access level<select value={role} onChange={(event) => setRole(event.target.value as ProjectInviteRole)}><option value="viewer">Viewer</option><option value="editor">Editor</option></select></label>
              <div className="side-form-actions"><button type="button" onClick={beginCreate} disabled={busy}>New invite</button><button type="button" className="primary" onClick={() => void submit()} disabled={busy || selectedRooms.length === 0}>{busy ? "Saving..." : editing ? "Save permissions" : "Create invite"}</button></div>
              {createdLink && <div className="project-invite-link"><span>{createdLink}</span><button type="button" onClick={() => copy(createdLink.slice(createdLink.lastIndexOf("/") + 1))}>Copy link</button></div>}
              {error && <p className="form-error">{error}</p>}
            </section>
            <section><div className="field-label">Existing project invites</div>{invites.length === 0 && !busy && <p className="field-note">No invites created yet.</p>}{invites.map((invite) => <div className={`project-invite-row ${invite.revoked ? "revoked" : ""}`} key={invite.code}><div><strong>{invite.revoked ? "Revoked invite" : `${invite.role} access`}</strong><span>{invite.rooms.map((room) => room.label).join(", ")}</span></div><div className="project-invite-actions"><button type="button" onClick={() => copy(invite.code)} disabled={invite.revoked}>Copy link</button><button type="button" onClick={() => editInvite(invite)} disabled={invite.revoked}>Edit</button><button type="button" onClick={() => void revoke(invite.code)} disabled={invite.revoked || busy}>Revoke</button></div></div>)}</section>
          </>}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- presence */

export function Presence({ users, me }: { users: PresenceUser[]; me: string | null }) {
  return (
    <div className="presence" title={`${users.length} online in the room`}>
      {users.map((u) => (
        <span
          key={u.uid}
          className={`presence-user ${u.uid === me ? "presence-user-me" : ""}`}
          title={`${u.name} · ${u.role}`}
        >
          <span className="presence-avatar" style={{ borderColor: u.color }}>
            {u.avatar ? <img src={u.avatar} alt="" referrerPolicy="no-referrer" /> : u.name.slice(0, 1).toUpperCase()}
            <span className="presence-online" aria-label="Online" />
          </span>
          <span className="presence-name">{u.name}</span>
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
  working = false,
  toolDisplay = "compact",
}: {
  entries: Entry[];
  me: string | null;
  /** True while the agent is mid-turn, so the last entry may still fill in. */
  working?: boolean;
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
      {entries.map((entry, i) => (
        <EntryView
          key={entry.id}
          entry={entry}
          me={me}
          live={working && i === entries.length - 1}
          toolDisplay={toolDisplay}
        />
      ))}
    </div>
  );
}

const EntryView = memo(function EntryView({
  entry,
  me,
  live,
  toolDisplay,
}: {
  entry: Entry;
  me: string | null;
  /** This is the entry the agent is still writing into. */
  live: boolean;
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
        {/* Only while the turn is actually running: a turn that ended without
            producing a block — interrupted, or failed before the model spoke —
            would otherwise leave these dots pulsing for good. */}
        {entry.blocks.length === 0 && live && <span className="dots" aria-label="Working" />}
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
    return <div className="text">{inlineMarkdown(block.text)}</div>;
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
        <span className="disclosure">{open ? "▾" : "▸"}</span>
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
      {open && <div className="thinking-body">{inlineMarkdown(block.text)}</div>}
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
        <span className="disclosure">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{toolLabel(block.name)}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        <span className={`pip pip-${block.status}`} aria-hidden="true" />
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

function ChangeDetails({ name, input }: { name: string; input: Record<string, unknown> }) {
  const path = typeof input.path === "string" ? input.path : "";
  const hasPath = name === "write_file" || name === "edit_file" || name === "delete_file";
  const oldText = String(input.old_text ?? "");
  const newText = String(input.new_text ?? "");

  if (name === "edit_doc" || name === "edit_file") {
    return (
      <div className="change-details">
        {hasPath && <div className="change-path">File: <code>{path}</code></div>}
        <div className="diff">
          <div className="diff-row diff-old">
            <span>−</span>
            <pre>{truncate(oldText, 900)}</pre>
          </div>
          <div className="diff-row diff-new">
            <span>+</span>
            <pre>{truncate(newText, 900)}</pre>
          </div>
        </div>
      </div>
    );
  }

  if (name === "write_doc" || name === "write_file") {
    return (
      <div className="change-details">
        {hasPath && <div className="change-path">File: <code>{path}</code></div>}
        <div className="change-label">Complete replacement</div>
        <pre className="proposed">{truncate(String(input.content ?? ""), 1400)}</pre>
      </div>
    );
  }

  if (name === "delete_file") {
    return <div className="change-details change-delete">File to permanently delete: <code>{path}</code></div>;
  }

  return null;
}

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

      {input && <ChangeDetails name={pending.name} input={input} />}

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
        {/* A third way to approve: this call, and the next few like it. Sits
            with the other votes rather than in a menu, because it is a vote —
            it needs the same number of people as approving once does. */}
        <button
          className={`vote grant ${mine === "grant" ? "cast" : ""}`}
          onClick={() => onVote(pending.toolUseId, "grant")}
          disabled={!canDecide}
          title={`Approve, and stop asking for ${pending.name} for a short while`}
        >
          Approve &amp; Stop Asking
          <span className="count">
            {counts.grant}/{pending.threshold}
          </span>
        </button>
        {mine && (
          <span className="voted">
            {mine === "grant"
              ? "You Voted To Approve And Stop Asking"
              : `You Voted To ${titleCaseWords(mine)}`}
          </span>
        )}
      </div>
      {!canDecide && (
        <div className="hint redacted" style={{ fontStyle: "italic" }}>
          You can't see this file's contents, so an owner or admin has to decide this one.
        </div>
      )}
    </div>
  );
}

/** A question the agent put to the room, one button per option. */
export function ChoiceCard({
  pending,
  me,
  onVote,
  canDecide,
}: {
  pending: PendingTool;
  me: string | null;
  onVote: (toolUseId: string, optionId: string) => void;
  canDecide: boolean;
}) {
  const options = pending.options ?? [];
  const counts = optionTally(pending);
  const mine = me ? pending.votes[me] : undefined;
  const input = pending.input as { question?: string } | null;
  const mineLabel = options.find((o) => o.id === mine)?.label;

  return (
    <div className="approval choice">
      <div className="approval-top">
        <span className="approval-tool">{toolLabel(pending.name)}</span>
      </div>
      <div className="choice-question">{String(input?.question ?? pending.summary)}</div>
      <div className="approval-actions choice-options">
        {options.map((opt) => (
          <button
            key={opt.id}
            className={`vote option ${mine === opt.id ? "cast" : ""}`}
            onClick={() => onVote(pending.toolUseId, opt.id)}
            disabled={!canDecide}
          >
            <span className="option-text">
              <span className="option-label">{opt.label}</span>
              {opt.description && <span className="option-desc">{opt.description}</span>}
            </span>
            <span className="count">
              {counts[opt.id] ?? 0}/{pending.threshold}
            </span>
          </button>
        ))}
      </div>
      {mineLabel && <span className="voted">You Voted For {mineLabel}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ doc */

export function DocPanel({
  doc,
  revision,
  canViewHistory,
  onHistory,
  onClose,
}: {
  doc: string;
  revision: number;
  canViewHistory?: boolean;
  onHistory?: () => void;
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
        {canViewHistory && onHistory && (
          <button type="button" className="doc-history" onClick={onHistory}>
            History
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

export function RevisionHistoryPanel({
  revisions,
  userName,
  isOwn,
  onClose,
}: {
  revisions: DocumentRevision[];
  userName: string;
  isOwn: boolean;
  onClose: () => void;
}) {
  return (
    <div className="modal-scrim" onClick={onClose}>
      <section className="modal revision-panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>Revision history</h2>
            <p className="hint">{isOwn ? "Your shared-document snapshots." : `Snapshots attributed to ${userName}.`}</p>
          </div>
          <button type="button" className="icon" onClick={onClose} aria-label="Close revision history">×</button>
        </div>
        {revisions.length === 0 ? (
          <div className="empty"><p>No revisions yet.</p></div>
        ) : (
          <div className="revision-list">
            {revisions.map((item) => (
              <details key={item.revision} className="revision-item">
                <summary>
                  <span>Rev {item.revision}</span>
                  <span className="hint">{item.author} · {new Date(item.ts).toLocaleString()}</span>
                </summary>
                <pre className="revision-body">{item.doc || "(empty document)"}</pre>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * What the agent may currently do without asking.
 *
 * Always on screen while any grant is live, next to the conversation rather
 * than filed in a settings panel. The whole safety argument for a grant is
 * that the room can see it standing and take it back in one click — a grant
 * you have to go looking for is just a permission with extra steps.
 */
export function GrantStrip({
  grants,
  canRevoke,
  onRevoke,
}: {
  grants: Grant[];
  canRevoke: boolean;
  onRevoke: (id: string) => void;
}) {
  // Re-render on a timer so "4 min left" is true rather than true-when-loaded.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 20_000);
    return () => clearInterval(timer);
  }, []);

  const now = Date.now();
  const live = grants.filter((g) => grantIsLive(g, now));
  if (live.length === 0) return null;

  return (
    <div className="grants" role="status">
      <span className="grants-head">Running without asking</span>
      {live.map((g) => {
        const minutes = Math.max(1, Math.round((g.expiresAt - now) / 60000));
        return (
          <span className="grant" key={g.id}>
            <code>{g.tool}</code>
            <span className="hint">
              {minutes} min left · {g.maxUses - g.usedCount} of {g.maxUses} uses
            </span>
            {canRevoke && (
              <button type="button" onClick={() => onRevoke(g.id)}>
                Take back
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------- the consent record */

/**
 * Who authorised what the agent did.
 *
 * Deliberately not a filtered view: an action that ran unattended sits in the
 * same list as one the room voted through, because the honest answer to "who
 * approved this?" is sometimes "nobody was asked", and a record that hid those
 * would be worse than no record. The counts at the top say how the balance
 * falls, which is the number worth watching.
 */
export function ConsentRecordPanel({
  decisions,
  onClose,
}: {
  decisions: DecisionRecord[];
  onClose: () => void;
}) {
  const counts = {
    approved: decisions.filter((d) => d.verdict === "approved").length,
    denied: decisions.filter((d) => d.verdict === "denied").length,
    unattended: decisions.filter((d) => d.verdict === "unattended").length,
  };

  const exportRecord = () => {
    const blob = new Blob([JSON.stringify(decisions, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `consent-record-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <section className="modal consent-panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>Consent record</h2>
            <p className="hint">
              Every action that could change something, and the authority it ran on.
            </p>
          </div>
          <button type="button" className="icon" onClick={onClose} aria-label="Close consent record">×</button>
        </div>

        <div className="consent-counts">
          <span className="consent-count"><strong>{counts.approved}</strong> approved</span>
          <span className="consent-count"><strong>{counts.denied}</strong> refused</span>
          <span className={`consent-count ${counts.unattended > 0 ? "consent-count-warn" : ""}`}>
            <strong>{counts.unattended}</strong> ran unattended
          </span>
          {decisions.length > 0 && (
            <button type="button" onClick={exportRecord}>Export</button>
          )}
        </div>

        {decisions.length === 0 ? (
          <div className="empty">
            <p>Nothing yet. Actions appear here once the agent proposes something.</p>
          </div>
        ) : (
          <div className="consent-list">
            {decisions.map((d) => (
              <details key={d.id} className={`consent-item consent-${d.verdict}`}>
                <summary>
                  <span className={`consent-verdict consent-verdict-${d.verdict}`}>
                    {d.verdict === "approved" ? "Approved" : d.verdict === "denied" ? "Refused" : "Unattended"}
                  </span>
                  <span className="consent-summary">{d.summary}</span>
                  <span className="hint">{new Date(d.ts).toLocaleString()}</span>
                </summary>
                <div className="consent-detail">
                  <div className="hint">
                    Asked by {d.askedBy} · tool <code>{d.tool}</code> · room in {d.policyMode} mode
                  </div>
                  {d.verdict === "unattended" ? (
                    <div className="hint">
                      No vote was taken — the room's permissions allowed this without asking.
                    </div>
                  ) : (
                    <div className="consent-votes">
                      {d.votes.length === 0 ? (
                        <span className="hint">No votes recorded.</span>
                      ) : (
                        d.votes.map((v) => (
                          <span key={v.uid} className={`consent-vote consent-vote-${v.vote}`}>
                            {v.name} · {v.vote}
                          </span>
                        ))
                      )}
                      <span className="hint">{d.threshold} needed</span>
                    </div>
                  )}
                  <pre className="consent-args">{d.args}</pre>
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
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
                      className={m.online ? "pip pip-ok" : "pip"}
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
 * room's current workspace status and the code editor for that workspace.
 */
export function WorkspacePanel({
  workspace,
  supported,
  hosting,
  canWrite,
  github,
  repos,
  reposLoading,
  repoSource,
  onAttach,
  onDetach,
  onConnectGithub,
  onAuthGithub,
  onListRepos,
  onSignOutGithub,
  onRequest,
  canEdit,
  initialView = "connections",
  onClose,
}: {
  workspace: WorkspaceInfo;
  supported: boolean;
  hosting: boolean;
  canWrite: boolean | null;
  github: GithubStatus;
  repos: GithubRepo[] | null;
  reposLoading: boolean;
  repoSource: GithubRepoSource | null;
  onAttach: (allowWrites: boolean) => void;
  onDetach: () => void;
  onConnectGithub: (repo: string) => void;
  onAuthGithub: () => void;
  onListRepos: () => void;
  onSignOutGithub: () => void;
  onRequest: (req: FsRequest) => Promise<FsResponse>;
  canEdit: boolean;
  initialView?: WorkspaceView;
  onClose: () => void;
}) {
  const attached = workspace.kind !== "none";
  const [allowWrites, setAllowWrites] = useState(false);
  const [repo, setRepo] = useState("");
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<WorkspaceView>(initialView);

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

  // Write access has three states, and the missing one is not a "no": a
  // repository connected before the app started asking GitHub about it has
  // never been checked, and the chip says exactly that rather than guessing
  // in either direction. Only the two states worth acting on take colour —
  // a healthy connection stays as quiet as every other chip in the app, so
  // the eye lands on the connection that needs something.
  const access =
    canWrite === true
      ? { label: "Can propose changes", chip: "chip" }
      : canWrite === false
        ? { label: "Read-only", chip: "chip chip-warn" }
        : { label: "Write access unchecked", chip: "chip chip-empty" };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className={view === "ide" ? "modal workspace-modal workspace-modal-ide" : "modal workspace-modal"}
        role="dialog"
        aria-label="Workspace"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2>Workspace</h2>
            <p className="field-note">Connect files or edit code in the same workspace.</p>
          </div>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <nav className="workspace-tabs" aria-label="Workspace views">
          <button type="button" className={view === "connections" ? "workspace-tab active" : "workspace-tab"} onClick={() => setView("connections")}>Connections</button>
          <button type="button" className={view === "ide" ? "workspace-tab active" : "workspace-tab"} onClick={() => setView("ide")}>IDE</button>
        </nav>

        {view === "ide" ? <IdePanel embedded workspace={workspace} canEdit={canEdit} onRequest={onRequest} onClose={onClose} onOpenConnections={() => setView("connections")} /> : <div className="modal-body">
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
                ) : github.app && !github.installed && !github.authorized ? (
                  // GitHub App installation is preferred whenever the app is
                  // configured — but only while nothing is authorised yet.
                  // Preferring it unconditionally stranded any deployment
                  // that has both configured and an App nobody can install:
                  // installing on a repository needs admin on it, so a
                  // collaborator with push and no more would authorise
                  // successfully and still be shown this button, with the
                  // repositories they had just granted access to nowhere in
                  // sight. An authorization that exists is never worse than
                  // one being asked for.
                  <>
                    <p className="field-note">
                      Connect the HuddleAI GitHub App to choose from your private and public repositories.
                      If it is already installed, HuddleAI will detect it automatically. Otherwise, GitHub will ask
                      you to select an account or organization and choose All repositories or specific ones.
                    </p>
                    <button className="primary" onClick={onAuthGithub}>Connect GitHub App</button>
                    <p className="field-note">
                      The app uses the installation only for repositories you grant it, and changes still require room approval.
                    </p>
                  </>
                ) : github.oauth && !github.authorized ? (
                  // OAuth is configured but nobody here has authorised yet —
                  // one button starts the round trip. Reached now whether or
                  // not an App is also configured: the branch above hands
                  // over once it has an uninstalled App and no
                  // authorization, so this is the offer that remains.
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
                              {repoSource && (
                                <p className="field-note">
                                  {repoSource.via === "installations" ? (
                                    <>
                                      Found through {repoSource.accounts?.length ?? 0} GitHub App
                                      {(repoSource.accounts?.length ?? 0) === 1 ? " installation" : " installations"}
                                      {repoSource.accounts && repoSource.accounts.length > 0
                                        ? ` (${repoSource.accounts.join(", ")})`
                                        : ""}
                                      . A private repository owned by someone else appears only once
                                      they have installed this app and granted it that repository.
                                      {repoSource.unreadable
                                        ? ` ${repoSource.unreadable} installation(s) refused, and may be hiding more.`
                                        : ""}
                                    </>
                                  ) : repoSource.via === "account" ? (
                                    <>
                                      Listed from your account directly, because this server could not
                                      enumerate app installations{repoSource.note ? `: ${repoSource.note}` : ""}.
                                    </>
                                  ) : (
                                    <>
                                      Listed through this room's single app installation, which sees only
                                      the repositories that one installation was granted.
                                    </>
                                  )}
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
            <section className="ws-connected">
              <div className="ws-connection">
                <p className="ws-connection-head">
                  <span
                    className={workspace.online ? "pip pip-ok" : "pip"}
                    aria-hidden="true"
                  />
                  <span className="ws-connection-name" title={workspace.label}>
                    {workspace.label}
                  </span>
                  <span className={access.chip}>{access.label}</span>
                </p>
                <p className="ws-connection-meta">
                  {workspace.kind === "github" ? "GitHub repository" : "Local folder"}
                  {" · "}
                  {workspace.online ? "Online" : "Offline"}
                </p>
              </div>
              {workspace.kind === "local" && !hosting && (
                <p className="field-warn">
                  This tab isn't serving files. The member who connected
                  the folder has to have it open.
                </p>
              )}
              {canWrite === false && workspace.kind === "local" && (
                <p className="field-warn">
                  Shared read-only. Disconnect and reconnect with edits
                  allowed to change that.
                </p>
              )}
              {canWrite === false && workspace.kind === "github" && (
                <p className="field-warn">
                  GitHub reports no write access for this connection. The agent
                  can read the repository, but its edits will be refused. Check
                  that the connected account can push, and that a GitHub App
                  installation grants Contents and Pull requests write access.
                </p>
              )}
              {canWrite === null && workspace.kind === "github" && (
                <p className="field-note">
                  This repository was connected before the app started asking
                  GitHub about write access, so nobody has checked. Disconnect
                  and reconnect to find out rather than discovering it when an
                  edit is refused.
                </p>
              )}
              <button className="ws-disconnect" onClick={onDetach}>Disconnect</button>
            </section>
          )}
        </div>}
      </div>
    </div>
  );
}

export type WorkspaceView = "connections" | "ide";

export function WorkspaceActions({
  visible,
  onWorkspace,
  onIde,
}: {
  visible: boolean;
  onWorkspace: () => void;
  onIde: () => void;
}) {
  if (!visible) return null;
  return (
    <>
      <button type="button" className="chat-action" onClick={onWorkspace}>
        Workspace
      </button>
      <button type="button" className="chat-action" onClick={onIde}>
        IDE
      </button>
    </>
  );
}
