// G4 — no theming regression: both themes define the same token set, every
// var() reference resolves, and nothing that existed before the retune was
// dropped. The pre-change token list is read from git, not from a copy I wrote.

import { execFileSync } from "node:child_process";
import { readCss, themes, parseTokens, writeJson, fail } from "./lib.mjs";
import { ROOT } from "./lib.mjs";

const css = readCss();
const { light, darkOverrides } = themes(css);

// 1. Same token set in both blocks. The dark block may legitimately omit a
//    token only if the light value is theme-independent — but this project
//    redefines every color, so an omission is a gap.
const lightKeys = new Set(Object.keys(light));
const darkKeys = new Set(Object.keys(darkOverrides));
const COLOR_LIKE = (k, v) => /^(#|rgb|hsl)/.test(v) || /shadow|scrim/.test(k);
const missingInDark = [...lightKeys].filter(
  (k) => !darkKeys.has(k) && COLOR_LIKE(k, light[k]) && !/^logo-/.test(k),
);
const extraInDark = [...darkKeys].filter((k) => !lightKeys.has(k));

// 2. Every var(--x) resolves to a defined token.
const defined = new Set([...css.matchAll(/^\s*--([\w-]+)\s*:/gm)].map((m) => m[1]));
const referenced = [...new Set([...css.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]))];
const unresolved = referenced.filter((r) => !defined.has(r));
const unused = [...defined].filter((d) => !referenced.includes(d) && !/^(sans|mono|radius)$/.test(d));

// 3. Nothing dropped versus the committed baseline.
let baselineTokens = [];
try {
  const prior = execFileSync("git", ["show", "HEAD:src/client/styles.css"], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  baselineTokens = [...new Set([...prior.matchAll(/^\s*--([\w-]+)\s*:/gm)].map((m) => m[1]))];
} catch (e) {
  fail(`could not read the committed baseline from git: ${e.message}`);
}
if (baselineTokens.length === 0) fail("baseline token list came back empty — the comparison would be vacuous");
const dropped = baselineTokens.filter((t) => !defined.has(t));

writeJson("token-integrity.json", {
  lightTokenCount: lightKeys.size,
  darkOverrideCount: darkKeys.size,
  baselineTokenCount: baselineTokens.length,
  currentTokenCount: defined.size,
  missingInDark, extraInDark, unresolved, unused, dropped,
});

console.log(`tokens: ${defined.size} defined now, ${baselineTokens.length} at HEAD`);
console.log(`dark block overrides ${darkKeys.size} of ${lightKeys.size} light tokens`);
const problems = [];
if (missingInDark.length) problems.push(`color tokens with no dark value: ${missingInDark.join(", ")}`);
if (extraInDark.length) problems.push(`tokens defined only in dark: ${extraInDark.join(", ")}`);
if (unresolved.length) problems.push(`var() references with no definition: ${unresolved.join(", ")}`);
if (unused.length) problems.push(`tokens defined but never used: ${unused.join(", ")}`);
if (dropped.length) problems.push(`tokens that existed at HEAD and are now gone: ${dropped.join(", ")}`);
if (problems.length) { for (const p of problems) console.error("FAIL: " + p); process.exit(1); }
console.log("no unresolved references, no dead tokens, no theme gaps, nothing dropped");
console.log("TOKEN_INTEGRITY_OK");
