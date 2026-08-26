// G7 — a stylesheet-scoped change must not break the build. Runs the project's
// own typecheck and test scripts and requires both to exit zero.

import { execSync } from "node:child_process";
import { ROOT, writeJson } from "./lib.mjs";

// On Windows npm is a .cmd shim, which execFileSync cannot spawn directly —
// it needs a shell. The commands are fixed strings defined here, not input.
const steps = [
  { name: "typecheck", cmd: "npm run typecheck" },
  { name: "test", cmd: "npm run test" },
];

const results = [];
let failed = false;
for (const s of steps) {
  const started = Date.now();
  try {
    const out = execSync(s.cmd, {
      cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: "pipe",
      timeout: 8 * 60 * 1000,
    });
    results.push({ ...s, ok: true, ms: Date.now() - started, tail: out.trim().split("\n").slice(-4).join("\n") });
    console.log(`PASS ${s.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed = true;
    const out = `${e.stdout || ""}${e.stderr || ""}`.trim();
    results.push({ ...s, ok: false, ms: Date.now() - started, tail: out.split("\n").slice(-25).join("\n") });
    console.error(`FAIL ${s.name} (exit ${e.status})`);
    console.error(out.split("\n").slice(-25).join("\n"));
  }
}

writeJson("build.json", { results });
if (failed) process.exit(1);
console.log("BUILD_OK");
