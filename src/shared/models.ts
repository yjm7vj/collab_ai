/**
 * Model catalogue, workflow presets, and settings validation.
 *
 * The capability flags here are not decoration — they decide which parameters
 * are put on the wire. Sending a parameter a model has dropped is a 400, not a
 * silent no-op, so the settings UI reads these flags to disable controls and the
 * server reads them again to build the request. Client-side disabling is a
 * courtesy; `sanitizeSettings` on the server is the actual guard.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ModelInfo = {
  id: string;
  label: string;
  blurb: string;
  /** USD per million tokens, list price. */
  price: { in: number; out: number };
  /**
   * Whether `temperature` is accepted. Removed on Opus 5, Sonnet 5, Opus 4.8/4.7
   * and Fable 5 — sending it there returns 400. Still accepted on 4.6 and older.
   */
  temperature: boolean;
  /** Effort levels this model accepts. Empty means the parameter errors. */
  efforts: Effort[];
  /** Adaptive thinking. Models without it get no `thinking` parameter at all. */
  adaptiveThinking: boolean;
  /**
   * Whether this model accepts the dynamic-filtering server tools
   * (`web_search_20260209` / `web_fetch_20260209`). Those run code execution
   * under the hood, so a model without programmatic tool calling rejects them
   * with a 400 and must be given the basic variants instead.
   */
  dynamicServerTools: boolean;
  /** Suitable as a delegating manager (needs strong planning + tool use). */
  canManage: boolean;
  /** Suitable as a cheap worker doing reading-heavy subtasks. */
  canWork: boolean;
  /** Context window in tokens. Caps how high the room's context limit can go. */
  contextWindow: number;
  note?: string;
};

const ALL_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const MODELS: ModelInfo[] = [
  {
    id: "claude-opus-5",
    label: "Opus 5",
    blurb: "Best default. Strongest agentic and long-horizon work.",
    price: { in: 5, out: 25 },
    temperature: false,
    efforts: ALL_EFFORTS,
    adaptiveThinking: true,
    dynamicServerTools: true,
    canManage: true,
    canWork: false,
    contextWindow: 1000000,
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
    blurb: "Most capable, and the most expensive. For genuinely hard problems.",
    price: { in: 10, out: 50 },
    temperature: false,
    efforts: ALL_EFFORTS,
    adaptiveThinking: true,
    dynamicServerTools: true,
    canManage: true,
    canWork: false,
    contextWindow: 1000000,
    note: "Requires 30-day data retention — every request 400s under zero-retention.",
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    blurb: "Near-Opus quality on coding and agentic work, at Sonnet cost.",
    price: { in: 3, out: 15 },
    temperature: false,
    efforts: ALL_EFFORTS,
    adaptiveThinking: true,
    dynamicServerTools: true,
    canManage: true,
    canWork: true,
    contextWindow: 1000000,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    blurb: "Previous generation. The cheapest model here that still takes temperature.",
    price: { in: 3, out: 15 },
    temperature: true,
    efforts: ["low", "medium", "high", "max"],
    adaptiveThinking: true,
    dynamicServerTools: true,
    canManage: true,
    canWork: true,
    contextWindow: 1000000,
    note: "No xhigh effort on this generation.",
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    blurb: "Fastest and cheapest. Ideal as a worker for reading-heavy subtasks.",
    price: { in: 1, out: 5 },
    temperature: true,
    efforts: [],
    adaptiveThinking: false,
    dynamicServerTools: false,
    canManage: false,
    canWork: true,
    contextWindow: 200000,
    note:
      "Does not accept the effort parameter, and has no adaptive thinking. " +
      "Also needs the basic web_search/web_fetch tool variants — it does not " +
      "support the dynamic-filtering ones.",
  },
];

export function modelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]!;
}

/** The server-side tool definitions a given model will actually accept. */
export function serverToolsFor(modelId: string): unknown[] {
  const info = modelInfo(modelId);
  return info.dynamicServerTools
    ? [
        { type: "web_search_20260209", name: "web_search" },
        { type: "web_fetch_20260209", name: "web_fetch" },
      ]
    : [
        // Older models reject the dynamic-filtering variants outright.
        { type: "web_search_20250305", name: "web_search" },
        { type: "web_fetch_20250910", name: "web_fetch" },
      ];
}

/* -------------------------------------------------------------- workflows */

/** The orchestration mechanism. Presets are bundles of settings on top of these. */
export type Workflow = "solo" | "manager";

export type ScalingMode = "auto" | "fixed";

/**
 * When and how aggressively to compact the conversation.
 *
 * A room that runs for a day accumulates a conversation that eventually exceeds
 * the context window, and every turn re-sends all of it — so this is a cost
 * control as much as a correctness one. Compaction summarises the older half and
 * keeps the recent messages verbatim.
 */
