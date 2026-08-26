// G5 — inventory every interactive element the client TSX renders and flag the
// ones with no accessible name. An element is named if it has non-whitespace
// text content, an aria-label / aria-labelledby / title, or (for form controls)
// an id referenced by a <label htmlFor>.

import fs from "node:fs";
import path from "node:path";
import { ROOT, writeJson, fail } from "./lib.mjs";

const FILES = ["App.tsx", "RoomView.tsx", "components.tsx", "Settings.tsx"]
  .map((f) => path.join(ROOT, "src", "client", f));

const TAGS = ["button", "input", "select", "textarea", "summary", "a", "details"];

const elements = [];
const labelFor = new Set();

for (const file of FILES) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");

  for (const m of src.matchAll(/htmlFor=\{?["'`]([^"'`}]+)/g)) labelFor.add(m[1]);

  for (const tag of TAGS) {
    // Opening tag plus, for non-void tags, everything up to the matching close.
    const re = new RegExp(`<${tag}(\\s[^>]*?)?(/>|>)`, "g");
    for (const m of src.matchAll(re)) {
      const attrs = m[1] || "";
      const selfClosing = m[2] === "/>";
      const start = m.index;
      const line = src.slice(0, start).split("\n").length;

      let inner = "";
      if (!selfClosing) {
        const closeIdx = src.indexOf(`</${tag}>`, start);
        if (closeIdx !== -1) inner = src.slice(start + m[0].length, closeIdx);
      }

      const hasAria = /aria-label\s*=/.test(attrs) || /aria-labelledby\s*=/.test(attrs) || /title\s*=/.test(attrs);
      const idMatch = attrs.match(/\bid=\{?["'`]([^"'`}]+)/);
      const hasLabelFor = idMatch ? labelFor.has(idMatch[1]) : false;

      // Implicit labelling: a <label> that opens before this control and closes
      // after it wraps the control, which names it without htmlFor.
      let wrappedByLabel = false;
      {
        const before = src.slice(0, start);
        const lastLabelOpen = before.lastIndexOf("<label");
        if (lastLabelOpen !== -1) {
          const lastLabelClose = before.lastIndexOf("</label>");
          if (lastLabelClose < lastLabelOpen) {
            const closeAfter = src.indexOf("</label>", start);
            const nextOpenAfter = src.indexOf("<label", start);
            if (closeAfter !== -1 && (nextOpenAfter === -1 || closeAfter < nextOpenAfter)) {
              wrappedByLabel = true;
            }
          }
        }
      }

      const hasPlaceholder = /placeholder\s*=/.test(attrs);

      // Text content: strip nested JSX tags and expression braces, then see if
      // anything renderable is left. An icon-only glyph still counts as text.
      const text = inner
        .replace(/<[^>]*>/g, " ")
        .replace(/\{[^{}]*\}/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const hasChildExpression = /\{[^{}]*\}/.test(inner);

      const type = (attrs.match(/type=\{?["'`](\w+)/) || [])[1] || null;
      const isHiddenInput = type === "hidden";
      if (isHiddenInput) continue;

      const named = hasAria || hasLabelFor || wrappedByLabel || text.length > 0;
      elements.push({
        file: rel, line, tag, type,
        attrs: attrs.trim().slice(0, 110),
        text: text.slice(0, 60),
        hasAria, hasLabelFor, wrappedByLabel, hasPlaceholder,
        hasText: text.length > 0, hasChildExpression,
        named,
        // A control named only by a runtime expression can't be verified statically.
        indeterminate: !named && hasChildExpression,
      });
    }
  }
}

const unnamed = elements.filter((e) => !e.named && !e.indeterminate);
const indeterminate = elements.filter((e) => e.indeterminate);
const formControls = elements.filter((e) => ["input", "select", "textarea"].includes(e.tag));
const unlabeledControls = formControls.filter((e) => !e.hasAria && !e.hasLabelFor && !e.wrappedByLabel);
// Controls whose only visible naming is a placeholder — an accname of last
// resort that disappears the moment the user types (WCAG 2.4.6 / 3.3.2).
const placeholderOnly = unlabeledControls.filter((e) => e.hasPlaceholder);

if (elements.length === 0) fail("parser found zero interactive elements across the client");
if (!FILES.every((f) => fs.existsSync(f))) fail("a declared source file is missing");

writeJson("a11y-names.json", {
  scannedFiles: FILES.map((f) => path.relative(ROOT, f).replace(/\\/g, "/")),
  totalInteractive: elements.length,
  unnamedCount: unnamed.length,
  indeterminateCount: indeterminate.length,
  formControlCount: formControls.length,
  unlabeledFormControlCount: unlabeledControls.length,
  placeholderOnlyCount: placeholderOnly.length,
  unnamed, indeterminate, unlabeledControls, placeholderOnly, elements,
});

console.log(`interactive elements found: ${elements.length}`);
console.log(`  with no static accessible name: ${unnamed.length}`);
for (const e of unnamed) console.log(`    ${e.file}:${e.line} <${e.tag}${e.type ? ` type=${e.type}` : ""}> ${e.attrs}`);
console.log(`  named only by a runtime expression (needs manual read): ${indeterminate.length}`);
console.log(`  form controls: ${formControls.length}`);
console.log(`    with no label at all (no aria-label, no htmlFor, no wrapping <label>): ${unlabeledControls.length}`);
for (const e of unlabeledControls) {
  console.log(`      ${e.file}:${e.line} <${e.tag}${e.type ? ` type=${e.type}` : ""}>${e.hasPlaceholder ? " [placeholder only]" : " [no name at all]"}`);
}
console.log(`    of those, relying on a placeholder as the only name: ${placeholderOnly.length}`);
console.log("A11Y_NAME_MEASURE_OK");
