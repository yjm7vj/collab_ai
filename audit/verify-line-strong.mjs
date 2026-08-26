// G3 — the control-boundary token must exist, clear 3:1 against every surface
// it borders, AND actually be applied to the controls. A token defined but not
// used would otherwise let this gate pass while the UI stayed unchanged.

import { readCss, themes, resolve, composite, contrast, writeJson, fail } from "./lib.mjs";

const css = readCss();
const { light, dark } = themes(css);

if (!light["line-strong"] || !dark["line-strong"]) {
  fail("--line-strong is not defined in both themes");
}

const SURFACES = ["bg", "panel", "panel-2"];
const measured = [];
for (const [name, theme] of [["light", light], ["dark", dark]]) {
  for (const s of SURFACES) {
    const bg = resolve(theme, s);
    const r = contrast(composite(resolve(theme, "line-strong"), bg), bg);
    measured.push({ theme: name, surface: `--${s}`, ratio: Number(r.toFixed(2)), pass: r >= 3 });
  }
}
const weak = measured.filter((m) => !m.pass);

// Applied where it matters: the controls whose fill does not distinguish them.
const REQUIRED = [
  { name: "text inputs", re: /input,\s*textarea\s*\{[^}]*border:\s*1px solid var\(--line-strong\)/ },
  { name: "select", re: /select\s*\{[^}]*border:\s*1px solid var\(--line-strong\)/ },
  { name: "base button", re: /\nbutton\s*\{[^}]*border:\s*1px solid var\(--line-strong\)/ },
];
const notApplied = REQUIRED.filter((r) => !r.re.test(css)).map((r) => r.name);

// The button fill genuinely fails to identify the control, which is why the
// border must. Prove that premise rather than asserting it.
const fillRatio = contrast(
  composite(resolve(light, "panel-2"), resolve(light, "panel")),
  resolve(light, "panel"),
);
if (fillRatio >= 3) {
  fail(`button fill measures ${fillRatio.toFixed(2)}:1 against its surface — it identifies the control on its own, so this gate's premise no longer holds and should be rewritten`);
}

writeJson("line-strong.json", { measured, notApplied, buttonFillRatio: Number(fillRatio.toFixed(2)) });

console.log(`--line-strong: light ${light["line-strong"]}, dark ${dark["line-strong"]}`);
for (const m of measured) console.log(`  [${m.theme}] vs ${m.surface}: ${m.ratio}:1 ${m.pass ? "ok" : "WEAK"}`);
console.log(`button fill vs its surface: ${fillRatio.toFixed(2)}:1 — too low to identify the control, so the border carries it`);
if (weak.length) { console.error(`FAIL: ${weak.length} surface(s) below 3:1`); process.exit(1); }
if (notApplied.length) { console.error(`FAIL: token defined but not applied to: ${notApplied.join(", ")}`); process.exit(1); }
console.log("LINE_STRONG_OK");
