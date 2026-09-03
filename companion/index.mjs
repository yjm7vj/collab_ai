import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { WebSocketServer } from "ws";
import * as pty from "node-pty";

const args = process.argv.slice(2);
const option = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const port = Number(option("--port", "43127"));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be between 1024 and 65535");

const requestedRoot = path.resolve(option("--cwd", process.cwd()));
const root = fs.realpathSync(requestedRoot);
if (!fs.statSync(root).isDirectory()) throw new Error("--cwd must identify a directory");

const extraOrigin = option("--origin");
const allowedOrigins = new Set([
  "https://app.huddleai.org",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...(extraOrigin ? [extraOrigin] : []),
]);
const pairingToken = crypto.randomBytes(24).toString("base64url");
const shell = process.platform === "win32"
  ? (process.env.HUDDLEAI_SHELL || "powershell.exe")
  : (process.env.SHELL || "/bin/bash");
const shellArgs = process.platform === "win32" ? ["-NoLogo", "-NoProfile"] : ["-l"];

/**
 * Interactive terminals belong to the developer, so they inherit that
 * developer's normal environment. Agent-dispatched commands are different:
 * they cross a room boundary, and so do not inherit obvious credentials.
 */
const agentEnvironment = () => Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/(token|secret|password|credential|api[_-]?key|private[_-]?key|auth)/i.test(key)),
);

const sameToken = (value) => {
  if (typeof value !== "string") return false;
  const left = Buffer.from(value);
  const right = Buffer.from(pairingToken);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const safeSend = (socket, message) => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
};

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port,
  maxPayload: 32_768,
  verifyClient: ({ origin }) => allowedOrigins.has(origin),
});

wss.on("connection", (socket) => {
  let authenticated = false;
  let terminal = null;
  let authTimer = setTimeout(() => socket.close(4401, "Pairing timed out"), 15_000);

  const closeTerminal = () => {
    if (!terminal) return;
    try { terminal.kill(); } catch { /* already closed */ }
    terminal = null;
  };

  socket.on("message", (raw) => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return socket.close(4400, "Invalid message"); }

    if (!authenticated) {
      if (message?.t !== "auth" || !sameToken(message.token)) return socket.close(4401, "Pairing code rejected");
      authenticated = true;
      clearTimeout(authTimer);
      authTimer = null;
      safeSend(socket, { t: "authenticated", root: path.basename(root), shell: path.basename(shell), platform: os.platform() });
      return;
    }

    if (message?.t === "start") {
      closeTerminal();
      terminal = pty.spawn(shell, shellArgs, {
        name: "xterm-256color",
        cols: Math.max(20, Math.min(240, Number(message.cols) || 100)),
        rows: Math.max(8, Math.min(100, Number(message.rows) || 30)),
        cwd: root,
        env: { ...process.env, HUDDLEAI_TERMINAL: "1" },
      });
      terminal.onData((data) => safeSend(socket, { t: "output", data }));
      terminal.onExit(({ exitCode }) => safeSend(socket, { t: "exit", exitCode }));
      safeSend(socket, { t: "started" });
      return;
    }

    if (message?.t === "input" && terminal && typeof message.data === "string" && Buffer.byteLength(message.data) <= 8192) {
      terminal.write(message.data);
      return;
    }

    if (message?.t === "resize" && terminal) {
      const cols = Math.max(20, Math.min(240, Number(message.cols) || 100));
      const rows = Math.max(8, Math.min(100, Number(message.rows) || 30));
      terminal.resize(cols, rows);
      return;
    }

    if (message?.t === "run" && typeof message.id === "string" && typeof message.command === "string") {
      const command = message.command.trim();
      if (!command || Buffer.byteLength(command) > 2000) {
        safeSend(socket, { t: "command.result", id: message.id, ok: false, output: "Command rejected by the local companion." });
        return;
      }
      const runArgs = process.platform === "win32"
        ? ["-NoLogo", "-NoProfile", "-Command", command]
        : ["-lc", command];
      const runner = pty.spawn(shell, runArgs, {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: root,
        env: { ...agentEnvironment(), HUDDLEAI_TERMINAL: "1" },
      });
      let output = "";
      let truncated = false;
      const timeout = setTimeout(() => {
        try { runner.kill(); } catch { /* already closed */ }
      }, 120_000);
      runner.onData((data) => {
        safeSend(socket, { t: "command.output", id: message.id, data });
        if (output.length < 128_000) output += data.slice(0, 128_000 - output.length);
        else truncated = true;
      });
      runner.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        safeSend(socket, {
          t: "command.result",
          id: message.id,
          ok: exitCode === 0,
          output: output + (truncated ? "\n[Output truncated]" : ""),
        });
      });
    }
  });

  socket.on("close", () => {
    if (authTimer) clearTimeout(authTimer);
    closeTerminal();
  });
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const socket of wss.clients) socket.close(1001, "Local companion stopping");
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`HuddleAI local companion is listening on ws://127.0.0.1:${port}`);
console.log(`Workspace: ${root}`);
console.log(`Shell: ${shell}`);
console.log(`Pairing code: ${pairingToken}`);
console.log("Keep this window open. The pairing code is valid only until this process exits.");
