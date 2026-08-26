// G7 — assert the final report is structurally complete: five dimension
// scores, a total, an integrity verdict, an executive summary with severity
// counts, and every finding carrying a P-tag and a file location.

import fs from "node:fs";
import path from "node:path";
import { ROOT, fail } from "./lib.mjs";

// An explicit path argument lets the negative-control harness point this same
// checker at a deliberately broken fixture.
const REPORT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "audit", "AUDIT.md");
if (!fs.existsSync(REPORT)) fail("audit/AUDIT.md does not exist");
const md = fs.readFileSync(REPORT, "utf8");

const DIMENSIONS = ["Accessibility", "Performance", "Theming", "Responsive", "Implementation Integrity"];
for (const d of DIMENSIONS) {
  const re = new RegExp(`\\|\\s*${d}[^|]*\\|\\s*([0-4])\\s*(?:/\\s*4)?\\s*\\|`, "i");
  if (!re.test(md)) fail(`no 0-4 score row found for dimension: ${d}`);
}

const total = md.match(/\*\*(\d{1,2})\s*\/\s*20\*\*/);
if (!total) fail("no bolded **N/20** total score found");
const totalValue = Number(total[1]);
if (totalValue < 0 || totalValue > 20) fail(`total ${totalValue} out of range`);

// The total must equal the sum of the five dimension scores.
const scores = DIMENSIONS.map((d) => {
  const m = md.match(new RegExp(`\\|\\s*${d}[^|]*\\|\\s*([0-4])\\s*(?:/\\s*4)?\\s*\\|`, "i"));
  return Number(m[1]);
});
const sum = scores.reduce((a, b) => a + b, 0);
if (sum !== totalValue) fail(`dimension scores sum to ${sum} but the report claims ${totalValue}/20`);

if (!/Implementation Integrity Verdict/i.test(md)) fail("missing the Implementation Integrity Verdict section");
if (!/Executive Summary/i.test(md)) fail("missing the Executive Summary section");

// Every finding heading must carry a P0-P3 tag.
const findingHeadings = [...md.matchAll(/^#{3,4}\s+(.+)$/gm)]
  .map((m) => m[1])
  .filter((h) => /^\[P[0-3]\]/.test(h));
if (findingHeadings.length === 0) fail("no [P0-P3] tagged findings found in the report");

// Each tagged finding must be followed by a Location line naming a real file.
const blocks = md.split(/^#{3,4}\s+(?=\[P[0-3]\])/m).slice(1);
if (blocks.length !== findingHeadings.length) {
  fail(`found ${findingHeadings.length} tagged headings but split into ${blocks.length} blocks`);
}
const missingLocation = [];
const badPath = [];
for (const b of blocks) {
  const title = b.split("\n")[0].trim();
  const loc = b.match(/\*\*Location\*\*:\s*(.+)/);
  if (!loc) { missingLocation.push(title); continue; }
  const filesInLoc = [...loc[1].matchAll(/((?:src|audit|\.)[\w./-]*\.\w+|index\.html|styles\.css)/g)].map((m) => m[1]);
  if (filesInLoc.length === 0) { missingLocation.push(title); continue; }
  for (const f of filesInLoc) {
    const candidate = f.startsWith("src/") || f.startsWith("audit/") || f === "index.html"
      ? path.join(ROOT, f)
      : path.join(ROOT, "src", "client", f);
    if (!fs.existsSync(candidate)) badPath.push(`${title} -> ${f}`);
  }
}
if (missingLocation.length) fail(`findings without a file Location: ${missingLocation.join(" | ")}`);
if (badPath.length) fail(`findings citing a non-existent file: ${badPath.join(" | ")}`);

// The severity counts claimed in the summary must match the tags actually present.
const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
for (const h of findingHeadings) counts[h.match(/^\[(P[0-3])\]/)[1]]++;
for (const [tag, n] of Object.entries(counts)) {
  const claimed = md.match(new RegExp(`${tag}[^\\d\\n]{0,24}?(\\d+)`));
  if (!claimed) fail(`executive summary does not state a count for ${tag}`);
  if (Number(claimed[1]) !== n) {
    fail(`report claims ${claimed[1]} ${tag} findings but ${n} are actually tagged`);
  }
}

if (!/Positive Findings/i.test(md)) fail("missing the Positive Findings section");
if (!/Recommended Actions/i.test(md)) fail("missing the Recommended Actions section");

console.log(`report: ${findingHeadings.length} tagged findings (P0=${counts.P0} P1=${counts.P1} P2=${counts.P2} P3=${counts.P3})`);
console.log(`dimension scores: ${scores.join(" + ")} = ${sum}/20`);
console.log("REPORT_STRUCTURE_OK");
