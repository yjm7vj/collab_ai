/**
 * One Durable Object per room. Everything the room needs to agree on lives here:
 * the transcript, the shared document, who is present, and the agent's turn.
 * Because a DO is single-threaded, none of it needs locking.
 *
 * The important design decision is in `advance()` / `settleIfDecided()`. An agent
 * turn that hits an approval-gated tool cannot simply `await` the vote: the
 * runtime may evict this object long before a human clicks a button. So the turn
 * is a state machine whose progress is written to storage. `advance()` runs until
 * it either finishes or parks on a vote, then returns. A later `vote` message —
 * separate invocation, possibly a fresh instance — reads that state back and
 * resumes. Nothing is held in memory across the wait.
 */

import { Agent, type Connection, type ConnectionContext } from "agents";
import type {
  MessageParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";

import {
  INITIAL_ROOM_STATE,
  colorFor,
  tally,
  thresholdFor,
  type AgentBlock,
  type ClientMsg,
  type Entry,
  type PendingTool,
  type Presence,
  type RoomState,
  type ServerMsg,
  type WorkerStatus,
} from "../shared/protocol";
import {
  DEFAULT_SETTINGS,
  addUsage,
  describeSettings,
  effectiveWorkerCap,
  sanitizeSettings,
  type RoomSettings,
} from "../shared/models";
import {
  runModel,
  runWorker,
  summarize as summarizeConversation,
  type ModelConfig,
  type Usage,
  type WorkerTask,
} from "./model";
import { GATED, execute, summarize as summarizeCall, type ToolCtx } from "./tools";

/** In-flight turn bookkeeping. Persisted, because a turn can outlive this instance. */
type Turn = {
  /** Transcript entry this turn is writing into. */
  entryId: string;
  /** Results from auto-approved tools, held until the gated ones are decided. */
  carried: ToolResultBlockParam[];
};

type QueuedLine = { name: string; text: string };

/** Hard stop on tool round-trips so a confused turn can't loop forever. */
const MAX_ROUNDS = 12;

export class Room extends Agent<Env, RoomState> {
  initialState: RoomState = INITIAL_ROOM_STATE;

  #schemaReady = false;

  // ---------------------------------------------------------------- storage

  #ready() {
    if (this.#schemaReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`;
    this.#schemaReady = true;
  }

  #kvGet<T>(key: string, fallback: T): T {
    const rows = this.sql<{ v: string }>`SELECT v FROM kv WHERE k = ${key}`;
    if (rows.length === 0) return fallback;
    try {
      return JSON.parse(rows[0]!.v) as T;
    } catch {
      return fallback;
    }
  }

  #kvSet(key: string, value: unknown) {
    const v = JSON.stringify(value);
    this.sql`INSERT INTO kv (k, v) VALUES (${key}, ${v})
             ON CONFLICT(k) DO UPDATE SET v = excluded.v`;
  }

  #kvDel(key: string) {
    this.sql`DELETE FROM kv WHERE k = ${key}`;
  }

  #convo(): MessageParam[] {
    return this.#kvGet<MessageParam[]>("convo", []);
  }
  #setConvo(m: MessageParam[]) {
    this.#kvSet("convo", m);
  }

  #inbox(): QueuedLine[] {
    return this.#kvGet<QueuedLine[]>("inbox", []);
  }
  #setInbox(q: QueuedLine[]) {
    this.#kvSet("inbox", q);
  }

  #turn(): Turn | null {
    return this.#kvGet<Turn | null>("turn", null);
  }
  #setTurn(t: Turn | null) {
    if (t === null) this.#kvDel("turn");
    else this.#kvSet("turn", t);
  }

  // -------------------------------------------------------------- transcript

  #entries(): Entry[] {
    const rows = this.sql<{ json: string }>`SELECT json FROM entries ORDER BY ts ASC`;
    return rows.map((r) => JSON.parse(r.json) as Entry);
  }

  #getEntry(id: string): Entry | null {
    const rows = this.sql<{ json: string }>`SELECT json FROM entries WHERE id = ${id}`;
    return rows.length ? (JSON.parse(rows[0]!.json) as Entry) : null;
  }

  #putEntry(entry: Entry) {
    const json = JSON.stringify(entry);
    this.sql`INSERT INTO entries (id, ts, json) VALUES (${entry.id}, ${entry.ts}, ${json})
             ON CONFLICT(id) DO UPDATE SET json = excluded.json`;
  }

  #append(entry: Entry) {
    this.#putEntry(entry);
    this.#send({ t: "entry", entry });
  }

  #patch(entry: Entry) {
    this.#putEntry(entry);
    this.#send({ t: "patch", entry });
  }

  #system(text: string) {
    this.#append({ id: crypto.randomUUID(), ts: Date.now(), kind: "system", text });
  }

  #send(msg: ServerMsg) {
    this.broadcast(JSON.stringify(msg));
  }

  // ---------------------------------------------------------------- presence

  #presence(): Presence[] {
    const out: Presence[] = [];
    for (const conn of this.getConnections()) {
      const name = this.#kvGet<string | null>(`user:${conn.id}`, null);
      if (name) out.push({ id: conn.id, name, color: colorFor(conn.id) });
    }
    return out;
  }

  /**
   * Recompute who is here. Thresholds on open votes move with the headcount —
   * otherwise a vote raised in a busy room becomes undecidable once people leave.
   */
  async #refreshPresence() {
    const users = this.#presence();
    const threshold = thresholdFor(users.length);
    const present = new Set(users.map((u) => u.id));

    const pending = this.state.pending.map((p) => {
      // Drop votes from people who have left, so tallies match the new threshold.
      const votes = Object.fromEntries(
        Object.entries(p.votes).filter(([id]) => present.has(id)),
      );
      return { ...p, votes, threshold };
    });

    this.setState({ ...this.state, users, pending });
    if (pending.length > 0) await this.#settleIfDecided();
  }

  // ------------------------------------------------------------ connections

  override async onConnect(connection: Connection, _ctx: ConnectionContext) {
    this.#ready();
    connection.send(JSON.stringify({ t: "you", id: connection.id } satisfies ServerMsg));
    connection.send(
      JSON.stringify({ t: "history", entries: this.#entries() } satisfies ServerMsg),
    );
  }

  override async onClose(connection: Connection) {
    this.#ready();
    const name = this.#kvGet<string | null>(`user:${connection.id}`, null);
    this.#kvDel(`user:${connection.id}`);
    if (name) this.#system(`${name} left`);
    await this.#refreshPresence();
  }

  override async onMessage(connection: Connection, raw: string | ArrayBuffer) {
    this.#ready();
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    switch (msg.t) {
      case "join":
        return this.#onJoin(connection, msg.name);
      case "say":
        return this.#onSay(connection, msg.text);
      case "vote":
        return this.#onVote(connection, msg.toolUseId, msg.vote);
      case "interrupt":
        return this.#onInterrupt(connection);
      case "settings":
        return this.#onSettings(connection, msg.settings);
      case "compact":
        return this.#onCompact(connection);
    }
  }

  /**
   * Apply a configuration change.
   *
   * Settings are room-wide — everyone shares one agent, so everyone shares its
   * configuration. Rather than putting changes to a vote, every change is
   * announced in the transcript with who made it, so the room can see the model
   * or the spend policy shift under them.
   */
  async #onSettings(connection: Connection, incoming: unknown) {
    const name = this.#kvGet<string | null>(`user:${connection.id}`, null);
    if (!name) return;

    // Changing models mid-turn would swap the model underneath a running tool
    // loop and invalidate the prompt cache, so hold changes until it settles.
    if (this.state.status !== "idle") {
      connection.send(
        JSON.stringify({
          t: "error",
          message: "Settings can only change while the agent is idle.",
        } satisfies ServerMsg),
      );
      return;
    }

    // Never trust the client: re-validate against the model catalogue so a stale
    // or crafted frame can't put an invalid parameter on the wire.
    const settings = sanitizeSettings(incoming);
    this.setState({ ...this.state, settings });
    this.#system(
      `${name} changed the setup — ${describeSettings(settings, this.state.users.length)}`,
    );
  }

  async #onCompact(connection: Connection) {
    const name = this.#kvGet<string | null>(`user:${connection.id}`, null);
    if (!name) return;
    if (this.state.status !== "idle") {
      connection.send(
        JSON.stringify({
          t: "error",
          message: "Wait for the agent to finish before compacting.",
        } satisfies ServerMsg),
      );
      return;
    }
    await this.#compact(`${name} compacted it manually`);
  }

  async #onJoin(connection: Connection, rawName: string) {
    const name = rawName.trim().slice(0, 32) || "anon";
    const existing = this.#kvGet<string | null>(`user:${connection.id}`, null);
    this.#kvSet(`user:${connection.id}`, name);
    if (existing !== name) this.#system(`${name} joined`);
    await this.#refreshPresence();
  }

  async #onSay(connection: Connection, rawText: string) {
    const text = rawText.trim();
    if (!text) return;
    const name = this.#kvGet<string | null>(`user:${connection.id}`, null);
    if (!name) return; // must join before speaking

    this.#append({
      id: crypto.randomUUID(),
      ts: Date.now(),
      kind: "user",
      authorId: connection.id,
      authorName: name,
      color: colorFor(connection.id),
      text,
    });

    // Queue rather than interrupt. If the agent is mid-turn this line waits and
    // is folded into the next one, so concurrent speakers never split a turn.
    this.#setInbox([...this.#inbox(), { name, text }]);

    if (this.state.status === "idle") await this.#startTurn();
  }

  async #onVote(connection: Connection, toolUseId: string, vote: "approve" | "deny") {
    const name = this.#kvGet<string | null>(`user:${connection.id}`, null);
    if (!name) return;

    // Ignore votes for calls that are no longer open — a stale click from a
    // client whose view hadn't caught up yet.
    if (!this.state.pending.some((p) => p.toolUseId === toolUseId)) return;

    const pending = this.state.pending.map((p) =>
      p.toolUseId === toolUseId
        ? { ...p, votes: { ...p.votes, [connection.id]: vote } }
        : p,
    );
    this.setState({ ...this.state, pending });
    await this.#settleIfDecided();
  }

  async #onInterrupt(connection: Connection) {
    const name = this.#kvGet<string | null>(`user:${connection.id}`, null);
    if (this.state.status === "idle") return;
    this.#setTurn(null);
    this.#setInbox([]);
    this.setState({ ...this.state, status: "idle", pending: [] });
    this.#system(`${name ?? "someone"} stopped the agent`);
  }

  // ------------------------------------------------------------- agent turn

  #config(): ModelConfig {
    return { apiKey: this.env.ANTHROPIC_API_KEY };
  }

  #settings(): RoomSettings {
    return this.state.settings ?? DEFAULT_SETTINGS;
  }

  /** Fold one response's token counts into the room's running ledger. */
  #recordUsage(usage: Usage | null | undefined) {
    if (!usage) return;
    this.setState({
      ...this.state,
      cost: addUsage(this.state.cost, usage.model, usage.in, usage.out),
      context: {
        messages: this.#convo().length,
        tokens: usage.promptTokens || this.state.context.tokens,
      },
    });
  }

  /**
   * A document buffer for one tool round.
   *
   * Tools read and write through this rather than through `this.state` directly,
   * for two reasons: several approved edits can land in the same round and each
   * must see the previous one's result, and one flush at the end means one state
   * broadcast instead of one per edit.
   */
  #docBuffer(): ToolCtx & { flush(): void } {
    let doc = this.state.doc;
    let dirty = false;
    return {
      getDoc: () => doc,
      setDoc: (next) => {
        doc = next;
        dirty = true;
      },
      flush: () => {
        if (!dirty) return;
        this.setState({
          ...this.state,
          doc,
          docRevision: this.state.docRevision + 1,
        });
      },
    };
  }

  /* ---------------------------------------------------------- compaction */

  /**
   * Find a message index it is safe to cut the history at.
   *
   * A `tool_use` block must always be followed by its matching `tool_result`, so
   * cutting mid-round would produce a conversation the API rejects. The only
   * unambiguously safe boundary is a plain-text user turn — one that starts a
   * round rather than answering a tool call. Walks backwards from `target`.
   */
  #safeCut(convo: MessageParam[], target: number): number {
    for (let i = Math.min(target, convo.length - 1); i > 0; i--) {
      const m = convo[i]!;
      if (m.role === "user" && typeof m.content === "string") return i;
    }
    return 0;
  }

  /** Whether the conversation has grown past either configured threshold. */
  #needsCompaction(): string | null {
    const { compactAfterMessages, maxContextTokens } = this.#settings().context;
    const messages = this.#convo().length;
    const tokens = this.state.context.tokens;
    if (compactAfterMessages > 0 && messages > compactAfterMessages) {
      return `${messages} messages exceeds the ${compactAfterMessages} limit`;
    }
    if (maxContextTokens > 0 && tokens > maxContextTokens) {
      return `${tokens.toLocaleString()} tokens exceeds the ${maxContextTokens.toLocaleString()} limit`;
    }
    return null;
  }

  /**
   * Replace the older half of the conversation with a summary.
   *
   * Only ever runs between turns, never mid-turn: rewriting history while a turn
   * is parked on a vote would orphan the tool call it is waiting to resolve.
   */
  async #compact(reason: string) {
    const settings = this.#settings();
    const convo = this.#convo();
    const cut = this.#safeCut(convo, convo.length - settings.context.keepRecentMessages);
    if (cut <= 1) return; // nothing meaningful to fold away

    const older = convo.slice(0, cut);
    let summaryText: string;
    try {
      const { text, usage } = await summarizeConversation(this.#config(), settings, older);
      this.#recordUsage(usage);
      summaryText = text;
    } catch (err) {
      console.error("compaction failed", err);
      this.#system(
        "Could not compact the conversation, so it is still growing. " +
          (err instanceof Error ? err.message : String(err)),
      );
      return;
    }

    this.#setConvo([
      {
        role: "user",
        content:
          "[Summary of earlier conversation in this room, folded down to save " +
          `context. ${older.length} messages replaced.]\n\n${summaryText}`,
      },
      ...convo.slice(cut),
    ]);

    this.setState({
      ...this.state,
      context: { messages: this.#convo().length, tokens: 0 },
    });
    this.#system(
      `Compacted ${older.length} earlier messages — ${reason}. ` +
        `The last ${convo.length - cut} are kept verbatim.`,
    );
  }

  /* --------------------------------------------------------- delegation */

  /**
   * Run delegated tasks on the worker model, `cap` at a time.
   *
   * Workers hold read-only tools, so nothing here can change the document or
   * needs the room's approval. Their progress is mirrored into room state so
   * everyone can watch the fan-out rather than staring at a spinner.
   */
  async #delegate(rawTasks: unknown, ctx: ToolCtx): Promise<{ ok: boolean; text: string }> {
    const settings = this.#settings();
    const cap = effectiveWorkerCap(settings, this.state.users.length);

    const parsed = Array.isArray(rawTasks) ? rawTasks : [];
    const tasks: WorkerTask[] = parsed
      .filter((t): t is WorkerTask => !!t && typeof (t as WorkerTask).title === "string")
      .map((t) => ({
        title: String(t.title).slice(0, 120),
        instructions: String(t.instructions ?? ""),
      }));

    if (tasks.length === 0) {
      return { ok: false, text: "delegate requires a non-empty `tasks` array." };
    }

    const dropped = Math.max(0, tasks.length - cap);
    const accepted = tasks.slice(0, cap);

    const statuses: WorkerStatus[] = accepted.map((t) => ({
      id: crypto.randomUUID(),
      title: t.title,
      model: settings.workerModel,
      state: "running",
    }));
    this.setState({ ...this.state, workers: statuses });

    const settle = (id: string, state: WorkerStatus["state"]) => {
      this.setState({
        ...this.state,
        workers: this.state.workers.map((w) => (w.id === id ? { ...w, state } : w)),
      });
    };

    const results = await Promise.all(
      accepted.map(async (task, i) => {
        const id = statuses[i]!.id;
        try {
          const r = await runWorker(this.#config(), settings, task, ctx);
          r.usage.forEach((u) => this.#recordUsage(u));
          settle(id, "done");
          return `## ${task.title}\n\n${r.text}`;
        } catch (err) {
          settle(id, "failed");
          const msg = err instanceof Error ? err.message : String(err);
          return `## ${task.title}\n\n(worker failed: ${msg})`;
        }
      }),
    );

    this.setState({ ...this.state, workers: [] });

    const notice = dropped
      ? `\n\n(${dropped} further task${dropped === 1 ? "" : "s"} were dropped — the ` +
        `room's worker cap is ${cap}. Delegate them in a follow-up call if they matter.)`
      : "";

    return { ok: true, text: results.join("\n\n---\n\n") + notice };
  }

  /** Drain the inbox into one user turn and hand it to the model. */
  async #startTurn() {
    const inbox = this.#inbox();
    if (inbox.length === 0) return;

    // Compact before the turn, never during one. Rewriting history while a turn
    // is parked on a vote would orphan the tool call it is waiting to resolve.
    const reason = this.#needsCompaction();
    if (reason) await this.#compact(reason);

    this.#setInbox([]);

    // The whole point of the room: many speakers collapse into one tagged turn,
    // so the model sees a conversation rather than a single anonymous request.
    const text = inbox.map((l) => `[${l.name}]: ${l.text}`).join("\n");
    this.#setConvo([...this.#convo(), { role: "user", content: text }]);

    const entry: Entry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      kind: "agent",
      blocks: [],
    };
    this.#append(entry);
    this.#setTurn({ entryId: entry.id, carried: [] });
    this.setState({ ...this.state, status: "thinking" });

    await this.#advance();
  }

  /**
   * Run the model until the turn ends or parks on a vote.
   *
   * Returns (rather than awaiting) when a gated tool needs approval. Everything
   * needed to pick the turn back up is in storage by then.
   */
  async #advance() {
    let round = 0;
    try {
      for (; round < MAX_ROUNDS; round++) {
        const turn = this.#turn();
        if (!turn) return; // interrupted

        const entry = this.#getEntry(turn.entryId);
        if (!entry || entry.kind !== "agent") break;

        // Map API content-block index -> index in the entry we render.
        const slots = new Map<number, number>();

        const { message, usage } = await runModel(this.#config(), this.#settings(), this.#convo(), {
          onBlockStart: (index, type) => {
            if (type !== "text" && type !== "thinking") return;
            entry.blocks.push({ type, text: "" } as AgentBlock);
            slots.set(index, entry.blocks.length - 1);
            this.#patch(entry);
          },
          onDelta: (index, _kind, text) => {
            const slot = slots.get(index);
            if (slot === undefined) return;
            const block = entry.blocks[slot]!;
            if (block.type === "text" || block.type === "thinking") block.text += text;
            // Stream the token; persist the accumulated entry once, below. A
            // write per token would be a lot of storage traffic for no benefit.
            this.#send({ t: "delta", entryId: entry.id, block: slot, text });
          },
        });

        this.#setConvo([...this.#convo(), { role: "assistant", content: message.content }]);
        this.#recordUsage(usage);

        // Refusals stop the turn; there is no content to act on.
        if (message.stop_reason === "refusal") {
          this.#patch(entry);
          this.#system(
            "The model declined this request" +
              (message.stop_details?.explanation
                ? `: ${message.stop_details.explanation}`
                : "."),
          );
          break;
        }

        // A server-side tool (search/fetch) hit its iteration cap mid-turn.
        // Re-send to let it carry on; there is nothing for us to execute.
        if (message.stop_reason === "pause_turn") {
          this.#patch(entry);
          continue;
        }

        if (message.stop_reason !== "tool_use") {
          this.#patch(entry);
          if (message.stop_reason === "max_tokens") {
            this.#system("The agent hit its output limit and stopped early.");
          }
          break;
        }

        // ---- tool round ----
        const calls = message.content.filter((b) => b.type === "tool_use");
        const results: ToolResultBlockParam[] = [...turn.carried];
        const gated: PendingTool[] = [];
        const threshold = thresholdFor(this.state.users.length);
        const docs = this.#docBuffer();

        for (const call of calls) {
          entry.blocks.push({
            type: "tool",
            toolUseId: call.id,
            name: call.name,
            input: call.input,
            status: "running",
          });

          if (GATED.has(call.name)) {
            gated.push({
              toolUseId: call.id,
              name: call.name,
              input: call.input,
              summary: summarizeCall(call.name, call.input),
              votes: {},
              threshold,
            });
          } else {
            // `delegate` is the one async tool — it fans out to worker models.
            // Everything else resolves synchronously against the doc buffer.
            const outcome =
              call.name === "delegate"
                ? await this.#delegate((call.input as { tasks?: unknown })?.tasks, docs)
                : execute(call.name, call.input, docs);

            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: outcome.text,
              is_error: !outcome.ok,
            });
            const block = entry.blocks.at(-1)!;
            if (block.type === "tool") {
              block.status = outcome.ok ? "ok" : "error";
              block.result = outcome.text;
            }
          }
        }
        docs.flush();
        this.#patch(entry);

        if (gated.length > 0) {
          // Park. The vote handler resumes from here.
          this.#setTurn({ ...turn, carried: results });
          this.setState({ ...this.state, status: "awaiting_approval", pending: gated });
          return;
        }

        this.#setConvo([...this.#convo(), { role: "user", content: results }]);
        this.#setTurn({ ...turn, carried: [] });
      }

      if (round >= MAX_ROUNDS) {
        this.#system(
          `The agent stopped after ${MAX_ROUNDS} tool rounds without finishing. ` +
            "Say something to nudge it in a different direction.",
        );
      }
    } catch (err) {
      console.error("agent turn failed", err);
      this.#system(
        `The agent turn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.#finishTurn();
  }

  async #finishTurn() {
    this.#setTurn(null);
    this.setState({ ...this.state, status: "idle", pending: [] });
    // Anything said while the agent was busy becomes the next turn.
    if (this.#inbox().length > 0) await this.#startTurn();
  }

  /**
   * If every parked tool call has reached its threshold, apply the verdicts and
   * resume the turn. Called after any vote and after presence changes.
   */
  async #settleIfDecided() {
    const turn = this.#turn();
    if (!turn || this.state.pending.length === 0) return;

    const verdicts: { p: PendingTool; approved: boolean }[] = [];
    for (const p of this.state.pending) {
      const { approve, deny } = tally(p);
      if (approve >= p.threshold) verdicts.push({ p, approved: true });
      else if (deny >= p.threshold) verdicts.push({ p, approved: false });
      else return; // at least one still undecided — keep waiting
    }

    const entry = this.#getEntry(turn.entryId);
    if (!entry || entry.kind !== "agent") return;

    const results: ToolResultBlockParam[] = [...turn.carried];
    const docs = this.#docBuffer();
    for (const { p, approved } of verdicts) {
      const outcome = approved
        ? execute(p.name, p.input, docs)
        : {
            ok: false,
            text:
              "The room voted against this action, so it did not run. Do not " +
              "retry the same call — ask the room what they would prefer.",
          };

      results.push({
        type: "tool_result",
        tool_use_id: p.toolUseId,
        content: outcome.text,
        is_error: !outcome.ok,
      });

      const block = entry.blocks.find(
        (b) => b.type === "tool" && b.toolUseId === p.toolUseId,
      );
      if (block && block.type === "tool") {
        block.status = approved ? (outcome.ok ? "ok" : "error") : "denied";
        block.result = outcome.text;
      }
    }
    docs.flush();
    this.#patch(entry);

    this.#setConvo([...this.#convo(), { role: "user", content: results }]);
    this.#setTurn({ ...turn, carried: [] });
    this.setState({ ...this.state, status: "thinking", pending: [] });

    await this.#advance();
  }
}
