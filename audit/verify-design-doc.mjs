// G8 — the design doc must carry the shipped values. Every color in the
// DESIGN.md frontmatter is compared against the light-theme token of the same
// name in styles.css, and the sidecar's canonical values are checked too.

import fs from "node:fs";
import path from "node:path";
import { ROOT, readCss, themes, writeJson, fail } from "./lib.mjs";

const css = readCss();
const { light } = themes(css);

const md = fs.readFileSync(path.join(ROOT, "DESIGN.md"), "utf8");
const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
if (!fmMatch) fail("DESIGN.md has no YAML frontmatter");
const colorsBlock = fmMatch[1].match(/^colors:\n((?:  [\w-]+: "[^"]*"\n?)+)/m);
if (!colorsBlock) fail("DESIGN.md frontmatter has no colors block");

const docColors = {};
for (const m of colorsBlock[1].matchAll(/^  ([\w-]+): "([^"]*)"/gm)) docColors[m[1]] = m[2];
if (Object.keys(docColors).length === 0) fail("parsed zero colors from the frontmatter");

const mismatches = [];
const missingFromCss = [];
for (const [name, value] of Object.entries(docColors)) {
  const shipped = light[name];
  if (shipped === undefined) { missingFromCss.push(name); continue; }
  if (shipped.toLowerCase() !== value.toLowerCase()) {
    mismatches.push({ token: name, doc: value, shipped });
  }
}

// A superseded hex must not survive anywhere in the prose either.
const priorValues = ["#1683e8", "#0f62c4", "#d43f3a", "#9b6a10", "#7b8a9e", "#526278", "#2f8f5b", "#2d96ee", "#7dc6ff"];
const staleInProse = priorValues.filter((v) => md.toLowerCase().includes(v));

// Sidecar canonicals must match too.
const sidecarPath = path.join(ROOT, ".impeccable", "design.json");
if (!fs.existsSync(sidecarPath)) fail(".impeccable/design.json is missing");
const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
const sidecarBad = [];
for (const [name, meta] of Object.entries(sidecar.extensions?.colorMeta || {})) {
  const shipped = light[name];
  if (!shipped) { sidecarBad.push(`${name}: not a token in styles.css`); continue; }
  if (meta.canonical?.toLowerCase() !== shipped.toLowerCase()) {
    sidecarBad.push(`${name}: sidecar ${meta.canonical} vs shipped ${shipped}`);
  }
}
if (Object.keys(sidecar.extensions?.colorMeta || {}).length === 0) {
  fail("sidecar colorMeta is empty — this comparison would be vacuous");
}

writeJson("design-doc.json", { docColorCount: Object.keys(docColors).length, mismatches, missingFromCss, staleInProse, sidecarBad });

console.log(`DESIGN.md frontmatter: ${Object.keys(docColors).length} colors checked against styles.css`);
console.log(`sidecar colorMeta: ${Object.keys(sidecar.extensions.colorMeta).length} canonical values checked`);
const problems = [];
if (mismatches.length) problems.push("frontmatter disagrees with styles.css: " + mismatches.map((m) => `${m.token} doc=${m.doc} shipped=${m.shipped}`).join("; "));
if (missingFromCss.length) problems.push("frontmatter names tokens that do not exist in styles.css: " + missingFromCss.join(", "));
if (staleInProse.length) problems.push("superseded values still in DESIGN.md prose: " + staleInProse.join(", "));
if (sidecarBad.length) problems.push("sidecar drift: " + sidecarBad.join("; "));
if (problems.length) { for (const p of problems) console.error("FAIL: " + p); process.exit(1); }
console.log("doc, sidecar and stylesheet agree");
console.log("DESIGN_DOC_OK");
