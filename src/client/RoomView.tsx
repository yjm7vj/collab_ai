import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";

import {
  INITIAL_ROOM_STATE,
  type ClientMsg,
  type Entry,
  type InviteSummary,
  type MemberSummary,
  type RoomState,
  type ServerMsg,
  type Vote,
} from "../shared/protocol";
import type { RoomSettings } from "../shared/models";
import { asRole, can, describePolicy, type Role } from "../shared/access";
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
} from "./components";
import { SettingsPanel } from "./Settings";
import {
  ensureReadPermission,
  forgetHandle,
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
}: {
  roomId: string;
  token: string;
  displayName: string;
  onAccessLost: (reason: string) => void;
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
  const [showPermissions, setShowPermissions] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [showInvites, setShowInvites] = useState(false);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  // The picked directory handle isn't rendered, so it lives in a ref rather
  // than state — putting it in state would just cause re-renders nothing reads.
  const rootRef = useRef<FileSystemDirectoryHandle | null>(null);
  // Whether this tab can currently answer fs.req itself, i.e. whether rootRef
  // is populated and its permission is (still) granted.
  const [wsReady, setWsReady] = useState(false);

  // These hide controls the server would refuse anyway; the server is the
  // boundary, this is only so nobody clicks into a refusal.
  const maySpeak = can(myRole, "speak");
  const maySettings = can(myRole, "settings");
  const mayPolicy = can(myRole, "policy");
  const mayInvite = can(myRole, "invite");
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
    }
  }, []);

  const agent = useAgent({
    agent: "room",
    name: roomId,
    query: { tk: token },
    onStateUpdate: (s: RoomState) => setState(s),
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
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const attachWorkspace = useCallback(async () => {
    const handle = await pickDirectory();
    if (!handle) return;
    const granted = await ensureReadPermission(handle);
    if (!granted) return;
    await saveHandle(roomId, handle);
    rootRef.current = handle;
    setWsReady(true);
    send({ t: "workspace.attach", kind: "local", label: handle.name });
  }, [roomId, send]);

  const detachWorkspace = useCallback(async () => {
    await forgetHandle(roomId);
    rootRef.current = null;
    setWsReady(false);
    send({ t: "workspace.detach" });
  }, [roomId, send]);

  const copyLink = useCallback(() => {
    void navigator.clipboard.writeText(`${location.origin}/#/r/${roomId}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [roomId]);

  const statusLabel = useMemo(() => {
    if (!connected) return "reconnecting…";
    switch (state.status) {
      case "thinking":
        return "agent is working";
      case "awaiting_approval":
        return "waiting on the room";
      default:
        return "ready";
    }
  }, [connected, state.status]);

  return (
    <div className="app">
      <header className="bar">
        <div className="bar-left">
          <span className="logo">collab_ai</span>
          <div className="room-chip">
            <span className="room" title={roomId}>room {roomId.slice(0, 6)}…</span>
            <button className="linkbtn" onClick={copyLink}>
              {copied ? "copied" : "copy link"}
            </button>
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
              <button type="submit">save</button>
            </form>
          ) : (
            <button className="namebtn" onClick={() => setRenaming(true)}>
              {displayName}
            </button>
          )}
        </div>
        <div className="bar-right">
          <ContextGauge
            context={state.context}
            settings={state.settings}
            cost={state.cost}
          />
          <span className={`status status-${state.status}`}>{statusLabel}</span>
          <span
            className={`policy-chip policy-${state.policy.mode}`}
            title={describePolicy(state.policy)}
          >
            {state.policy.mode === "read_only"
              ? "read-only"
              : state.policy.mode === "auto"
                ? "auto-accept"
                : state.policy.mode === "custom"
                  ? "custom"
                  : "ask first"}
          </span>
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
              {state.workspace.online ? "" : " (offline)"}
            </span>
          )}
          <Presence users={state.users} me={me} />
          {mayManage && (
            <button
              className="icon"
              onClick={openMembers}
              title="Members"
              aria-label="Members"
            >
              👥
            </button>
          )}
          {/*
            This check is only a UI courtesy — it hides the button so people who
            can't mint invites don't see one. The server re-checks the role on
            every invite.* message; a hidden button is not a permission.
          */}
          {mayInvite && (
            <button
              className="icon"
              onClick={openInvites}
              title="Invite people"
              aria-label="Invite people"
            >
              🔗
            </button>
          )}
          {mayPolicy && (
            <button
              className="icon"
              onClick={() => setShowWorkspace(true)}
              title="Workspace"
              aria-label="Workspace"
            >
              📁
            </button>
          )}
          {mayPolicy && (
            <button
              className="icon"
              onClick={() => setShowPermissions(true)}
              title="What the agent may do"
              aria-label="What the agent may do"
            >
              🛡
            </button>
          )}
          {maySettings && (
            <button
              className="icon"
              onClick={() => setShowSettings(true)}
              title="Room setup"
              aria-label="Room setup"
            >
              ⚙
            </button>
          )}
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
          onAttach={attachWorkspace}
          onDetach={detachWorkspace}
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

      <div className="columns">
        <section className="chat">
          <Transcript entries={entries} me={me} />

          {state.workers.length > 0 && <WorkerStrip workers={state.workers} />}

          {state.pending.length > 0 && (
            <div className="approvals">
              <div className="approvals-head">
                The agent needs the room's approval
                {/*
                  The server computes the threshold from eligible voters and the
                  approval rule (e.g. owner_only needs one vote regardless of
                  headcount); the client has no way to recompute that denominator,
                  so it displays the pending item's own threshold rather than
                  guessing one from users.length.
                */}
                <span className="hint">
                  {state.pending[0]!.threshold}{" "}
                  {state.pending[0]!.threshold === 1 ? "approval" : "approvals"} needed
                </span>
              </div>
              {state.pending.map((p) => (
                <ApprovalCard key={p.toolUseId} pending={p} me={me} onVote={vote} />
              ))}
            </div>
          )}

          <Composer
            disabled={!connected}
            busy={state.status !== "idle"}
            readOnly={!maySpeak}
            onSend={say}
            onInterrupt={interrupt}
          />
        </section>

        <DocPanel doc={state.doc} revision={state.docRevision} />
      </div>
    </div>
  );
}
