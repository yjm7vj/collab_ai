// G6 — the retune must not introduce a NEW non-advisory detector warning.
// Baseline is the pre-change summary captured during the audit.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, writeJson, fail } from "./lib.mjs";

const BASE = path.join(ROOT, "audit", "detector-summary.json");
if (!fs.existsSync(BASE)) fail("no pre-change baseline at audit/detector-summary.json");
const baseline = JSON.parse(fs.readFileSync(BASE, "utf8"));
const baseRules = {};
for (const b of baseline.blocking || []) baseRules[b.antipattern] = (baseRules[b.antipattern] || 0) + 1;
if (Object.keys(baseRules).length === 0) {
  fail("baseline recorded zero non-advisory warnings — a regression check against an empty baseline is vacuous");
}

const DETECTOR = path.join(ROOT, ".claude", "skills", "impeccable", "scripts", "detect.mjs");
let out;
try {
  out = execFileSync(process.execPath, [DETECTOR, "src/client", "--json"], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: "pipe",
  });
} catch (e) {
  out = e.stdout;
  if (!out) fail(`detector produced no output: ${e.message}`);
}
const now = JSON.parse(out).filter((f) => f.severity !== "advisory");
const nowRules = {};
for (const f of now) nowRules[f.antipattern] = (nowRules[f.antipattern] || 0) + 1;

const regressions = [];
for (const [rule, count] of Object.entries(nowRules)) {
  const was = baseRules[rule] || 0;
  if (count > was) regressions.push(`${rule}: ${was} -> ${count}`);
}
const improvements = [];
for (const [rule, was] of Object.entries(baseRules)) {
  const count = nowRules[rule] || 0;
  if (count < was) improvements.push(`${rule}: ${was} -> ${count}`);
}

writeJson("no-new-warnings.json", { baseRules, nowRules, regressions, improvements });

console.log("non-advisory warnings by rule");
console.log("  baseline:", JSON.stringify(baseRules));
console.log("  now:     ", JSON.stringify(nowRules));
if (improvements.length) console.log("  improved:", improvements.join(", "));
if (regressions.length) { console.error(`FAIL: new warnings — ${regressions.join(", ")}`); process.exit(1); }
console.log("NO_NEW_WARNINGS_OK");
