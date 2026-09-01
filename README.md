# collab_ai

Multiplayer AI: several people in one room, sharing one agent that can work on
real files.

Everyone talks into the same conversation. The agent sees who said what, replies
to the room rather than to a person, and can edit a shared document or the files
in a connected workspace — but a write goes to a vote first, unless the room has
told it not to bother asking.

---

## The problem this is actually solving

N humans produce input concurrently. An agent has one linear conversation and
takes one action at a time. How you reconcile those two facts *is* the product;
everything else is plumbing that follows from it.

| Concern | How it's handled |
|---|---|
| Many speakers, one conversation | Each message is tagged `[Name]:` and several are merged into a single user turn, so the model sees a room talking, not an anonymous request. |
| Someone types while the agent is working | The message goes into an inbox and is folded into the next turn. Nothing is dropped and no turn is split. |
| The group has to authorise an action | A gated tool call becomes a proposal, and the room votes — or, in a room set to auto-accept, the write just happens. |
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
   │  WebSocket (token in the URL, verified before upgrade)
   ▼
Worker  ──/agents/room/:name──▶  Room  (Durable Object, one per room)
                                 ├── transcript      SQLite
                                 ├── conversation    SQLite  (Anthropic messages)
                                 ├── members + invites  SQLite  (roles, codes)
                                 ├── inbox + turn    SQLite  (resumable turn state)
                                 └── RoomState       synced to every client
                                        status · presence · doc · workspace · open votes
                                            │
                                            ▼
                                Anthropic API ── workspace provider (local folder or GitHub)
```

One Durable Object per room means the transcript, the document, presence, roles
and the vote tally all live in the same single-threaded place. There is nothing
to lock and no way for two clients to see different truths.

Two channels reach the browser. `RoomState` is synced automatically by the Agents
SDK and carries small current-value data (who's here, the document, open votes,
workspace status). The transcript is append-heavy and far too large to resend on
every keystroke, so it is broadcast as explicit deltas instead.

| File | Role |
|---|---|
| `src/server/index.ts` | The Worker. Room creation, invite admission, the GitHub App callback, and the token check on every socket upgrade. |
| `src/server/room.ts` | The Durable Object. Turn loop, approval state machine, presence, membership and invites. |
| `src/server/auth.ts` | HMAC session tokens and invite codes. |
| `src/server/tools.ts` | Tool definitions and their implementations. |
| `src/server/model.ts` | System prompt and the streaming Anthropic call. |
| `src/server/workspace.ts` | The local-folder-relay side of the workspace protocol, run inside the Room. |
| `src/server/github.ts` | The GitHub App client: JWT/installation tokens, the contents API, branches and pull requests. |
| `src/server/oauth.ts` | Sign-in: authorize URLs, code exchange, the signed state parameter, derived uids. |
| `src/server/userIndex.ts` | Maps a signed-in identity to the rooms it belongs to. |
| `src/shared/models.ts` | The model capability table — which models accept `temperature`, which effort levels each supports. |
| `src/shared/workflow.ts` | Workflow graph shape, `sanitizeGraph`'s caps and model-by-role rules. |
| `src/shared/access.ts` | Roles, capabilities, permission modes and the path policy shape — read by both server and client. |
| `src/shared/workspace.ts` | The path deny list, file-size limits, and the wire format for filesystem requests. |
| `src/shared/protocol.ts` | Wire types shared by both sides. |
| `src/client/` | React UI. |

---

## Running it

```bash
npm install
```

Create `.dev.vars` in the project root (gitignored) and fill it in. At minimum
you need:

```
ANTHROPIC_API_KEY=sk-ant-...
ROOM_SECRET=some-long-random-string
```

```bash
npm run dev
```

Open http://localhost:5173, pick a name, and create a room. To bring someone
else in, open the invite panel (🔗 in the header), create an invite link, and
send it to them — or just open the room URL in a second window to see the
multiplayer behaviour yourself.

### No API key handy

Set `ANTHROPIC_API_KEY=mock` instead. The model is replaced by a scripted turn
that proposes a document write and then responds to however the room voted —
enough to exercise streaming, the approval pause, the vote and the resumption,
without a key or a bill.

### Deploying

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ROOM_SECRET
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

### Two hostnames: the app and the waitlist

One Worker and one build answer both routes in `wrangler.jsonc`:

| Host | What it serves |
| --- | --- |
| `huddleai.org` | The landing page, ending in a waitlist form. |
| `app.huddleai.org` | The product — rooms and invite links. Its root is closed while the waitlist runs. |

While the app is closed, a signed-out visitor to `app.huddleai.org/` is sent to
the waitlist. Deep links are deliberately exempt: `#/r/…` and `#/j/…` still go
to their own gate, so an invite works for whoever was sent one, and anyone
already signed in is unaffected. `?app=1` opts out of the redirect — that is how
you reach the sign-in before you have an identity stored. Reopening the app is
deleting `GATED_APP_HOSTS` in `src/client/host.ts`.

