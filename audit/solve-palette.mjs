// Palette solver. Finds token values that satisfy every contrast constraint
// simultaneously while staying as close as possible to the incumbent hue —
// this is a retune of the Shared Desk world, not a replacement of it.

import { contrast, parseColor, composite } from "./lib.mjs";

function toHsl(hex) {
  const { r, g, b } = parseColor(hex);
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}
function toHex(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const t = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return "#" + t(r) + t(g) + t(b);
}
const ratio = (fg, bg) => contrast(composite(parseColor(fg), parseColor(bg)), parseColor(bg));

/**
 * Walk lightness away from the incumbent value (keeping hue, allowing a small
 * saturation nudge) until every constraint is met. Returns the *closest*
 * passing value, so the retune moves each token as little as it has to.
 */
function solve(startHex, constraints, { satAdjust = 0, direction = "darker" } = {}) {
  const [h, s0, l0] = toHsl(startHex);
  const s = Math.max(0, Math.min(100, s0 + satAdjust));
  const step = direction === "darker" ? -0.5 : 0.5;
  for (let i = 0; i <= 200; i++) {
    const l = l0 + step * i;
    if (l < 0 || l > 100) break;
    const hex = toHex(h, s, l);
    if (constraints.every(([against, min]) => ratio(hex, against) >= min)) {
      return { hex, from: startHex, moved: (l - l0).toFixed(1), ratios: constraints.map(([a, m]) => `${ratio(hex, a).toFixed(2)}/${m}`) };
    }
  }
  return null;
}

// ------------------------------------------------------------------ LIGHT
const L = { bg: "#eef6fd", panel: "#ffffff", panel2: "#f6faff", panel3: "#e8f3ff" };

console.log("=== LIGHT THEME ===");
// --accent must work as text on every surface it lands on, and as a fill
// behind white text (the same ratio, since contrast is symmetric).
const accentL = solve("#1683e8", [[L.panel, 4.5], [L.panel3, 4.5], [L.bg, 4.5], ["#ffffff", 4.5]]);
console.log("--accent        ", JSON.stringify(accentL));

// --ink-faint is the quiet tier; bg is the darkest surface it sits on.
const faintL = solve("#7b8a9e", [[L.bg, 4.5], [L.panel, 4.5], [L.panel2, 4.5]]);
console.log("--ink-faint     ", JSON.stringify(faintL));

const dimL = solve("#526278", [[L.bg, 7.0], [L.panel, 7.0]]);
console.log("--ink-dim       ", JSON.stringify(dimL));

const warnL = solve("#9b6a10", [[L.bg, 4.5], [L.panel, 4.5], ["#f3f8ff", 4.5]]);
console.log("--warn          ", JSON.stringify(warnL));

const badL = solve("#d43f3a", [["#fff0ef", 4.5], [L.panel, 4.5], [L.bg, 4.5]]);
console.log("--bad           ", JSON.stringify(badL));

const okL = solve("#2f8f5b", [["#eefaf3", 4.5], [L.panel, 4.5], [L.bg, 4.5]]);
console.log("--success-ink   ", JSON.stringify(okL));

const diffOldL = solve("#b33932", [["#fff1f0", 4.5]]);
console.log("--diff-old-ink  ", JSON.stringify(diffOldL));
const diffNewL = solve("#2f7c4c", [["#eefaf3", 4.5]]);
console.log("--diff-new-ink  ", JSON.stringify(diffNewL));

// New role: a border strong enough to identify a control (WCAG 1.4.11).
const lineStrongL = solve("#cddced", [[L.bg, 3.0], [L.panel, 3.0], [L.panel2, 3.0]]);
console.log("--line-strong   ", JSON.stringify(lineStrongL));

// ------------------------------------------------------------------- DARK
const D = { bg: "#10141c", panel: "#161b24", panel2: "#202734", panel3: "#14243a" };

console.log("\n=== DARK THEME ===");
const faintD = solve("#718094", [[D.panel2, 4.5], [D.panel, 4.5], [D.bg, 4.5]], { direction: "lighter" });
console.log("--ink-faint     ", JSON.stringify(faintD));

const dimD = solve("#aab7c8", [[D.panel2, 7.0], [D.panel, 7.0]], { direction: "lighter" });
console.log("--ink-dim       ", JSON.stringify(dimD));

const accentD = solve("#5aa7ff", [[D.panel, 4.5], [D.bg, 4.5], [D.panel3, 4.5]], { direction: "lighter" });
console.log("--accent        ", JSON.stringify(accentD));

const lineStrongD = solve("#303948", [[D.bg, 3.0], [D.panel, 3.0], [D.panel2, 3.0]], { direction: "lighter" });
console.log("--line-strong   ", JSON.stringify(lineStrongD));

const okD = solve("#6bc48c", [[D.panel, 4.5], ["#13261c", 4.5]], { direction: "lighter" });
console.log("--ok            ", JSON.stringify(okD));
const badD = solve("#ff766d", [[D.panel, 4.5], ["#351b1e", 4.5]], { direction: "lighter" });
console.log("--bad           ", JSON.stringify(badD));
const warnD = solve("#ffd36e", [[D.panel, 4.5], ["#171f2d", 4.5]], { direction: "lighter" });
console.log("--warn          ", JSON.stringify(warnD));

// White text on the dark theme's accent fill.
console.log("\n--accent-ink #07111f on solved dark accent:",
  accentD ? ratio("#07111f", accentD.hex).toFixed(2) : "n/a");
