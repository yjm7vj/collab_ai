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
import { REDACTED, redactEntry, thresholdFor } from "../src/shared/protocol";
import {
  ROLE_CAPS,
  TOOL_NAMES,
  approvalThreshold,
  asRole,
  can,
  canSeeFileContents,
  isFileContentTool,
  isVoter,
  outranks,
  resolveTools,
  sanitizeAccessPolicy,
  type Capability,
  type Role,
} from "../src/shared/access";
import { DEFAULT_DENY, DEFAULT_PATH_POLICY } from "../src/shared/workspace";
import { gatedFor, toolsFor, toolsForRoom } from "../src/server/tools";

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

console.log("\nagent permission policy");

const basePolicy = {
  mode: "ask" as const,
  tools: {} as never,
  approval: "majority" as const,
  paths: DEFAULT_PATH_POLICY,
};

const readOnlyDecisions = resolveTools({ ...basePolicy, mode: "read_only" });
check("read_only denies write_doc", readOnlyDecisions.write_doc === "deny", readOnlyDecisions.write_doc);
check("read_only denies edit_doc", readOnlyDecisions.edit_doc === "deny", readOnlyDecisions.edit_doc);
check("read_only allows read_doc", readOnlyDecisions.read_doc === "allow", readOnlyDecisions.read_doc);

const askDecisions = resolveTools({ ...basePolicy, mode: "ask" });
check("ask marks write_doc as ask", askDecisions.write_doc === "ask", askDecisions.write_doc);
check("ask marks edit_doc as ask", askDecisions.edit_doc === "ask", askDecisions.edit_doc);

const autoDecisions = resolveTools({ ...basePolicy, mode: "auto" });
check(
  // delete_file is the deliberate exception: deleting someone's file is not
  // symmetric with editing it, so auto-accept does not extend to it.
  "auto allows everything except delete_file",
  Object.entries(autoDecisions).every(([name, d]) => (name === "delete_file" ? d === "ask" : d === "allow")),
  autoDecisions,
);

const gatedAuto = gatedFor({ ...basePolicy, mode: "auto" });
check(
  "gatedFor under auto is exactly delete_file",
  gatedAuto.size === 1 && gatedAuto.has("delete_file"),
  [...gatedAuto],
);
check("gatedFor under auto does not include write_file", !gatedAuto.has("write_file"), [...gatedAuto]);
check("gatedFor under auto does not include edit_file", !gatedAuto.has("edit_file"), [...gatedAuto]);

const gatedAsk = gatedFor({ ...basePolicy, mode: "ask" });
check(
  "gatedFor under ask is exactly write_doc, edit_doc, write_file, edit_file, delete_file",
  gatedAsk.size === 5 &&
    gatedAsk.has("write_doc") &&
    gatedAsk.has("edit_doc") &&
    gatedAsk.has("write_file") &&
    gatedAsk.has("edit_file") &&
    gatedAsk.has("delete_file"),
  [...gatedAsk],
);

const readOnlyTools = toolsFor({ ...basePolicy, mode: "read_only" }, "solo") as { name?: string }[];
const readOnlyNames = readOnlyTools.map((t) => t.name);
check("toolsFor(read_only) excludes write_doc", !readOnlyNames.includes("write_doc"), readOnlyNames);
check("toolsFor(read_only) excludes edit_doc", !readOnlyNames.includes("edit_doc"), readOnlyNames);
check("toolsFor(read_only) includes read_doc", readOnlyNames.includes("read_doc"), readOnlyNames);

// The distinction the whole phase rests on: gated is not the same as removed.
// Under "ask", write_doc is still offered to the model — it is voted on only
// once the model actually calls it — whereas under "read_only" it is withheld
// entirely so the agent never proposes a call it cannot make.
const askTools = toolsFor({ ...basePolicy, mode: "ask" }, "solo") as { name?: string }[];
const askNames = askTools.map((t) => t.name);
check("toolsFor(ask) still includes write_doc (gated, not removed)", askNames.includes("write_doc"), askNames);

