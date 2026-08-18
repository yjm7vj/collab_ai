import { useCallback, useMemo, useState } from "react";
import { useAgent } from "agents/react";

import {
  INITIAL_ROOM_STATE,
  type ClientMsg,
  type Entry,
  type InviteSummary,
  type RoomState,
  type ServerMsg,
  type Vote,
} from "../shared/protocol";
import type { RoomSettings } from "../shared/models";
import {
  ApprovalCard,
  Composer,
  ContextGauge,
  DocPanel,
  InvitePanel,
  Presence,
  Transcript,
  WorkerStrip,
} from "./components";
import { SettingsPanel } from "./Settings";

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
  const [myRole, setMyRole] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [showInvites, setShowInvites] = useState(false);

  const applyServerMessage = useCallback((msg: ServerMsg) => {
    switch (msg.t) {
      case "you":
        setMe(msg.uid);
        setMyRole(msg.role);
        break;
      case "invites":
        setInvites(msg.invites);
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
          <Presence users={state.users} me={me} />
          {/*
            This check is only a UI courtesy — it hides the button so people who
            can't mint invites don't see one. The server re-checks the role on
            every invite.* message; a hidden button is not a permission.
          */}
          {(myRole === "owner" || myRole === "admin") && (
            <button
              className="icon"
              onClick={openInvites}
              title="Invite people"
              aria-label="Invite people"
            >
              🔗
            </button>
          )}
          <button
            className="icon"
            onClick={() => setShowSettings(true)}
            title="Room setup"
            aria-label="Room setup"
          >
            ⚙
          </button>
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

      {showInvites && (
        <InvitePanel
          invites={invites}
          roomId={roomId}
          onCreate={createInvite}
          onRevoke={revokeInvite}
          onClose={() => setShowInvites(false)}
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
                <span className="hint">
                  {state.pending[0]!.threshold} of {Math.max(1, state.users.length)} to
                  decide
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
            onSend={say}
            onInterrupt={interrupt}
          />
        </section>

        <DocPanel doc={state.doc} revision={state.docRevision} />
      </div>
    </div>
  );
}
