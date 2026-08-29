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

Every product fact on the page comes from PRODUCT.md: tagged `[Name]:` merges,
the inbox fold, gated writes as proposals, auto-accept as an explicit room
decision, the turn as persisted resumable state, hibernation, local-folder and
GitHub workspace providers, room-shared settings announced in the transcript,
and the header token gauge.

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

## Constraints

- The product name is **Huddle.AI** (settled Aug 2026). The nav wordmark sets it
  at control size and full weight beside the mark; it is no longer a placeholder.
- Nothing may claim adoption, scale, or endorsement.
- The demos are content, not decoration: every one reaches its finished state
  under `prefers-reduced-motion`, and the page is complete before any motion
  runs.

## Unresolved

- Whether the page should ever carry real evidence; it cannot until evidence
  exists.
