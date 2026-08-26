// G6 — count color literals and separate legitimate token definitions (inside
// a :root block) from uses outside them, which are theming drift: a literal
// used in a rule does not change when the theme flips.

import fs from "node:fs";
import path from "node:path";
import { ROOT, readCss, writeJson, fail } from "./lib.mjs";

const COLOR = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;

const css = readCss();
const lines = css.split("\n");

// Mark the line ranges of every :root{...} block; literals inside are defs.
const rootRanges = [];
for (const m of css.matchAll(/:root[^{]*\{/g)) {
  const startLine = css.slice(0, m.index).split("\n").length;
  const close = css.indexOf("}", m.index);
  const endLine = css.slice(0, close).split("\n").length;
  rootRanges.push([startLine, endLine]);
}
const inRoot = (n) => rootRanges.some(([a, b]) => n >= a && n <= b);

const definitions = [];
const drift = [];

lines.forEach((raw, i) => {
  const n = i + 1;
  const line = raw.trim();
  if (line.startsWith("/*") || line.startsWith("*")) return;
  for (const m of line.matchAll(COLOR)) {
    const entry = { line: n, value: m[0], context: line.slice(0, 100) };
    if (inRoot(n)) definitions.push(entry);
    else drift.push(entry);
  }
});

// Same scan over the TSX, where any color literal is drift by definition.
const tsxDrift = [];
for (const f of ["App.tsx", "RoomView.tsx", "components.tsx", "Settings.tsx", "workspace.ts", "main.tsx"]) {
  const p = path.join(ROOT, "src", "client", f);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, "utf8");
  src.split("\n").forEach((raw, i) => {
    for (const m of raw.matchAll(COLOR)) {
      tsxDrift.push({ file: `src/client/${f}`, line: i + 1, value: m[0], context: raw.trim().slice(0, 100) });
    }
  });
}

// Group CSS drift by value so a repeated literal reads as one systemic issue.
const byValue = {};
for (const d of drift) (byValue[d.value.toLowerCase()] ||= []).push(d.line);

if (rootRanges.length === 0) fail("no :root block found — the parser is not reading styles.css correctly");
if (definitions.length === 0) fail("zero token definitions found inside :root, which cannot be true");

writeJson("hardcoded-color.json", {
  rootBlocks: rootRanges.length,
  tokenDefinitions: definitions.length,
  cssDriftCount: drift.length,
  tsxDriftCount: tsxDrift.length,
  driftByValue: Object.fromEntries(
    Object.entries(byValue).sort((a, b) => b[1].length - a[1].length).map(([v, ls]) => [v, { count: ls.length, lines: ls }])
  ),
  cssDrift: drift,
  tsxDrift,
});

console.log(`:root blocks: ${rootRanges.length}`);
console.log(`token definitions inside :root: ${definitions.length}`);
console.log(`color literals OUTSIDE :root in styles.css (theming drift): ${drift.length}`);
for (const [v, ls] of Object.entries(byValue).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`    ${v} x${ls.length} — lines ${ls.slice(0, 12).join(", ")}${ls.length > 12 ? ", ..." : ""}`);
}
console.log(`color literals in client TSX: ${tsxDrift.length}`);
for (const d of tsxDrift.slice(0, 10)) console.log(`    ${d.file}:${d.line} ${d.value}`);
console.log("HARDCODED_COLOR_MEASURE_OK");
