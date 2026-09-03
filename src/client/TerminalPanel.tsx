import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import type {
  TerminalControlRequest,
  TerminalCommandRequest,
  TerminalOutput,
  TerminalRemoteInput,
  TerminalSession,
  TerminalSharing,
} from "../shared/terminal";

type CompanionMessage =
  | { t: "authenticated"; root: string; shell: string; platform: string }
  | { t: "started" }
  | { t: "output"; data: string }
  | { t: "exit"; exitCode: number }
  | { t: "command.output"; id: string; data: string }
  | { t: "command.result"; id: string; ok: boolean; output: string };

export function TerminalPanel({
  me,
  canHost,
  sessions,
  outputs,
  controlRequests,
  commands,
  remoteInputs,
  onList,
  onHostOpen,
  onHostClose,
  onHostOutput,
  onInput,
  onRequestControl,
  onDecideControl,
  onCommandResult,
  onClose,
}: {
  me: string | null;
  canHost: boolean;
  sessions: TerminalSession[];
  outputs: TerminalOutput[];
  controlRequests: TerminalControlRequest[];
  commands: TerminalCommandRequest[];
  remoteInputs: TerminalRemoteInput[];
  onList: () => void;
  onHostOpen: (session: { id: string; label: string; shell: string; sharing: TerminalSharing }) => void;
  onHostClose: (sessionId: string) => void;
  onHostOutput: (sessionId: string, data: string, seq: number) => void;
  onInput: (sessionId: string, data: string) => void;
  onRequestControl: (sessionId: string) => void;
  onDecideControl: (sessionId: string, uid: string, allow: boolean) => void;
  onCommandResult: (id: string, ok: boolean, output: string) => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const localSessionRef = useRef<string | null>(null);
  const localInfoRef = useRef<{ root: string; shell: string; platform: string } | null>(null);
  const sharingRef = useRef<TerminalSharing>("room");
  const seqRef = useRef(0);
  const handledOutputRef = useRef(0);
  const handledCommandsRef = useRef(new Set<string>());
  const handledInputsRef = useRef(0);

  const [pairingCode, setPairingCode] = useState("");
  const [sharing, setSharing] = useState<TerminalSharing>("room");
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [problem, setProblem] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(sessions[0]?.id ?? null);
  const [localInfo, setLocalInfo] = useState<{ root: string; shell: string; platform: string } | null>(null);

  const selected = sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null;
  const isLocalHost = selected?.id === localSessionRef.current;
  const controlsSelected = Boolean(
    selected && me && (selected.hostUid === me || selected.controllers.some((controller) => controller.uid === me)),
  );
  const myHosted = useMemo(() => sessions.find((session) => session.hostUid === me), [sessions, me]);

  useEffect(() => {
    onList();
  }, [onList]);

  useEffect(() => {
    sharingRef.current = sharing;
  }, [sharing]);

  useEffect(() => {
    if (!hostRef.current || terminalRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      fontSize: 13,
      scrollback: 5_000,
      theme: { background: "#0a1019", foreground: "#d9e4f2", cursor: "#58a6ff" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    fit.fit();
    terminal.writeln("HuddleAI terminal");
    terminal.writeln("Start the local companion, then enter its pairing code.\r\n");
    const input = terminal.onData((data) => {
      const local = socketRef.current;
      if (selected?.id === localSessionRef.current && local?.readyState === WebSocket.OPEN) {
        local.send(JSON.stringify({ t: "input", data }));
      } else if (selected && controlsSelected) {
        onInput(selected.id, data);
      }
    });
    const resize = new ResizeObserver(() => {
      fit.fit();
      const local = socketRef.current;
      if (local?.readyState === WebSocket.OPEN) {
        local.send(JSON.stringify({ t: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    });
    resize.observe(hostRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;
    return () => {
      input.dispose();
      resize.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [selected?.id, controlsSelected, onInput]);

  useEffect(() => {
    if (!selected || selected.id === localSessionRef.current) return;
    const unseen = outputs.slice(handledOutputRef.current).filter((item) => item.sessionId === selected.id);
    for (const item of unseen) terminalRef.current?.write(item.data);
    handledOutputRef.current = outputs.length;
  }, [outputs, selected]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    for (const request of commands) {
      if (request.sessionId !== localSessionRef.current || handledCommandsRef.current.has(request.id)) continue;
      handledCommandsRef.current.add(request.id);
      terminalRef.current?.writeln(`\r\n\x1b[36mHuddleAI Agent\x1b[0m\r\n> ${request.command}\r\n`);
      socket.send(JSON.stringify({ t: "run", id: request.id, command: request.command }));
    }
  }, [commands, status]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !localSessionRef.current) return;
    for (const input of remoteInputs.slice(handledInputsRef.current)) {
      if (input.sessionId === localSessionRef.current) socket.send(JSON.stringify({ t: "input", data: input.data }));
    }
    handledInputsRef.current = remoteInputs.length;
  }, [remoteInputs, status]);

  const disconnect = () => {
    const id = localSessionRef.current;
    if (id) onHostClose(id);
    localSessionRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    setStatus("disconnected");
    setLocalInfo(null);
  };

  useEffect(() => disconnect, []);

  const connect = () => {
    const token = pairingCode.trim();
    if (!token) return;
    setProblem(null);
    setStatus("connecting");
    const socket = new WebSocket("ws://127.0.0.1:43127");
    socketRef.current = socket;
    socket.addEventListener("open", () => socket.send(JSON.stringify({ t: "auth", token })));
    socket.addEventListener("message", (event) => {
      let message: CompanionMessage;
      try { message = JSON.parse(String(event.data)) as CompanionMessage; } catch { return; }
      if (message.t === "authenticated") {
        localInfoRef.current = message;
        setLocalInfo(message);
        socket.send(JSON.stringify({
          t: "start",
          cols: terminalRef.current?.cols ?? 100,
          rows: terminalRef.current?.rows ?? 30,
        }));
      } else if (message.t === "started") {
        const id = crypto.randomUUID();
        localSessionRef.current = id;
        setSelectedId(id);
        setStatus("connected");
        setPairingCode("");
        onHostOpen({
          id,
          label: localInfoRef.current?.root ?? "Local workspace",
          shell: localInfoRef.current?.shell ?? "Local shell",
          sharing: sharingRef.current,
        });
      } else if (message.t === "output") {
        terminalRef.current?.write(message.data);
        const id = localSessionRef.current;
        if (id && sharingRef.current === "room") onHostOutput(id, message.data, ++seqRef.current);
      } else if (message.t === "command.output") {
        terminalRef.current?.write(message.data);
        const id = localSessionRef.current;
        if (id && sharingRef.current === "room") onHostOutput(id, message.data, ++seqRef.current);
      } else if (message.t === "command.result") {
        onCommandResult(message.id, message.ok, message.output);
      } else if (message.t === "exit") {
        terminalRef.current?.writeln(`\r\n[Shell exited with code ${message.exitCode}]`);
      }
    });
    socket.addEventListener("error", () => {
      setProblem("Could not reach the local companion. Start it and try again.");
      setStatus("disconnected");
    });
    socket.addEventListener("close", (event) => {
      if (localSessionRef.current) onHostClose(localSessionRef.current);
      localSessionRef.current = null;
      socketRef.current = null;
      setStatus("disconnected");
      if (event.code === 4401) setProblem("The pairing code was rejected or expired.");
    });
  };

  const changeSharing = (next: TerminalSharing) => {
    setSharing(next);
    sharingRef.current = next;
    const id = localSessionRef.current;
    if (id && localInfo) onHostOpen({ id, label: localInfo.root, shell: localInfo.shell, sharing: next });
  };

  const pendingForMe = controlRequests.filter((request) => sessions.some(
    (session) => session.id === request.sessionId && session.hostUid === me,
  ));

  return (
    <div className="modal-scrim" onClick={onClose}>
      <section className="modal terminal-modal" role="dialog" aria-label="Terminal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head terminal-head">
          <div>
            <h2>Terminal</h2>
            <p className="terminal-status">
              {status === "connected" && localInfo ? `${localInfo.shell} in ${localInfo.root}` : "Local companion terminal"}
            </p>
          </div>
          <button className="icon" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="terminal-toolbar">
          {sessions.map((session) => (
            <button key={session.id} type="button" className={selected?.id === session.id ? "terminal-session active" : "terminal-session"} onClick={() => setSelectedId(session.id)}>
              <span className="pip pip-ok" /> {session.label}
              <small>{session.hostName}</small>
            </button>
          ))}
          {sessions.length === 0 && <span className="field-note">No shared terminal is running.</span>}
        </div>

        {canHost && !myHosted && status === "disconnected" && (
          <div className="terminal-pairing">
            <div>
              <strong>Connect your computer</strong>
              <span>Run <code>npm start -- --cwd C:\path\to\project</code> inside the companion folder.</span>
            </div>
            <input type="password" value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} placeholder="One-time pairing code" aria-label="One-time pairing code" />
            <select value={sharing} onChange={(event) => changeSharing(event.target.value as TerminalSharing)} aria-label="Terminal visibility">
              <option value="room">Room can view</option>
              <option value="private">Private</option>
            </select>
            <button type="button" className="primary" disabled={!pairingCode.trim()} onClick={connect}>Connect</button>
          </div>
        )}

        {isLocalHost && (
          <div className="terminal-local-controls">
            <label><input type="checkbox" checked={sharing === "room"} onChange={(event) => changeSharing(event.target.checked ? "room" : "private")} /> Share output with the room</label>
            <span className="field-note">Agent commands are classified and approved by the room before reaching this computer.</span>
            <button type="button" onClick={disconnect}>Disconnect</button>
          </div>
        )}

        {selected && !isLocalHost && !controlsSelected && selected.sharing === "room" && (
          <div className="terminal-viewer-bar">
            <span>Viewing {selected.hostName}'s terminal</span>
            <button type="button" onClick={() => onRequestControl(selected.id)}>Request Control</button>
          </div>
        )}
        {selected && controlsSelected && !isLocalHost && <div className="terminal-viewer-bar terminal-control-live">You have control of this terminal.</div>}

        {pendingForMe.map((request) => (
          <div className="terminal-control-request" key={`${request.sessionId}:${request.uid}`}>
            <span><strong>{request.name}</strong> requested terminal control.</span>
            <button type="button" className="primary" onClick={() => onDecideControl(request.sessionId, request.uid, true)}>Allow</button>
            <button type="button" onClick={() => onDecideControl(request.sessionId, request.uid, false)}>Deny</button>
          </div>
        ))}

        <div className="terminal-host" ref={hostRef} />
        <div className="terminal-note">The companion listens only on this computer. Stop it to revoke the pairing code and close the shell.</div>
        {problem && <div className="terminal-error">{problem}</div>}
      </section>
    </div>
  );
}
