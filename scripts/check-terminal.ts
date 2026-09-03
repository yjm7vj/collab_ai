import fs from "node:fs";
import path from "node:path";
import { classifyTerminalCommand, sanitizeTerminalLabel, sanitizeTerminalShell, TERMINAL_LIMITS } from "../src/shared/terminal";
import { DEFAULT_POLICY, resolveTools } from "../src/shared/access";

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  }
}

console.log("\nterminal command classification");
for (const command of ["ls", "git status", "git diff -- src/server/room.ts", "npm test", "grep -R token src", "pwd"]) {
  check(`${command} is low risk`, classifyTerminalCommand(command) === "low", classifyTerminalCommand(command));
}
for (const command of ["npm install stripe", "git push", "rm -rf .", "git status; git push", "cat $(echo secret)", "echo hi > file", "npm test\ngit push"]) {
  check(`${JSON.stringify(command)} needs approval`, classifyTerminalCommand(command) === "approval_required", classifyTerminalCommand(command));
}

console.log("\nterminal input limits");
check("label removes control characters and clamps length", sanitizeTerminalLabel("\n project\t") === "project");
check("shell falls back safely", sanitizeTerminalShell(42) === "Local shell");
check("frame limit is smaller than command result limit", TERMINAL_LIMITS.frameBytes < TERMINAL_LIMITS.resultBytes);
check("default policy gates terminal commands", resolveTools(DEFAULT_POLICY).run_terminal === "ask");

console.log("\nrelay security surface");
const room = fs.readFileSync(path.join(process.cwd(), "src", "server", "room.ts"), "utf8");
const companion = fs.readFileSync(path.join(process.cwd(), "companion", "index.mjs"), "utf8");
check("host opening requires policy capability", room.includes('"Only the room\'s owner or admins can host a local terminal."'));
check("terminal input is sent only to an active host", room.includes("const host = this.#terminalHost(runtime);"));
check("terminal output has a server-side frame limit", room.includes("TERMINAL_LIMITS.frameBytes"));
check("companion binds to loopback only", companion.includes('host: "127.0.0.1"'));
check("companion checks exact allowed origins", companion.includes("allowedOrigins.has(origin)"));
check("companion uses constant-time pairing comparison", companion.includes("crypto.timingSafeEqual"));
check("companion never accepts a browser supplied cwd", !companion.includes("message.cwd"));
check("agent-dispatched commands receive a scrubbed environment", companion.includes("agentEnvironment()"));

if (failures > 0) process.exitCode = 1;
else console.log("\nterminal checks passed");