The redirect is client-side on purpose. Rooms and invites are hash routes, and a
fragment never reaches the server, so a Worker-side 302 on `/` would swallow
every deep link it cannot see.

The split is decided in the browser by hostname (`src/client/host.ts`), not by a
build flag, so either page can be opened from any deployment or from the dev
server — append `?waitlist=1` to see the apex page on `localhost:5173`.

Taking the apex means this Worker serves whatever `huddleai.org` resolves to.
If that record currently points at another site, deploying is what displaces
it. `www.huddleai.org` is deliberately not claimed here.

Signups land in a D1 table, `huddleai-waitlist`, already created and bound in
`wrangler.jsonc`. A fork starts by creating its own with `npx wrangler d1 create
huddleai-waitlist` and pasting the printed id into `database_id`. Schema changes
are migrations in `migrations/`:

```bash
npx wrangler d1 migrations apply huddleai-waitlist --remote
```

Read the list back, newest first:

```bash
npx wrangler d1 execute huddleai-waitlist --remote --command "SELECT email, created_at FROM waitlist ORDER BY created_at DESC"
```

`POST /api/waitlist` takes `{ "email": "..." }`, lower-cases and de-duplicates
on the address, and answers `{ "ok": true }` either way — a repeat signup is a
success, and saying otherwise would turn the form into a way to test whether a
given address is on the list. It sits above the Worker's secret guards, so
collecting an address does not depend on the model key. Without the D1 binding
it answers 503 and the rest of the Worker still runs. There is no rate limit on
it beyond Cloudflare's own; if the apex draws abuse, that is the gap to close.

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
`web_search` and `web_fetch`, and neither the document tools, the workspace file
tools, nor `delegate` itself. A worker therefore cannot change anything, cannot
spawn workers of its own, and never needs the room's approval. Only the manager
proposes writes, and those still follow the room's normal approval policy.

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

| Tool | Default | Notes |
|---|---|---|
| `read_doc` | auto | Read the shared document. Read-only. |
| `write_doc` | vote | Replaces the whole document. |
| `edit_doc` | vote | Replaces one exact span; rejected if it isn't unique. |
| `list_files` | auto | List a workspace directory. Requires a connected workspace. |
| `read_file` | auto | Read one workspace file. Requires a connected workspace. |
| `search_files` | auto | Literal substring search over the workspace. Requires a connected workspace. |
| `write_file` | vote | Replace a workspace file's contents, creating it if absent. |
| `edit_file` | vote | Replace one exact span in a workspace file. |
| `delete_file` | vote | Delete a workspace file. Irreversible. |
| `delegate` | auto | Manager workflow only. Fans out to read-only workers. |
| `web_search` | auto | Anthropic server-side. |
| `web_fetch` | auto | Anthropic server-side. |

"Default" is the room's starting policy (`ask`, see Agent permission modes
below) — it is not fixed. Which tools actually require a vote is computed by
`gatedFor` in `src/server/tools.ts` from the room's current `AccessPolicy`
(`src/shared/access.ts`); a room can loosen this to auto-accept or tighten it to
read-only. Any tool with a real external side effect belongs in that policy, the
same way `write_doc`/`write_file`/`edit_file`/`delete_file` are today.

### Voting policy

