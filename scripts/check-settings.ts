/**
 * Guard checks for `sanitizeSettings`, the only thing between a crafted
 * WebSocket frame and an invalid parameter on the wire.
 *
 * Run: npm run check
 */
import {
  addUsage,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  DEFAULT_SETTINGS,
  effectiveWorkerCap,
  EMPTY_LEDGER,
  modelInfo,
  sanitizeSettings,
  serverToolsFor,
} from "../src/shared/models";
import {
  REDACTED,
  redactEntry,
  thresholdFor,
  tally,
  grantFor,
  grantIsLive,
  type Grant,
  type PendingTool,
} from "../src/shared/protocol";
import { SYSTEM_PROMPT } from "../src/server/model";
import {
  MODE_PRESETS,
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
  DEFAULT_POLICY,

  sanitizeAccessPolicy,
  type Capability,
  type Role,
} from "../src/shared/access";
import { DEFAULT_DENY, DEFAULT_PATH_POLICY, NO_WORKSPACE } from "../src/shared/workspace";
import {
  gatedFor,
  toolsFor,
  toolsForRoom,
  workerToolsFor,
  workspaceGrantsFileTools,
} from "../src/server/tools";

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
check("allows Opus 5 as worker", m3.workerModel === "claude-opus-5", m3.workerModel);

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
  // delete_file is irreversible, and terminal commands can execute arbitrary
  // code on somebody's computer. Both stay gated even when ordinary edits are
  // auto-accepted.
  "auto keeps delete_file and run_terminal gated",
  Object.entries(autoDecisions).every(([name, d]) =>
    name === "delete_file" || name === "run_terminal" ? d === "ask" : d === "allow"),
  autoDecisions,
);

const gatedAuto = gatedFor({ ...basePolicy, mode: "auto" });
check(
  "gatedFor under auto is exactly delete_file and run_terminal",
  gatedAuto.size === 2 && gatedAuto.has("delete_file") && gatedAuto.has("run_terminal"),
  [...gatedAuto],
);
check("gatedFor under auto does not include write_file", !gatedAuto.has("write_file"), [...gatedAuto]);
check("gatedFor under auto does not include edit_file", !gatedAuto.has("edit_file"), [...gatedAuto]);

const gatedAsk = gatedFor({ ...basePolicy, mode: "ask" });
check(
  "gatedFor under ask includes document, file, terminal, and mcp mutation tools",
  gatedAsk.size === 7 &&
    gatedAsk.has("write_doc") &&
    gatedAsk.has("edit_doc") &&
    gatedAsk.has("write_file") &&
    gatedAsk.has("edit_file") &&
    gatedAsk.has("delete_file") &&
    gatedAsk.has("run_terminal") &&
    // A call to somebody else's server is gated for the same reason a write
    // is: the room cannot see what it does, so it decides first.
    gatedAsk.has("mcp"),
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
  "toolsForRoom(policy, 'solo', connected: false) contains none of the file tools",
  FILE_TOOLS.every((n) => !offlineNames.includes(n)),
  offlineNames,
);

const onlineTools = toolsForRoom({ ...basePolicy, mode: "auto" }, "solo", true) as { name?: string }[];
const onlineNames = onlineTools.map((t) => t.name);
check(
  "toolsForRoom(policy, 'solo', connected: true) contains all three file tools",
  FILE_TOOLS.every((n) => onlineNames.includes(n)),
  onlineNames,
);

// toolsForRoom composes with the existing per-tool filter: a denied doc tool
// stays denied whether or not a workspace is connected.
const deniedDocPolicy = {
  ...basePolicy,
  mode: "custom" as const,
  tools: { ...resolveTools({ ...basePolicy, mode: "auto" }), read_doc: "deny" as const },
};
const composedTools = toolsForRoom(deniedDocPolicy, "solo", true) as { name?: string }[];
const composedNames = composedTools.map((t) => t.name);
check(
  "toolsForRoom(workspaceConnected: true) still excludes a denied doc tool",
  !composedNames.includes("read_doc"),
  composedNames,
);
check(
  "toolsForRoom(workspaceConnected: true) still includes the file tools alongside the denial",
  FILE_TOOLS.every((n) => composedNames.includes(n)),
  composedNames,
);

// Tools render at position 0 of the prompt, so a change to the list invalidates
// the whole cached prefix — system and the entire conversation with it. That is
// why the grant reads `kind` and never `online`: a host closing their tab must
// not re-bill the room's full context at cold prices.
check(
  "a connected workspace grants the file tools even while its host is offline",
  workspaceGrantsFileTools({ kind: "local", online: false, hostUid: "u1", label: "proj" }),
);
check(
  "a github workspace grants the file tools while offline too",
  workspaceGrantsFileTools({ kind: "github", online: false, hostUid: "u1", label: "o/r" }),
);
check(
  "a room with no workspace never grants the file tools",
  !workspaceGrantsFileTools(NO_WORKSPACE),
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
  "toolsForRoom(policy, 'solo', connected: false) contains none of the write tools",
  WRITE_TOOLS.every((n) => !offlineWriteNames.includes(n)),
  offlineWriteNames,
);

