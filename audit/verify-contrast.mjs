// G2 — measure WCAG contrast for every foreground/background pair the UI
// actually composes, in both themes, from the token values in styles.css.
//
// Each pair below names the CSS rule that composes it, so a reader can check
// the pair is real rather than invented. Ratios are computed here from the
// parsed hex values; no ratio is copied in from anywhere.

import { readCss, themes, resolve, composite, contrast, writeJson, fail } from "./lib.mjs";

// [id, fgToken, bgToken, minRatio, kind, whereItComesFrom, fgAlpha]
// minRatio: 4.5 normal text (WCAG 1.4.3), 3.0 UI component / graphical (1.4.11)
const PAIRS = [
  ["body-text",          "ink",        "bg",          4.5, "text", "body { color: var(--ink); background: var(--bg) }"],
  ["panel-text",         "ink",        "panel",       4.5, "text", ".modal / .doc / .side-pane body copy"],
  ["panel2-text",        "ink",        "panel-2",     4.5, "text", "button { background: var(--panel-2); color: var(--ink) }"],
  ["panel3-text",        "ink",        "panel-3",     4.5, "text", "button:hover / .preset.on"],
  ["dim-on-panel",       "ink-dim",    "panel",       4.5, "text", ".gate-sub, .preset-desc, .worker"],
  ["dim-on-panel2",      "ink-dim",    "panel-2",     4.5, "text", ".linkbtn, .namebtn, .chat-action"],
  ["dim-on-bg",          "ink-dim",    "bg",          4.5, "text", ".status, .empty"],
  ["faint-on-panel",     "ink-faint",  "panel",       4.5, "text", ".rev, .doc-empty, .tool-summary, .approval-summary"],
  ["faint-on-panel2",    "ink-faint",  "panel-2",     4.5, "text", ".gauge-text, .invite-empty"],
  ["faint-on-bg",        "ink-faint",  "bg",          4.5, "text", ".empty-sub, .sys"],
  ["accent-on-panel",    "accent",     "panel",       4.5, "text", ".agent-who, .approval-tool, .field-value"],
  ["accent-on-bg",       "accent",     "bg",          4.5, "text", ".status-thinking, .side-small-action"],
  ["accent-on-panel3",   "accent",     "panel-3",     4.5, "text", ".segmented button.on { color: var(--accent) }"],
  ["accentink-on-accent","accent-ink", "accent",      4.5, "text", ".send, .primary, .side-icon-btn"],
  ["accentink-on-strong","accent-ink", "accent-strong",4.5,"text", ".send:hover, .primary:hover"],
  ["topbarink-on-topbar","topbar-ink", "topbar",      4.5, "text", ".bar { background: var(--topbar); color: var(--topbar-ink) }"],
  ["warn-on-bg",         "warn",       "bg",          4.5, "text", ".status-awaiting_approval"],
  ["warn-on-approval",   "warn",       "approval-bg", 4.5, "text", ".notice, .field-warn"],
  ["bad-on-danger",      "bad",        "danger-bg",   4.5, "text", ".banner.error, .stop, .policy-auto"],
  ["bad-on-panel",       "bad",        "panel",       4.5, "text", ".gate-error, .vote.deny.cast"],
  ["successink-on-success","success-ink","success-bg",4.5, "text", ".workers-head"],
  ["diffold",            "diff-old-ink","diff-old-bg",4.5, "text", ".diff-old"],
  ["diffnew",            "diff-new-ink","diff-new-bg",4.5, "text", ".diff-new"],
  // Non-text UI affordances — WCAG 1.4.11 threshold is 3:1.
  // --line is now a DIVIDER weight only: section rules, card outlines and the
  // status-label chips. WCAG 1.4.11 governs boundaries that identify a control,
  // and every such boundary moved to --line-strong (measured below). These two
  // rows stay in the report so the number is visible rather than dropped, but
  // they carry no threshold because nothing depends on them to find a control.
  ["divider-on-panel",   "line",       "panel",       0,   "decorative", ".modal, .approval, card outlines"],
  ["divider-on-bg",      "line",       "bg",          0,   "decorative", ".bar and .banner section rules"],
  ["gauge-fill",         "accent",     "line",        3.0, "ui",   ".gauge-fill over .gauge-track"],
  ["dot-online",         "ok",         "panel",       3.0, "ui",   ".dot-online, .worker-done .worker-dot"],
  ["dot-offline",        "ink-faint",  "panel",       3.0, "ui",   ".dot-offline, .worker-dot at rest"],
  ["pip-running",        "accent",     "panel",       3.0, "ui",   ".tool-pip-running"],
  ["focus-ring",         "accent",     "bg",          3.0, "ui",   "input:focus { border-color: var(--accent) }"],
  // Roles introduced by the colorize retune.
  ["control-border-bg",   "line-strong","bg",          3.0, "ui",   "input, textarea, select { border: 1px solid var(--line-strong) }"],
  ["control-border-panel","line-strong","panel",       3.0, "ui",   "a control sitting on an elevated panel"],
  ["control-border-p2",   "line-strong","panel-2",     3.0, "ui",   "a control sitting on a tinted surface"],
  ["topbar-quiet-ink",    "on-topbar-ink-dim","topbar",4.5, "text", ".bar .status"],
  ["logo-mid-on-topbar",  "logo-mid",   "topbar",      3.0, "ui",   ".logo-mark span"],
  ["logo-key-on-topbar",  "logo-key",   "topbar",      3.0, "ui",   ".logo-mark span:nth-child(2), :nth-child(3)"],
  ["logo-lift-on-topbar", "logo-lift",  "topbar",      3.0, "ui",   ".logo-mark span:nth-child(4)"],
];