const managerTools = toolsFor({ ...basePolicy, mode: "ask" }, "manager") as { name?: string }[];
const soloTools = toolsFor({ ...basePolicy, mode: "ask" }, "solo") as { name?: string }[];
check(
  "toolsFor manager includes delegate",
  managerTools.some((t) => t.name === "delegate"),
  managerTools.map((t) => t.name),
);
check(
  "toolsFor solo excludes delegate",
  !soloTools.some((t) => t.name === "delegate"),
  soloTools.map((t) => t.name),
);

check("majority of 4 is 3", approvalThreshold("majority", 4) === 3, approvalThreshold("majority", 4));
check("unanimous of 4 is 4", approvalThreshold("unanimous", 4) === 4, approvalThreshold("unanimous", 4));
check("unanimous of 0 is 1", approvalThreshold("unanimous", 0) === 1, approvalThreshold("unanimous", 0));
check("any_editor of 9 is 1", approvalThreshold("any_editor", 9) === 1, approvalThreshold("any_editor", 9));
check("owner_only of 9 is 1", approvalThreshold("owner_only", 9) === 1, approvalThreshold("owner_only", 9));

// Unknown values must fall back to the most restrictive option, never the
// most permissive — a malformed frame must not be a way to turn approval off.
const p1 = sanitizeAccessPolicy({});
check("sanitizeAccessPolicy({}) mode is ask", p1.mode === "ask", p1.mode);
check("sanitizeAccessPolicy({}) approval is majority", p1.approval === "majority", p1.approval);

const p2 = sanitizeAccessPolicy(null);
check("sanitizeAccessPolicy(null) mode is ask", p2.mode === "ask", p2.mode);
check("sanitizeAccessPolicy(null) approval is majority", p2.approval === "majority", p2.approval);

const p3 = sanitizeAccessPolicy({ mode: "nonsense" });
check("sanitizeAccessPolicy({mode:'nonsense'}) mode is ask", p3.mode === "ask", p3.mode);
check("sanitizeAccessPolicy({mode:'nonsense'}) approval is majority", p3.approval === "majority", p3.approval);

const p4 = sanitizeAccessPolicy({ approval: "whatever" });
check("sanitizeAccessPolicy({approval:'whatever'}) mode is ask", p4.mode === "ask", p4.mode);
check("sanitizeAccessPolicy({approval:'whatever'}) approval is majority", p4.approval === "majority", p4.approval);

// A malformed per-tool decision must never resolve to "allow" — that would be
// a way to switch approval off by sending garbage instead of a real value.
const p5 = sanitizeAccessPolicy({ tools: { write_doc: "banana" } });
check(
  "sanitizeAccessPolicy({tools:{write_doc:'banana'}}) does not yield allow",
  p5.tools.write_doc !== "allow",
  p5.tools.write_doc,
);

console.log("\nworkspace file tools");

const FILE_TOOLS = ["list_files", "read_file", "search_files"] as const;

check(
  "TOOL_NAMES contains the three file tools",
  FILE_TOOLS.every((n) => (TOOL_NAMES as readonly string[]).includes(n)),
  TOOL_NAMES,
);

for (const mode of ["read_only", "ask", "auto"] as const) {
  const decisions = resolveTools({ ...basePolicy, mode });
  check(
    `${mode} allows all three file tools`,
    FILE_TOOLS.every((n) => decisions[n] === "allow"),
    FILE_TOOLS.map((n) => [n, decisions[n]]),
  );
}

const p6 = sanitizeAccessPolicy({});
check(
  "sanitizeAccessPolicy({}) paths.deny contains the default deny entries",
  DEFAULT_DENY.every((g) => p6.paths.deny.includes(g)),
  p6.paths.deny,
);

// A client cannot shrink the path deny list by sending an empty array for it
// — sanitizePathPolicy always unions the defaults back in, so the policy can
// never be widened from the wire.
const p7 = sanitizeAccessPolicy({ paths: { deny: [] } });
check(
  "sanitizeAccessPolicy({paths:{deny:[]}}) still contains every default deny entry",
  DEFAULT_DENY.every((g) => p7.paths.deny.includes(g)),
  p7.paths.deny,
);