export type ContextSettings = {
  /** Compact once the conversation exceeds this many messages. 0 disables it. */
  compactAfterMessages: number;
  /** Compact once the prompt exceeds this many tokens. 0 disables it. */
  maxContextTokens: number;
  /** Messages always kept verbatim after a compaction. */
  keepRecentMessages: number;
};

export type RoomSettings = {
  workflow: Workflow;
  /** The model the room talks to. In `manager` mode, the one that delegates. */
  agentModel: string;
  /** Only used in `manager` mode. */
  workerModel: string;
  effort: Effort;
  /** null = don't send the parameter. Only settable on models that accept it. */
  temperature: number | null;
  scaling: { mode: ScalingMode; maxWorkers: number };
  context: ContextSettings;
};

export const CONTEXT_LIMITS = {
  messages: { min: 0, max: 400, step: 10 },
  tokens: { min: 0, max: 500_000, step: 10_000 },
  keep: { min: 2, max: 40, step: 2 },
} as const;

export const DEFAULT_CONTEXT: ContextSettings = {
  compactAfterMessages: 60,
  maxContextTokens: 120_000,
  keepRecentMessages: 12,
};

export const WORKER_CEILING = 8;
export const WORKER_FLOOR = 1;

/**
 * How many workers may run at once.
 *
 * `auto` scales the cap with the size of the room — a busier room is doing more
 * at once and gets more parallelism — bounded so cost stays predictable.
 * `fixed` pins it to whatever the slider says regardless of headcount.
 */
export function effectiveWorkerCap(
  settings: RoomSettings,
  userCount: number,
): number {
  if (settings.scaling.mode === "fixed") {
    return clamp(settings.scaling.maxWorkers, WORKER_FLOOR, WORKER_CEILING);
  }
  return clamp(2 + userCount, WORKER_FLOOR, WORKER_CEILING);
}

export type Preset = {
  id: string;
  label: string;
  description: string;
  settings: RoomSettings;
};

export const PRESETS: Preset[] = [
  {
    id: "manager",
    label: "Manager + workers",
    description:
      "Opus 5 plans, delegates reading-heavy subtasks to Haiku 4.5 workers in " +
      "parallel, then verifies and synthesises. The expensive model spends its " +
      "tokens on judgement; the cheap one does the bulk reading.",
    settings: {
      workflow: "manager",
      agentModel: "claude-opus-5",
      workerModel: "claude-haiku-4-5",
      effort: "high",
      temperature: null,
      scaling: { mode: "auto", maxWorkers: 4 },
        context: DEFAULT_CONTEXT,
    },
  },
  {
    id: "research-swarm",
    label: "Research swarm",
    description:
      "Same shape, but workers are Sonnet 5 and fan out wider. For questions " +
      "that need many sources read properly rather than skimmed.",
    settings: {
      workflow: "manager",
      agentModel: "claude-opus-5",
      workerModel: "claude-sonnet-5",
      effort: "high",
      temperature: null,
      scaling: { mode: "fixed", maxWorkers: 6 },
        context: DEFAULT_CONTEXT,
    },
  },
  {
    id: "solo-deep",
    label: "Solo, deep",
    description:
      "One Opus 5 agent at xhigh effort, no delegation. Best when the task is " +
      "one hard thing rather than many independent ones.",
    settings: {
      workflow: "solo",
      agentModel: "claude-opus-5",
      workerModel: "claude-haiku-4-5",
      effort: "xhigh",
      temperature: null,
      scaling: { mode: "auto", maxWorkers: 4 },
        context: DEFAULT_CONTEXT,
    },
  },
  {
    id: "solo-fast",
    label: "Solo, fast",
    description:
      "One Sonnet 5 agent at medium effort. Cheapest and quickest — good for " +
      "conversation and light editing.",
    settings: {
      workflow: "solo",
      agentModel: "claude-sonnet-5",
      workerModel: "claude-haiku-4-5",
      effort: "medium",
      temperature: null,
      scaling: { mode: "auto", maxWorkers: 4 },
        context: DEFAULT_CONTEXT,
    },
  },
];

export const DEFAULT_SETTINGS: RoomSettings = PRESETS.find((p) => p.id === "manager")!
  .settings;

/** Which preset the current settings correspond to, or null if hand-tuned. */
export function matchPreset(s: RoomSettings): string | null {
  const found = PRESETS.find(
    (p) =>
      p.settings.workflow === s.workflow &&
      p.settings.agentModel === s.agentModel &&
      p.settings.workerModel === s.workerModel &&
      p.settings.effort === s.effort &&
      p.settings.temperature === s.temperature &&
      p.settings.scaling.mode === s.scaling.mode &&
      p.settings.scaling.maxWorkers === s.scaling.maxWorkers,
  );
  return found?.id ?? null;
}

