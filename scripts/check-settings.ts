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
import {
  ROLE_CAPS,
  asRole,
  can,
  isVoter,
  outranks,
  type Capability,
  type Role,
} from "../src/shared/access";

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

// Viewers are present but do not count toward the denominator, so a room of
// 2 editors + 1 viewer needs 2 votes (strict majority of 2 voters), not
// 2-of-3 as a naive headcount would suggest.
const twoEditorsOneViewer: Role[] = ["editor", "editor", "viewer"];
const eligible = twoEditorsOneViewer.filter(isVoter).length;
check("2 editors + 1 viewer: only 2 are vote-eligible", eligible === 2, eligible);
check(
  "2 editors + 1 viewer needs 2 votes, not 2-of-3",
  thresholdFor(eligible) === 2,
  thresholdFor(eligible),
);

console.log("\nworker autoscaling");
const auto = { ...DEFAULT_SETTINGS, scaling: { mode: "auto" as const, maxWorkers: 4 } };
check("auto scales with headcount", effectiveWorkerCap(auto, 3) === 5, effectiveWorkerCap(auto, 3));
check("auto is capped at 8", effectiveWorkerCap(auto, 50) === 8, effectiveWorkerCap(auto, 50));
const fixed = { ...DEFAULT_SETTINGS, scaling: { mode: "fixed" as const, maxWorkers: 2 } };
check("fixed ignores headcount", effectiveWorkerCap(fixed, 50) === 2, effectiveWorkerCap(fixed, 50));

console.log("\naccess control");

// A viewer has no capabilities at all.
check("viewer has zero capabilities", ROLE_CAPS.viewer.length === 0, ROLE_CAPS.viewer);

// An editor can speak and vote but cannot change settings, invite, or manage members.
check("editor can speak", can("editor", "speak"));
check("editor can vote", can("editor", "vote"));
check("editor can compact", can("editor", "compact"));
check("editor cannot change settings", !can("editor", "settings"));
check("editor cannot invite", !can("editor", "invite"));
check("editor cannot manage members", !can("editor", "manage_members"));
check("editor cannot admin_room", !can("editor", "admin_room"));
check("editor cannot policy", !can("editor", "policy"));

// An admin can invite and manage members but cannot admin_room.
check("admin can invite", can("admin", "invite"));
check("admin can manage members", can("admin", "manage_members"));
check("admin cannot admin_room", !can("admin", "admin_room"));

// An owner can do every capability in the union.
const allCaps: Capability[] = [
  "speak",
  "vote",
  "compact",
  "settings",
  "policy",
  "invite",
  "manage_members",
  "admin_room",
];
check(
  "owner can do every capability",
  allCaps.every((cap) => can("owner", cap)),
  allCaps.filter((cap) => !can("owner", cap)),
);

// outranks is strict: only a role above another outranks it, and nobody outranks themself.
check("owner outranks admin", outranks("owner", "admin"));
check("admin outranks editor", outranks("admin", "editor"));
check("editor outranks viewer", outranks("editor", "viewer"));
check("owner does not outrank itself", !outranks("owner", "owner"));
check("admin does not outrank itself", !outranks("admin", "admin"));
check("editor does not outrank itself", !outranks("editor", "editor"));
check("viewer does not outrank itself", !outranks("viewer", "viewer"));

// isVoter matches the "vote" capability exactly.
check("owner is a voter", isVoter("owner"));
check("admin is a voter", isVoter("admin"));
check("editor is a voter", isVoter("editor"));
check("viewer is not a voter", !isVoter("viewer"));

// asRole defaults anything unrecognized to the least powerful role.
check("asRole(null) is viewer", asRole(null) === "viewer", asRole(null));
check("asRole(undefined) is viewer", asRole(undefined) === "viewer", asRole(undefined));
check("asRole('') is viewer", asRole("") === "viewer", asRole(""));
check("asRole('OWNER') is viewer", asRole("OWNER") === "viewer", asRole("OWNER"));
check("asRole('superuser') is viewer", asRole("superuser") === "viewer", asRole("superuser"));
check("asRole(42) is viewer", asRole(42) === "viewer", asRole(42));

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