const offlineTools = toolsForRoom({ ...basePolicy, mode: "auto" }, "solo", false) as { name?: string }[];
const offlineNames = offlineTools.map((t) => t.name);
check(
  "toolsForRoom(policy, 'solo', false) contains none of the file tools",
  FILE_TOOLS.every((n) => !offlineNames.includes(n)),
  offlineNames,
);

const onlineTools = toolsForRoom({ ...basePolicy, mode: "auto" }, "solo", true) as { name?: string }[];
const onlineNames = onlineTools.map((t) => t.name);
check(
  "toolsForRoom(policy, 'solo', true) contains all three file tools",
  FILE_TOOLS.every((n) => onlineNames.includes(n)),
  onlineNames,
);

// toolsForRoom composes with the existing per-tool filter: a denied doc tool
// stays denied whether or not the workspace is online.
const deniedDocPolicy = {
  ...basePolicy,
  mode: "custom" as const,
  tools: { ...resolveTools({ ...basePolicy, mode: "auto" }), read_doc: "deny" as const },
};
const composedTools = toolsForRoom(deniedDocPolicy, "solo", true) as { name?: string }[];
const composedNames = composedTools.map((t) => t.name);
check(
  "toolsForRoom(workspaceOnline: true) still excludes a denied doc tool",
  !composedNames.includes("read_doc"),
  composedNames,
);
check(
  "toolsForRoom(workspaceOnline: true) still includes the file tools alongside the denial",
  FILE_TOOLS.every((n) => composedNames.includes(n)),
  composedNames,
);

console.log("\nworkspace write tools");

const WRITE_TOOLS = ["write_file", "edit_file", "delete_file"] as const;

check(
  "TOOL_NAMES contains the three write tools",
  WRITE_TOOLS.every((n) => (TOOL_NAMES as readonly string[]).includes(n)),
  TOOL_NAMES,
);

const readOnlyWriteDecisions = resolveTools({ ...basePolicy, mode: "read_only" });
check(
  "read_only denies all three write tools",
  WRITE_TOOLS.every((n) => readOnlyWriteDecisions[n] === "deny"),
  WRITE_TOOLS.map((n) => [n, readOnlyWriteDecisions[n]]),
);

const askWriteDecisions = resolveTools({ ...basePolicy, mode: "ask" });
check(
  "ask marks all three write tools as ask",
  WRITE_TOOLS.every((n) => askWriteDecisions[n] === "ask"),
  WRITE_TOOLS.map((n) => [n, askWriteDecisions[n]]),
);

const autoWriteDecisions = resolveTools({ ...basePolicy, mode: "auto" });
check(
  "auto allows write_file and edit_file",
  autoWriteDecisions.write_file === "allow" && autoWriteDecisions.edit_file === "allow",
  [autoWriteDecisions.write_file, autoWriteDecisions.edit_file],
);
// Deliberate asymmetry: editing is reversible with another edit, deleting is
// not, so delete_file keeps requiring a vote even under auto-accept.
check(
  "auto still asks before delete_file",
  autoWriteDecisions.delete_file === "ask",
  autoWriteDecisions.delete_file,
);

const gatedForAsk = gatedFor({ ...basePolicy, mode: "ask" });
check(
  "gatedFor under ask includes all three write tools",
  WRITE_TOOLS.every((n) => gatedForAsk.has(n)),
  [...gatedForAsk],
);

const gatedForAuto = gatedFor({ ...basePolicy, mode: "auto" });
check("gatedFor under auto includes delete_file", gatedForAuto.has("delete_file"), [...gatedForAuto]);
check("gatedFor under auto does not include write_file", !gatedForAuto.has("write_file"), [...gatedForAuto]);

const offlineWriteTools = toolsForRoom({ ...basePolicy, mode: "ask" }, "solo", false) as { name?: string }[];
const offlineWriteNames = offlineWriteTools.map((t) => t.name);
check(
  "toolsForRoom(policy, 'solo', false) contains none of the write tools",
  WRITE_TOOLS.every((n) => !offlineWriteNames.includes(n)),
  offlineWriteNames,
);

const onlineAskWriteTools = toolsForRoom({ ...basePolicy, mode: "ask" }, "solo", true) as { name?: string }[];
const onlineAskWriteNames = onlineAskWriteTools.map((t) => t.name);
check(
  "toolsForRoom(policy, 'solo', true) under ask contains all three write tools",
  WRITE_TOOLS.every((n) => onlineAskWriteNames.includes(n)),
  onlineAskWriteNames,
);