// Pairs whose foreground is deliberately faded by an `opacity` declaration.
// [id, fgToken, bgToken, alpha, minRatio, where]
const FADED = [
  // WCAG exempts disabled controls from contrast; this row is kept so the
  // measurement still reports it rather than quietly dropping the case.
  ["disabled-45",    "ink",        "panel-2",0.45, 0,    "button:disabled { opacity: 0.45 } — WCAG-exempt"],
];

const css = readCss();
const { light, dark } = themes(css);
const results = [];

for (const themeName of ["light", "dark"]) {
  const theme = themeName === "light" ? light : dark;

  for (const [id, fgT, bgT, min, kind, where] of PAIRS) {
    const fg = resolve(theme, fgT);
    const bg = resolve(theme, bgT);
    const ratio = contrast(composite(fg, bg), bg);
    results.push({
      id, theme: themeName, fg: `--${fgT}`, bg: `--${bgT}`,
      fgValue: theme[fgT], bgValue: theme[bgT],
      ratio: Number(ratio.toFixed(2)), min, kind, where,
      pass: ratio >= min, faded: false,
    });
  }

  for (const [id, fgT, bgT, alpha, min, where] of FADED) {
    const bg = resolve(theme, bgT);
    const fg = resolve(theme, fgT);
    const effective = composite(fg, bg, alpha);
    const ratio = contrast(effective, bg);
    results.push({
      id, theme: themeName, fg: `--${fgT}`, bg: `--${bgT}`,
      fgValue: theme[fgT], bgValue: theme[bgT],
      alpha, ratio: Number(ratio.toFixed(2)), min, kind: "text", where,
      pass: ratio >= min, faded: true,
    });
  }
}

const failures = results.filter((r) => !r.pass);
const expectedRows = (PAIRS.length + FADED.length) * 2;

// Completeness invariants — the gate must fail if the measurement is partial.
if (results.length !== expectedRows) {
  fail(`expected ${expectedRows} measured rows, got ${results.length}`);
}
if (results.some((r) => !Number.isFinite(r.ratio) || r.ratio < 1)) {
  fail("a pair produced a non-finite or sub-1.0 ratio");
}
if (new Set(results.map((r) => `${r.theme}:${r.id}`)).size !== expectedRows) {
  fail("duplicate pair ids in results");
}
// Sanity control: pure white on pure black must measure 21:1, proving the math.
const control = contrast({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 });
if (Math.abs(control - 21) > 0.01) fail(`contrast math broken: white/black = ${control}`);

writeJson("contrast.json", {
  measuredRows: results.length,
  failing: failures.length,
  failures,
  results,
});

console.log(`measured ${results.length} pairs across 2 themes; ${failures.length} below threshold`);
for (const f of failures) {
  console.log(`  [${f.theme}] ${f.id}: ${f.fg} on ${f.bg} = ${f.ratio}:1 (needs ${f.min}) — ${f.where}`);
}
if (process.argv.includes("--strict")) {
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} pair(s) still below threshold`);
    process.exit(1);
  }
  console.log("CONTRAST_STRICT_OK");
} else {
  console.log("CONTRAST_MEASURE_OK");
}