The default is strict majority — `floor(n/2) + 1` of the members who can vote on
that proposal, computed by `approvalThreshold` in `src/shared/access.ts`. With
two voters present both must agree, so nobody can push a change through over a
colleague's objection by clicking first. Approve and deny use the same bar, so
one holdout can't block the room either. Thresholds and tallies are recomputed
when someone joins or leaves, so a vote can't become undecidable because people
went home.

A room can change the policy itself: `unanimous` (every voter), `any_editor`
(the first vote decides), or `owner_only` (the room refuses votes from anyone
but the owner, so one vote settles it). See "Agent permission modes" and "Access
control" below for who counts as a voter on a given proposal.

---

## Access control

Rooms are private. A room id is 22 random characters (`ROOM_ID_RE` in
`src/shared/protocol.ts`), so it cannot be guessed, and a room is invite-only by
default — its `visibility` is set to `invite` when it's created and admission
(`/api/join`) refuses anyone without a valid invite code.

The owner can change that to `open`, where anyone holding the room id joins as
an editor, or `locked`, where nobody new gets in at all — an invite code will
not help, though existing members are unaffected and keep their access. Only
the owner may change it, deliberately not admins: opening a room up is the one
setting that undoes the point of a private room, and it should take the person
who owns it.

Membership is decided over HTTP, in the Worker's `/api/join` handler, before any
socket exists — so the WebSocket is authenticated from its first byte. The
Worker verifies an HMAC-SHA-256 token in `onBeforeConnect` and sets the
`x-room-uid` / `x-room-role` headers the incoming request carries into the
Durable Object (`set` overwrites anything a client tried to forge there); the
Durable Object's own `onConnect` then re-checks the uid against its member table
and closes the socket if it isn't one. A token proves only that this server
issued it and that it has not expired — actual membership is re-checked on every
connect, so removing someone takes effect immediately rather than when their
token runs out.

### Roles

Four roles, most powerful first, defined in `ROLE_CAPS` in `src/shared/access.ts`:

| Role | Can |
|---|---|
| **owner** | Everything below, plus rename the room, change its visibility, transfer or delete it (`admin_room`). One per room. |
| **admin** | Speak, vote, compact the conversation, change model/spend settings, change agent permission modes and tool policy, mint and revoke invites, change other members' roles and remove them. |
| **editor** | Speak, vote, compact the conversation. Cannot invite, manage members, or change settings. |
| **viewer** | Nothing. `ROLE_CAPS.viewer` is deliberately an empty array rather than a short one, so adding a capability later is always a decision, not an oversight. Viewers can read the room but not act in it. |

`isVoter(role)` is just `can(role, "vote")` — editors, admins and owners vote;
viewers don't.

Viewers are excluded from the approval threshold's denominator, not just from
voting: `approvalThreshold` divides only among members for whom `isVoter` is
true. Counting someone who cannot vote would raise a bar they can never help
clear — a room of two editors and one viewer would silently need unanimity from
the two editors if the viewer were counted at all.

### Invites

Invite links carry a role (restricted to `admin`, `editor` or `viewer` —
`INVITABLE_ROLES` in `src/shared/protocol.ts` — an invite can never grant
ownership), an optional expiry in hours, and an optional use limit, and can be
revoked at any time by an owner or admin. A room has exactly one owner; handing
that over is a deliberate act, not a side effect of sharing a link.

Invite codes are never put in room state and never broadcast to the room. Room
state syncs to every connected client, so a code placed there would be a code
handed to everyone in the room. The transcript records that an invite was
created and by whom, never the code itself.

---

## Agent permission modes

Distinct from roles: roles are about what a *person* may do in the room; the
permission mode is about what the *agent* is allowed to attempt before a human
gets involved at all. It's set via the 🛡 panel, gated on the `policy`
capability (admins and the owner).

The modes are named presets over a per-tool matrix (`MODE_PRESETS` in
`src/shared/access.ts`), in the shape Claude Code uses:

