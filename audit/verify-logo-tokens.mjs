// G5 — the logo must not carry a hard-coded duplicate of the accent. The
// baseline value is read from git so the check cannot be satisfied by editing
// a constant I wrote myself.

import { execFileSync } from "node:child_process";
import { ROOT, readCss, themes, resolve, composite, contrast, writeJson, fail } from "./lib.mjs";

const css = readCss();
const { light, dark } = themes(css);

const prior = execFileSync("git", ["show", "HEAD:src/client/styles.css"], {
  cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
});
const priorLogo = prior.slice(prior.indexOf(".logo-mark span {"), prior.indexOf(".room {"));
const priorLiterals = [...new Set([...priorLogo.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0].toLowerCase()))];
if (priorLiterals.length === 0) {
  fail("the committed logo had no color literals, so this check has nothing to prove and would pass vacuously");
}

const nowLogo = css.slice(css.indexOf(".logo-mark span {"), css.indexOf(".room {"));
const stillLiteral = priorLiterals.filter((lit) => nowLogo.toLowerCase().includes(lit));
const anyLiteral = [...new Set([...nowLogo.matchAll(/#[0-9a-f]{3,8}/gi)].map((m) => m[0]))];
const tokenRefs = [...new Set([...nowLogo.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]))];

// The mark sits on the topbar, which stays dark in both themes, so every tint
// must clear 3:1 against both topbar values.
const tintChecks = [];
for (const t of tokenRefs) {
  for (const [name, theme] of [["light", light], ["dark", dark]]) {
    const bg = resolve(theme, "topbar");
    const r = contrast(composite(resolve(theme, t), bg), bg);
    tintChecks.push({ token: `--${t}`, theme: name, ratio: Number(r.toFixed(2)), pass: r >= 3 });
  }
}
const weak = tintChecks.filter((t) => !t.pass);

writeJson("logo-tokens.json", { priorLiterals, stillLiteral, anyLiteral, tokenRefs, tintChecks });

console.log(`committed logo literals: ${priorLiterals.join(", ")}`);
console.log(`logo now references: ${tokenRefs.map((t) => "--" + t).join(", ") || "(none)"}`);
for (const t of tintChecks) console.log(`  ${t.token} on ${t.theme} topbar: ${t.ratio}:1 ${t.pass ? "ok" : "WEAK"}`);
if (stillLiteral.length) { console.error(`FAIL: the logo still hard-codes ${stillLiteral.join(", ")}`); process.exit(1); }
if (anyLiteral.length) { console.error(`FAIL: the logo still contains color literals: ${anyLiteral.join(", ")}`); process.exit(1); }
if (tokenRefs.length === 0) { console.error("FAIL: the logo references no tokens at all"); process.exit(1); }
if (weak.length) { console.error(`FAIL: ${weak.length} logo tint(s) below 3:1 on the topbar`); process.exit(1); }
console.log("LOGO_TOKEN_OK");