const readOnlyWriteTools = toolsForRoom({ ...basePolicy, mode: "read_only" }, "solo", true) as { name?: string }[];
const readOnlyWriteNames = readOnlyWriteTools.map((t) => t.name);
check(
  // Denied tools are removed from the list, not gated behind a vote — so
  // read_only withholds them even though a workspace is connected.
  "toolsForRoom under read_only contains none of the write tools",
  WRITE_TOOLS.every((n) => !readOnlyWriteNames.includes(n)),
  readOnlyWriteNames,
);

console.log("\nfile content visibility");

check("canSeeFileContents(owner) is true", canSeeFileContents("owner") === true);
check("canSeeFileContents(admin) is true", canSeeFileContents("admin") === true);
check("canSeeFileContents(editor) is false", canSeeFileContents("editor") === false);
check("canSeeFileContents(viewer) is false", canSeeFileContents("viewer") === false);

check("isFileContentTool(read_file) is true", isFileContentTool("read_file") === true);
check("isFileContentTool(search_files) is true", isFileContentTool("search_files") === true);
check("isFileContentTool(write_file) is true", isFileContentTool("write_file") === true);
check("isFileContentTool(edit_file) is true", isFileContentTool("edit_file") === true);
check("isFileContentTool(list_files) is false", isFileContentTool("list_files") === false);
check("isFileContentTool(delete_file) is false", isFileContentTool("delete_file") === false);
check("isFileContentTool(read_doc) is false", isFileContentTool("read_doc") === false);

console.log("\nfile content redaction");

const userEntry = {
  id: "e1",
  ts: 0,
  kind: "user" as const,
  authorUid: "u1",
  authorName: "Ann",
  color: "#fff",
  text: "hello",
};
check(
  "redactEntry on a non-agent entry returns it unchanged",
  redactEntry(userEntry, false) === userEntry,
);

const agentEntry = {
  id: "e2",
  ts: 0,
  kind: "agent" as const,
  blocks: [
    { type: "text" as const, text: "here is the file" },
    {
      type: "tool" as const,
      toolUseId: "t1",
      name: "read_file",
      input: { path: "a.txt" },
      status: "ok" as const,
      result: "secret contents",
      sensitive: true,
    },
    {
      type: "tool" as const,
      toolUseId: "t2",
      name: "list_files",
      input: {},
      status: "ok" as const,
      result: "a.txt\nb.txt",
      sensitive: false,
    },
  ],
};

check(
  "redactEntry(entry, true) returns the entry unchanged even with sensitive blocks",
  redactEntry(agentEntry, true) === agentEntry,
);

const redacted = redactEntry(agentEntry, false);
const redactedBlocks = redacted.kind === "agent" ? redacted.blocks : [];
check(
  "redactEntry(entry, false) replaces only sensitive block results, leaving the rest untouched",
  redacted !== agentEntry &&
    redactedBlocks[0]!.type === "text" &&
    redactedBlocks[0]!.text === "here is the file" &&
    redactedBlocks[1]!.type === "tool" &&
    redactedBlocks[1]!.result === REDACTED &&
    redactedBlocks[2]!.type === "tool" &&
    redactedBlocks[2]!.result === "a.txt\nb.txt",
  redacted,
);

check(
  "redactEntry(entry, false) does not mutate the input — the stored copy stays whole",
  agentEntry.blocks[1]!.result === "secret contents" && agentEntry.blocks[2]!.result === "a.txt\nb.txt",
  agentEntry,
);

const noSensitiveEntry = {
  id: "e3",
  ts: 0,
  kind: "agent" as const,
  blocks: [
    {
      type: "tool" as const,
      toolUseId: "t3",
      name: "list_files",
      input: {},
      status: "ok" as const,
      result: "a.txt",
      sensitive: false,
    },
  ],
};
check(
  "an entry with no sensitive blocks is returned by identity when not allowed — the common path allocates nothing",
  redactEntry(noSensitiveEntry, false) === noSensitiveEntry,
);

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
