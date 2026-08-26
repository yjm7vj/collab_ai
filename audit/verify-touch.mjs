// G3 — measure the effective minimum touch height of every interactive rule in
// styles.css. Height comes from an explicit `height`/`min-height`, otherwise
// from vertical padding + the rule's own font-size (or the 15px/1.55 body
// default) + border, matching how the box actually resolves.

import fs from "node:fs";
import { readCss, writeJson, fail } from "./lib.mjs";

const BODY_FONT = 15;
const BODY_LINE = 1.55;

// Selectors that produce a pointer target. A rule counts if its selector names
// a button/input/select/summary, or a class the TSX renders with onClick.
const INTERACTIVE = /(^|[\s,>])(button|input|select|textarea|summary|a)\b|\.(btn|chip-|side-item|side-project-head|side-room-card|ws-repo|preset|policy-mode-opt|segmented|linkbtn|namebtn|icon|send|stop|mini|vote|theme-toggle|doc-close|doc-reopen|side-icon-btn|chat-action|side-small-action|tool-head|link)/;

const css = readCss();
const lines = css.split("\n");

// Walk top-level rules, tracking any @media wrapper so we can report context.
const rules = [];
let depth = 0;
let media = null;
let current = null;

lines.forEach((raw, i) => {
  const line = raw.trim();
  if (line.startsWith("@media")) {
    media = line.replace(/\s*\{$/, "");
    depth++;
    return;
  }
  const opens = (raw.match(/\{/g) || []).length;
  const closes = (raw.match(/\}/g) || []).length;

  if (opens && !current) {
    const selector = raw.slice(0, raw.indexOf("{")).trim();
    if (selector && !selector.startsWith("@")) {
      current = { selector, line: i + 1, media, body: "" };
    }
    depth += opens;
    if (closes) {
      if (current) { rules.push(current); current = null; }
      depth -= closes;
      if (depth <= 0) { depth = 0; media = null; }
    }
    return;
  }
  if (current) {
    if (closes) {
      rules.push(current);
      current = null;
      depth -= closes;
      if (depth <= 0 && media) { depth = 0; media = null; }
      return;
    }
    current.body += line + " ";
    return;
  }
  if (closes) {
    depth -= closes;
    if (depth <= 0) { depth = 0; media = null; }
  }
});

// Same-line rules (`.foo { a: b; }`) are common in this file; capture them too.
for (const m of css.matchAll(/(^|\n)([^\n{}@]+)\{([^{}]*)\}/g)) {
  const selector = m[2].trim();
  if (!selector) continue;
  const line = css.slice(0, m.index).split("\n").length;
  if (!rules.some((r) => r.selector === selector && Math.abs(r.line - line) < 2)) {
    rules.push({ selector, line, media: null, body: m[3] });
  }
}

function decl(body, prop) {
  const m = body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
}
function px(v) {
  if (!v) return null;
  const m = String(v).match(/(-?[\d.]+)px/);
  return m ? parseFloat(m[1]) : null;
}
function padY(body) {
  const p = decl(body, "padding");
  if (p) {
    const parts = p.split(/\s+/);
    const top = px(parts[0]);
    const bottom = parts.length >= 3 ? px(parts[2]) : top;
    if (top !== null) return (top ?? 0) + (bottom ?? 0);
  }
  const t = px(decl(body, "padding-top"));
  const b = px(decl(body, "padding-bottom"));
  if (t !== null || b !== null) return (t ?? 0) + (b ?? 0);
  return null;
}

const measured = [];
for (const r of rules) {
  if (!INTERACTIVE.test(r.selector)) continue;
  if (/::?(before|after|placeholder)/.test(r.selector)) continue;
  const body = r.body;
  const explicit = px(decl(body, "height")) ?? px(decl(body, "min-height"));
  const pad = padY(body);
  const fs_ = px(decl(body, "font-size"));
  const border = /border\s*:\s*(?:none|0)/.test(body) ? 0
    : px(decl(body, "border-width")) ?? (/border(-\w+)?\s*:/.test(body) || /^(button|input|select|textarea)/.test(r.selector.trim()) ? 2 : 0);

  let height = null;
  let basis = null;
  if (explicit !== null) {
    height = explicit;
    basis = decl(body, "height") ? "height" : "min-height";
  } else if (pad !== null) {
    const text = fs_ !== null ? fs_ * 1.25 : BODY_FONT * BODY_LINE;
    height = pad + text + border;
    basis = "padding+text";
  }
  if (height === null) continue;

  measured.push({
    selector: r.selector,
    line: r.line,
    media: r.media,
    height: Number(height.toFixed(1)),
    basis,
    meetsAAA: height >= 44,   // WCAG 2.5.5 Target Size (Enhanced), AAA
    meetsAA: height >= 24,    // WCAG 2.5.8 Target Size (Minimum), AA
  });
}

measured.sort((a, b) => a.height - b.height);
const underAA = measured.filter((m) => !m.meetsAA);
const underAAA = measured.filter((m) => !m.meetsAAA);

if (measured.length === 0) fail("no interactive rules measured — the parser found nothing");
if (measured.some((m) => !Number.isFinite(m.height))) fail("a rule produced a non-finite height");

writeJson("touch.json", {
  measuredRules: measured.length,
  underAA: underAA.length,
  underAAA: underAAA.length,
  aaFailures: underAA,
  aaaFailures: underAAA,
  all: measured,
});

console.log(`measured ${measured.length} interactive rules`);
console.log(`  under 24px (WCAG 2.5.8 AA): ${underAA.length}`);
for (const m of underAA) console.log(`    ${m.selector} — ${m.height}px (styles.css:${m.line})`);
console.log(`  under 44px (WCAG 2.5.5 AAA): ${underAAA.length}`);
console.log("TOUCH_TARGET_MEASURE_OK");
