import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";

import {
  INITIAL_ROOM_STATE,
  type ClientMsg,
  type Entry,
  type GithubRepo,
  type InviteSummary,
  type MemberSummary,
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
  Presence,
  Transcript,
  WorkerStrip,
  WorkspacePanel,
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

/**
 * Everything that needs a live socket to the room. Only ever mounted once a
 * token exists — App is the one that gets us there.
 */
export function RoomView({
  roomId,
  token,
  displayName,
  onAccessLost,
  onWorkspaceChange,
  theme,
  onToggleTheme,
}: {
  roomId: string;
  token: string;
  displayName: string;
  onAccessLost: (reason: string) => void;
  onWorkspaceChange: (roomId: string, workspace: RoomState["workspace"]) => void;
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
  const [showPermissions, setShowPermissions] = useState(false);
  const [showWorkflow, setShowWorkflow] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [showInvites, setShowInvites] = useState(false);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  // The repository list for the GitHub picker. `null` means "not fetched
  // yet"; an array means fetched, possibly empty.
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [toolDisplay, setToolDisplay] = useState<"hidden" | "compact" | "full">("compact");
  const [showDocument, setShowDocument] = useState(false);
  // The picked directory handle isn't rendered, so it lives in a ref rather
  // than state — putting it in state would just cause re-renders nothing reads.
  const rootRef = useRef<FileSystemDirectoryHandle | null>(null);
  // Whether this tab can currently answer fs.req itself, i.e. whether rootRef
  // is populated and its permission is (still) granted.
  const [wsReady, setWsReady] = useState(false);
  // Whether the attached folder currently holds read-write permission. Purely
  // descriptive — the server, not this flag, decides whether a write is ever
  // attempted; it only shapes what the workspace panel tells the user.
  const [canWrite, setCanWrite] = useState(false);

  useEffect(() => {
    if (!showSettingsMenu) return;
    const closeWhenOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !settingsMenuRef.current?.contains(target)) {
        setShowSettingsMenu(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowSettingsMenu(false);
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [showSettingsMenu]);

  // These hide controls the server would refuse anyway; the server is the
  // boundary, this is only so nobody clicks into a refusal.
  const maySpeak = can(myRole, "speak");
  const maySettings = can(myRole, "settings");
  const mayPolicy = can(myRole, "policy");
  const mayInvite = can(myRole, "invite");
  const mayWorkflow = can(myRole, "workflow");
  const mayManage = can(myRole, "manage_members");

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
      send({ t: "rename", name: trimmed });
      setRenaming(false);
    },
    [send],
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
    void (async () => {
      const handle = await loadHandle(roomId);
      if (!handle || cancelled) return;
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
  }, [roomId]);

  const attachWorkspace = useCallback(
    async (allowWrites: boolean) => {
      const handle = await pickDirectory(allowWrites ? "readwrite" : "read");
      if (!handle) return;
      const granted = allowWrites
        ? await ensureWritePermission(handle)
        : await ensureReadPermission(handle);
      if (!granted) return;
      await saveHandle(roomId, handle);
      rootRef.current = handle;
      setWsReady(true);
      setCanWrite(allowWrites);
      send({ t: "workspace.attach", kind: "local", label: handle.name });
    },
    [roomId, send],
  );

  const detachWorkspace = useCallback(async () => {
    await forgetHandle(roomId);
    rootRef.current = null;
    setWsReady(false);
    send({ t: "workspace.detach" });
  }, [roomId, send]);

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
   * After the GitHub round trip the browser lands back here with `?gh=connected`.
   * Reopen the workspace panel where the person left off and fetch their
   * repositories, then strip the marker from the address bar so a reload or a
   * copied link does not repeat it.
   */
  useEffect(() => {
    if (new URLSearchParams(location.search).get("gh") !== "connected") return;
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
        <div className="bar-left">
          <div className="room-chip" title={roomId}>
            <span className="room">Room {roomId.slice(0, 6)}...</span>
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
                onBlur={() => setRenaming(false)}
              />
              <button type="submit">Save</button>
            </form>
          ) : (
            <button className="namebtn" onClick={() => setRenaming(true)}>
              {displayName}
            </button>
          )}
        </div>
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
          <div className="bar-presence" aria-label="People in room">
            <Presence users={state.users} me={me} />
          </div>
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
                    Tool details: {toolDisplay === "compact" ? "Compact" : toolDisplay === "full" ? "Full" : "Hidden"}
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
          canWrite={canWrite}
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
                  canDecide={!p.sensitive || canSeeFileContents(myRole)}
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
                <button
                  type="button"
                  className="chat-action"
                  onClick={() => setShowWorkflow(true)}
                >
                  {mayWorkflow ? "Workflow" : "View Workflow"}
                </button>
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
