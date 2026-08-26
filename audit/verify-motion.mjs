// G4 — decide the reduced-motion verdict by counting, not by impression.
// Counts every transition/animation declaration in styles.css and every
// prefers-reduced-motion block, and flags transitions on layout-triggering
// properties (which force reflow rather than compositing).

import { readCss, writeJson, fail } from "./lib.mjs";

const LAYOUT_PROPS = ["width", "height", "top", "left", "right", "bottom", "margin", "padding", "font-size"];

const css = readCss();
const lines = css.split("\n");

const transitions = [];
const animations = [];
const keyframes = [];
const reducedMotionBlocks = [];

lines.forEach((raw, i) => {
  const line = raw.trim();
  const n = i + 1;
  if (/prefers-reduced-motion/.test(line)) reducedMotionBlocks.push({ line: n, text: line });
  if (/@keyframes/.test(line)) keyframes.push({ line: n, text: line });

  const t = line.match(/(?:^|[;{\s])transition\s*:\s*([^;}]+)/);
  if (t) {
    const value = t[1].trim();
    const props = value.split(",").map((s) => s.trim().split(/\s+/)[0]);
    const layout = props.filter((p) => LAYOUT_PROPS.includes(p));
    transitions.push({ line: n, value, props, layoutProps: layout, animatesLayout: layout.length > 0 });
  }

  const a = line.match(/(?:^|[;{\s])animation\s*:\s*([^;}]+)/);
  if (a) animations.push({ line: n, value: a[1].trim() });
});

const layoutAnimated = transitions.filter((t) => t.animatesLayout);
const infinite = animations.filter((a) => /\binfinite\b/.test(a.value));

// Positive control: the parser must actually find the declarations that exist.
if (transitions.length === 0 && animations.length === 0) {
  fail("parser found zero motion declarations in a file that visibly has them");
}

const verdict = reducedMotionBlocks.length === 0
  ? "NO_REDUCED_MOTION_SUPPORT"
  : "HAS_REDUCED_MOTION_BLOCKS";

writeJson("motion.json", {
  verdict,
  transitionCount: transitions.length,
  animationCount: animations.length,
  infiniteAnimationCount: infinite.length,
  keyframeCount: keyframes.length,
  reducedMotionBlockCount: reducedMotionBlocks.length,
  layoutAnimatedCount: layoutAnimated.length,
  layoutAnimated,
  infiniteAnimations: infinite,
  transitions,
  animations,
});

console.log(`transitions: ${transitions.length}`);
console.log(`animations: ${animations.length} (${infinite.length} infinite)`);
console.log(`@keyframes blocks: ${keyframes.length}`);
console.log(`prefers-reduced-motion blocks: ${reducedMotionBlocks.length}`);
console.log(`verdict: ${verdict}`);
console.log(`transitions on layout-triggering properties: ${layoutAnimated.length}`);
for (const t of layoutAnimated) {
  console.log(`  styles.css:${t.line} — transition: ${t.value} (layout props: ${t.layoutProps.join(", ")})`);
}
for (const a of infinite) console.log(`  infinite animation styles.css:${a.line} — ${a.value}`);
console.log("MOTION_MEASURE_OK");
