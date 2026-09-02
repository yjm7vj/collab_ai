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

Small groups — friends, teams — who have never seen this and are deciding
whether to open a room. They arrive knowing the category (AI chat) and not
knowing the difference (one agent shared by a room, writes voted on). The
action is: create a room, or sign in and then create one.

## Proof and content

PRODUCT.md records **no evidence on hand** — no testimonials, logos, metrics,
case studies or press. Nothing of that kind may be invented here. The page
persuades by running the mechanism instead of claiming it: both demo rooms are
labelled "Sample room · illustration" in their own chrome, and the people in
them (Ana, Ravi, Mia) are authored fixtures, not customers.

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

Two claims the page deliberately keeps rather than smooths over, because they
are what the room actually does: an MCP call is gated like a file write, since
the room cannot tell a read from a write on somebody else's server; and a
catalogue server that speaks only OAuth says so instead of being wired up to
fail quietly.

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
