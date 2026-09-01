import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";

import {
  INITIAL_ROOM_STATE,
  type ClientMsg,
  type Entry,
  type GithubRepo,
  type InviteSummary,
  type MemberSummary,
  type DocumentRevision,
  type RoomState,
  type ServerMsg,
  type Vote,
} from "../shared/protocol";
import { modelInfo, type RoomSettings } from "../shared/models";
import { delegatesOf, leadOf, type WorkflowGraph } from "../shared/workflow";
import { asRole, can, canSeeFileContents, type Role } from "../shared/access";
import type { AccessPolicy } from "../shared/access";
import {
  ApprovalCard,
  Composer,
  ContextGauge,
  DocPanel,
  InvitePanel,
  MembersPanel,
  PermissionsPanel,
  RevisionHistoryPanel,
  Transcript,
  WorkerStrip,
  WorkspacePanel,
  WorkspaceActions,
  ThemeToggle,
  type ThemeMode,
} from "./components";
import { SettingsPanel } from "./Settings";
import { WorkflowPanel } from "./Workflow";
import {
  ensureReadPermission,
  ensureWritePermission,
  forgetHandle,
  hasWritePermission,
  isFileAccessSupported,
  loadHandle,
  performFsRequest,
  pickDirectory,
  saveHandle,
} from "./workspace";

const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((module) => ({ default: module.TerminalPanel })),
);

/**
 * Everything that needs a live socket to the room. Only ever mounted once a
 * token exists — App is the one that gets us there.
 */
