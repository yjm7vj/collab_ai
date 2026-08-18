# collab_ai

Multiplayer AI: several people in one room, sharing one agent.

Everyone talks into the same conversation. The agent sees who said what, replies
to the room rather than to a person, and edits a shared document — but any edit
it wants to make goes to a vote first.

---

## The problem this is actually solving

N humans produce input concurrently. An agent has one linear conversation and
takes one action at a time. How you reconcile those two facts *is* the product;
everything else is plumbing that follows from it.

| Concern | How it's handled |
|---|---|
| Many speakers, one conversation | Each message is tagged `[Name]:` and several are merged into a single user turn, so the model sees a room talking, not an anonymous request. |
| Someone types while the agent is working | The message goes into an inbox and is folded into the next turn. Nothing is dropped and no turn is split. |
| The group has to authorise an action | Document writes are gated. The agent's tool call becomes a proposal, and the room votes. |
| A vote takes longer than a request | The turn is a **persisted state machine**, not a suspended `await`. |

That last row is the one that shapes the code. You cannot `await` a human's
click inside an agent loop — the runtime will evict the object long before the
click arrives. So `Room#advance` runs the model until it either finishes or hits
a gated tool, writes everything needed to resume into storage, and **returns**.
A vote arriving minutes later, in a different invocation and possibly a fresh
instance, reads that state back and continues the turn from where it stopped.

---

## Architecture

```
browser (React)
   │  WebSocket
   ▼
Worker  ──/agents/room/:name──▶  Room  (Durable Object, one per room)
                                 ├── transcript      SQLite
                                 ├── conversation    SQLite  (Anthropic messages)
                                 ├── inbox + turn    SQLite  (resumable turn state)
                                 └── RoomState       synced to every client
                                        status · presence · doc · open votes
                                            │
                                            ▼
                                     Anthropic API (streaming)
```

One Durable Object per room means the transcript, the document, presence and the
vote tally all live in the same single-threaded place. There is nothing to lock
and no way for two clients to see different truths.

