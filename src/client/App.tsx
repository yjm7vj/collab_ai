import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";

import {
  INITIAL_ROOM_STATE,
  type ClientMsg,
  type Entry,
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
  JoinGate,
  Presence,
  Transcript,
  WorkerStrip,
} from "./components";
import { SettingsPanel } from "./Settings";

/** Room name comes from the URL fragment, so a link is an invitation. */
function roomFromHash(): string {
  const raw = decodeURIComponent(location.hash.replace(/^#/, "")).trim();
  return raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "lobby";
}

export function App() {
  const [room, setRoom] = useState(roomFromHash);
  const [state, setState] = useState<RoomState>(INITIAL_ROOM_STATE);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [name, setName] = useState(() => localStorage.getItem("collab_ai:name") ?? "");
  const [joined, setJoined] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Re-key the socket when the fragment changes so links between rooms work.
  useEffect(() => {
    const onHash = () => {
      setRoom(roomFromHash());
      setEntries([]);
      setState(INITIAL_ROOM_STATE);
      setJoined(false);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const applyServerMessage = useCallback((msg: ServerMsg) => {
    switch (msg.t) {
      case "you":
        setMe(msg.id);
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
    name: room,
    onStateUpdate: (s: RoomState) => setState(s),
    onOpen: () => {
      setConnected(true);
      setError(null);
    },
    onClose: () => setConnected(false),
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

  // Re-announce on every (re)connect: the server keys presence by connection id,
  // so a dropped socket means a new identity that has to say who it is.
  const rejoin = useRef<string | null>(null);
  useEffect(() => {
    if (!connected || !joined || !name) return;
    if (rejoin.current === `${room}:${name}`) return;
    rejoin.current = `${room}:${name}`;
    send({ t: "join", name });
  }, [connected, joined, name, room, send]);

  useEffect(() => {
    rejoin.current = null;
  }, [connected, room]);

  const join = useCallback(
    (n: string) => {
      const trimmed = n.trim().slice(0, 32);
      if (!trimmed) return;
      localStorage.setItem("collab_ai:name", trimmed);
      setName(trimmed);
      setJoined(true);
    },
    [],
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

  if (!joined) {
    return <JoinGate room={room} initialName={name} onJoin={join} />;
  }

  return (
    <div className="app">
      <header className="bar">
        <div className="bar-left">
          <span className="logo">collab_ai</span>
          <span className="room">#{room}</span>
        </div>
        <div className="bar-right">
          <ContextGauge
            context={state.context}
            settings={state.settings}
            cost={state.cost}
          />
          <span className={`status status-${state.status}`}>{statusLabel}</span>
          <Presence users={state.users} me={me} />
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