export function RoomView({
  roomId,
  token,
  displayName,
  onDisplayNameChange,
  onSignOut,
  onAccessLost,
  onWorkspaceChange,
  onWorkspaceDetach,
  workspaceKey,
  projectWorkspace,
  theme,
  onToggleTheme,
}: {
  roomId: string;
  token: string;
  displayName: string;
  onDisplayNameChange?: (name: string) => void;
  onSignOut?: () => void;
  onAccessLost: (reason: string) => void;
  onWorkspaceChange: (roomId: string, workspace: RoomState["workspace"]) => void;
  onWorkspaceDetach: (roomId: string) => void;
  /**
   * Which saved folder this room uses: the project's id when the room belongs
   * to one, so every room in the project opens the same folder, and the room's
   * own id when it stands alone.
   */
  workspaceKey: string;
  /** The workspace the room's project carries, or "none" for a lone room. */
  projectWorkspace: RoomState["workspace"];
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  const [state, setState] = useState<RoomState>(INITIAL_ROOM_STATE);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [me, setMe] = useState<string | null>(null);
  // Defaulting to "viewer" before the handshake arrives is deliberate — the UI
  // should start with the fewest powers and gain them, never the reverse.
  const [myRole, setMyRole] = useState<Role>("viewer");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const [showPermissions, setShowPermissions] = useState(false);
  const [showWorkflow, setShowWorkflow] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [showInvites, setShowInvites] = useState(false);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [revisions, setRevisions] = useState<DocumentRevision[]>([]);
  const [revisionUid, setRevisionUid] = useState<string | null>(null);
  const [showRevisionHistory, setShowRevisionHistory] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  // The repository list for the GitHub picker. `null` means "not fetched
  // yet"; an array means fetched, possibly empty.
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [toolDisplay, setToolDisplay] = useState<"hidden" | "compact" | "full">("hidden");
  const [showDocument, setShowDocument] = useState(false);
  // The picked directory handle isn't rendered, so it lives in a ref rather
  // than state — putting it in state would just cause re-renders nothing reads.
  const rootRef = useRef<FileSystemDirectoryHandle | null>(null);
  // Whether this tab can currently answer fs.req itself, i.e. whether rootRef
  // is populated and its permission is (still) granted.
  const [wsReady, setWsReady] = useState(false);
  // The project workspace this room has already offered to connect for itself,
  // so the offer is made once rather than once per render.
  const inheritedRef = useRef<string | null>(null);
  // Whether this room has already given up a workspace it could not host.
  const strandedRef = useRef(false);
  // Whether this room has no saved folder at all — as opposed to one whose
  // permission has lapsed, which is recoverable and must not be torn down.
  const [handleMissing, setHandleMissing] = useState(false);
  // Whether the attached folder currently holds read-write permission. Purely
  // descriptive — the server, not this flag, decides whether a write is ever
  // attempted; it only shapes what the workspace panel tells the user.
  const [canWrite, setCanWrite] = useState(false);

  useEffect(() => {
    if (!showSettingsMenu && !showAccountMenu) return;
    const closeWhenOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node) {
        if (!settingsMenuRef.current?.contains(target)) setShowSettingsMenu(false);
        if (!accountMenuRef.current?.contains(target)) setShowAccountMenu(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowSettingsMenu(false);
        setShowAccountMenu(false);
      }
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [showSettingsMenu, showAccountMenu]);

  // These hide controls the server would refuse anyway; the server is the
  // boundary, this is only so nobody clicks into a refusal.
  const maySpeak = can(myRole, "speak");
  const maySettings = can(myRole, "settings");
  const mayPolicy = can(myRole, "policy");
  const mayVote = can(myRole, "vote");
  const mayInvite = can(myRole, "invite");
  const mayWorkflow = can(myRole, "workflow");
  const mayManage = can(myRole, "manage_members");
  const mayViewRevisions = can(myRole, "view_revisions");

  const applyServerMessage = useCallback((msg: ServerMsg) => {
    switch (msg.t) {
      case "you":
        setMe(msg.uid);
        setMyRole(asRole(msg.role));
        break;
      case "invites":
        setInvites(msg.invites);
        break;
      case "members":
        setMembers(msg.members);
        break;
      case "revisions":
        setRevisions(msg.revisions);
        setRevisionUid(msg.uid);
        setShowRevisionHistory(true);
        break;
      case "history":
        setEntries(msg.entries);
        break;
      case "entry":
        setEntries((prev) =>
          prev.some((e) => e.id === msg.entry.id) ? prev : [...prev, msg.entry],
        );
        break;
      case "patch":
        setEntries((prev) => {
          const i = prev.findIndex((e) => e.id === msg.entry.id);
          if (i === -1) return [...prev, msg.entry];
          const next = prev.slice();
          next[i] = msg.entry;
          return next;
        });
        break;
      case "delta":
        // Replace only the entry that changed; every other entry keeps its
        // identity so memoised rows skip re-rendering on each token.
        setEntries((prev) => {
          const i = prev.findIndex((e) => e.id === msg.entryId);
          if (i === -1) return prev;
          const entry = prev[i]!;
          if (entry.kind !== "agent") return prev;
          const block = entry.blocks[msg.block];
          if (!block || (block.type !== "text" && block.type !== "thinking")) return prev;
          const blocks = entry.blocks.slice();
          blocks[msg.block] = { ...block, text: block.text + msg.text };
          const next = prev.slice();
          next[i] = { ...entry, blocks };
          return next;
        });
        break;
      case "error":
        setError(msg.message);
        // A refusal from the server is still an answer to whatever asked —
        // if that was the repo list, the spinner must not spin forever.
        setReposLoading(false);
        break;
      case "fs.req":
        // applyServerMessage is synchronous but answering a filesystem
        // request is not, so the work happens in a fire-and-forget async
        // closure. The reply carries the same id the room sent, which is
        // how the room matches it back up — nothing here depends on this
        // resolving before the next message is handled.
        void (async () => {
          if (!rootRef.current) {
            send({
              t: "fs.res",
              id: msg.id,
              res: { ok: false, error: "This member isn't hosting a workspace." },
            });
            return;
          }
          const res = await performFsRequest(rootRef.current, msg.req);
          send({ t: "fs.res", id: msg.id, res });
        })();
        break;
      case "github.install":
        // Opened in a new tab rather than navigating away: the room is a live
        // socket and a full navigation would drop it, losing the transcript
        // scroll position and forcing a reconnect for everyone watching.
        window.open(msg.url, "_blank", "noopener,noreferrer");
        break;
      case "github.repos":
        setRepos(msg.repos);
        setReposLoading(false);
        break;
    }
  }, []);

  const agent = useAgent({
    agent: "room",
    name: roomId,
    query: { tk: token },
    onStateUpdate: (s: RoomState) => {
      setState(s);
      onWorkspaceChange(roomId, s.workspace);
    },
    onOpen: () => {
      setConnected(true);
      setError(null);
    },
    onClose: (event: CloseEvent) => {
      setConnected(false);
      // 4401/4403 are the room refusing this token outright — an expired
      // session, or a member who was removed. Reconnecting cannot fix either,
      // so hand it back to App rather than retrying in a loop.
      if (event.code === 4401) onAccessLost("Your session expired. Rejoin to continue.");
      else if (event.code === 4403) onAccessLost("You're no longer a member of this room.");
    },
    onMessage: (event: MessageEvent) => {
      try {
        applyServerMessage(JSON.parse(event.data as string) as ServerMsg);
      } catch {
        /* state-sync frames are handled by the SDK, not us */
      }
    },
  });

  const send = useCallback(
    (msg: ClientMsg) => agent.send(JSON.stringify(msg)),
    [agent],
  );

  const rename = useCallback(
    (n: string) => {
      const trimmed = n.trim().slice(0, 32);
      if (!trimmed) return;
      localStorage.setItem("collab_ai:name", trimmed);
      onDisplayNameChange?.(trimmed);
      send({ t: "rename", name: trimmed });
      setRenaming(false);
    },
    [onDisplayNameChange, send],
  );

  const say = useCallback((text: string) => send({ t: "say", text }), [send]);
  const vote = useCallback(
    (toolUseId: string, v: Vote) => send({ t: "vote", toolUseId, vote: v }),
    [send],
  );
  const interrupt = useCallback(() => send({ t: "interrupt" }), [send]);
  const applySettings = useCallback(
    (s: RoomSettings) => send({ t: "settings", settings: s }),
    [send],
  );
  const applyPolicy = useCallback((p: AccessPolicy) => send({ t: "policy", policy: p }), [send]);
  const applyWorkflow = useCallback(
    (graph: WorkflowGraph, useCustom: boolean) => send({ t: "workflow", graph, useCustom }),
    [send],
  );
  const compactNow = useCallback(() => send({ t: "compact" }), [send]);
  const openRevisionHistory = useCallback((uid: string) => send({ t: "revision.list", uid }), [send]);
  const createInvite = useCallback(
    (role: string, maxUses: number, expiresInHours: number, label: string) =>
      send({ t: "invite.create", role, maxUses, expiresInHours, label }),
    [send],
  );
  const revokeInvite = useCallback(
    (code: string) => send({ t: "invite.revoke", code }),
    [send],
  );
  // Fetched on open rather than kept live, because only owners and admins
  // may see the invite list.
  const openInvites = useCallback(() => {
    setShowInvites(true);
    send({ t: "invite.list" });
  }, [send]);
  const openMembers = useCallback(() => {
    setShowMembers(true);
    send({ t: "member.list" });
  }, [send]);
  const setMemberRole = useCallback(
    (uid: string, role: Role) => send({ t: "member.role", uid, role }),
    [send],
  );
  const removeMember = useCallback((uid: string) => send({ t: "member.remove", uid }), [send]);

  // A stored handle can outlive its permission grant — browsers drop File
  // System Access permissions on things like a profile restart or enough time
  // away, so a handle recovered from IndexedDB is only trusted once its
  // permission is re-confirmed, never assumed from the fact that it was saved.
  useEffect(() => {
    let cancelled = false;
    // A different room asks the inherit question again from scratch, and must
    // not keep hosting the folder the previous one had: the handle below is
    // the only folder this room may serve, and until it loads there is none.
    inheritedRef.current = null;
    rootRef.current = null;
    setWsReady(false);
    setCanWrite(false);
    setHandleMissing(false);
    strandedRef.current = false;
    void (async () => {
      // Rooms that have since joined a project keep the folder they saved
      // under their own id; move it to the project's key on the way past, so
      // the whole project inherits what one room already had.
      let handle = await loadHandle(workspaceKey);
      if (!handle && workspaceKey !== roomId) {
        handle = await loadHandle(roomId);
        if (handle) await saveHandle(workspaceKey, handle);
      }
      if (cancelled) return;
      if (!handle) {
        // A directory can be picked while the IndexedDB lookup above is still
        // in flight. Do not let that stale "missing" result detach the folder
        // the user just selected.
        if (!rootRef.current) setHandleMissing(true);
        return;
      }
      const granted = await ensureReadPermission(handle);
      if (!granted || cancelled) return;
      rootRef.current = handle;
      setWsReady(true);
      // Queried, never requested: restoring a session must never itself
      // trigger a permission prompt, so this only reads whatever write
      // permission already happens to be granted.
      const writable = await hasWritePermission(handle);
      if (!cancelled) setCanWrite(writable);
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, workspaceKey]);

  const attachWorkspace = useCallback(
    async (allowWrites: boolean) => {
      const handle = await pickDirectory(allowWrites ? "readwrite" : "read");
      if (!handle) return;
      const granted = allowWrites
        ? await ensureWritePermission(handle)
        : await ensureReadPermission(handle);
      if (!granted) return;
      // Publish the newly picked handle before saving it. A slower initial
      // IndexedDB read may still be finishing, and it must see that a current
      // selection now exists rather than marking the workspace as stranded.
      rootRef.current = handle;
      setHandleMissing(false);
      strandedRef.current = false;
      await saveHandle(workspaceKey, handle);
      setWsReady(true);
      setCanWrite(allowWrites);
      send({ t: "workspace.attach", kind: "local", label: handle.name });
    },
    [workspaceKey, send],
  );

  const detachWorkspace = useCallback(async () => {
    await forgetHandle(workspaceKey);
    // A room that joined a project after saving its own folder can still have
    // the older per-room copy behind it; disconnecting means disconnecting.
    if (workspaceKey !== roomId) await forgetHandle(roomId);
    rootRef.current = null;
    setWsReady(false);
    send({ t: "workspace.detach" });
    onWorkspaceDetach(roomId);
  }, [roomId, workspaceKey, send, onWorkspaceDetach]);

  /**
   * Give up a folder this browser is on record as hosting but no longer has.
   *
   * The room keeps its workspace configured while the host is away and brings
   * it back online when that host reconnects, which is right for a closed tab
   * and wrong for a folder that has been disconnected since — disconnecting in
   * one room of a project removes the folder every room in it was sharing, and
   * the rooms that were not open at the time would otherwise come back online
   * hosting nothing. Only the recorded host can answer for it, and only an
   * absent folder counts: a folder whose permission merely lapsed is
   * reconnectable from the panel and must survive.
   */
  useEffect(() => {
    if (!connected || !mayPolicy || strandedRef.current) return;
    if (!handleMissing || state.workspace.kind !== "local") return;
    if (!me || state.workspace.hostUid !== me) return;
    strandedRef.current = true;
    send({ t: "workspace.detach" });
    onWorkspaceDetach(roomId);
  }, [connected, mayPolicy, handleMissing, state.workspace.kind, state.workspace.hostUid, me, roomId, send, onWorkspaceDetach]);

  /**
   * Connect the project's workspace to this room.
   *
   * A workspace connected in one room belongs to the project, so opening any
   * other room in it should find the same folder or repository already there
   * rather than an empty panel. The room's own server state is the authority:
   * this only ever fills a gap, and stays quiet once the room has a workspace
   * of its own.
   *
   * A local folder can be reconnected outright — the handle is this browser's
   * and its permission has already been re-confirmed above. A repository can
   * only be reconnected where GitHub is already authorised in this room;
   * without that, connecting would bounce the person through an install
   * redirect they never asked for, so it waits for them to do it themselves.
   */
  useEffect(() => {
    if (!connected || !mayPolicy) return;
    if (state.workspace.kind !== "none" || projectWorkspace.kind === "none") return;
    // Asked once per workspace, never on a loop: a server that refuses the
    // attach leaves the room's workspace at "none", and this would otherwise
    // ask again on every render that follows.
    const attempt = `${projectWorkspace.kind}:${projectWorkspace.label}`;
    if (inheritedRef.current === attempt) return;
    if (projectWorkspace.kind === "local") {
      const handle = rootRef.current;
      if (!wsReady || !handle) return;
      inheritedRef.current = attempt;
      send({ t: "workspace.attach", kind: "local", label: handle.name });
      return;
    }
    if (state.github.authorized && projectWorkspace.label) {
      inheritedRef.current = attempt;
      send({ t: "github.connect", repo: projectWorkspace.label });
    }
  }, [
    connected,
    mayPolicy,
    wsReady,
    state.workspace.kind,
    state.github.authorized,
    projectWorkspace.kind,
    projectWorkspace.label,
    send,
  ]);

  const connectGithub = useCallback((repo: string) => send({ t: "github.connect", repo }), [send]);
  const authGithub = useCallback(() => send({ t: "github.auth" }), [send]);
  const listRepos = useCallback(() => {
    setReposLoading(true);
    send({ t: "github.repos" });
  }, [send]);
  const signOutGithub = useCallback(() => {
    setRepos(null);
    send({ t: "github.signout" });
  }, [send]);

  /**
   * A room switch only unmounts this view, so it must stay silent. `pagehide`
   * is different: the browser is actually leaving the application. A beacon
   * survives that navigation long enough to record the real departure.
   */
  const announceApplicationExit = useCallback(() => {
    const body = new Blob([JSON.stringify({ token })], { type: "application/json" });
    navigator.sendBeacon(`/api/rooms/${encodeURIComponent(roomId)}/exit`, body);
  }, [roomId, token]);

  useEffect(() => {
    window.addEventListener("pagehide", announceApplicationExit);
    return () => window.removeEventListener("pagehide", announceApplicationExit);
  }, [announceApplicationExit]);

  /**
   * After the GitHub round trip the browser lands back here with `?gh=connected`
   * or `?gh=installed`.
   * Reopen the workspace panel where the person left off and fetch their
   * repositories, then strip the marker from the address bar so a reload or a
   * copied link does not repeat it.
   */
  useEffect(() => {
    const githubMarker = new URLSearchParams(location.search).get("gh");
    if (githubMarker !== "connected" && githubMarker !== "installed") return;
    setShowWorkspace(true);
    // Wait for the socket. This effect runs on mount, which is before the
    // WebSocket has opened, and a frame sent then is simply dropped — the
    // panel would sit on an empty list for no visible reason. Returning
    // early leaves the marker in the URL, so the effect runs again the
    // moment `connected` flips and the request actually goes out.
    if (!connected) return;
    setReposLoading(true);
    send({ t: "github.repos" });
    history.replaceState(null, "", location.pathname + location.hash);
  }, [connected, send]);

  const statusLabel = useMemo(() => {
    if (!connected) return "Reconnecting...";
    switch (state.status) {
      case "thinking":
        return "Agent Is Working";
      case "awaiting_approval":
        return "Waiting On The Room";
      default:
        return "Ready";
    }
  }, [connected, state.status]);

  const effortLabel = state.settings.effort === "xhigh" ? "Xhigh" : state.settings.effort[0]!.toUpperCase() + state.settings.effort.slice(1);
  // Under a custom workflow the room is answered by the graph's lead, so naming
  // `agentModel` here would put a model in the header that is not the one running.
  const custom = state.settings.workflow === "custom";
  const leadModel = custom ? leadOf(state.graph).model : state.settings.agentModel;
  const modelLabel = `${modelInfo(leadModel).label}, ${effortLabel}`;
  const policyLabel =
    state.policy.mode === "read_only"
      ? "Read-only"
      : state.policy.mode === "auto"
        ? "Auto-accept"
        : state.policy.mode === "custom"
          ? "Custom"
          : "Ask first";
  const teamCount = custom ? delegatesOf(state.graph).length : 0;

  return (
    <div className="app">
      <header className="bar">
        <div className="bar-left" />
        <div className="bar-right">
          <div className="bar-control-group" aria-label="Room controls">
            {custom && (
              <button
                className="wf-chip"
                onClick={() => setShowWorkflow(true)}
                title={`Custom workflow: ${leadOf(state.graph).name} and ${teamCount} teammate${
                  teamCount === 1 ? "" : "s"
                }`}
              >
                {leadOf(state.graph).name} +{teamCount}
              </button>
            )}
            {state.workspace.kind !== "none" && (
              <span
                className={`ws-chip ${state.workspace.online ? "ws-online" : "ws-offline"}`}
                title={
                  state.workspace.online
                    ? `Workspace: ${state.workspace.label}`
                    : "The workspace host is offline"
                }
              >
                📁 {state.workspace.label}
                {state.workspace.online ? "" : " (Offline)"}
              </span>
            )}
          </div>
          {renaming ? (
            <form
              className="rename-form"
              onSubmit={(e) => {
                e.preventDefault();
                const input = e.currentTarget.elements.namedItem(
                  "name",
                ) as HTMLInputElement;
                rename(input.value);
              }}
            >
              <input
                name="name"
                autoFocus
                defaultValue={displayName}
                maxLength={32}
                aria-label="Your name"
              />
              <button type="submit">Save</button>
            </form>
          ) : (
            <div className="settings-menu-wrap account-menu-wrap" ref={accountMenuRef}>
              <button
                type="button"
                className="person-trigger"
                aria-haspopup="menu"
                aria-expanded={showAccountMenu}
                onClick={() => {
                  setShowAccountMenu((open) => !open);
                  send({ t: "member.list" });
                }}
                aria-label="Open people and account menu"
              >
                <svg className="person-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5Z" />
                </svg>
              </button>
              {showAccountMenu && (
                <div className="settings-menu people-menu" role="menu" aria-label="People and account">
                  <div className="settings-menu-title">People in this room</div>
                  <section className="people-section">
                    <div className="settings-menu-label">Active</div>
                    {members.filter((member) => member.online).length === 0 ? (
                      <div className="people-empty">No active users</div>
                    ) : members.filter((member) => member.online).map((member) => (
                      <button
                        key={member.uid}
                        type="button"
                        role="menuitem"
                        className="people-user"
                        disabled={member.uid !== me && !mayViewRevisions}
                        onClick={() => openRevisionHistory(member.uid)}
                        title={member.uid === me || mayViewRevisions ? "View revision history" : "Only your own history is available"}
                      >
                        <span className="people-avatar">
                          {member.avatar ? <img src={member.avatar} alt="" referrerPolicy="no-referrer" /> : member.name.slice(0, 1).toUpperCase()}
                          <span className="people-online" />
                        </span>
                        <span className="people-user-name">{member.name}{member.uid === me ? " (You)" : ""}</span>
                        <span className="people-user-role">{member.role}</span>
                      </button>
                    ))}
                  </section>
                  <section className="people-section">
                    <div className="settings-menu-label">Inactive</div>
                    {members.filter((member) => !member.online).length === 0 ? (
                      <div className="people-empty">No inactive users</div>
                    ) : members.filter((member) => !member.online).map((member) => (
                      <button
                        key={member.uid}
                        type="button"
                        role="menuitem"
                        className="people-user people-user-inactive"
                        disabled={member.uid !== me && !mayViewRevisions}
                        onClick={() => openRevisionHistory(member.uid)}
                        title={member.uid === me || mayViewRevisions ? "View revision history" : "Only your own history is available"}
                      >
                        <span className="people-avatar">
                          {member.avatar ? <img src={member.avatar} alt="" referrerPolicy="no-referrer" /> : member.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="people-user-name">{member.name}{member.uid === me ? " (You)" : ""}</span>
                        <span className="people-user-role">Offline</span>
                      </button>
                    ))}
                  </section>
                  <section className="settings-menu-section account-actions">
                    <div className="settings-menu-label">Account</div>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowAccountMenu(false);
                        setRenaming(true);
                      }}
                    >
                      Rename
                    </button>
                    {onSignOut && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setShowAccountMenu(false);
                          announceApplicationExit();
                          onSignOut();
                        }}
                      >
                        Sign out
                      </button>
                    )}
                  </section>
                </div>
              )}
            </div>
          )}
          <div className="settings-menu-wrap" ref={settingsMenuRef}>
            <button
              type="button"
              className="settings-trigger"
              aria-label="Open settings"
              aria-expanded={showSettingsMenu}
              onClick={() => setShowSettingsMenu((open) => !open)}
            >
              <span aria-hidden="true">⚙</span>
            </button>
            {showSettingsMenu && (
              <div className="settings-menu" role="menu" aria-label="Settings">
                <div className="settings-menu-title">Settings</div>

                <section className="settings-menu-section">
                  <div className="settings-menu-label">Agent</div>
                  {maySettings && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowSettingsMenu(false);
                        setShowSettings(true);
                      }}
                    >
                      Agent setup
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowSettingsMenu(false);
                      setShowWorkflow(true);
                    }}
                  >
                    {mayWorkflow ? "Workflow" : "View workflow"}
                  </button>
                  {mayPolicy && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowSettingsMenu(false);
                        setShowPermissions(true);
                      }}
                    >
                      Permissions
                    </button>
                  )}
                </section>

                <section className="settings-menu-section">
                  <div className="settings-menu-label">Room</div>
                  {mayManage && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowSettingsMenu(false);
                        openMembers();
                      }}
                    >
                      Members
                    </button>
                  )}
                  {mayInvite && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowSettingsMenu(false);
                        openInvites();
                      }}
                    >
                      Invite people
                    </button>
                  )}
                  {mayPolicy && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowSettingsMenu(false);
                        setShowWorkspace(true);
                      }}
                    >
                    Workspace
                  </button>
                )}
              </section>

                <section className="settings-menu-section">
                  <div className="settings-menu-label">Usage</div>
                  <ContextGauge
                    context={state.context}
                    settings={state.settings}
                    cost={state.cost}
                  />
                </section>

                <section className="settings-menu-section">
                  <div className="settings-menu-label">Appearance</div>
                  <ThemeToggle theme={theme} onToggle={onToggleTheme} />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setToolDisplay((d) =>
                      d === "compact" ? "full" : d === "full" ? "hidden" : "compact",
                    )}
                  >
                    Tool details: {toolDisplay === "compact" ? "Compact" : toolDisplay === "full" ? "Full" : "Collapsed"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setShowDocument((open) => !open)}
                  >
                    {showDocument ? "Hide document" : "Show document"}
                  </button>
                </section>
              </div>
            )}
          </div>
        </div>
      </header>

      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {showSettings && (
        <SettingsPanel
          settings={state.settings}
          userCount={state.users.length}
          busy={state.status !== "idle"}
          onApply={applySettings}
          onCompactNow={compactNow}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showWorkflow && (
        <WorkflowPanel
          graph={state.graph}
          active={state.settings.workflow === "custom"}
          canEdit={mayWorkflow}
          canSetModels={maySettings}
          busy={state.status !== "idle"}
          onApply={(graph, useCustom) => {
            applyWorkflow(graph, useCustom);
            setShowWorkflow(false);
          }}
          onClose={() => setShowWorkflow(false)}
        />
      )}

      {showPermissions && (
        <PermissionsPanel
          policy={state.policy}
          busy={state.status !== "idle"}
          onApply={(p) => {
            applyPolicy(p);
            setShowPermissions(false);
          }}
          onClose={() => setShowPermissions(false)}
        />
      )}

      {showWorkspace && (
        <WorkspacePanel
          workspace={state.workspace}
          supported={isFileAccessSupported()}
          hosting={wsReady}
          canWrite={state.workspace.kind === "github" ? state.workspace.canWrite : canWrite}
          github={state.github}
          repos={repos}
          reposLoading={reposLoading}
          onAttach={attachWorkspace}
          onDetach={detachWorkspace}
          onConnectGithub={connectGithub}
          onAuthGithub={authGithub}
          onListRepos={listRepos}
          onSignOutGithub={signOutGithub}
          onClose={() => setShowWorkspace(false)}
        />
      )}

      {showTerminal && (
        <Suspense fallback={null}>
          <TerminalPanel
            roomId={roomId}
            token={token}
            onClose={() => setShowTerminal(false)}
          />
        </Suspense>
      )}

      {showInvites && (
        <InvitePanel
          invites={invites}
          roomId={roomId}
          onCreate={createInvite}
          onRevoke={revokeInvite}
          onClose={() => setShowInvites(false)}
        />
      )}

      {showMembers && (
        <MembersPanel
          members={members}
          myRole={myRole}
          me={me}
          onSetRole={setMemberRole}
          onRemove={removeMember}
          onClose={() => setShowMembers(false)}
        />
      )}

      {showRevisionHistory && (
        <RevisionHistoryPanel
          revisions={revisions}
          userName={members.find((member) => member.uid === revisionUid)?.name ?? "User"}
          isOwn={revisionUid === me}
          onClose={() => setShowRevisionHistory(false)}
        />
      )}

      <div className={`columns ${showDocument ? "" : "columns-doc-closed"}`}>
        <section className="chat">
          <Transcript entries={entries} me={me} toolDisplay={toolDisplay} />

          {state.workers.length > 0 && <WorkerStrip workers={state.workers} />}

          {state.pending.length > 0 && (
            <div className="approvals">
              <div className="approvals-head">
                Approval Needed
                {/*
                  The server computes the threshold from eligible voters and the
                  approval rule (e.g. owner_only needs one vote regardless of
                  headcount); the client has no way to recompute that denominator,
                  so it displays the pending item's own threshold rather than
                  guessing one from users.length.
                */}
                <span className="hint">
                  {state.pending[0]!.threshold}{" "}
                  {state.pending[0]!.threshold === 1 ? "Person" : "People"} Required
                </span>
              </div>
              {state.pending.map((p) => (
                <ApprovalCard
                  key={p.toolUseId}
                  pending={p}
                  me={me}
                  onVote={vote}
                  canDecide={mayVote && (!p.sensitive || canSeeFileContents(myRole))}
                />
              ))}
            </div>
          )}

          <Composer
            disabled={!connected}
            busy={state.status !== "idle"}
            readOnly={!maySpeak}
            modelLabel={modelLabel}
            policyLabel={policyLabel}
            statusLabel={statusLabel}
            quickActions={
              <>
                {maySettings && (
                  <button
                    type="button"
                    className="chat-action"
                    onClick={() => setShowSettings(true)}
                  >
                    Agent setup
                  </button>
                )}
                <button
                  type="button"
                  className="chat-action"
                  onClick={() => setShowWorkflow(true)}
                >
                  {mayWorkflow ? "Workflow" : "View Workflow"}
                </button>
                {mayPolicy && (
                  <button
                    type="button"
                    className="chat-action"
                    onClick={() => setShowPermissions(true)}
                  >
                    Permissions
                  </button>
                )}
                <WorkspaceActions
                  visible={mayPolicy}
                  onWorkspace={() => setShowWorkspace(true)}
                  onTerminal={() => setShowTerminal(true)}
                />
              </>
            }
            onSend={say}
            onInterrupt={interrupt}
          />
        </section>

        {showDocument && (
          <DocPanel
            doc={state.doc}
            revision={state.docRevision}
            canViewHistory={mayViewRevisions}
            onHistory={() => {
              if (me) openRevisionHistory(me);
            }}
            onClose={() => setShowDocument(false)}
          />
        )}
        {!showDocument && (
          <button
            type="button"
            className="doc-reopen"
            onClick={() => setShowDocument(true)}
            aria-label="Open shared document"
          >
            Open Document
          </button>
        )}
      </div>
    </div>
  );
}
