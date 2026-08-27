/**
 * The workflow designer: the room's agent graph, drawn.
 *
 * Two things this screen is careful about.
 *
 * First, it never lies about what a link does. Three of the four relation kinds
 * change what actually runs; `custom` only changes what the agents are told.
 * The palette says which is which, and `graphWarnings` reports every arrow the
 * runtime will ignore rather than deleting it behind the person who drew it.
 *
 * Second, dragging is not the only way to work. Every node can be moved with
 * the arrow keys while focused, every link can be made from a button, and the
 * canvas is readable at a glance without pointer precision — a design surface
 * that can only be operated with a mouse is one half the room cannot use.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MODELS, modelInfo } from "../shared/models";
import {
  CARD,
  GRAPH_LIMITS,
  GRAPH_PRESETS,
  MAX_POS,
  RELATIONS,
  delegatesOf,
  graphWarnings,
  leadOf,
  matchGraphPreset,
  relationInfo,
  type AgentNode,
  type Relation,
  type RelationKind,
  type WorkflowGraph,
} from "../shared/workflow";

const GRID = 20;

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

type Selection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "none" };

export function WorkflowPanel({
  graph,
  active,
  canEdit,
  canSetModels,
  busy,
  onApply,
  onClose,
}: {
  graph: WorkflowGraph;
  /** Whether the room is currently running on this graph. */
  active: boolean;
  canEdit: boolean;
  /** Whether this person may also choose which models the agents run on. */
  canSetModels: boolean;
  busy: boolean;
  onApply: (graph: WorkflowGraph, useCustom: boolean) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<WorkflowGraph>(graph);
  const [useCustom, setUseCustom] = useState(active);
  const [selected, setSelected] = useState<Selection>({ kind: "none" });
  /** Source node id while a link is being drawn, else null. */
  const [linking, setLinking] = useState<string | null>(null);

  const surfaceRef = useRef<HTMLDivElement>(null);
  /** Live drag, kept in a ref: it changes on every pointer move. */
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(graph) || useCustom !== active,
    [draft, graph, useCustom, active],
  );
  const warnings = useMemo(() => graphWarnings(draft), [draft]);
  const preset = useMemo(() => matchGraphPreset(draft), [draft]);
  const roster = useMemo(() => delegatesOf(draft), [draft]);
  const lead = leadOf(draft);

  /* ------------------------------------------------------------- editing */

  const patchNode = useCallback(
    (id: string, patch: Partial<AgentNode>) =>
      setDraft((d) => ({
        ...d,
        nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
      })),
    [],
  );

  const patchEdge = useCallback(
    (id: string, patch: Partial<Relation>) =>
      setDraft((d) => ({
        ...d,
        edges: d.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      })),
    [],
  );

  const addAgent = useCallback(() => {
    if (draft.nodes.length >= GRAPH_LIMITS.nodes) return;
    const id = newId();
    // Dropped into the first free column-ish spot rather than always at the
    // same coordinates, so adding three in a row does not stack them.
    const taken = draft.nodes.length;
    const node: AgentNode = {
      id,
      name: `Teammate ${taken}`,
      model: MODELS.find((m) => m.canWork)!.id,
      prompt: "",
      x: Math.min(MAX_POS.x, 660 + (taken % 2) * 300),
      y: Math.min(MAX_POS.y, 120 + Math.floor(taken / 2) * 180),
    };
    setDraft((d) => ({ ...d, nodes: [...d.nodes, node] }));
    setSelected({ kind: "node", id });
  }, [draft.nodes.length]);

  const removeNode = useCallback(
    (id: string) => {
      // The lead is the room's only way to talk to the graph, so it cannot be
      // deleted — promote someone else first.
      if (id === draft.leadId) return;
      setDraft((d) => ({
        ...d,
        nodes: d.nodes.filter((n) => n.id !== id),
        edges: d.edges.filter((e) => e.from !== id && e.to !== id),
      }));
      setSelected({ kind: "none" });
    },
    [draft.leadId],
  );

  /**
   * Promote a node to lead, reconciling both models.
   *
   * The same rule the server applies: a lead has to be a model that can plan
   * and drive tools, a teammate one we are willing to fan out to. Doing it here
   * too means the canvas never shows a pairing the server would silently
   * rewrite on Apply.
   */
  const makeLead = useCallback((id: string) => {
    setDraft((d) => {
      const firstManager = MODELS.find((m) => m.canManage)!.id;
      const firstWorker = MODELS.find((m) => m.canWork)!.id;
      return {
        ...d,
        leadId: id,
        nodes: d.nodes.map((n) => {
          if (n.id === id) {
            return modelInfo(n.model).canManage ? n : { ...n, model: firstManager };
          }
          if (n.id === d.leadId) {
            return modelInfo(n.model).canWork ? n : { ...n, model: firstWorker };
          }
          return n;
        }),
      };
    });
  }, []);

  const link = useCallback(
    (from: string, to: string) => {
      setLinking(null);
      if (from === to) return;
      if (draft.edges.length >= GRAPH_LIMITS.edges) return;
      // One relationship per direction per kind is the server's rule, but a pair
      // may hold several at once. So rather than refusing a second link between
      // two agents that already have one, take the next kind that is still free
      // — linking the lead to a teammate it already delegates to now proposes a
      // review, which is the thing someone drawing that arrow twice meant.
      // Default to the link people mean nine times in ten; the inspector opens
      // on it so changing the kind is one click, not a hunt.
      const preferred: RelationKind[] =
        from === draft.leadId
          ? ["delegates", "reviews", "handoff", "custom"]
          : ["reviews", "handoff", "custom", "delegates"];
      const taken = draft.edges.filter((e) => e.from === from && e.to === to);
      const kind = preferred.find((k) => !taken.some((e) => e.kind === k));
      // Every kind spent: nothing left to add, so open the first one they have
      // instead of swallowing the click.
      if (!kind) {
        if (taken[0]) setSelected({ kind: "edge", id: taken[0].id });
        return;
      }
      const id = newId();
      setDraft((d) => ({
        ...d,
        edges: [...d.edges, { id, from, to, kind, prompt: relationInfo(kind).defaultPrompt }],
      }));
      setSelected({ kind: "edge", id });
    },
    [draft.edges, draft.leadId],
  );

  const removeEdge = useCallback((id: string) => {
    setDraft((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== id) }));
    setSelected({ kind: "none" });
  }, []);

  // Relative, so it has to read the position inside the updater rather than
  // from the render it was created in: a held arrow key repeats faster than
  // React re-renders, and a stale closure would drop every press but the last.
  const nudge = useCallback(
    (id: string, dx: number, dy: number) =>
      setDraft((d) => ({
        ...d,
        nodes: d.nodes.map((n) =>
          n.id === id
            ? {
                ...n,
                x: clamp(n.x + dx, 0, MAX_POS.x),
                y: clamp(n.y + dy, 0, MAX_POS.y),
              }
            : n,
        ),
      })),
    [],
  );

  /* -------------------------------------------------------------- pointer */

  const onNodePointerDown = (e: React.PointerEvent, node: AgentNode) => {
    setSelected({ kind: "node", id: node.id });
    if (!canEdit) return;
    // A press on the card's own controls must not begin a drag: capturing the
    // pointer here retargets the pointerup, and the click those buttons were
    // waiting for never arrives — which made Link and Lead do nothing at all.
    if ((e.target as HTMLElement).closest(".wf-node-acts")) return;
    if (linking) {
      link(linking, node.id);
      return;
    }
    const surface = surfaceRef.current;
    if (!surface) return;
    const box = surface.getBoundingClientRect();
    drag.current = {
      id: node.id,
      dx: e.clientX - box.left - node.x,
      dy: e.clientY - box.top - node.y,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onNodePointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const surface = surfaceRef.current;
    if (!d || !surface) return;
    const box = surface.getBoundingClientRect();
    patchNode(d.id, {
      x: snap(clamp(e.clientX - box.left - d.dx, 0, MAX_POS.x)),
      y: snap(clamp(e.clientY - box.top - d.dy, 0, MAX_POS.y)),
    });
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  // Escape backs out of whatever is in progress, innermost first, and only
  // closes the screen when nothing else is pending.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (linking) setLinking(null);
      else if (selected.kind !== "none") setSelected({ kind: "none" });
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [linking, selected.kind, onClose]);

  /* --------------------------------------------------------------- render */

  const selNode = selected.kind === "node" ? draft.nodes.find((n) => n.id === selected.id) : null;
  const selEdge = selected.kind === "edge" ? draft.edges.find((e) => e.id === selected.id) : null;

  return (
    <div className="wf-screen" role="dialog" aria-label="Workflow designer">
      <header className="wf-head">
        <div className="wf-head-left">
          <h2>Workflow</h2>
          <p className="wf-sub">
            {lead.name} talks to the room.{" "}
            {roster.length === 0
              ? "No teammates are wired up yet."
              : `${roster.length} teammate${roster.length === 1 ? "" : "s"} take${
                  roster.length === 1 ? "s" : ""
                } work from it.`}
          </p>
        </div>
        <div className="wf-head-right">
          <label className={`wf-toggle ${useCustom ? "on" : ""}`}>
            <input
              type="checkbox"
              checked={useCustom}
              disabled={!canEdit}
              onChange={(e) => setUseCustom(e.target.checked)}
            />
            <span>Run this workflow</span>
          </label>
          <button
            className="primary"
            disabled={!canEdit || busy || !dirty}
            onClick={() => onApply(draft, useCustom)}
          >
            Apply
          </button>
          <button disabled={!dirty} onClick={() => {
            setDraft(graph);
            setUseCustom(active);
            setSelected({ kind: "none" });
            setLinking(null);
          }}>
            Revert
          </button>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
      </header>

      {busy && (
        <div className="notice wf-notice">
          The agent is working. The workflow can only change while it is idle.
        </div>
      )}
      {!canEdit && (
        <div className="notice wf-notice">
          You are viewing this workflow. Editors and above can change it.
        </div>
      )}
      {!useCustom && (
        <div className="notice wf-notice">
          This room is running a built-in workflow. Turn on “Run this workflow” to use the
          team below instead.
        </div>
      )}

      <div className="wf-body">
        {/* ------------------------------------------------------- left rail */}
        <aside className="wf-rail" aria-label="Workflow tools">
          <section>
            <h3>Start from</h3>
            <div className="wf-presets">
              {GRAPH_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={`wf-preset ${preset === p.id ? "on" : ""}`}
                  disabled={!canEdit}
                  onClick={() => {
                    setDraft(JSON.parse(JSON.stringify(p.graph)) as WorkflowGraph);
                    setSelected({ kind: "none" });
                  }}
                >
                  <span className="wf-preset-name">{p.label}</span>
                  <span className="wf-preset-desc">{p.description}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3>Add</h3>
            <button
              className="wf-add"
              disabled={!canEdit || draft.nodes.length >= GRAPH_LIMITS.nodes}
              onClick={addAgent}
            >
              + Agent
            </button>
            <p className="wf-note">
              {draft.nodes.length} of {GRAPH_LIMITS.nodes} agents, {draft.edges.length} of{" "}
              {GRAPH_LIMITS.edges} links.
            </p>
          </section>

          <section>
            <h3>Links</h3>
            <ul className="wf-legend">
              {RELATIONS.map((r) => (
                <li key={r.kind}>
                  <span className={`wf-swatch wf-swatch-${r.kind}`} />
                  <div>
                    <b>{r.label}</b>
                    {!r.mechanical && <em className="wf-prose">prompt only</em>}
                    <p>{r.mechanism}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {warnings.length > 0 && (
            <section>
              <h3>Check</h3>
              <ul className="wf-warnings">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </section>
          )}
        </aside>

        {/* ---------------------------------------------------------- canvas */}
        <div className="wf-canvas">
          {linking && (
            <div className="wf-linking">
              Pick the agent this link points to.
              <button onClick={() => setLinking(null)}>Cancel</button>
            </div>
          )}
          <div
            className={`wf-surface ${linking ? "wf-surface-linking" : ""}`}
            ref={surfaceRef}
            style={{ width: GRAPH_LIMITS.width, height: GRAPH_LIMITS.height }}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) setSelected({ kind: "none" });
            }}
          >
            <Wires
              graph={draft}
              selectedId={selected.kind === "edge" ? selected.id : null}
              onSelect={(id) => setSelected({ kind: "edge", id })}
            />

            {draft.nodes.map((node) => {
              const isLead = node.id === draft.leadId;
              const info = modelInfo(node.model);
              return (
                <div
                  key={node.id}
                  className={[
                    "wf-node",
                    isLead ? "wf-node-lead" : "",
                    selected.kind === "node" && selected.id === node.id ? "wf-node-on" : "",
                    linking === node.id ? "wf-node-source" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ left: node.x, top: node.y, width: CARD.w, height: CARD.h }}
                  tabIndex={0}
                  role="button"
                  aria-label={`${node.name}, ${isLead ? "lead" : "teammate"}, on ${info.label}`}
                  onPointerDown={(e) => onNodePointerDown(e, node)}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onKeyDown={(e) => {
                    if (!canEdit) return;
                    const step = e.shiftKey ? GRID * 5 : GRID;
                    if (e.key === "ArrowLeft") nudge(node.id, -step, 0);
                    else if (e.key === "ArrowRight") nudge(node.id, step, 0);
                    else if (e.key === "ArrowUp") nudge(node.id, 0, -step);
                    else if (e.key === "ArrowDown") nudge(node.id, 0, step);
                    else if (e.key === "Enter" && linking) link(linking, node.id);
                    else return;
                    e.preventDefault();
                  }}
                >
                  <div className="wf-node-head">
                    <span className="wf-node-name">{node.name}</span>
                    {isLead && <span className="wf-badge">Lead</span>}
                  </div>
                  <span className="wf-node-model">{info.label}</span>
                  <p className="wf-node-prompt">
                    {node.prompt.trim() || <em>No brief yet.</em>}
                  </p>
                  {canEdit && (
                    <div className="wf-node-acts">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setLinking(linking === node.id ? null : node.id);
                        }}
                        title="Draw a link from this agent"
                      >
                        {linking === node.id ? "Linking…" : "Link"}
                      </button>
                      {!isLead && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            makeLead(node.id);
                          }}
                          title="Make this the agent the room talks to"
                        >
                          Lead
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ------------------------------------------------------- inspector */}
        <aside className="wf-inspector" aria-label="Selection">
          {selNode && (
            <NodeInspector
              node={selNode}
              graph={draft}
              canEdit={canEdit}
              canSetModels={canSetModels}
              onPatch={(patch) => patchNode(selNode.id, patch)}
              onDelete={() => removeNode(selNode.id)}
              onStartLink={() => setLinking(selNode.id)}
            />
          )}
          {selEdge && (
            <EdgeInspector
              edge={selEdge}
              graph={draft}
              canEdit={canEdit}
              onPatch={(patch) => patchEdge(selEdge.id, patch)}
              onDelete={() => removeEdge(selEdge.id)}
              onSelect={(id) => setSelected({ kind: "edge", id })}
            />
          )}
          {!selNode && !selEdge && (
            <div className="wf-empty">
              <h3>Nothing selected</h3>
              <p>
                Pick an agent to write its brief, or a link to say what that relationship
                should do. Drag a card to move it, or focus one and use the arrow keys.
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- inspectors */

function NodeInspector({
  node,
  graph,
  canEdit,
  canSetModels,
  onPatch,
  onDelete,
  onStartLink,
}: {
  node: AgentNode;
  graph: WorkflowGraph;
  canEdit: boolean;
  canSetModels: boolean;
  onPatch: (patch: Partial<AgentNode>) => void;
  onDelete: () => void;
  onStartLink: () => void;
}) {
  const isLead = node.id === graph.leadId;
  // The catalogue already knows which models are fit to lead and which are fit
  // to fan out to; offering the others here would only produce a choice the
  // server rewrites on Apply.
  const options = MODELS.filter((m) => (isLead ? m.canManage : m.canWork));
  const info = modelInfo(node.model);

  return (
    <div className="wf-inspect">
      <header>
        <h3>{isLead ? "Lead agent" : "Teammate"}</h3>
        {!isLead && canEdit && (
          <button className="wf-danger" onClick={onDelete}>
            Delete
          </button>
        )}
      </header>

      <label className="field">
        <span className="field-label">Name</span>
        <input
          value={node.name}
          disabled={!canEdit}
          maxLength={GRAPH_LIMITS.nameChars}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <span className="field-note">
          This is the name the lead uses when it hands over a task, so make it say what the
          agent is for.
        </span>
      </label>

      <label className="field">
        <span className="field-label">Model</span>
        <select
          value={node.model}
          disabled={!canEdit || !canSetModels}
          onChange={(e) => onPatch({ model: e.target.value })}
        >
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — ${m.price.in}/${m.price.out} per Mtok
            </option>
          ))}
        </select>
        <span className="field-note">
          {canSetModels
            ? info.blurb
            : "Choosing models is a spend decision, so it stays with the room's owner and admins."}
        </span>
      </label>

      <label className="field">
        <span className="field-label">Brief</span>
        <textarea
          rows={8}
          value={node.prompt}
          disabled={!canEdit}
          maxLength={GRAPH_LIMITS.promptChars}
          placeholder={
            isLead
              ? "How should this agent plan, split work, and decide what reaches the room?"
              : "What is this teammate for, and how should it work?"
          }
          onChange={(e) => onPatch({ prompt: e.target.value })}
        />
        <span className="field-note">
          Added to this agent's system prompt. {node.prompt.length}/{GRAPH_LIMITS.promptChars}
        </span>
      </label>

      {canEdit && (
        <button onClick={onStartLink}>Draw a link from {node.name}</button>
      )}
    </div>
  );
}

function EdgeInspector({
  edge,
  graph,
  canEdit,
  onPatch,
  onDelete,
  onSelect,
}: {
  edge: Relation;
  graph: WorkflowGraph;
  canEdit: boolean;
  onPatch: (patch: Partial<Relation>) => void;
  onDelete: () => void;
  /** Jump to another link — the pair's other relationships are listed here. */
  onSelect: (id: string) => void;
}) {
  const from = graph.nodes.find((n) => n.id === edge.from);
  const to = graph.nodes.find((n) => n.id === edge.to);
  const info = relationInfo(edge.kind);

  // The other links these same two agents already hold, in this direction and
  // the other. Their kinds are the ones this link cannot be switched to: the
  // server keeps one relationship per direction per kind and would drop the
  // duplicate on Apply, which from here would look like the click did nothing.
  const siblings = graph.edges.filter(
    (e) =>
      e.id !== edge.id &&
      ((e.from === edge.from && e.to === edge.to) || (e.from === edge.to && e.to === edge.from)),
  );
  const clash = new Set(
    siblings.filter((e) => e.from === edge.from && e.to === edge.to).map((e) => e.kind),
  );

  return (
    <div className="wf-inspect">
      <header>
        <h3>Link</h3>
        {canEdit && (
          <button className="wf-danger" onClick={onDelete}>
            Delete
          </button>
        )}
      </header>

      <p className="wf-relation">
        <b>{from?.name ?? "?"}</b> {info.label} <b>{to?.name ?? "?"}</b>
      </p>

      {siblings.length > 0 && (
        <p className="wf-relation-more">
          {siblings.length === 1 ? "One other link" : `${siblings.length} other links`} between
          these two agents:{" "}
          {siblings.map((e) => {
            // The sentence above already names this link's source, so a sibling
            // running the same way needs no subject and one running back the
            // other way has to name its own.
            const src = graph.nodes.find((n) => n.id === e.from);
            const back = e.from !== edge.from;
            return (
              <button
                key={e.id}
                className={`wf-relation-kind wf-relation-kind-${e.kind}`}
                onClick={() => onSelect(e.id)}
                title="Edit this link"
              >
                {back && `${src?.name ?? "?"} `}
                {relationInfo(e.kind).label}
              </button>
            );
          })}
        </p>
      )}

      <div className="field">
        <span className="field-label">Relationship</span>
        <div className="wf-kinds">
          {RELATIONS.map((r) => (
            <button
              key={r.kind}
              className={`wf-kind wf-kind-${r.kind} ${edge.kind === r.kind ? "on" : ""}`}
              disabled={!canEdit || clash.has(r.kind)}
              title={
                clash.has(r.kind)
                  ? `${from?.name ?? "?"} already ${r.label} ${to?.name ?? "?"} on another link.`
                  : r.mechanism
              }
              onClick={() =>
                // Swapping kinds carries the wording across only when it was
                // left at the previous kind's default — an instruction someone
                // actually wrote is theirs to keep or clear, not ours to drop.
                onPatch({
                  kind: r.kind,
                  prompt:
                    edge.prompt.trim() === "" || edge.prompt === info.defaultPrompt
                      ? r.defaultPrompt
                      : edge.prompt,
                })
              }
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="field-note">
          {info.mechanism}
          {!info.mechanical && " Nothing extra runs for this link."}
          {clash.size > 0 &&
            ` The greyed-out kinds are already taken by another link between these two.`}
        </span>
      </div>

      <label className="field">
        <span className="field-label">Instruction</span>
        <textarea
          rows={7}
          value={edge.prompt}
          disabled={!canEdit}
          maxLength={GRAPH_LIMITS.promptChars}
          placeholder={info.defaultPrompt || "What should this relationship mean in practice?"}
          onChange={(e) => onPatch({ prompt: e.target.value })}
        />
        <span className="field-note">
          {edge.prompt.trim()
            ? `Written into the prompts on both ends. ${edge.prompt.length}/${GRAPH_LIMITS.promptChars}`
            : "Empty falls back to the wording above."}
        </span>
      </label>
    </div>
  );
}

/* -------------------------------------------------------------------- wires */

/**
 * The links, drawn under the cards.
 *
 * Every wire is a button as well as a path: a hit area you can only reach by
 * clicking a two-pixel curve is not a control. The label pill is what people
 * actually aim at, and it says which kind of link it is in words rather than
 * relying on colour alone.
 */
function Wires({
  graph,
  selectedId,
  onSelect,
}: {
  graph: WorkflowGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const wires = useMemo(() => layOutWires(graph), [graph]);

  return (
    <>
      <svg
        className="wf-wires"
        width={GRAPH_LIMITS.width}
        height={GRAPH_LIMITS.height}
        aria-hidden="true"
      >
        <defs>
          {RELATIONS.map((r) => (
            <marker
              key={r.kind}
              id={`wf-arrow-${r.kind}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className={`wf-arrow wf-wire-${r.kind}`} />
            </marker>
          ))}
        </defs>
        {wires.map((w) => (
          <path
            key={w.edge.id}
            d={w.d}
            className={`wf-wire wf-wire-${w.edge.kind} ${
              selectedId === w.edge.id ? "wf-wire-on" : ""
            }`}
            markerEnd={`url(#wf-arrow-${w.edge.kind})`}
          />
        ))}
      </svg>
      {wires.map((w) => {
        const info = relationInfo(w.edge.kind);
        const from = graph.nodes.find((n) => n.id === w.edge.from);
        const to = graph.nodes.find((n) => n.id === w.edge.to);
        return (
          <button
            key={w.edge.id}
            className={`wf-wire-label wf-wire-label-${w.edge.kind} ${
              selectedId === w.edge.id ? "on" : ""
            }`}
            style={{ left: w.mid.x, top: w.mid.y }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onSelect(w.edge.id)}
            aria-label={`${from?.name ?? "?"} ${info.label} ${to?.name ?? "?"}. Edit this link.`}
          >
            {info.label}
          </button>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ layout */

/** How far apart parallel links between one pair of agents are fanned. */
const SPREAD = 40;
/**
 * Least vertical distance between two labels on the same pair of agents. A gap
 * taller than a pill means no two can overlap whatever their x, which is what
 * makes the de-overlap pass below a guarantee rather than a heuristic.
 */
const LABEL_PITCH = 32;

type Wire = { edge: Relation; d: string; mid: { x: number; y: number } };

/**
 * Place every link on the canvas, fanning the ones that share a pair of agents.
 *
 * Two agents can hold several relationships at once — a lead that delegates to a
 * teammate and is reviewed by it is one graph, not two — and drawn naively those
 * links land on the same curve with their labels stacked on the same point, so
 * the second one is invisible and unclickable. Each link is therefore indexed
 * within its pair and pushed off the centre line three ways: its endpoints slide
 * along the card edge so the arrowheads do not collide, its control points bow
 * sideways so the curves separate, and its label sits at a different point along
 * its own curve so two pills cannot cover each other even when the fan is edge-on
 * and the sideways offset is foreshortened to nothing.
 *
 * Pairs are keyed unordered: a link back the other way shares the same lane and
 * has to be fanned out of it too.
 */
function layOutWires(graph: WorkflowGraph): Wire[] {
  const lanes = new Map<string, Relation[]>();
  for (const e of graph.edges) {
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    const lane = lanes.get(key);
    if (lane) lane.push(e);
    else lanes.set(key, [e]);
  }

  const out: Wire[] = [];
  for (const lane of lanes.values()) {
    const fanned: Wire[] = [];
    lane.forEach((e, i) => {
      const from = graph.nodes.find((n) => n.id === e.from);
      const to = graph.nodes.find((n) => n.id === e.to);
      if (!from || !to) return;

      // Centred on the lane: one link gets no offset at all, so a plain graph
      // draws exactly as it did before.
      const off = lane.length === 1 ? 0 : (i - (lane.length - 1) / 2) * SPREAD;

      // Leave from whichever side faces the target, so a link drawn back to the
      // left does not loop out around the card it starts on.
      const rightward = to.x >= from.x;
      const port = clamp(off, -(CARD.h / 2 - 14), CARD.h / 2 - 14);
      const x1 = from.x + (rightward ? CARD.w : 0);
      const y1 = from.y + CARD.h / 2 + port;
      const x2 = to.x + (rightward ? 0 : CARD.w);
      const y2 = to.y + CARD.h / 2 + port;

      const bow = Math.max(40, Math.abs(x2 - x1) / 2);
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const nx = -(y2 - y1) / len;
      const ny = (x2 - x1) / len;
      const c1 = { x: (rightward ? x1 + bow : x1 - bow) + nx * off, y: y1 + ny * off };
      const c2 = { x: (rightward ? x2 - bow : x2 + bow) + nx * off, y: y2 + ny * off };

      const t =
        lane.length === 1
          ? 0.5
          : clamp(0.5 + (i - (lane.length - 1) / 2) * 0.16, 0.22, 0.78);

      fanned.push({
        edge: e,
        d: `M ${x1} ${y1} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${x2} ${y2}`,
        mid: cubicAt(t, { x: x1, y: y1 }, c1, c2, { x: x2, y: y2 }),
      });
    });
    spreadLabels(fanned);
    out.push(...fanned);
  }
  return out;
}

/**
 * Push one lane's labels apart until none can cover another.
 *
 * The curves are already fanned, but a label is a pill several times wider than
 * the wire it names, so separating the wires does not separate the labels — on
 * the fan this was written for, three of them landed fifteen pixels apart and
 * the top one buried the two beneath it. Spacing is enforced on y alone because
 * that is the axis a pill is short on, and the run is recentred afterwards so
 * the group still sits over the links it describes instead of drifting down.
 */
function spreadLabels(lane: Wire[]) {
  if (lane.length < 2) return;
  const order = [...lane].sort((a, b) => a.mid.y - b.mid.y);
  const mean = (ws: Wire[]) => ws.reduce((sum, w) => sum + w.mid.y, 0) / ws.length;
  const before = mean(order);
  for (let i = 1; i < order.length; i++) {
    const floor = order[i - 1]!.mid.y + LABEL_PITCH;
    if (order[i]!.mid.y < floor) order[i]!.mid.y = floor;
  }
  const shift = before - mean(order);
  for (const w of order) w.mid.y += shift;
}

type Pt = { x: number; y: number };

/** The point at `t` along a cubic bezier. */
function cubicAt(t: number, p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/* ------------------------------------------------------------------- utils */

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function snap(n: number) {
  return Math.round(n / GRID) * GRID;
}
