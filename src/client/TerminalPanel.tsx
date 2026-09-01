import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SandboxAddon, type ConnectionState } from "@cloudflare/sandbox/xterm";
import "@xterm/xterm/css/xterm.css";

type TerminalSession = {
  sandboxId: string;
  terminalId: string;
  ticket: string;
};

function terminalError(status: number, body: unknown): string {
  const error = typeof body === "object" && body !== null && "error" in body
    ? String((body as { error: unknown }).error)
    : "";
  if (status === 403) return "Only the room owner and admins can open the terminal.";
  if (status === 503 || error === "terminal_unavailable") {
    return "The Linux sandbox is still starting or temporarily unavailable. Try again shortly.";
  }
  return "The terminal could not be opened.";
}

export function TerminalPanel({
  roomId,
  token,
  onClose,
}: {
  roomId: string;
  token: string;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Starting Linux sandbox...");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let session: TerminalSession | null = null;
    let terminal: Terminal | null = null;
    let addon: SandboxAddon | null = null;
    let observer: ResizeObserver | null = null;

    const disposeSession = () => {
      if (!session) return;
      void fetch(`/api/rooms/${encodeURIComponent(roomId)}/terminal`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, terminalId: session.terminalId }),
        keepalive: true,
      });
      session = null;
    };

    void (async () => {
      try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/terminal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const body = await response.json().catch(() => null) as TerminalSession | { error?: string } | null;
        if (!response.ok || !body || !("terminalId" in body)) {
          if (!cancelled) {
            setError(terminalError(response.status, body));
            setStatus("Unavailable");
          }
          return;
        }

        session = body;
        if (cancelled) {
          disposeSession();
          return;
        }

        const styles = getComputedStyle(document.documentElement);
        terminal = new Terminal({
          cursorBlink: true,
          convertEol: true,
          fontFamily: styles.getPropertyValue("--mono").trim() || "monospace",
          fontSize: 13,
          scrollback: 5_000,
          theme: {
            background: styles.getPropertyValue("--panel").trim() || "#111827",
            foreground: styles.getPropertyValue("--ink").trim() || "#e5e7eb",
            cursor: styles.getPropertyValue("--accent").trim() || "#60a5fa",
            selectionBackground: styles.getPropertyValue("--accent-bg").trim() || "#1e3a5f",
          },
        });
        const fit = new FitAddon();
        const activeSession = session;
        addon = new SandboxAddon({
          reconnect: true,
          getWebSocketUrl: ({ cursor, origin }) => {
            const params = new URLSearchParams({
              terminalId: activeSession.terminalId,
              ticket: activeSession.ticket,
            });
            if (cursor) params.set("cursor", cursor);
            return `${origin}/api/terminal/connect?${params.toString()}`;
          },
          onStateChange: (next: ConnectionState, connectionError?: Error) => {
            if (cancelled) return;
            if (next === "connected") setStatus("Connected to isolated Linux shell");
            else if (next === "connecting") setStatus("Connecting...");
            else setStatus(connectionError ? "Connection lost. Reconnecting..." : "Disconnected");
          },
        });

        terminal.loadAddon(fit);
        terminal.loadAddon(addon);
        terminal.open(host);
        fit.fit();
        addon.connect({ sandboxId: activeSession.sandboxId, terminalId: activeSession.terminalId });
        terminal.focus();

        observer = new ResizeObserver(() => fit.fit());
        observer.observe(host);
      } catch {
        if (!cancelled) {
          setError("The terminal could not be opened.");
          setStatus("Unavailable");
        }
      }
    })();

    return () => {
      cancelled = true;
      observer?.disconnect();
      addon?.dispose();
      terminal?.dispose();
      disposeSession();
    };
  }, [roomId, token]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal terminal-modal" role="dialog" aria-label="Linux terminal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Linux Terminal</h2>
            <p className="terminal-status">{status}</p>
          </div>
          <button className="icon" onClick={onClose} aria-label="Close terminal">✕</button>
        </header>
        <div className="terminal-note">
          Commands run inside an isolated room sandbox. Its local files are temporary and no application secrets are exposed.
        </div>
        <div ref={hostRef} className="terminal-host" aria-label="Interactive Linux shell" />
        {error && <div className="terminal-error">{error}</div>}
      </div>
    </div>
  );
}
