---
version: 1
slug: "src-client-landing-tsx"
primary_target: "src/client/landing.tsx"
related_targets: ["src/client/landing.css"]
---

## Scope

The signed-out root route (`#/`) only. Signed-in visitors keep the compact
create-room card inside the app shell, and invite/room deep links still go
straight to their gate — a marketing page between someone and the room they
were sent to would be a worse product.

The same surface serves two hostnames and differs only in its last section: on
`app.huddleai.org` it ends in sign-in or a create-room field, and on
`huddleai.org` it ends in a waitlist field posting to `/api/waitlist`
(`LandingCta` in `src/client/landing.tsx`). The argument above the fold is
identical, because it is the same product either way; only the ask changes.

While the app is closed, the app-host version of this page is reached only with
`?app=1` or by someone already signed in — a signed-out visitor to that root is
redirected to the waitlist. The page is kept rather than deleted because
reopening is meant to be one edit, not a rebuild.

Visitor mode: **Persuade**.

## Audience and job

A cross-functional group who own files in a repository they cannot operate:
support, legal, marketing, compliance, People Ops, plus the one engineer they
currently have to borrow. They arrive knowing the category (AI chat) and not
knowing the two differences that matter: one agent shared by a room with writes
voted on, and a team of agents they can ask for in a sentence instead of
building. The action is: create a room, or sign in and then create one.

The page's two claims are halves of one idea — **the room never operates the
machinery**. Git is machinery, and so is the agent graph; both are described in
plain language and executed by the agent. The hero carries both
(`Nobody opens GitHub. Nobody wires a graph.`) because either one alone reads as
a feature rather than as the product's shape.

Necessity is shown, never argued. It lives in the cast (legal is in the room),
in one flat line in the lead, in a heading (`It ends as a pull request. You
never open one.`), and in the durable chapter's approver six hours behind. It is
never restated as a claim in body copy — a body paragraph that re-explains a
heading's thesis is the failure mode here.

## Proof and content

PRODUCT.md records **no evidence on hand** — no testimonials, logos, metrics,
case studies or press. Nothing of that kind may be invented here. The page
persuades by running the mechanism instead of claiming it: both demo rooms are
labelled "Sample room · illustration" in their own chrome, and the people in
them (Priya · Support, Sam · Engineering, Dana · Legal) are authored fixtures,
not customers.

The demo runs **one scenario end to end**: a status-page incident note that
support, engineering and legal each own part of. It was chosen because approval
is mandatory there whether or not an agent exists, which is the test PRODUCT.md
sets for any use case. Every chapter draws from it — the merged turn, the
approval card's file, the durable timeline, the workspace file list, the
activity rows — so the page shows one group finishing one thing rather than
five unrelated screenshots.

**The approval card's diff is prose, not code, and must stay that way.** It is
the single detail that says who this is for: a sentence a customer will read and
a lawyer is accountable for, legible to every approver without a diff tool. A
code diff there would silently restore the audience PRODUCT.md excludes. The
row's `pre` inherits the page face (`font: inherit`), so prose does not render
as monospace.

Roles are shown on the message chrome and never inside the merged turn's tag:
`Room#startTurn` writes `[${name}]: ${text}`, so the tag the model receives is
the name alone. The role is how the room reads itself; the name is what the
model is given.

Every product fact on the page is read off the code, not paraphrased from the
category: tagged `[Name]:` merges and the inbox drain (`Room#startTurn`), gated
writes as proposals with three answers — approve, deny, and the standing
approval `grant` buys for fifteen minutes and ten uses (`Vote`, `tally`,
`GRANT_WINDOW_MS`), a strict-majority bar that approve and deny clear alike
(`thresholdFor`), auto-accept as one of four named permission modes, the turn as
persisted resumable state, hibernation, local-folder and GitHub workspace
providers with contents withheld from editors and viewers (`canSeeFileContents`),
the room's own agent graph and its four link kinds (`RELATIONS`), remote MCP
servers per agent on a shared or personal credential (`McpServerRef`) drawn from
the catalogue in `mcpCatalog.ts`, settings changes announced in the transcript in
the exact shape `describeSettings` / `describePolicy` / `describeGraph` write
them, and the header gauge's real pair of numbers — prompt tokens against the
compaction limit, and spend at list price.

One claim the page deliberately keeps rather than smooths over, because it is
what the room actually does: an MCP call is gated like a file write, since the
room cannot tell a read from a write on somebody else's server.

The workflow chapter runs the room's second way of editing a graph rather than
describing it: the chat types a sentence, sends it, and the canvas gains the
agent it asked for, with the agent and link counts moving against the graph's
real limits. A visitor who types their own line applies the same change instead
of pretending to draft a different one, because nothing here is talking to a
model.

The page does not carry the catalogue's per-server auth caveats. Which servers
this app can reach today is a build detail that moves while the app is still
being built, and a pre-launch page should not advertise a limitation its
authors are in the middle of closing. The editor still says so, where it is
load-bearing.

## Direction

**Kinetic hero + proof chapters** — chosen by the user over a single
scroll-scripted pinned demo and a materials-forward near-black page.

The world is the app's own system pushed to display scale: the same cool
blue-white panels, the same single working blue, the same flat border-plus-tint
construction with no ambient card shadow, Inter at 800 and -0.04em. What is new
is a deep slate **stage** used for the acts that go quiet and large (hero, the
vote chapter, the close), which echoes the app's "one fixed dark landmark"
idea rather than inventing a second identity.

Memorable moment: **the convergence.** Many strands enter the hero from the
left, bend toward one point, and leave as a single channel — the thesis drawn
rather than stated. It continues down the page as the scroll spine, so every
chapter's demo hangs off the same thread. This is the one authored motion
moment; the chapters differ by what their demo *does*, not by a second
entrance effect.

Six chapters, and every heading leads its chapter in the DOM and on screen —
the workspace chapter used to mirror its columns, which put the heading last
visually and first for a screen reader. Variety comes from three things
instead: ground (pale, tinted, stage), chapter shape (full-width head-over-demo
against a split), and the act's own padding step. A full-width chapter sets its
heading and paragraph side by side rather than leaving the right half of the
band empty.

## Constraints

- The product name is **Huddle.AI** (settled Aug 2026). The nav wordmark sets it
  at control size and full weight beside the mark; it is no longer a placeholder.
- Demo chrome copies the app's own construction rather than approximating it:
  the transcript's collapsed tool row, the approval card's tool label and change
  path, the grant strip, the workflow canvas with its inspector, and the header
  gauge. A demo that invents a control the app does not have is a bug, not a
  liberty — the "room budget" the spend panel used to show was one.
- Nothing may claim adoption, scale, or endorsement.
- The demos are content, not decoration: every one reaches its finished state
  under `prefers-reduced-motion`, and the page is complete before any motion
  runs.

## Unresolved

- Whether the page should ever carry real evidence; it cannot until evidence
  exists.
