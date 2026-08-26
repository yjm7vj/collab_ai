// G1 — confirm the bundled detector actually ran over the client source and
// that its findings were captured, including the zero-finding case.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, writeJson, fail } from "./lib.mjs";

const TXT = path.join(ROOT, "audit", "detector.txt");
const JSON_PATH = path.join(ROOT, "audit", "detector.json");
const DETECTOR = path.join(ROOT, ".claude", "skills", "impeccable", "scripts", "detect.mjs");

if (!fs.existsSync(DETECTOR)) fail("bundled detector not found at the expected path");
if (!fs.existsSync(TXT)) fail("audit/detector.txt missing — the detector output was not captured");
if (!fs.existsSync(JSON_PATH)) fail("audit/detector.json missing");

const findings = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
if (!Array.isArray(findings)) fail("detector.json is not an array of findings");

// Re-run the detector now and require the captured count to still match, so a
// stale capture cannot certify this gate.
// The detector exits non-zero whenever it has non-advisory findings, so a
// throw here is an expected outcome; only a missing stdout is a real failure.
let fresh;
try {
  fresh = execFileSync(process.execPath, [DETECTOR, "src/client", "--json"], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: "pipe",
  });
} catch (e) {
  fresh = e.stdout;
  if (!fresh) fail(`detector produced no output: ${e.message}`);
}
const freshFindings = JSON.parse(fresh);
if (freshFindings.length !== findings.length) {
  fail(`captured ${findings.length} findings but a fresh run produces ${freshFindings.length} — capture is stale`);
}

const scannedFiles = new Set(findings.map((f) => path.basename(f.file)));
const byRule = {};
for (const f of findings) {
  const k = f.antipattern;
  byRule[k] ||= { count: 0, severity: f.severity, category: f.category, lines: [] };
  byRule[k].count++;
  byRule[k].lines.push(f.line);
}

const blocking = findings.filter((f) => f.severity !== "advisory");
const advisory = findings.filter((f) => f.severity === "advisory");

if (findings.length > 0 && Object.keys(byRule).length === 0) fail("findings present but rule grouping is empty");

writeJson("detector-summary.json", {
  totalFindings: findings.length,
  blockingCount: blocking.length,
  advisoryCount: advisory.length,
  filesWithFindings: [...scannedFiles],
  byRule,
  blocking,
});

console.log(`detector findings: ${findings.length} (${blocking.length} warning/blocking, ${advisory.length} advisory)`);
for (const [rule, info] of Object.entries(byRule).sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${rule} [${info.severity}/${info.category}] x${info.count}`);
}
console.log("DETECTOR_CAPTURE_OK");