/* ------------------------------------------------------------ validation */

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Coerce anything a client sends into settings that are valid for the chosen
 * models. Runs on the server and is the only thing standing between a crafted
 * WebSocket frame and a 400 (or a surprise bill for a model nobody picked).
 */
export function sanitizeSettings(input: unknown): RoomSettings {
  const raw = (input ?? {}) as Partial<RoomSettings>;
  const base = DEFAULT_SETTINGS;

  const workflow: Workflow = raw.workflow === "solo" ? "solo" : "manager";

  const agent = MODELS.find((m) => m.id === raw.agentModel && m.canManage);
  const agentModel = agent?.id ?? base.agentModel;

  const worker = MODELS.find((m) => m.id === raw.workerModel && m.canWork);
  const workerModel = worker?.id ?? base.workerModel;

  const info = modelInfo(agentModel);

  // Effort: fall back to the closest supported level rather than erroring.
  let effort: Effort = base.effort;
  if (info.efforts.length > 0) {
    effort = info.efforts.includes(raw.effort as Effort)
      ? (raw.effort as Effort)
      : info.efforts.includes("high")
        ? "high"
        : info.efforts[info.efforts.length - 1]!;
  }

  // Temperature is dropped entirely on models that reject it — this is the
  // check that keeps a stale client from 400-ing every turn in the room.
  let temperature: number | null = null;
  if (info.temperature && typeof raw.temperature === "number" && Number.isFinite(raw.temperature)) {
    temperature = Math.round(clamp(raw.temperature, 0, 1) * 100) / 100;
  }

  const mode: ScalingMode = raw.scaling?.mode === "fixed" ? "fixed" : "auto";
  const maxWorkers = clamp(
    Math.round(Number(raw.scaling?.maxWorkers ?? base.scaling.maxWorkers)) ||
      base.scaling.maxWorkers,
    WORKER_FLOOR,
    WORKER_CEILING,
  );

  const rc = raw.context ?? DEFAULT_CONTEXT;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;

  // The token limit can never exceed the chosen model's window — a limit above
  // it would let the conversation grow past what the model can actually accept.
  const context: ContextSettings = {
    compactAfterMessages: clamp(
      num(rc.compactAfterMessages, DEFAULT_CONTEXT.compactAfterMessages),
      CONTEXT_LIMITS.messages.min,
      CONTEXT_LIMITS.messages.max,
    ),
    maxContextTokens: clamp(
      num(rc.maxContextTokens, DEFAULT_CONTEXT.maxContextTokens),
      CONTEXT_LIMITS.tokens.min,
      Math.min(CONTEXT_LIMITS.tokens.max, info.contextWindow),
    ),
    keepRecentMessages: clamp(
      num(rc.keepRecentMessages, DEFAULT_CONTEXT.keepRecentMessages),
      CONTEXT_LIMITS.keep.min,
      CONTEXT_LIMITS.keep.max,
    ),
  };

  return {
    workflow,
    agentModel,
    workerModel,
    effort,
    temperature,
    scaling: { mode, maxWorkers },
    context,
  };
}

/** Running cost of a room, accumulated from real `usage` on every response. */
export type CostLedger = {
  /** Per-model token totals, so a manager/worker split is visible. */
  byModel: Record<string, { in: number; out: number }>;
  /** Total USD at list price. */
  usd: number;
};

export const EMPTY_LEDGER: CostLedger = { byModel: {}, usd: 0 };

export function addUsage(
  ledger: CostLedger,
  model: string,
  inTokens: number,
  outTokens: number,
): CostLedger {
  const prev = ledger.byModel[model] ?? { in: 0, out: 0 };
  const info = modelInfo(model);
  const delta =
    (inTokens / 1_000_000) * info.price.in + (outTokens / 1_000_000) * info.price.out;
  return {
    byModel: {
      ...ledger.byModel,
      [model]: { in: prev.in + inTokens, out: prev.out + outTokens },
    },
    usd: ledger.usd + delta,
  };
}

/** Short human summary for the transcript audit line. */
export function describeSettings(s: RoomSettings, userCount: number): string {
  const agent = modelInfo(s.agentModel).label;
  if (s.workflow === "solo") {
    return `solo · ${agent} · effort ${s.effort}${
      s.temperature === null ? "" : ` · temp ${s.temperature}`
    }`;
  }
  const worker = modelInfo(s.workerModel).label;
  const cap = effectiveWorkerCap(s, userCount);
  return `manager · ${agent} directing ${worker} · effort ${s.effort} · up to ${cap} workers (${s.scaling.mode})`;
}
