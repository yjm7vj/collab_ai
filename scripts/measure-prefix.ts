/**
 * What a room actually sends before anyone has said anything interesting.
 *
 * Estimate only — chars/4 is a stand-in for the tokenizer, good to maybe 10%.
 * Run: npx esbuild scripts/measure-prefix.ts --bundle --format=esm --platform=node
 *      --outfile=node_modules/.cache/measure.mjs && node node_modules/.cache/measure.mjs
 */
import { SYSTEM_PROMPT, leadPlanFor } from "../src/server/model";
import { DEFAULT_POLICY } from "../src/shared/access";
import { DEFAULT_SETTINGS } from "../src/shared/models";
import { toolsForRoom } from "../src/server/tools";

const est = (s: string) => Math.round(s.length / 4);

// Built the way the room builds it, so this measures what actually ships
// rather than SYSTEM_PROMPT alone — the default preset is `manager`, which
// appends the delegation addendum.
const system = leadPlanFor(DEFAULT_SETTINGS, null).system;

for (const [label, connected] of [
  ["chat-only room (no workspace)", false],
  ["room with a workspace connected", true],
] as const) {
  const tools = toolsForRoom(
    DEFAULT_POLICY,
    DEFAULT_SETTINGS.workflow,
    connected,
    DEFAULT_SETTINGS.agentModel,
  );
  const toolJson = JSON.stringify(tools);
  const sysTokens = est(system);
  const toolTokens = est(toolJson);
  const total = sysTokens + toolTokens;

  console.log(`\n${label}`);
  console.log(`  system prompt   ~${sysTokens.toLocaleString()} tokens (${system.length} chars)`);
  console.log(`  tool schemas    ~${toolTokens.toLocaleString()} tokens (${tools.length} tools)`);
  console.log(`  prefix total    ~${total.toLocaleString()} tokens`);

  const inRate = 5 / 1_000_000; // Opus 5 input, $/token
  console.log(`  cold, uncached      $${(total * inRate).toFixed(4)}`);
  console.log(`  cache write @1.25x  $${(total * inRate * 1.25).toFixed(4)}  (5m TTL)`);
  console.log(`  cache write @2x     $${(total * inRate * 2).toFixed(4)}  (1h TTL)`);
  console.log(`  cache read  @0.1x   $${(total * inRate * 0.1).toFixed(4)}  (every later turn)`);
}

console.log(`\noutput side, for scale (Opus 5 @ $25/1M):`);
for (const n of [200, 500, 1000, 2000]) {
  console.log(`  ${String(n).padStart(4)} output+thinking tokens  $${((n * 25) / 1_000_000).toFixed(4)}`);
}
console.log(`\nSYSTEM_PROMPT alone: ${SYSTEM_PROMPT.length} chars`);