| Mode | What it does |
|---|---|
| `read_only` | The writing tools (`write_doc`, `edit_doc`, `write_file`, `edit_file`, `delete_file`) are **removed from the agent's tool list**, not merely gated. The read tools (`read_doc`, `list_files`, `read_file`, `search_files`) stay allowed, because reading is exactly what read-only mode is for. |
| `ask` | The default. Writing tools are gated (`ask`) and go to a room vote; a vote per file *read* would be unusable, so the file-read tools stay auto-allowed here too — the path policy is the real control on reads, not a vote. |
| `auto` | Writes skip the vote. `delete_file` is the one exception — it stays `ask` even under auto-accept, because a delete can't be undone by another edit the way a bad write can. Auto-accept is about not interrupting a flow, not about removing the last check on an irreversible action. |
| `custom` | The room's stored per-tool matrix is authoritative instead of a preset. |

The distinction in `read_only` is the one worth internalising: under `ask` or
`auto`, `write_file` exists as a tool the model can call and the room then
approves or refuses; under `read_only` the tool is never offered, so the agent
proposes the change in prose instead of spending a turn on a call the room has
already, structurally, refused.

`sanitizeAccessPolicy` coerces anything a client sends toward the *more*
restrictive interpretation — an unrecognised mode falls back to `ask`, not to
`auto` — so a malformed frame can never be a way to turn approval off.

---

## Workspaces

Beyond the shared document, a room can connect a workspace: a place with real
files the agent can list, read, search, and — behind the same approval machinery
as everything else — write to.

### Providers

- **Local folder**, via the browser's File System Access API
  (`window.showDirectoryPicker`, in `src/client/workspace.ts`). One member's
  browser hosts it; the Durable Object relays file requests to that browser's
  socket and waits for the reply. Chromium only — Chrome and Edge support the
  picker, Firefox and Safari do not, and the workspace panel says so plainly
  rather than showing a button that can't work.
- **GitHub repository**, via a GitHub App installed on that repository
  (`src/server/github.ts`). Works in any browser, since the server talks to
  GitHub's REST API directly rather than relying on anything in the client.

A GitHub App rather than an OAuth App on purpose: an OAuth App authenticates as
the *user* and can see every repository that user can see, with no way to scope
it to just the one repository a room wants to share — a blanket `repo` grant for
a feature that only ever needs one. A GitHub App is installed onto specific
repositories, mints short-lived installation tokens scoped to exactly those
repositories, and can be revoked from GitHub's side independent of anything this
server does.

GitHub writes never touch the repository's default branch. Changes land on a
working branch (created off the current default-branch head the first time it's
needed) and are opened as a pull request for a human to review — the room's vote
is the approval to make the change at all, not a substitute for someone looking
at the diff before it merges.

### The path deny list

`DEFAULT_DENY` in `src/shared/workspace.ts` is unioned into every room's path
policy and can only be narrowed further by adding more `ask`/`deny` rules, never
shrunk — `sanitizePathPolicy` always re-unions it in, no matter what a client
sends. It covers, broadly: dotenv-style env files; private keys and certificates
(`.pem`, `.key`, `.pfx`, `.jks`, SSH key files); whole credential directories
(`.ssh`, `.aws`, `.gnupg`, `.kube`); package-manager credential files (`.npmrc`,
`.netrc`, `.pypirc`); generic `credentials`/`secrets`/service-account files;
Terraform state; exported PGP keys and Docker's registry auth; and common shell
history files.

`.git` itself is readable — history, refs and branches are legitimately useful —
except for the specific files inside it that carry credentials
(`.git/config`, `.git/credentials`, `.git-credentials`), because a remote URL of
the form `https://user:token@host` lives in `.git/config`, and
`credential.helper store` writes plaintext tokens to `.git-credentials`.

A denied path is **hidden from listings, not shown-and-refused**: `list_files`
skips it before counting, and `search_files` prunes it from the walk before
opening it, so a room member (and the model) never learns the path exists at
all, on either the local or the GitHub provider. `read_file`, `write_file`,
`edit_file` and `delete_file` name one path directly, so those are refused
outright with an explicit error when that path is denied.

### Who sees what

File contents pulled from a workspace are visible to owners and admins only
(`canSeeFileContents` in `src/shared/access.ts`); editors and viewers see that a
file was read or written and its path, but not its content — a room's transcript
is shared, but a workspace is one person's disk or one team's repository.