Two channels reach the browser. `RoomState` is synced automatically by the Agents
SDK and carries small current-value data (who's here, the document, open votes).
The transcript is append-heavy and far too large to resend on every keystroke, so
it is broadcast as explicit deltas instead.

| File | Role |
|---|---|
| `src/server/room.ts` | The Durable Object. Turn loop, approval state machine, presence. |
| `src/server/tools.ts` | Tool definitions, the `GATED` set, and their implementations. |
| `src/server/model.ts` | System prompt and the streaming Anthropic call. |
| `src/shared/protocol.ts` | Wire types and the voting policy, shared by both sides. |
| `src/client/` | React UI. |

---

## Running it

```bash
npm install
```

Create `.dev.vars` (gitignored — see `.dev.vars.example`):

```
ANTHROPIC_API_KEY=sk-ant-...
```

```bash
npm run dev
```

Open http://localhost:5173, pick a name, and create a room. To bring someone
else in, open the invite panel (🔗 in the header), create an invite link, and
send it to them — or just open the room URL in a second window to see the
multiplayer behaviour yourself.

Rooms have unguessable ids and are invite-only by default, so there is no
lobby to wander into and no room name to guess.

### No API key handy

Set `ANTHROPIC_API_KEY=mock` instead. The model is replaced by a scripted turn
that proposes a document write and then responds to however the room voted —
enough to exercise streaming, the approval pause, the vote and the resumption,
without a key or a bill.

### Deploying

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

This runs on the **Workers Free** plan. Durable Objects are free-tier eligible
as long as they use the SQLite storage backend, which is what
`new_sqlite_classes` in `wrangler.jsonc` selects. Only the legacy key-value
backend needs a paid plan, and this does not use it.

Free limits are 100k requests/day, 13,000 GB-s of compute duration, 5M row reads,
100k row writes, and 5 GB stored. Exceeding one makes further operations of that
type fail with an error rather than billing you. Idle rooms hibernate and stop
accruing duration, so the practical ceiling is active room-time, not uptime.

Cloudflare is unlikely to be your main cost either way — Anthropic tokens are.
The header gauge tracks those.

---

## Room setup

The ⚙ panel configures the room. Settings are shared — one agent, one
configuration — and every change is announced in the transcript with who made
it, so nobody's model or spend policy shifts silently. Changes are accepted only
while the agent is idle: swapping models mid-turn would break a running tool loop
and throw away the prompt cache.

### Workflow presets

| Preset | Shape |
|---|---|
| **Manager + workers** | Opus 5 plans and delegates reading-heavy subtasks to Haiku 4.5 workers in parallel, then verifies and synthesises. |
| **Research swarm** | Same, with Sonnet 5 workers and a wider fan-out. |
| **Solo, deep** | One Opus 5 agent at `xhigh`, no delegation. |
| **Solo, fast** | One Sonnet 5 agent at `medium`. |

In manager mode the agent gets a `delegate` tool that runs several workers at
once. **Workers are read-only by construction** — they hold `read_doc`,
`web_search` and `web_fetch`, and neither the document tools nor `delegate`
itself. A worker therefore cannot change anything, cannot spawn workers of its
own, and never needs the room's approval. Only the manager proposes document
changes, and those still go to a vote.

The manager's cost case: the expensive model spends its tokens on planning,
verification and synthesis, while the cheap one does the bulk reading.

### Generation

**Effort** (`low` → `max`) is the real quality/cost dial on current models.

**Temperature is deliberately not always available.** Anthropic removed
`temperature` / `top_p` / `top_k` on Opus 5, Sonnet 5, Opus 4.8/4.7 and Fable 5 —
sending one returns a **400**, not a warning. The panel enables the slider only
on models that still accept it (Sonnet 4.6, Haiku 4.5) and explains why it is off
elsewhere. `sanitizeSettings` strips it again server-side, so a stale client
cannot 400 every turn in the room.

The same applies to effort: Haiku 4.5 rejects the parameter entirely and Sonnet
4.6 has no `xhigh`, so both are driven off the capability table in
`src/shared/models.ts` rather than assumed.

### Team scaling

How many workers may run at once.

- **auto** — `2 + headcount`, capped at 8. A busier room gets more parallelism.
- **fixed** — a constant cap regardless of who is present.

This is the strongest cost lever in the app: each worker is a full model run, so
a fan-out of 6 costs roughly 6× a single worker turn.

### Context and compaction

Every turn re-sends the whole conversation, so an untended room gets slower and
more expensive until it is compacted. Two thresholds, either of which trips it:

- **Compact after N messages** (0 disables)
- **Context limit in tokens** (0 disables; capped at the model's own window)
- **Keep verbatim** — how many recent messages survive untouched

Compaction summarises everything older with the cheap worker model and replaces
it with one message. It runs only *between* turns — rewriting history while a
turn is parked on a vote would orphan the tool call it is waiting on — and cuts
only at a plain user-message boundary, so a `tool_use` is never separated from
its `tool_result`. That means the number of messages actually kept can exceed the
number requested; the transcript reports the real figure.

The header gauge shows live context usage against the limit, plus running spend.
Both come from real `usage` on every response — `input_tokens + cache_creation +
cache_read` *is* the prompt size — so nothing is estimated and no extra
`count_tokens` call is made.

## The tools

| Tool | Approval | Notes |
|---|---|---|
| `read_doc` | auto | Read-only. |
| `write_doc` | **vote** | Replaces the whole document. |
| `edit_doc` | **vote** | Replaces one exact span; rejected if it isn't unique. |
| `delegate` | auto | Manager workflow only. Fans out to read-only workers. |
| `web_search` | auto | Anthropic server-side. |
| `web_fetch` | auto | Anthropic server-side. |

`GATED` in `src/server/tools.ts` is the security boundary — a tool in that set
does not run until the room decides. Adding a tool with real external side
effects means adding it to that set.

### Voting policy

Strict majority — `floor(n/2) + 1`, in `thresholdFor` in `src/shared/protocol.ts`.
With two people present both must agree, so nobody can push a change through over
a colleague's objection by clicking first. Approve and deny use the same bar, so
one holdout can't block the room either. Thresholds and tallies are recomputed
when someone joins or leaves, so a vote can't become undecidable because people
went home.

That one function is the governance model. Change it there for unanimity, a
single-approver fast path, or per-member veto.

---

## Checks

```bash
npm run check       # settings guards, voting thresholds, autoscaling
npm run typecheck
```

`scripts/check-settings.ts` covers `sanitizeSettings` — the only thing between a
crafted WebSocket frame and an invalid parameter on the wire. It asserts that
temperature is dropped on models that reject it, that effort falls back to a
supported level, that unknown or role-inappropriate models are refused, and that
worker counts and context limits are clamped.

## What's verified, and what isn't

Driven in a real browser: presence, message attribution, streaming, the approval
pause, live vote tallies, approve-then-resume, deny-then-resume, API-error
recovery, settings round-trip with server-side sanitisation, capability gating in
the panel, and compaction firing on the message threshold. One approval with two
people present correctly does *not* settle a vote.

Not yet exercised:

- **Real model behaviour.** The tool loop, `pause_turn` for server-side search,
  refusals, and — most of all — whether the manager actually delegates sensibly
  are written against the API contract but were tested against the scripted mock.
  The first run with a live key is where prompt tuning starts, and multi-agent
  delegation has more room to behave unexpectedly than a single call.
- **Eviction mid-vote.** Turn state is written to storage precisely so this works,
  but a genuine hibernation between proposal and vote hasn't been forced.
- **Load.** One room, a couple of people, short documents.

## Access control

Rooms are private. A room id is 22 random characters, so it cannot be guessed,
and the link alone is not enough unless the room is set to `open`.

Membership is decided over HTTP before any socket exists, so the WebSocket is
authenticated from its first byte. The Worker verifies an HMAC-SHA-256 token in
`onBeforeConnect` and passes the result to the Durable Object in headers a
client cannot forge. A token proves only that this server issued it and that it
has not expired — the room re-checks membership on every connect, so removing
someone takes effect immediately rather than when their token runs out.

Invite links carry a role, an optional expiry, and an optional use limit, and
can be revoked at any time. An invite can never grant ownership: a room has one
owner, and handing that over is a deliberate act rather than a side effect of
sharing a link.

Invite codes are never put in room state and never broadcast. Room state syncs
to every connected client, so a code placed there would be a code handed to
everyone in the room.

## Known limits

- `write_doc` sends the whole document as tool input, so it scales badly on large
  documents. `edit_doc` is the incremental path.
- Compaction is lossy by nature. The summariser is a cheap model, so a long room
  will drift; `keepRecentMessages` is the dial that trades context for fidelity.
- `delegate` is not approval-gated. Workers cannot change anything, but they do
  cost money — the worker cap is the control, not a vote.
- Identity is bound to a browser, not to a person. Clearing site data loses your
  membership until someone re-invites you. Cloudflare Access or an OIDC provider
  is the upgrade path, and `src/server/auth.ts` is the only file that would
  change.
- A room's access token travels in the WebSocket URL, because browsers cannot
  set headers on a WebSocket upgrade. With observability enabled that URL may be
  logged. A short-lived single-use connect ticket is the fix.
- `POST /api/rooms` is unauthenticated, so room creation is unbounded. It costs
  nothing but a Durable Object, and rate limiting is the control.
