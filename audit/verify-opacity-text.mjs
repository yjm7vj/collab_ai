// G2 — no live (non-disabled) text may be faded by `opacity` below the 4.5:1
// floor. Disabled controls are WCAG-exempt and are the only allowed case; the
// check asserts that exemption is still actually present rather than letting a
// silent deletion pass as compliance.

import { readCss, themes, resolve, composite, contrast, writeJson, fail } from "./lib.mjs";

const css = readCss();
const { light, dark } = themes(css);
const lines = css.split("\n");

// Selectors whose `opacity` is legitimately not a text-legibility question.
const EXEMPT = [
  { test: /:disabled/, why: "WCAG 1.4.3 exempts disabled controls" },
  { test: /@keyframes|\bpulse\b/, why: "animation keyframe, not a resting state" },
  { test: /\.wf-wire/, why: "SVG stroke on a graph edge, not text" },
  { test: /\.tool-pip/, why: "status dot; the border and label carry the meaning" },
];

const found = [];
let currentSelector = "";
lines.forEach((raw, i) => {
  const line = raw.trim();
  const braceIdx = raw.indexOf("{");
  if (braceIdx > 0) currentSelector = raw.slice(0, braceIdx).trim();

  const m = line.match(/(?:^|[;{\s])opacity\s*:\s*([\d.]+)/);
  if (!m) return;
  const value = parseFloat(m[1]);
  if (value >= 1) return;

  // A same-line rule carries its own selector.
  const selfSel = raw.match(/^([^{]+)\{/);
  const selector = selfSel ? selfSel[1].trim() : currentSelector;

  const exempt = EXEMPT.find((e) => e.test.test(selector) || e.test.test(line));
  found.push({ line: i + 1, selector, value, exempt: exempt ? exempt.why : null });
});

// For every non-exempt fade, measure what the fade actually produces. The
// stylesheet no longer fades ink, so this list should be empty — but the check
// measures rather than assuming.
const violations = [];
for (const f of found) {
  if (f.exempt) continue;
  for (const [name, theme] of [["light", light], ["dark", dark]]) {
    for (const inkToken of ["ink", "ink-dim", "ink-faint"]) {
      for (const surface of ["panel", "panel-2", "bg"]) {
        const bg = resolve(theme, surface);
        const r = contrast(composite(resolve(theme, inkToken), bg, f.value), bg);
        if (r < 4.5) {
          violations.push({ ...f, theme: name, ink: `--${inkToken}`, surface: `--${surface}`, ratio: Number(r.toFixed(2)) });
        }
      }
    }
  }
}

const disabledFades = found.filter((f) => /:disabled/.test(f.selector));
if (disabledFades.length === 0) {
  fail("no `:disabled { opacity }` rule found — the exempt case was removed rather than kept; this check would then be passing vacuously");
}

writeJson("opacity-text.json", {
  opacityDeclarations: found.length,
  exemptCount: found.filter((f) => f.exempt).length,
  nonExemptCount: found.filter((f) => !f.exempt).length,
  violations,
  found,
});

console.log(`opacity declarations below 1: ${found.length}`);
for (const f of found) {
  console.log(`  styles.css:${f.line} ${f.selector} -> ${f.value}${f.exempt ? `  [exempt: ${f.exempt}]` : "  [live text]"}`);
}
if (violations.length) {
  console.error(`FAIL: ${violations.length} faded live-text combination(s) below 4.5:1`);
  for (const v of violations.slice(0, 12)) {
    console.error(`  [${v.theme}] ${v.selector} ${v.ink} on ${v.surface} = ${v.ratio}:1`);
  }
  process.exit(1);
}
console.log(`disabled-state exemption present at ${disabledFades.length} rule(s), as required`);
console.log("OPACITY_TEXT_OK");