Because of that, editors cannot vote on proposals that would expose file
contents: `#eligible` in `src/server/room.ts` computes the threshold for a
"sensitive" proposal (one whose tool result carries file content — `read_file`,
`search_files`, `write_file`, `edit_file`) using only members for whom
`canSeeFileContents` is true, the same denominator-exclusion reasoning as
viewers above. A plain `write_doc`/`edit_doc`/`delete_file` vote — no file
content in the tool result — still counts every editor, admin and owner.

---

## Setting it up

Two secrets are required; the Worker refuses every request without them:

- `ANTHROPIC_API_KEY`
- `ROOM_SECRET` — signs and verifies the HMAC session tokens; without it nothing
  can prove who is allowed into a room.

Three more are optional, and only affect the GitHub provider — without them,
GitHub workspaces are simply unavailable and everything else in the app still
works:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY` — the GitHub App's PEM private key
- `GITHUB_APP_SLUG` — the app's URL slug (public; it appears in the app's own
  URL), used only to send a room owner straight to the install page

Locally, put all of these in `.dev.vars`. Deployed:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ROOM_SECRET
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_APP_SLUG
```

Sign-in uses separate OAuth credentials. Put the provider client id and
secret in local `.dev.vars` (never in the client bundle), and register these
exact callback URLs with the providers when running locally:

```
http://localhost:5173/api/auth/google/callback
http://localhost:5173/api/auth/github/callback
```

The host is significant: `127.0.0.1` and `localhost` are different callback
URLs to OAuth providers. Register the `127.0.0.1:5173` versions instead if
that is the address you use in your browser.

Google OAuth clients can list multiple callback URLs. GitHub OAuth Apps are
normally limited to one callback URL, so use a separate GitHub OAuth App for
local development if the production app already points at a deployed Worker.
The local GitHub client id and secret must be real values; the example
placeholders are treated as unconfigured by the Worker.