const onlineAskWriteTools = toolsForRoom({ ...basePolicy, mode: "ask" }, "solo", true) as { name?: string }[];
const onlineAskWriteNames = onlineAskWriteTools.map((t) => t.name);
check(
  "toolsForRoom(policy, 'solo', connected: true) under ask contains all three write tools",
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

/**
 * Guards the fix for a bug that broke the DEFAULT preset in production.
 *
 * The manager/worker preset runs Haiku 4.5 workers, and every worker was
 * handed the web_search_20260209 / web_fetch_20260209 tools. Those variants
 * do dynamic filtering by running code execution under the hood, so a model
 * without programmatic tool calling rejects them outright — every delegated
 * task came back as a 400. The manager (Opus 5) accepts them, which is why
 * this only ever surfaced during delegation.
 */
console.log("\nserver tool variants per model");
{
  const names = (defs: unknown[]) => JSON.stringify(defs);

  const haiku = serverToolsFor("claude-haiku-4-5");
  check(
    "haiku 4.5 gets the basic web_search variant",
    names(haiku).includes("web_search_20250305"),
    haiku,
  );
  check(
    "haiku 4.5 gets the basic web_fetch variant",
    names(haiku).includes("web_fetch_20250910"),
    haiku,
  );
  // The exact shape that returned a 400 from the live API.
  check(
    "haiku 4.5 never sees a dynamic-filtering variant",
    !names(haiku).includes("20260209"),
    haiku,
  );

  for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"]) {
    check(
      `${id} gets the dynamic-filtering variants`,
      names(serverToolsFor(id)).includes("20260209"),
      serverToolsFor(id),
    );
  }

  check(
    "an unknown model id still yields usable server tools",
    serverToolsFor("not-a-real-model").length === 2,
    serverToolsFor("not-a-real-model"),
  );

  // The worker path is the one that actually broke, so assert it directly
  // rather than trusting that it composes serverToolsFor correctly.
  const workerDefs = workerToolsFor(DEFAULT_POLICY, "claude-haiku-4-5");
  check(
    "worker tools for haiku contain no dynamic-filtering variant",
    !JSON.stringify(workerDefs).includes("20260209"),
    workerDefs,
  );
  check(
    "worker tools for haiku still include web_search",
    JSON.stringify(workerDefs).includes("web_search"),
    workerDefs,
  );

  // Denying a tool must win whichever variant the model would have received.
  const noSearch = sanitizeAccessPolicy({
    mode: "custom",
    tools: { ...DEFAULT_POLICY.tools, web_search: "deny" },
  });
  for (const id of ["claude-haiku-4-5", "claude-opus-5"]) {
    check(
      `a web_search denial removes it for ${id}`,
      !JSON.stringify(workerToolsFor(noSearch, id)).includes("\"web_search\""),
      workerToolsFor(noSearch, id),
    );
  }
}

console.log("\ncost accounting prices cached tokens as cached");
{
  const MODEL = "claude-sonnet-5";
  const price = modelInfo(MODEL).price;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  const only = (usage: { in: number; cacheWrite?: number; cacheRead?: number; out: number }) =>
    addUsage(EMPTY_LEDGER, MODEL, usage).usd;

  check(
    "uncached input is billed at the base rate",
    near(only({ in: 100_000, out: 0 }), (100_000 / 1e6) * price.in),
    only({ in: 100_000, out: 0 }),
  );
  check(
    "output is billed at the output rate",
    near(only({ in: 0, out: 10_000 }), (10_000 / 1e6) * price.out),
    only({ in: 0, out: 10_000 }),
  );
  check(
    "a cache write costs more than plain input",
    near(only({ in: 0, cacheWrite: 100_000, out: 0 }), (100_000 / 1e6) * price.in * CACHE_WRITE_MULTIPLIER),
    only({ in: 0, cacheWrite: 100_000, out: 0 }),
  );
  check(
    "a cache read costs a tenth of plain input",
    near(only({ in: 0, cacheRead: 100_000, out: 0 }), (100_000 / 1e6) * price.in * CACHE_READ_MULTIPLIER),
    only({ in: 0, cacheRead: 100_000, out: 0 }),
  );

  // THE REGRESSION. This app marks the system prompt and tool definitions as
  // cacheable, and in a short room those are almost the entire prompt — so
  // from the second turn onward nearly every input token is a cache read.
  // Summing the three classes and billing the total at the base rate is what
  // made a two-line exchange look like it cost real money.
  const cachedTurn = only({ in: 200, cacheRead: 8_000, out: 300 });
  const asIfFresh = only({ in: 8_200, out: 300 });
  check(
    "a turn served from cache costs far less than the same tokens sent fresh",
    cachedTurn < asIfFresh / 3,
    { cachedTurn, asIfFresh },
  );
  // Control: the two differ only in how the prompt tokens are classified, so
  // if the split were ever ignored again these would collapse to equal.
  check(
    "control: the comparison is not trivially true",
    !near(cachedTurn, asIfFresh),
    { cachedTurn, asIfFresh },
  );

  // Token counts stay whole. Someone reading a summary wants to know how many
  // prompt tokens went out, not how each one was priced.
  const ledger = addUsage(EMPTY_LEDGER, MODEL, { in: 100, cacheWrite: 200, cacheRead: 300, out: 40 });
  check(
    "byModel counts every prompt token regardless of class",
    ledger.byModel[MODEL]?.in === 600,
    ledger.byModel,
  );
  check("byModel counts output separately", ledger.byModel[MODEL]?.out === 40, ledger.byModel);

  // Omitting the cache fields must mean zero, not NaN — a NaN here would
  // poison the running total for the rest of the room's life.
  const legacy = addUsage(EMPTY_LEDGER, MODEL, { in: 1_000, out: 100 });
  check("omitted cache fields are treated as zero", Number.isFinite(legacy.usd) && legacy.usd > 0, legacy.usd);

  // Accumulation across turns.
  const twice = addUsage(addUsage(EMPTY_LEDGER, MODEL, { in: 1_000, out: 0 }), MODEL, { in: 1_000, out: 0 });
  check("usd accumulates across calls", near(twice.usd, only({ in: 2_000, out: 0 })), twice.usd);
}

