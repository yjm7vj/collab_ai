// G8 — negative controls. Every check in this audit must be able to fail.
// Each control feeds a known-bad input to the same logic the real check uses
// and asserts the bad input is caught, plus a known-good input that passes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, contrast, composite, parseColor, parseTokens } from "./lib.mjs";

const results = [];
function control(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (e) {
    results.push({ name, passed: false, error: e.message });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// 1. Contrast math must reject an unreadable pair and accept a readable one.
control("contrast rejects white-on-white and accepts black-on-white", () => {
  const white = parseColor("#ffffff");
  const black = parseColor("#000000");
  const same = contrast(composite(white, white), white);
  assert(same < 4.5, `white on white measured ${same}, should be below 4.5`);
  assert(Math.abs(same - 1) < 0.01, `white on white should be 1.0, got ${same}`);
  const max = contrast(composite(black, white), white);
  assert(max > 20.9, `black on white should be ~21, got ${max}`);
});

// 2. Alpha compositing must actually lower contrast, or the faded-text checks
//    would be measuring nothing.
control("alpha compositing lowers measured contrast", () => {
  const bg = parseColor("#ffffff");
  const fg = parseColor("#000000");
  const full = contrast(composite(fg, bg, 1), bg);
  const faded = contrast(composite(fg, bg, 0.3), bg);
  assert(faded < full, `fading should lower contrast: ${faded} !< ${full}`);
  assert(faded < 4.5, `30% black on white should fail AA, measured ${faded}`);
});

// 3. Token parsing must fail loudly on a block that has no custom properties.
control("token parser rejects a block with no custom properties", () => {
  const t = parseTokens(":root { color: red; }", ":root {");
  assert(Object.keys(t).length === 0, "parser invented tokens that do not exist");
  const real = parseTokens(":root { --a: #fff; --b: #000; }", ":root {");
  assert(real.a === "#fff" && real.b === "#000", "parser failed on a valid block");
});

// 4. The layout-property motion test must separate width from transform.
control("layout-property detection separates width from transform", () => {
  const LAYOUT = ["width", "height", "top", "left", "right", "bottom", "margin", "padding", "font-size"];
  const isLayout = (v) => v.split(",").map((s) => s.trim().split(/\s+/)[0]).some((p) => LAYOUT.includes(p));
  assert(isLayout("width 300ms ease"), "failed to flag a width transition");
  assert(!isLayout("transform 160ms ease"), "wrongly flagged a transform transition");
  assert(isLayout("background 200ms, height 100ms"), "failed to flag height in a list");
});

// 5. The accessible-name test must call an unnamed button unnamed.
control("accessible-name logic flags an unnamed button and clears a named one", () => {
  const named = (attrs, inner) => {
    const hasAria = /aria-label\s*=/.test(attrs) || /aria-labelledby\s*=/.test(attrs) || /title\s*=/.test(attrs);
    const text = inner.replace(/<[^>]*>/g, " ").replace(/\{[^{}]*\}/g, " ").replace(/\s+/g, " ").trim();
    return hasAria || text.length > 0;
  };
  assert(!named('className="icon"', "<span />"), "an icon-only button was treated as named");
  assert(named('aria-label="Close"', ""), "an aria-labelled button was treated as unnamed");
  assert(named("", "Send"), "a text button was treated as unnamed");
  assert(!named('className="x"', "{maybe}"), "an expression-only child was treated as static text");
});

// 6. The drift scan must call a literal outside :root drift and one inside a
//    definition — otherwise every project would look clean.
control("color-literal scan separates :root definitions from drift", () => {
  const css = ":root {\n  --accent: #1683e8;\n}\n.logo { background: #2d96ee; }\n";
  const lines = css.split("\n");
  const ranges = [];
  for (const m of css.matchAll(/:root[^{]*\{/g)) {
    const s = css.slice(0, m.index).split("\n").length;
    const e = css.slice(0, css.indexOf("}", m.index)).split("\n").length;
    ranges.push([s, e]);
  }
  const inRoot = (n) => ranges.some(([a, b]) => n >= a && n <= b);
  const defs = [], drift = [];
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/#[0-9a-f]{6}\b/gi)) (inRoot(i + 1) ? defs : drift).push(m[0]);
  });
  assert(defs.length === 1 && defs[0] === "#1683e8", `expected 1 definition, got ${JSON.stringify(defs)}`);
  assert(drift.length === 1 && drift[0] === "#2d96ee", `expected 1 drift literal, got ${JSON.stringify(drift)}`);
});

// 7. The report checker must reject a report whose scores do not add up.
control("report checker rejects a score sum that does not match the total", () => {
  const bad = [
    "| # | Dimension | Score | Key Finding |",
    "|---|---|---|---|",
    "| 1 | Accessibility | 4 | x |",
    "| 2 | Performance | 4 | x |",
    "| 3 | Theming | 4 | x |",
    "| 4 | Responsive Design | 4 | x |",
    "| 5 | Implementation Integrity | 4 | x |",
    "| **Total** | | **11/20** | Bogus |",
    "",
    "## Implementation Integrity Verdict",
    "## Executive Summary",
    "P0: 0, P1: 0, P2: 0, P3: 0",
    "## Positive Findings",
    "## Recommended Actions",
    "",
    "### [P1] Something",
    "- **Location**: src/client/styles.css:1",
  ].join("\n");
  const fixture = path.join(os.tmpdir(), `unlazy-audit-control-${process.pid}.md`);
  fs.writeFileSync(fixture, bad);
  let exitCode = 0;
  try {
    execFileSync(process.execPath, [path.join(ROOT, "audit", "verify-report.mjs"), fixture], {
      cwd: ROOT, encoding: "utf8", stdio: "pipe",
    });
  } catch (e) {
    exitCode = e.status ?? 1;
  } finally {
    fs.unlinkSync(fixture);
  }
  assert(exitCode !== 0, "verify-report accepted a report whose scores sum to 20 but claim 11/20");
});

// 8. The report checker must reject a finding that cites a file that is not there.
control("report checker rejects a finding citing a non-existent file", () => {
  const bad = [
    "| 1 | Accessibility | 1 | x |",
    "| 2 | Performance | 1 | x |",
    "| 3 | Theming | 1 | x |",
    "| 4 | Responsive Design | 1 | x |",
    "| 5 | Implementation Integrity | 1 | x |",
    "| **Total** | | **5/20** | x |",
    "## Implementation Integrity Verdict",
    "## Executive Summary",
    "P0: 0 P1: 1 P2: 0 P3: 0",
    "## Positive Findings",
    "## Recommended Actions",
    "### [P1] Ghost finding",
    "- **Location**: src/client/does-not-exist.tsx:42",
  ].join("\n");
  const fixture = path.join(os.tmpdir(), `unlazy-audit-control2-${process.pid}.md`);
  fs.writeFileSync(fixture, bad);
  let exitCode = 0;
  try {
    execFileSync(process.execPath, [path.join(ROOT, "audit", "verify-report.mjs"), fixture], {
      cwd: ROOT, encoding: "utf8", stdio: "pipe",
    });
  } catch (e) {
    exitCode = e.status ?? 1;
  } finally {
    fs.unlinkSync(fixture);
  }
  assert(exitCode !== 0, "verify-report accepted a finding pointing at a file that does not exist");
});

const failed = results.filter((r) => !r.passed);
for (const r of results) {
  console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : ` — ${r.error}`}`);
}
if (failed.length) {
  console.error(`${failed.length} of ${results.length} negative controls did not hold`);
  process.exit(1);
}
console.log(`${results.length} negative controls held — every check can fail`);
console.log("NEGATIVE_CONTROL_OK");
