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
import type { WorkflowChatTurn } from "../shared/protocol";
import {
  CARD,
  GRAPH_LIMITS,
  GRAPH_PRESETS,
  MAX_POS,
  RELATIONS,
  SAVED_LIMITS,
  delegatesOf,
  graphWarnings,
  leadOf,
  matchGraphPreset,
  matchSavedWorkflow,
  relationInfo,
  removeSavedWorkflow,
  renameSavedWorkflow,
  saveWorkflow,
  summarizeGraph,
  type AgentNode,
  type Relation,
  type RelationKind,
  type SavedWorkflow,
  type WorkflowGraph,
} from "../shared/workflow";
import {
  getLibrary,
  newWorkflowId,
  setLibrary as writeLibrary,
  subscribeLibrary,
  syncLibrary,
} from "./presets";

const GRID = 20;

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

type Selection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "none" };

export type WorkflowChatState = {
  turns: WorkflowChatTurn[];
  pending: boolean;
  error: string | null;
  proposal: { graph: WorkflowGraph; note: string; warnings: string[] } | null;
};

export function WorkflowPanel({
  graph,
  active,
  canEdit,
  canSetModels,
  busy,
  onApply,
  onClose,
  chat,
  onChatSend,
  onChatReset,
  mcpTokensSet,
  onSetMcpToken,
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
  /** State of the "describe your workflow" chat, lived above this panel — a
   *  reply arrives over the room's socket, which this panel does not own. */
  chat: WorkflowChatState;
  onChatSend: (text: string, graph: WorkflowGraph) => void;
  onChatReset: () => void;
  /** `"nodeId:serverId"` keys with a stored MCP token — see room.ts#mcpTokensSet. */
  mcpTokensSet: string[];
  onSetMcpToken: (nodeId: string, serverId: string, token: string) => void;
}) {
  const [draft, setDraft] = useState<WorkflowGraph>(graph);
  const [useCustom, setUseCustom] = useState(active);
  const [selected, setSelected] = useState<Selection>({ kind: "none" });
  /** Source node id while a link is being drawn, else null. */
  const [linking, setLinking] = useState<string | null>(null);
  const [showChat, setShowChat] = useState(false);

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

  /* ------------------------------------------------------------- library */

  /**
   * This person's saved workflows, which belong to them rather than to this
   * room — the same library shows up in every room they open and on every
   * machine they sign in on, which is the whole point of saving one.
   *
   * The store owns the copy; this is a view of it. Writes go to the store and
   * come back through the subscription, so a save made here and a save made in
   * another tab reach this list by the same path.
   */
  const [library, setLibraryView] = useState<SavedWorkflow[]>(getLibrary);
  /** The name being typed, or null when the save form is closed. */
  const [saving, setSaving] = useState<string | null>(null);
  /** Which saved workflow is being renamed, and the name so far. */
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);

  useEffect(() => subscribeLibrary(setLibraryView), []);

  // Opening this screen is the moment someone is about to reach for a workflow
  // they may have saved on another machine, so it is the moment to go and get
  // the account's copy. Failure is silent: the local library still works.
  useEffect(() => {
    void syncLibrary({ force: true });
  }, []);

  const commitLibrary = useCallback(
    (next: SavedWorkflow[], deleted?: string[]) => writeLibrary(next, deleted),
    [],
  );

  const savedMatch = useMemo(() => matchSavedWorkflow(library, draft), [library, draft]);

  /**
   * Keep the canvas under a name.
   *
   * Saving over a name already in the library replaces that entry, so "save,
   * tweak, save again" ends with one workflow rather than three near-identical
   * ones. Reusing the existing entry's id keeps it where it was in the list.
   */
  const keep = useCallback(
    (label: string, id?: string) => {
      const name = label.trim();
      if (!name) return;
      const existing = id ?? library.find((w) => w.label.toLowerCase() === name.toLowerCase())?.id;
      commitLibrary(
        saveWorkflow(library, { id: existing ?? newWorkflowId(), label: name, graph: draft }),
      );
      setSaving(null);
    },
    [commitLibrary, draft, library],
  );

  /** Put a graph on the canvas, from a built-in preset or the library. */
  const load = useCallback((graph: WorkflowGraph) => {
    setDraft(JSON.parse(JSON.stringify(graph)) as WorkflowGraph);
    setSelected({ kind: "none" });
    setLinking(null);
  }, []);

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
      mcpServers: [],
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
      if (showChat) setShowChat(false);
      else if (linking) setLinking(null);
      else if (selected.kind !== "none") setSelected({ kind: "none" });
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showChat, linking, selected.kind, onClose]);

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
          {canEdit && (
            <section>
              <h3>Describe it instead</h3>
              <button className="wf-add wf-chat-open" onClick={() => setShowChat(true)}>
                Describe your workflow
              </button>
              <p className="wf-note">
                Tell an assistant what you want the team to do, and it drafts a graph here for
                you to check and adjust. It can also edit whatever is already on the canvas —
                "add a critic" works too.
              </p>
            </section>
          )}

          <section>
            <h3>Start from</h3>
            <div className="wf-presets">
              {GRAPH_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={`wf-preset ${preset === p.id ? "on" : ""}`}
                  disabled={!canEdit}
                  onClick={() => load(p.graph)}
                >
                  <span className="wf-preset-name">{p.label}</span>
                  <span className="wf-preset-desc">{p.description}</span>
                </button>
              ))}
            </div>
          </section>

          {/* ------------------------------------------------------- library */}
          <section>
            <h3>Saved workflows</h3>
            {library.length === 0 ? (
              <p className="wf-note">
                Nothing saved yet. Keep a team here and any other room can start from it.
              </p>
            ) : (
              <div className="wf-presets">
                {library.map((w) => (
                  <div key={w.id} className={`wf-saved ${savedMatch === w.id ? "on" : ""}`}>
                    {renaming?.id === w.id ? (
                      <form
                        className="wf-save-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          commitLibrary(renameSavedWorkflow(library, w.id, renaming.label));
                          setRenaming(null);
                        }}
                      >
                        <input
                          autoFocus
                          value={renaming.label}
                          maxLength={SAVED_LIMITS.labelChars}
                          aria-label={`Rename ${w.label}`}
                          onChange={(e) => setRenaming({ id: w.id, label: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setRenaming(null);
                          }}
                        />
                        <div className="wf-save-acts">
                          <button
                            className="primary"
                            type="submit"
                            disabled={!renaming.label.trim()}
                          >
                            Rename
                          </button>
                          <button type="button" onClick={() => setRenaming(null)}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <button
                          className="wf-preset wf-saved-load"
                          disabled={!canEdit}
                          onClick={() => load(w.graph)}
                          title="Put this workflow on the canvas"
                        >
                          <span className="wf-preset-name">{w.label}</span>
                          <span className="wf-preset-desc">{summarizeGraph(w.graph)}</span>
                        </button>
                        {/* The library is personal, so these stay available to
                            someone who may only look at this room's graph —
                            they can keep a copy for a room of their own. */}
                        <div className="wf-saved-acts">
                          <button
                            onClick={() => keep(w.label, w.id)}
                            title="Save the canvas over this one"
                          >
                            Update
                          </button>
                          <button onClick={() => setRenaming({ id: w.id, label: w.label })}>
                            Rename
                          </button>
                          <button
                            onClick={() => commitLibrary(removeSavedWorkflow(library, w.id), [w.id])}
                            title={`Delete ${w.label}`}
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            {saving === null ? (
              <button
                className="wf-add wf-save-open"
                disabled={library.length >= SAVED_LIMITS.count && !savedMatch}
                onClick={() => setSaving(library.find((w) => w.id === savedMatch)?.label ?? "")}
              >
                Save this workflow
              </button>
            ) : (
              <form
                className="wf-save-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  keep(saving);
                }}
              >
                <input
                  autoFocus
                  value={saving}
                  maxLength={SAVED_LIMITS.labelChars}
                  placeholder="Name this workflow"
                  aria-label="Name this workflow"
                  onChange={(e) => setSaving(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setSaving(null);
                  }}
                />
                <div className="wf-save-acts">
                  <button className="primary" type="submit" disabled={!saving.trim()}>
                    {library.some((w) => w.label.toLowerCase() === saving.trim().toLowerCase())
                      ? "Replace"
                      : "Save"}
                  </button>
                  <button type="button" onClick={() => setSaving(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
            <p className="wf-note">
              {library.length} of {SAVED_LIMITS.count} saved.{" "}
              {library.length >= SAVED_LIMITS.count && !savedMatch
                ? "The library is full — delete one to keep another."
                : "Saved workflows are yours and follow your account when you are signed in; the room runs whatever was last applied to it."}
            </p>
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
              // Token entry targets the room's currently-applied graph, not this
              // unsaved draft — a server row added here has no token to set
              // until Apply gives it somewhere real to live.
              savedServerIds={
                new Set(graph.nodes.find((n) => n.id === selNode.id)?.mcpServers?.map((s) => s.id) ?? [])
              }
              mcpTokensSet={mcpTokensSet}
              onSetMcpToken={onSetMcpToken}
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

      {showChat && (
        <WorkflowChatPanel
          chat={chat}
          currentGraph={draft}
          busy={busy}
          onSend={onChatSend}
          onUseDraft={(g) => {
            load(g);
            setShowChat(false);
          }}
          onReset={onChatReset}
          onClose={() => setShowChat(false)}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------- describe chat */

/**
 * "Describe your workflow" — a chat overlay that drafts or edits a graph, and
 * hands the result to the canvas underneath rather than applying anything
 * itself.
 *
 * Every send carries `currentGraph` — the canvas's own `draft` — so "add a
 * critic" edits the team already there instead of starting over; the model
 * decides how much of it to keep. Nothing here writes to the room. `onUseDraft`
 * puts the proposal on the same `draft` the manual editor uses, so Apply,
 * Revert, and every warning in `graphWarnings` behave exactly as if the graph
 * had been drawn by hand — this screen only ever proposes what to react to.
 */
function WorkflowChatPanel({
  chat,
  currentGraph,
  busy,
  onSend,
  onUseDraft,
  onReset,
  onClose,
}: {
  chat: WorkflowChatState;
  currentGraph: WorkflowGraph;
  busy: boolean;
  onSend: (text: string, graph: WorkflowGraph) => void;
  onUseDraft: (graph: WorkflowGraph) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat.turns.length, chat.pending]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || chat.pending || busy) return;
    onSend(trimmed, currentGraph);
    setText("");
  };

  return (
    <div className="wfc-overlay" role="dialog" aria-label="Describe your workflow">
      <header className="wfc-head">
        <div>
          <h3>Describe your workflow</h3>
          <p className="wf-sub">
            Say what the team should do, or how to change the team already on the canvas.
            Answer if it asks one question back, then check the draft it puts there.
          </p>
        </div>
        <div className="wfc-head-acts">
          {chat.turns.length > 0 && (
            <button onClick={onReset} disabled={chat.pending}>
              Start over
            </button>
          )}
          <button className="icon" onClick={onClose} aria-label="Back to canvas">
            ✕
          </button>
        </div>
      </header>

      {busy && (
        <div className="notice wf-notice">
          The agent is working, so a draft cannot be applied yet — you can still describe one.
        </div>
      )}

      <div className="wfc-body">
        <div className="wfc-turns" ref={listRef}>
          {chat.turns.length === 0 && !chat.pending && (
            <p className="wf-note">
              {currentGraph.nodes.length > 1
                ? `For example: "add a critic that reviews the researcher's work" — this edits the ` +
                  `team already on the canvas.`
                : `For example: "A lead that plans posts, a researcher that gathers sources, and ` +
                  `an editor that polishes the final copy."`}
            </p>
          )}
          {chat.turns.map((t, i) => (
            <div key={i} className={`wfc-turn wfc-turn-${t.role}`}>
              <span className="wfc-turn-who">{t.role === "user" ? "You" : "Assistant"}</span>
              <p>{t.text}</p>
            </div>
          ))}
          {chat.pending && (
            <div className="wfc-turn wfc-turn-assistant wfc-turn-pending">
              <span className="wfc-turn-who">Assistant</span>
              <p>Thinking…</p>
            </div>
          )}
          {chat.error && <p className="wfc-error">{chat.error}</p>}
        </div>

        {chat.proposal && (
          <div className="wfc-proposal">
            <div>
              <b>{chat.proposal.note}</b>
              <p className="wf-note">{summarizeGraph(chat.proposal.graph)}</p>
              {chat.proposal.warnings.length > 0 && (
                <ul className="wf-warnings">
                  {chat.proposal.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
            <button className="primary" onClick={() => onUseDraft(chat.proposal!.graph)}>
              Put this on the canvas
            </button>
          </div>
        )}

        <form
          className="wfc-composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            rows={3}
            value={text}
            placeholder="Describe the team you want…"
            disabled={chat.pending}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button className="primary" type="submit" disabled={!text.trim() || chat.pending}>
            {chat.pending ? "Sending…" : "Send"}
          </button>
        </form>
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
  savedServerIds,
  mcpTokensSet,
  onSetMcpToken,
}: {
  node: AgentNode;
  graph: WorkflowGraph;
  canEdit: boolean;
  canSetModels: boolean;
  onPatch: (patch: Partial<AgentNode>) => void;
  onDelete: () => void;
  onStartLink: () => void;
  /** MCP server ids that exist in the room's applied graph, not just this draft. */
  savedServerIds: Set<string>;
  mcpTokensSet: string[];
  onSetMcpToken: (nodeId: string, serverId: string, token: string) => void;
}) {
  const isLead = node.id === graph.leadId;
  // `?? []`: a graph applied before mcpServers existed synced nodes without
  // it — this comes straight off RoomState, not sanitizeGraph's output.
  const mcpServers = node.mcpServers ?? [];
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

      {!isLead && (
        <div className="field">
          <span className="field-label">MCP Servers</span>
          <div className="wf-mcp-list">
            {mcpServers.map((s) => (
              <div className="wf-mcp-row" key={s.id}>
                <input
                  className="wf-mcp-name"
                  value={s.name}
                  disabled={!canEdit}
                  maxLength={GRAPH_LIMITS.mcpNameChars}
                  placeholder="Name"
                  onChange={(e) =>
                    onPatch({
                      mcpServers: mcpServers.map((x) =>
                        x.id === s.id ? { ...x, name: e.target.value } : x,
                      ),
                    })
                  }
                />
                <input
                  className="wf-mcp-url"
                  value={s.url}
                  disabled={!canEdit}
                  maxLength={GRAPH_LIMITS.mcpUrlChars}
                  placeholder="https://…"
                  onChange={(e) =>
                    onPatch({
                      mcpServers: mcpServers.map((x) =>
                        x.id === s.id ? { ...x, url: e.target.value } : x,
                      ),
                    })
                  }
                />
                {canEdit && (
                  <button
                    className="wf-danger"
                    onClick={() =>
                      onPatch({ mcpServers: mcpServers.filter((x) => x.id !== s.id) })
                    }
                  >
                    Remove
                  </button>
                )}
                {canEdit &&
                  (savedServerIds.has(s.id) ? (
                    <McpTokenField
                      hasToken={mcpTokensSet.includes(`${node.id}:${s.id}`)}
                      onSave={(token) => onSetMcpToken(node.id, s.id, token)}
                    />
                  ) : (
                    <span className="field-note">Apply the workflow to set a token here.</span>
                  ))}
              </div>
            ))}
          </div>
          {canEdit && mcpServers.length < GRAPH_LIMITS.mcpServersPerNode && (
            <button
              onClick={() =>
                onPatch({
                  mcpServers: [...mcpServers, { id: newId(), name: "", url: "" }],
                })
              }
            >
              Add MCP Server
            </button>
          )}
          <span className="field-note">
            Remote MCP servers only — this agent calls their tools directly when it runs as a
            delegate. Tools from a connected server run without a room vote, so only add servers
            you trust.
          </span>
        </div>
      )}

      {canEdit && (
        <button onClick={onStartLink}>Draw a link from {node.name}</button>
      )}
    </div>
  );
}

/** A password-style input that only sends its value on explicit Save — never on every keystroke. */
function McpTokenField({ hasToken, onSave }: { hasToken: boolean; onSave: (token: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <span className="wf-mcp-token">
      <input
        type="password"
        value={draft}
        placeholder={hasToken ? "Token set — replace" : "Token (optional)"}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        disabled={draft === ""}
        onClick={() => {
          onSave(draft);
          setDraft("");
        }}
      >
        Save
      </button>
      {hasToken && (
        <button
          className="wf-danger"
          onClick={() => onSave("")}
        >
          Clear
        </button>
      )}
    </span>
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
