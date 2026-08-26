// Shared measurement helpers for the collab_ai design audit.
// Everything here derives from src/client/styles.css; nothing is hard-coded
// from a supplied figure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CSS_PATH = path.join(ROOT, "src", "client", "styles.css");

export function readCss() {
  return fs.readFileSync(CSS_PATH, "utf8");
}

/** Parse the custom properties out of a specific `:root...` block. */
export function parseTokens(css, selector) {
  const idx = css.indexOf(selector);
  if (idx === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf("{", idx);
  const close = css.indexOf("}", open);
  const block = css.slice(open + 1, close);
  const out = {};
  for (const m of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/** Light theme = the bare `:root {`; dark theme layers over it. */
export function themes(css) {
  const light = parseTokens(css, ":root {");
  const darkOverrides = parseTokens(css, ':root[data-theme="dark"]');
  return { light, dark: { ...light, ...darkOverrides }, darkOverrides };
}

// ---------------------------------------------------------------- color math

export function parseColor(str) {
  const s = String(str).trim();
  let m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  throw new Error(`unparseable color: ${str}`);
}

/** Composite a possibly-translucent foreground over an opaque backdrop. */
export function composite(fg, bg, extraAlpha = 1) {
  const a = fg.a * extraAlpha;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(c) {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

export function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Resolve a token name (or literal color) against a theme map. */
export function resolve(theme, nameOrLiteral) {
  if (nameOrLiteral.startsWith("#") || nameOrLiteral.startsWith("rgb")) {
    return parseColor(nameOrLiteral);
  }
  const v = theme[nameOrLiteral];
  if (v === undefined) throw new Error(`unknown token: --${nameOrLiteral}`);
  return parseColor(v);
}

export function writeJson(name, data) {
  const p = path.join(ROOT, "audit", name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  return p;
}

export function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