GitHub hands out its App private key in **PKCS#1** (`BEGIN RSA PRIVATE KEY`).
WebCrypto, which is all that's available in a Worker, only imports **PKCS#8**
(`BEGIN PRIVATE KEY`). Convert it once before storing it:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in your-key.pem -out key-pkcs8.pem
```

`pemToPkcs8` in `src/server/github.ts` detects a PKCS#1 key at runtime and
reports this exact fix rather than failing as an opaque crypto error — it's
apparently the single most likely thing to go wrong when setting this up.

---

## Checks

```bash
npm run check           # sanitizeSettings: temperature/effort/model/worker-count clamping
npm run check:auth      # HMAC token mint/verify, invite code generation
npm run check:workflow  # sanitizeGraph's caps, model-by-role rules and cycle bounds, and the briefing builders
npm run check:workspace # the path deny list and pathDecision matching
npm run check:fs        # the real client-side local-folder provider, against a throwaway folder on disk
npm run check:github    # GitHub App JWT/token minting, PEM handling, repo-ref parsing, the read-only provider
npm run check:oauth     # derived uids, authorize URLs, code exchange, and the signed state parameter
npm run check:docx      # the Markdown-to-DOCX export, checked as a real ZIP package
npm run check:markdown  # inline Markdown rendered to React nodes
npm run typecheck
npm test                # runs all nine checks above in sequence
npm run test:integration # vitest — SELF.fetch through the real Worker, plus wrangler.jsonc's actual routing config
```

`scripts/check-settings.ts` covers `sanitizeSettings` — the only thing between a
crafted WebSocket frame and an invalid parameter on the wire. It asserts that
temperature is dropped on models that reject it, that effort falls back to a
supported level, that unknown or role-inappropriate models are refused, and that
worker counts and context limits are clamped.

`scripts/check-auth.ts`, `check-workspace.ts`, `check-fs-provider.ts` and
`check-github.ts` are the guard suites for, respectively: the access-token
primitives (the only thing standing between a forged token and a private room);
the path deny list (the only thing standing between a crafted path and a file
outside the workspace, or a secret inside it); the real local-folder provider
running against files on disk (`search`/`list` walk the tree themselves rather
than naming one path the server can police first, so the deny list has to be
enforced inside the provider too, not just before dispatch); and the GitHub App
JWT/token code, entirely against injected stubs so it runs offline with no
credentials.

## What's verified, and what isn't

The check suites above are unit-level guards on the security-sensitive
primitives: token verification, path policy, role capabilities, settings
sanitisation. `test/access.test.ts` and `test/config.test.ts` (`npm run
test:integration`) go one level up, through the real Worker `fetch()` entry
point: room creation, invite admission, role assignment, and the WebSocket
token gate, plus a check that `wrangler.jsonc`'s actual on-disk routing config
is what the tests assumed it was.

Driven in a real browser: presence, message attribution, streaming, the approval
pause, live vote tallies, approve-then-resume, deny-then-resume, API-error
recovery, settings round-trip with server-side sanitisation, capability gating in
the panel, and compaction firing on the message threshold. One approval with two
people present correctly does *not* settle a vote.

Access control — who gets in, who can vote on what, what a path policy hides —
is the best-covered part of this codebase. **The agent's actual behaviour
against a live model is far less exercised.** Specifically, not yet exercised:

- **Real model behaviour.** The tool loop, `pause_turn` for server-side search,
  refusals, whether the manager actually delegates sensibly, and whether the
  model behaves itself around the workspace file tools and the path policy, are
  all written against the API contract but tested against the scripted mock.
  The first run with a live key is where prompt tuning starts, and multi-agent
  delegation and file access both have more room to behave unexpectedly than a
  single call against a text document.
- **GitHub writes end-to-end.** `check:github` stubs every network call; nothing
  in the check suite exercises a real installation token against a real
  repository, a real branch creation, or a real pull request.
- **Eviction mid-vote.** Turn state is written to storage precisely so this works,
  but a genuine hibernation between proposal and vote hasn't been forced.
- **Eviction mid-round, recovered.** `test/turn-resume.test.ts` evicts a room
  with a turn in flight and checks that the next wake picks it up, trims the
  round nobody finished, and gives up out loud at the cap. What that test does
  not cover is the resume itself re-running a model call — it drives the turn to
  its cap so the suite never reaches the Anthropic API. The retry path proper is
  first exercised by a real deploy over a live turn.
- **Load.** One room, a couple of people, short documents and small workspaces.

## Known limits

- `write_doc` and `write_file` send the whole document or file as tool input, so
  they scale badly on large content. `edit_doc`/`edit_file` are the incremental
  path.
- Compaction is lossy by nature. The summariser is a cheap model, so a long room
  will drift; `keepRecentMessages` is the dial that trades context for fidelity.
- `delegate` is not approval-gated in any mode. Workers cannot change anything,
  but they do cost money — the worker cap is the control, not a vote.
- Identity is bound to a browser, not to a person. Clearing site data loses your
  membership until someone re-invites you. Cloudflare Access or an OIDC provider
  is the upgrade path, and `src/server/auth.ts` is the only file that would
  change.
- A room's access token travels in the WebSocket URL (as the `tk` query
  parameter), because browsers cannot set headers on a WebSocket upgrade. With
  observability enabled that URL may be logged. A short-lived single-use connect
  ticket is the fix.
- `POST /api/rooms` is unauthenticated, so room creation is unbounded. It costs
  nothing but a Durable Object, and rate limiting is the control.
- An interrupted turn is retried, not continued. The resume re-runs the round
  that was in flight, which costs its input tokens a second time and can produce
  different text than the tokens the room already watched appear. The abandoned
  round is trimmed from the transcript so the reader sees one answer rather than
  two, and after `MAX_RESUMES` interruptions the turn is dropped instead of
  retried again.
- A local-folder workspace request (list/read/search/write) does not survive
  Durable Object eviction the way a vote does. A vote is parked in SQLite and
  read back on resume; a filesystem round trip over the host's WebSocket is a
  live in-memory promise, deliberately not made durable because it's meant to
  be sub-second. If the object is evicted or the host never answers, the
  request times out and the agent sees an ordinary failed tool result rather
  than a hang — but it is a real gap between "voted yes" and "the write
  actually happened" that a slow or disconnected host can hit.