console.log("\nthe system prompt keeps up with the tools");
{
  // Derived from MODE_PRESETS rather than hardcoded here: read-only mode
  // denies exactly the tools that change something, so this list grows by
  // itself the moment a new write tool is added — and these checks then fail
  // until the prompt mentions it.
  //
  // That is not hypothetical. The prompt described write_doc and edit_doc and
  // nothing else, long after the agent had gained write_file, edit_file and
  // delete_file. It told the model those three would run immediately, which
  // was wrong, and nothing anywhere noticed.
  const mutating = TOOL_NAMES.filter((name) => MODE_PRESETS.read_only[name] === "deny");
  check("there is a set of mutating tools to check against", mutating.length > 1, mutating);
  for (const name of mutating) {
    check(`the system prompt names the write tool ${name}`, SYSTEM_PROMPT.includes(name), name);
  }

  // Naming the tools is not enough on its own — the ordering is the point of
  // that section, and a rewrite could leave the list intact while losing it.
  check(
    "the system prompt requires a plan before the call",
    /before you call any of them/i.test(SYSTEM_PROMPT),
  );
  check(
    "the system prompt puts the plan first, not after",
    /plan, then act/i.test(SYSTEM_PROMPT),
  );
  check(
    "the system prompt requires reading before editing",
    /read before you write/i.test(SYSTEM_PROMPT),
  );

  // The read tools have to be named as immediate, or the agent starts asking
  // the room for permission to look at things.
  for (const name of ["read_doc", "read_file", "list_files", "search_files"]) {
    check(`the system prompt names the read tool ${name}`, SYSTEM_PROMPT.includes(name), name);
  }

  // A room may run unattended, and a prompt that flatly promises a vote makes
  // the agent tell people something untrue about what just happened.
  check(
    "the system prompt allows for a room that acts unattended",
    /unattended/i.test(SYSTEM_PROMPT),
  );
}



/* ------------------------------------------------- standing authority */

console.log("\nstanding authority");

const gate = (votes: Record<string, string>, threshold = 2): PendingTool => ({
  toolUseId: "t1",
  name: "edit_file",
  input: {},
  summary: "Edit a file",
  votes,
  threshold,
});

// A grant is a stronger ask than an approval, so it has to imply one — but an
// approval must never quietly become a grant.
const bothGrant = tally(gate({ a: "grant", b: "grant" }));
check("a grant vote counts toward approving the call", bothGrant.approve === 2, bothGrant);
check("grant votes are also counted on their own", bothGrant.grant === 2, bothGrant);

const mixed = tally(gate({ a: "grant", b: "approve" }));
check("a plain approval still approves", mixed.approve === 2, mixed);
check(
  "a plain approval is not counted as wanting standing authority",
  mixed.grant === 1,
  mixed,
);
check(
  "so a call can be approved without granting standing authority",
  mixed.approve >= 2 && mixed.grant < 2,
  mixed,
);

const denied = tally(gate({ a: "deny", b: "deny" }));
check("denials are unaffected", denied.deny === 2 && denied.approve === 0, denied);

const now = Date.now();
const live: Grant = {
  id: "g1", tool: "edit_file", summary: "Edit a file",
  createdAt: now, expiresAt: now + 60_000, maxUses: 3, usedCount: 1, grantedBy: ["Ada"],
};

check("a live grant is live", grantIsLive(live, now));
check("a grant is dead once its window closes", !grantIsLive({ ...live, expiresAt: now - 1 }, now));
check("a grant is dead once its uses run out", !grantIsLive({ ...live, usedCount: 3 }, now));
check(
  "a grant never covers a tool it was not given for",
  grantFor([live], "delete_file", now) === undefined,
);
check("a grant covers the tool it was given for", grantFor([live], "edit_file", now)?.id === "g1");
check(
  "an expired grant covers nothing",
  grantFor([{ ...live, expiresAt: now - 1 }], "edit_file", now) === undefined,
);


console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
