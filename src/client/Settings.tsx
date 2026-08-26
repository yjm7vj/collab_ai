import { useMemo, useState } from "react";
import {
  CONTEXT_LIMITS,
  MODELS,
  PRESETS,
  WORKER_CEILING,
  WORKER_FLOOR,
  effectiveWorkerCap,
  matchPreset,
  modelInfo,
  type Effort,
  type RoomSettings,
} from "../shared/models";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Xhigh",
  max: "Max",
};

export function SettingsPanel({
  settings,
  userCount,
  busy,
  onApply,
  onClose,
  onCompactNow,
}: {
  settings: RoomSettings;
  userCount: number;
  busy: boolean;
  onApply: (s: RoomSettings) => void;
  onClose: () => void;
  onCompactNow: () => void;
}) {
  const [draft, setDraft] = useState<RoomSettings>(settings);

  const agent = modelInfo(draft.agentModel);
  const activePreset = useMemo(() => matchPreset(draft), [draft]);
  const cap = effectiveWorkerCap(draft, userCount);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const set = (patch: Partial<RoomSettings>) => setDraft((d) => ({ ...d, ...patch }));
  const setCtx = (patch: Partial<RoomSettings["context"]>) =>
    setDraft((d) => ({ ...d, context: { ...d.context, ...patch } }));

  // Switching model can invalidate effort and temperature — reconcile here so the
  // panel never shows a combination the server would silently rewrite.
  const chooseAgent = (id: string) => {
    const info = modelInfo(id);
    setDraft((d) => ({
      ...d,
      agentModel: id,
      effort: info.efforts.includes(d.effort)
        ? d.effort
        : info.efforts.includes("high")
          ? "high"
          : (info.efforts[info.efforts.length - 1] ?? "high"),
      temperature: info.temperature ? d.temperature : null,
      context: {
        ...d.context,
        maxContextTokens: Math.min(d.context.maxContextTokens, info.contextWindow),
      },
    }));
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label="Room settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Room Setup</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {busy && (
          <div className="notice">
            The agent is working. Settings can only change while it's idle.
          </div>
        )}

        <div className="modal-body">
          {/* ------------------------------------------------ presets */}
          <section>
            <h3>Workflow</h3>
            <div className="presets">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={`preset ${activePreset === p.id ? "on" : ""}`}
                  onClick={() => setDraft({ ...p.settings, context: draft.context })}
                >
                  <span className="preset-name">{p.label}</span>
                  <span className="preset-desc">{p.description}</span>
                </button>
              ))}
            </div>
            {/*
              Two screens can set the room's workflow, so whichever one is not
              in charge has to say so. Picking a preset here switches the room
              off the drawn workflow, and someone who has not been told that
              would read the models below as the ones answering the room when
              they are not — the graph's own nodes are.
            */}
            {draft.workflow === "custom" ? (
              <p className="field-note">
                This room is running the workflow drawn on the Workflow screen, so the
                agents and models below are not in use. Choosing a preset here switches
                back to a built-in workflow.
              </p>
            ) : (
              activePreset === null && (
                <p className="field-note">Custom — These settings don't match a preset.</p>
              )
            )}
          </section>

          {/* ------------------------------------------------- models */}
          <section>
            <h3>Models</h3>

            <label className="field">
              <span className="field-label">
                {draft.workflow === "manager" ? "Manager" : "Agent"}
              </span>
              <select
                value={draft.agentModel}
                onChange={(e) => chooseAgent(e.target.value)}
              >
                {MODELS.filter((m) => m.canManage).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — ${m.price.in}/${m.price.out} per Mtok
                  </option>
                ))}
              </select>
              <span className="field-note">{agent.blurb}</span>
              {agent.note && <span className="field-warn">{agent.note}</span>}
            </label>

            {draft.workflow === "manager" && (
              <label className="field">
                <span className="field-label">Workers</span>
                <select
                  value={draft.workerModel}
                  onChange={(e) => set({ workerModel: e.target.value })}
                >
                  {MODELS.filter((m) => m.canWork).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — ${m.price.in}/${m.price.out} per Mtok
                    </option>
                  ))}
                </select>
                <span className="field-note">
                  Workers are read-only. They research and report; only the manager
                  proposes document changes, and the room still votes on those.
                </span>
              </label>
            )}
          </section>

          {/* ---------------------------------------------- generation */}
          <section>
            <h3>Generation</h3>

            <div className="field">
              <span className="field-label">Effort</span>
              {agent.efforts.length === 0 ? (
                <p className="field-warn">
                  {agent.label} does not accept the effort parameter — sending it
                  would be a 400, so it is omitted for this model.
                </p>
              ) : (
                <div className="segmented">
                  {EFFORTS.map((e) => {
                    const ok = agent.efforts.includes(e);
                    return (
                      <button
                        key={e}
                        disabled={!ok}
                        title={ok ? undefined : `${agent.label} has no ${EFFORT_LABELS[e]} effort`}
                        className={draft.effort === e ? "on" : ""}
                        onClick={() => set({ effort: e })}
                      >
                        {EFFORT_LABELS[e]}
                      </button>
                    );
                  })}
                </div>
              )}
              <span className="field-note">
                Effort is the real quality/cost dial on current models — it controls
                how deeply the model thinks and how much it does per turn.
              </span>
            </div>

            <div className="field">
              <span className="field-label">
                Temperature
                {draft.temperature !== null && (
                  <span className="field-value">{draft.temperature.toFixed(2)}</span>
                )}
              </span>
              {!agent.temperature ? (
                <p className="field-warn">
                  Not available on {agent.label}. Anthropic removed{" "}
                  <code>temperature</code> on Opus 5, Sonnet 5, Opus 4.8/4.7 and
                  Fable 5 — sending it returns a 400. Use effort instead, or pick
                  Sonnet 4.6 / Haiku 4.5 if you specifically need sampling control.
                </p>
              ) : (
                <>
                  <div className="row">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={draft.temperature ?? 1}
                      onChange={(e) => set({ temperature: Number(e.target.value) })}
                    />
                    <button
                      className="mini"
                      onClick={() =>
                        set({ temperature: draft.temperature === null ? 1 : null })
                      }
                    >
                      {draft.temperature === null ? "Enable" : "Use Default"}
                    </button>
                  </div>
                  <span className="field-note">
                    {draft.temperature === null
                      ? "Not sent — the model uses its own default."
                      : "0 is focused and repetitive, 1 is varied."}
                  </span>
                </>
              )}
            </div>
          </section>

          {/* ------------------------------------------------ scaling */}
          {draft.workflow === "manager" && (
            <section>
          <h3>Team Scaling</h3>
              <div className="field">
                <div className="segmented">
                  <button
                    className={draft.scaling.mode === "auto" ? "on" : ""}
                    onClick={() =>
                      set({ scaling: { ...draft.scaling, mode: "auto" } })
                    }
                  >
                    Auto
                  </button>
                  <button
                    className={draft.scaling.mode === "fixed" ? "on" : ""}
                    onClick={() =>
                      set({ scaling: { ...draft.scaling, mode: "fixed" } })
                    }
                  >
                    Fixed
                  </button>
                </div>
                <span className="field-note">
                  {draft.scaling.mode === "auto"
                    ? `Scales with the room: 2 + headcount, capped at ${WORKER_CEILING}. Right now that's ${cap} parallel workers.`
                    : "A constant cap regardless of how many people are here."}
                </span>
              </div>

              {draft.scaling.mode === "fixed" && (
                <label className="field">
                  <span className="field-label">
                    Max Parallel Workers
                    <span className="field-value">{draft.scaling.maxWorkers}</span>
                  </span>
                  <input
                    type="range"
                    min={WORKER_FLOOR}
                    max={WORKER_CEILING}
                    step={1}
                    value={draft.scaling.maxWorkers}
                    onChange={(e) =>
                      set({
                        scaling: {
                          ...draft.scaling,
                          maxWorkers: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              )}
              <p className="field-note">
                This is the strongest cost lever here. Each worker is a full model
                run — {cap} of them fanned out at once costs roughly {cap}× a single
                turn on the worker model.
              </p>
            </section>
          )}

          {/* ------------------------------------------------ context */}
          <section>
            <h3>Context</h3>
            <p className="field-note">
              Every turn re-sends the whole conversation, so an old room gets slower
              and more expensive until it is compacted. Compaction summarises the
              older half and keeps recent messages verbatim.
            </p>

            <label className="field">
              <span className="field-label">
                Compact After
                <span className="field-value">
                  {draft.context.compactAfterMessages === 0
                    ? "Never"
                    : `${draft.context.compactAfterMessages} Messages`}
                </span>
              </span>
              <input
                type="range"
                min={CONTEXT_LIMITS.messages.min}
                max={CONTEXT_LIMITS.messages.max}
                step={CONTEXT_LIMITS.messages.step}
                value={draft.context.compactAfterMessages}
                onChange={(e) =>
                  setCtx({ compactAfterMessages: Number(e.target.value) })
                }
              />
            </label>

            <label className="field">
              <span className="field-label">
                Context Limit
                <span className="field-value">
                  {draft.context.maxContextTokens === 0
                    ? "Off"
                    : `${(draft.context.maxContextTokens / 1000).toFixed(0)}k Tokens`}
                </span>
              </span>
              <input
                type="range"
                min={CONTEXT_LIMITS.tokens.min}
                max={Math.min(CONTEXT_LIMITS.tokens.max, agent.contextWindow)}
                step={CONTEXT_LIMITS.tokens.step}
                value={draft.context.maxContextTokens}
                onChange={(e) => setCtx({ maxContextTokens: Number(e.target.value) })}
              />
              <span className="field-note">
                Whichever threshold trips first triggers compaction.{" "}
                {agent.label}'s own window is{" "}
                {(agent.contextWindow / 1000).toLocaleString()}k.
              </span>
            </label>

            <label className="field">
              <span className="field-label">
                Keep Verbatim
                <span className="field-value">
                  {draft.context.keepRecentMessages} Messages
                </span>
              </span>
              <input
                type="range"
                min={CONTEXT_LIMITS.keep.min}
                max={CONTEXT_LIMITS.keep.max}
                step={CONTEXT_LIMITS.keep.step}
                value={draft.context.keepRecentMessages}
                onChange={(e) => setCtx({ keepRecentMessages: Number(e.target.value) })}
              />
              <span className="field-note">
                Recent turns survive compaction untouched. Higher keeps more detail
                and saves less context.
              </span>
            </label>

            <button className="mini" disabled={busy} onClick={onCompactNow}>
              Compact Now
            </button>
          </section>
        </div>

        <footer className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={busy || !dirty}
            onClick={() => {
              onApply(draft);
              onClose();
            }}
          >
            Apply To Room
          </button>
        </footer>
      </div>
    </div>
  );
}
