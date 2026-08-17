/**
 * Guard checks for `sanitizeSettings`, the only thing between a crafted
 * WebSocket frame and an invalid parameter on the wire.
 *
 * Run: npm run check
 */
import {
  DEFAULT_SETTINGS,
  effectiveWorkerCap,
  modelInfo,
  sanitizeSettings,
} from "../src/shared/models";
import { thresholdFor } from "../src/shared/protocol";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

console.log("\nsanitizeSettings");

// A model that rejects temperature must never carry one through.
const t1 = sanitizeSettings({ ...DEFAULT_SETTINGS, agentModel: "claude-opus-5", temperature: 0.9 });
check("drops temperature on Opus 5", t1.temperature === null, t1.temperature);

const t2 = sanitizeSettings({ ...DEFAULT_SETTINGS, agentModel: "claude-sonnet-4-6", temperature: 0.9 });
check("keeps temperature on Sonnet 4.6", t2.temperature === 0.9, t2.temperature);

const t3 = sanitizeSettings({ ...DEFAULT_SETTINGS, agentModel: "claude-sonnet-4-6", temperature: 42 });
check("clamps out-of-range temperature", t3.temperature === 1, t3.temperature);

// Effort must be one the model actually accepts.
const e1 = sanitizeSettings({ ...DEFAULT_SETTINGS, agentModel: "claude-sonnet-4-6", effort: "xhigh" });
check("rejects xhigh on Sonnet 4.6", e1.effort !== "xhigh", e1.effort);

const e2 = sanitizeSettings({ ...DEFAULT_SETTINGS, agentModel: "claude-opus-5", effort: "xhigh" });
check("allows xhigh on Opus 5", e2.effort === "xhigh", e2.effort);

// Unknown or role-inappropriate models fall back rather than reaching the API.
const m1 = sanitizeSettings({ ...DEFAULT_SETTINGS, agentModel: "gpt-4o" });
check("rejects an unknown model", m1.agentModel === DEFAULT_SETTINGS.agentModel, m1.agentModel);

const m2 = sanitizeSettings({ ...DEFAULT_SETTINGS, agentModel: "claude-haiku-4-5" });
check("rejects Haiku as manager", m2.agentModel !== "claude-haiku-4-5", m2.agentModel);

const m3 = sanitizeSettings({ ...DEFAULT_SETTINGS, workerModel: "claude-opus-5" });
check("rejects Opus 5 as worker", m3.workerModel !== "claude-opus-5", m3.workerModel);

// Worker cap is bounded no matter what arrives.
const w1 = sanitizeSettings({
  ...DEFAULT_SETTINGS,
  scaling: { mode: "fixed", maxWorkers: 9999 },
});
check("clamps worker count", w1.scaling.maxWorkers === 8, w1.scaling.maxWorkers);

// Context limit can never exceed the model's own window.
const c1 = sanitizeSettings({
  ...DEFAULT_SETTINGS,
  agentModel: "claude-sonnet-4-6",
  workerModel: "claude-haiku-4-5",
  context: { compactAfterMessages: -5, maxContextTokens: 9_000_000, keepRecentMessages: 999 },
});
check(
  "clamps token limit to the model window",
  c1.context.maxContextTokens <= modelInfo("claude-sonnet-4-6").contextWindow,
  c1.context.maxContextTokens,
);
check("clamps negative message threshold", c1.context.compactAfterMessages === 0, c1.context.compactAfterMessages);
check("clamps keepRecent", c1.context.keepRecentMessages === 40, c1.context.keepRecentMessages);

// Garbage in, defaults out — never a throw.
const g1 = sanitizeSettings(null);
check("survives null", g1.agentModel === DEFAULT_SETTINGS.agentModel);
const g2 = sanitizeSettings({ workflow: "../../etc", scaling: "nope", context: 7 });
check("survives nonsense", g2.workflow === "manager" && g2.scaling.maxWorkers > 0, g2);

console.log("\nvoting threshold (strict majority)");
check("1 person needs 1", thresholdFor(1) === 1, thresholdFor(1));
check("2 people need 2", thresholdFor(2) === 2, thresholdFor(2));
check("3 people need 2", thresholdFor(3) === 2, thresholdFor(3));
check("4 people need 3", thresholdFor(4) === 3, thresholdFor(4));
check("empty room still needs 1", thresholdFor(0) === 1, thresholdFor(0));

console.log("\nworker autoscaling");
const auto = { ...DEFAULT_SETTINGS, scaling: { mode: "auto" as const, maxWorkers: 4 } };
check("auto scales with headcount", effectiveWorkerCap(auto, 3) === 5, effectiveWorkerCap(auto, 3));
check("auto is capped at 8", effectiveWorkerCap(auto, 50) === 8, effectiveWorkerCap(auto, 50));
const fixed = { ...DEFAULT_SETTINGS, scaling: { mode: "fixed" as const, maxWorkers: 2 } };
check("fixed ignores headcount", effectiveWorkerCap(fixed, 50) === 2, effectiveWorkerCap(fixed, 50));

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
