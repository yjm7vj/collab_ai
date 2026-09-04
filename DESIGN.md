---
name: Huddle.AI
description: A shared desk where a room of people and one AI agent work from the same conversation and the same document.
colors:
  bg: "#eef6fd"
  panel: "#ffffff"
  panel-2: "#f6faff"
  panel-3: "#e8f3ff"
  line: "#cddced"
  line-strong: "#7b8a9b"
  ink: "#1e2636"
  ink-dim: "#475467"
  ink-faint: "#617085"
  accent: "#136fc5"
  accent-strong: "#0d5495"
  accent-ink: "#ffffff"
  logo-mid: "#2f8ada"
  logo-key: "#4a9ce4"
  logo-lift: "#8cc6f3"
  topbar: "#ffffff"
  topbar-ink: "#1e2636"
  on-topbar-ink-dim: "#475467"
  lp-stage: "#0b1424"
  lp-stage-2: "#111d31"
  lp-stage-ink: "#eaf2ff"
  lp-stage-dim: "#a3b8d4"
  lp-stage-faint: "#8296b3"
  lp-stage-line: "rgba(154, 192, 240, 0.2)"
  lp-stage-line-soft: "rgba(154, 192, 240, 0.11)"
  lp-stage-fill: "rgba(154, 192, 240, 0.07)"
  lp-stage-fill-hover: "rgba(154, 192, 240, 0.14)"
  lp-stage-accent: "#5aa7ff"
  lp-stage-accent-hover: "#8ac2ff"
  on-stage-accent: "#06101f"
  lp-stage-ok: "#6bc48c"
  lp-stage-bad: "#ff8d85"
  lp-stage-warn: "#e8b761"
  ok: "#297e50"
  bad: "#cf322d"
  warn: "#966710"
  danger-bg: "#fff0ef"
  danger-line: "#ffbbb6"
  approval-bg: "#f3f8ff"
  approval-line: "#bcd8f6"
  mine-line: "#9fc6f3"
  success-bg: "#eefaf3"
  success-ink: "#297e50"
  diff-old-bg: "#fff1f0"
  diff-old-ink: "#b33932"
  diff-new-bg: "#eefaf3"
  diff-new-ink: "#2f7c4c"
  lp-diff-old: "#ff766d"
  lp-diff-old-ink: "#ffb6b0"
  lp-diff-new: "#6bc48c"
  lp-diff-new-ink: "#b8efc5"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "clamp(2.55rem, 6.6vw, 5rem)"
    fontWeight: 800
    lineHeight: 0.98
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "clamp(1.85rem, 3.6vw, 2.85rem)"
    fontWeight: 800
    lineHeight: 1.04
    letterSpacing: "-0.032em"
  stat:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "clamp(1.9rem, 3vw, 2.6rem)"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.03em"
  close:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "clamp(2.1rem, 5vw, 3.6rem)"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  lead:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "clamp(1.05rem, 1.35vw, 1.28rem)"
    fontWeight: 400
    lineHeight: 1.5
  body-lg:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.6
  control:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 600
  ui:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  meta:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.08em"
  micro:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "10px"
    fontWeight: 700
    letterSpacing: "0.08em"
  glyph-sm:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "15px"
    lineHeight: 1
  glyph-lg:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "18px"
    lineHeight: 1
rounded:
  xxs: "2px"
  xs: "4px"
  sm: "7px"
  md: "9px"
  lg: "10px"
  xl: "12px"
  pill: "999px"
  lp-xs: "6px"
  lp-md: "8px"
  lp-xl: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  lp-gutter: "clamp(20px, 5vw, 72px)"
  lp-act: "clamp(84px, 11vw, 150px)"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.sm}"
    padding: "7px 13px"
  button-primary-hover:
    backgroundColor: "{colors.accent-strong}"
  button-default:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "7px 13px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  button-landing:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.lp-md}"
    padding: "0 22px"
    height: "48px"
  button-landing-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.lp-md}"
    padding: "0 22px"
    height: "48px"
  button-landing-primary-on-stage:
    backgroundColor: "{colors.lp-stage-accent}"
    textColor: "{colors.on-stage-accent}"
    rounded: "{rounded.lp-md}"
    padding: "0 22px"
    height: "48px"
  button-landing-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.lp-stage-ink}"
    rounded: "{rounded.lp-md}"
    padding: "0 22px"
    height: "48px"
  panel-landing:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lp-xl}"
  panel-landing-on-stage:
    backgroundColor: "{colors.lp-stage-2}"
    textColor: "{colors.lp-stage-ink}"
    rounded: "{rounded.lp-xl}"
  chip-illustration:
    backgroundColor: "transparent"
    textColor: "{colors.ink-faint}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
---

# Design System: Huddle.AI

## Overview

**Creative North Star: "The Shared Desk"**

Huddle.AI is not a dashboard people report to — it's a desk several people sit around, with the AI agent as one more hand on the same document. The visual system already in place backs this up: everyone reads off the same calm, cool-toned surface, and every meaningful state — thinking, awaiting approval, denied, mine — gets a specific, quiet color rather than an alert-style callout. Nothing yells. Status is legible at a glance (a pip, a border color, a dashed outline) so the room can stay focused on the conversation and the document instead of the chrome around them.

The palette and type scale are a considered, working system already — cool blue-white surfaces, a single sky-blue accent, tinted state colors (ok/bad/warn) reused consistently for votes, tool results, and diffs. It is not treated as final identity; color values here are documented as the current source of truth, not locked doctrine, and may be revisited.

**The system runs in two modes.** *Operate* is the app shell: a fixed-height frame that never scrolls the document, a compact 13/12px working ramp, 7–12px radii, everything on the inverting light/dark surfaces. *Persuade* is the signed-out landing route, scoped entirely under `.lp` (`src/client/landing.css`), which keeps the same palette, the same one accent, the same flat border-plus-tint construction and the same one typeface — but declares its own larger type ramp, its own two extra radius steps, and a committed dark **stage** ground for the acts that go quiet and large. Persuade does not replace Operate: both ramps are live, and which one applies is decided by which surface you are on, never by what a screen is "for."

**Key Characteristics:**
- Cool, pale blue-white surfaces at rest, with a deep slate stage reserved for the landing's quiet acts
- One accent color, reused everywhere action or "live" state needs to read (send button, focus ring, active tab, presence)
- Flat by default — structure comes from border + background-tint, not shadow
- Every state (ok / bad / warn / mine / auto-accept) has one committed color, reused verbatim across chat, votes, diffs, and chips
- Full parallel dark theme via `[data-theme="dark"]`, not an afterthought; every surface inverts, including the topbar
- One shared UI ramp (17/16/14/13/12/11/10) used by both modes, with display-scale `clamp()` steps that only the landing adds

## Colors

A narrow, cool palette: one background family, one ink family, one accent, and a small set of committed semantic colors reused everywhere that state needs to read.

### Primary
- **Working Blue** (`#136fc5` light / `#5aa7ff` dark): the one accent. Send button, focus rings, active/selected state, links, the "thinking" status, gauge fill. Used sparingly — most of the interface is neutral so this color reliably means "this is active or actionable." The light value is set so white-on-accent clears 4.5:1, because the accent is a fill behind white text as often as it is text itself.

### Neutral
- **Sky Wash** (`--bg`, `#eef6fd` / `#10141c`): page background.
- **Panel** (`--panel`, `#ffffff` / `#161b24`): primary surface — cards, modals, the chat/doc columns.
- **Panel Tint** (`--panel-2`, `#f6faff` / `#202734`): hover and secondary surfaces (buttons at rest, input fields).
- **Panel Select** (`--panel-3`, `#e8f3ff` / `#14243a`): selected/active surfaces (active side-nav item, "on" preset).
- **Line** (`--line`, `#cddced` / `#303948`): dividers and card outlines only — never a control boundary.
- **Line Strong** (`--line-strong`, `#7b8a9b` / `#68758a`): the boundary of anything you can click or type into. Buttons and inputs have fills that sit ~1.05:1 against their surface, so the border is the only thing identifying them and owes WCAG its 3:1.
- **Ink** (`--ink`, `#1e2636` / `#edf4ff`): primary text.
- **Ink Dim** (`--ink-dim`, `#475467` / `#aab7c8`): secondary text, labels, status text (~7:1).
- **Ink Faint** (`--ink-faint`, `#617085` / `#8794a6`): metadata, timestamps, the quietest legible tier. It sits deliberately at the 4.5:1 floor — there is no tier below it, which is why nothing fades ink with `opacity`.
- **Topbar** (`--topbar`, `#ffffff` light / `#050b14` dark): the header bar's own surface. It **inverts with the theme like every other surface** — white in light mode, near-black in dark — and is not a fixed dark landmark. What stays constant is not its color but its *construction*: `--topbar-ink` and the `--on-topbar-*` set (well, fill, fill-hover, line, line-soft, track, ink-dim) are named translucencies of the bar's own ink, so a control on the bar is always drawn the same way and just resolves dark-on-light or light-on-dark. The logo tints (`--logo-mid/key/lift`) are the one genuinely fixed set: identical in both themes, tuned once to read against either bar.

**Landing stage** — the Persuade mode's own dark ground, defined in the `.lp` block and used nowhere in the app shell:

- **Stage** (`--lp-stage`, `#0b1424` light-theme / `#05090f` dark-theme): the committed dark surface behind the hero, the vote chapter, the close, and the footer. It is the landing's *own* ground, not a quotation of the topbar (the topbar is white in light mode). It nudges darker under `[data-theme="dark"]` so it still sits below the page around it, which is the only theme response it makes; in both themes the stage is dark, and text on it is always drawn from the `--lp-stage-*` ink tiers rather than from `--ink`.
- **Stage Panel** (`--lp-stage-2`, `#111d31` / `#0b131e`): the demo-panel surface when a panel sits on the stage — the stage's `--panel` equivalent.
- **Stage Ink / Dim / Faint** (`--lp-stage-ink` `#eaf2ff`, `--lp-stage-dim` `#a3b8d4`, `--lp-stage-faint` `#8296b3`): the three-tier ink ladder on the stage, one-for-one with `--ink` / `--ink-dim` / `--ink-faint` on pale surfaces.
- **Stage Line / Line Soft / Fill / Fill Hover**: translucencies of one cool blue-white (`rgba(154, 192, 240, …)` at 0.2 / 0.11 / 0.07 / 0.14) — borders, hairlines, and control fills on the stage, exactly the way the topbar uses named `--on-topbar-*` translucencies rather than ad-hoc rgba.
- **Stage Accent** (`--lp-stage-accent`, `#5aa7ff`, hover `#8ac2ff`, with `--lp-on-stage-accent` `#06101f` as the ink on top): the same working blue, taken to its dark-theme value because on the stage it always sits on a dark ground. `--lp-stage-ok` and `--lp-stage-bad` do the same for the semantic pair.

### Semantic (state colors, committed and reused)
- **Ok** (`--ok`, `#297e50` / `#6bc48c`): approve votes, online presence dot, successful tool runs.
- **Bad** (`--bad`, `#cf322d` / `#ff766d`): deny votes, errors, denied tools, the stop button.
- **Warn** (`--warn`, `#966710` / `#ffd36e`): awaiting-approval status, permission warnings.
- **Mine Line** (`--mine-line`, `#9fc6f3`): border accent marking the current user's own messages.
- **Diff Old / Diff New**: dedicated red/green pairs for proposed-change diffs, distinct from the general ok/bad pair so a diff always reads as a diff. The landing carries its own `--lp-diff-old/-new` pair (plus `-ink` tiers) that keeps the same distinct-from-ok/bad discipline but does not invert, because the landing's diff always sits on the stage.

### Named Rules
**The One State, One Color Rule.** Ok/bad/warn/mine map to exactly one meaning each, reused verbatim across chat, votes, tool results, and diffs. Never introduce a second color for "success" or borrow ok/bad for something that isn't actually approve/deny.

**The No-Fade Rule.** Quiet is a token, never an `opacity`. `--ink-faint` is the quietest legible tier and already sits at the contrast floor, so fading it produces unreadable text rather than a subtler one. Only `:disabled` may fade, because WCAG exempts it. Where something needs to read as degraded — a revoked invite, a viewer chip, a denied tool — the non-color cue carries it: strikethrough, a dashed border, the status pip.

*One bounded carve-out on the landing, and no others.* **Opacity is legal as a motion state**: the reveal-on-scroll grammar, the typed lines folding into one turn, the timeline node that hasn't been reached yet — these animate from faded to full and their resting state is opaque, so nothing is ever read at a reduced opacity. No resting element on the landing is faded. The vote demo's unchosen option looked like the exception and is not one: it recedes to `--lp-stage-faint` with a softened border, because it still carries its own tally and a fade would have taken that below the contrast floor the moment `disabled` stopped exempting it.

**The Stage Rule.** The stage is a ground, not a theme. Anything drawn on `--lp-stage` takes its color from the `--lp-stage-*` set — never from `--ink`, `--line`, `--panel`, or the bare `--accent`. Conversely, `--lp-stage-*` never appears on a pale surface. The two palettes meet at a section boundary and nowhere else. The one element exempt is the fixed scroll rail, which crosses every ground on the page and therefore takes neither palette: it draws from `--lp-spine`, an alias of `--logo-mid`, the system's one hue already fixed across themes and tuned to read against a pale or a dark bar alike (3.2:1 on `--bg`, 4.9:1 on `--lp-stage`).

**The Boundary Rule.** `--line` divides; `--line-strong` bounds. If a user can click it or type into it and its fill does not separate it from the surface behind it, its border is what identifies the control and takes `--line-strong`. On the stage, `--lp-stage-line` plays the `--line-strong` part: stage controls carry a visible border because their translucent fill is deliberately near-invisible.

## Typography

**Body Font:** Inter (with ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif fallback)
**Mono role:** also Inter — there is no distinct monospace face; tool names, diffs, doc bodies, and revision stamps use the same sans font at a smaller size instead of switching families.

**Character:** One typeface throughout, doing all the work through size, weight, and color rather than a second face. Utilitarian and calm, matching the "shared desk" instrumentation feel rather than an editorial or marketing voice.

### Hierarchy (the shared UI ramp)

One ramp of seven steps serves both modes. It is compact and tops out low on purpose: this is a tool read at a desk, all day, with two panes side by side, and the landing's larger voice comes from the display steps below rather than from a second set of UI sizes.

The landing declares the ramp as tokens (`--lp-fs-*`); the app shell writes the same values as literals. They are the same scale — see **The One Ramp Rule**.

- **Body-lg** (400, 17px, line-height 1.6, max 58ch): the landing's default reading size, set on `.lp` itself. Unused in the app shell.
- **Control** (600, 16px): text inside landing buttons and the close-form input; modal and screen `h2` headings in the app.
- **UI** (400–600, 14px): text inside the landing's demo panels — chat lines, vote labels, workspace rows. In the app it is the sidebar's project row, one step above the rooms nested under it.
- **Body** (400, 13px, line-height ~1.5): **the app shell's real working size** — list-row titles, input text, panel prose, banners, document bodies. The single most load-bearing text step in the product (37 rules).
- **Meta** (400–600, 12px, tabular figures via `[data-num]`): the app's most-used size of all (64 rules) — chips, field notes, timestamps, counts, tool names, diff text. Quieter than body, never smaller than legible.
- **Label** (700, 11px, uppercase, 0.06–0.08em): section kickers, modal section headings, panel-bar captions. Identical in both modes.
- **Micro** (700, 10px): the smallest labels only — the topbar status word, settings menu captions, the IDE file-list heading.

### Display steps (Persuade — the landing, scoped under `.lp`)

A 13px working size is right at a desk and far too quiet on a page someone is deciding from, so the landing adds display steps above the shared ramp. Every one is a `clamp()` — fluid between a phone and a wide desktop, not stepped at breakpoints.

- **Display** (800, `clamp(2.55rem, 6.6vw, 5rem)`, line-height 0.98, −0.04em, max 15ch): the hero headline. One per page.
- **Headline** (800, `clamp(1.85rem, 3.6vw, 2.85rem)`, 1.04, −0.032em, max 20ch): every chapter `h2`.
- **Close** (800, `clamp(2.1rem, 5vw, 3.6rem)`, 1.02, −0.035em, max 17ch): the closing call to action only — a display-weight step deliberately set below the hero so the page does not end louder than it began.
- **Stat** (800, `clamp(1.9rem, 3vw, 2.6rem)`, −0.03em): the one numeric readout (the token gauge value).
- **Lead** (400, `clamp(1.05rem, 1.35vw, 1.28rem)`, 1.5, max 46ch): the paragraph directly under the hero headline.

### Glyph steps (icon sizing, not type)

Several app controls draw their icon as a Unicode character rather than an SVG (`⋯`, `☰`, `✕`, `✎`, `⧉`, `+`), so their `font-size` sizes an icon, not text. These sit on fixed square buttons with `line-height: 1` and are not part of the reading hierarchy: **glyph-sm** (15px), **Control** (16px) and **Body-lg** (17px) doubling as glyph sizes, and **glyph-lg** (18px) for the largest trigger. Drawn icons (`ArchiveIcon`, the CSS-drawn folder) take no type step at all.

### Named Rules
**The One Face Rule.** Every weight of hierarchy — including code-like content (tool names, diffs, doc bodies) — stays on the Inter stack. Don't introduce a monospace font; distinguish "code-like" content by size and background tint instead. The landing enforces this literally: its diff rows are real `<pre>` elements taking `font: inherit`, so a code block is code by tint and layout, never by face.

**The One Ramp Rule.** There is one UI ramp — 17 / 16 / 14 / 13 / 12 / 11 / 10 — and both modes use it. The landing writes it as `--lp-fs-*` tokens; the app shell writes the same values as literals. What separates the two modes is not a different set of UI sizes but the **display steps**, which only the landing has, and density. A new marketing-scale surface joins the `.lp` scope and reaches for a display step; it does not grow a third ramp. Never invent a size between two steps because a specific block "needs" it.

**The Declared Step Rule.** A size must be a step on the ramp above, not a number invented at the call site. Where it is declared is a separate question, and the two halves of the product answer it differently today: **`landing.css` is fully tokenised** — every `font-size` is a `var(--lp-fs-*)` — while **the app shell still writes 49 literals**. That gap is known and is the one place this document describes an intention rather than the state of the code. New work in the app shell should use a value from the ramp; converting the existing literals to tokens is a mechanical change nobody has made yet. Until it happens, a literal is acceptable in `styles.css` only if it is already a named step.

## Layout

A two-column shell: a fixed-height topbar, then a body split into `columns` — the main chat/workspace area and an optional right-hand document pane (`minmax(0, 1fr) minmax(0, 380px)`), collapsible to a single column. Inside the main area, an optional left `side-shell` (rooms/projects nav, 276px fixed) sits beside the active chat.

Density is compact and functional: 12–16px padding on chrome (topbar, headers, composer), 8–14px gaps between related controls. Cards and list rows use small internal padding (8–12px) rather than generous whitespace — this is a working tool, not a marketing surface.

Responsive collapse happens at two breakpoints: 860px stacks the topbar controls and turns the chat/doc split into stacked rows; 760px lets the topbar wrap and turns the left nav into a fixed-height panel above the chat instead of beside it.

**The landing (Persuade mode)** is the one route that scrolls the document — `html`, `body`, and `#root` drop their fixed height when they contain a `.lp`. Its spatial model is a single centred measure rather than a shell: content sits in a 1180px max-width column (`--lp-max`) with a fluid side gutter (`--lp-gutter`, `clamp(20px, 5vw, 72px)`), and vertical rhythm is carried by one act-padding step (`--lp-act-pad`, `clamp(84px, 11vw, 150px)`) applied to every section, so chapters are separated by air and by ground color rather than by rules. The hero is the exception: full-bleed and `100svh` minus the 64px nav, which it slides under. Chapters are two-column splits (`0.85fr / 1.15fr`, head then demo, alternating order) that collapse to one column at 900px; the merge demo's three-part grid collapses at 860px and the durable-turn timeline switches from a horizontal 5-node track to a vertical bordered list at 820px; 760px thins the scroll spine to a hairline in the gutter.

Density is the clearest split between the two modes. The app is compact everywhere; the landing runs a 48px primary control height, 34px secondary, and 10–22px internal panel padding on fluid `clamp()` steps. Under `(pointer: coarse)` the landing's small controls and its text links alike grow to a 44px target — only the landing's, deliberately: the app's compact heights are correct at a desk and wrong under a thumb, and the two are allowed to differ.

## Elevation & Depth

**The Flat-By-Default Rule.** Structure comes from `border` + background-tint (panel / panel-2 / panel-3), not shadow. Cards, modals, and panels sit flush against their neighbors with a 1px `--line` border; there is no ambient card shadow anywhere in the system. Shadow is reserved for things that genuinely float above the layout flow, and each depth is a token so it themes: `--shadow` for the deepest overlay, `--shadow-float` for a control hovering over a pane (the reopen-document button), `--shadow-node` for a draggable workflow node. Every one of them has a dark-theme value — a literal `rgba()` shadow would stay light-theme pale on a dark ground, which is exactly the bug this token set exists to prevent. Ordinary surfaces still take none of them.

The landing holds the same line at display scale: its demo panels are 1px border plus tint and carry **no ambient shadow at all**, on the pale acts and on the stage alike. The only `box-shadow` on the whole surface is the contact-free halo around a 7–9px status dot (the hero's live pip, the scroll spine's head) — a glow drawn in the accent's own color, not an elevation cue, and never applied to anything with an edge. Depth on the landing comes from ground color instead: an act is pale, tinted (`--panel-3` mixed 55% into `--bg`), or on the stage, and that three-step ladder does all the work a shadow stack would.

## Shapes

Two radius steps cover almost everything in the app: **7px** for interactive controls (buttons, inputs, chips-as-controls, selects) and a slightly larger **9–10px** (`--radius`) for containing surfaces (cards, invite/member rows), with modals at 12px. Fully pill-shaped (`999px`) radius is reserved for status chips, presence pills, and toggle tracks — anything that reads as a small, discrete tag rather than a container. Corners are consistently rounded; nothing in the system uses a sharp 0px corner.

Below the control step sit two steps for things that are not containers at all, and both are shared with the landing's scale rather than being app inventions:

- **8px** — the app uses this as widely as 7px, on chips, gauges, and icon-button triggers. It is the same value the landing calls `--lp-r-md`; the two are one step, not two.
- **6px** — inset rows inside a surface: a diff row, a collapsed tool head, a `field-warn` block, an IDE file row. The landing calls it `--lp-r-xs`.
- **4px** (`{rounded.xs}`) — inline `code` inside prose. The smallest rounding that still reads as rounded at text scale.
- **2px** (`{rounded.xxs}`) — icon geometry only, not UI: the corners of the CSS-drawn folder mark in the sidebar. It exists so a 14×10px drawn shape does not look sharp beside 7px controls, and it should never be used on a control or a container.

The landing names the same family as a six-step scale and adds two steps at the ends, because its objects are bigger than the app's:

- **`--lp-r-xs` (6px)** — the tightest step, for things smaller than a control: a diff row, the focus-ring's own corner.
- **`--lp-r-sm` (7px)** — the app's control step, kept verbatim: small buttons, vote buttons, segmented-control thumbs, workspace rows.
- **`--lp-r-md` (8px)** — the landing's own control step, one pixel up from the app's, for the 48px-tall primary/ghost buttons and the close-form input. Bigger control, slightly bigger corner; the ratio holds.
- **`--lp-r-lg` (9px)** — the app's container step, for the small cards nested inside a demo panel (a typed line, a merged turn).
- **`--lp-r-xl` (14px)** — the new step, and the landing's signature shape: the demo panels. These are page furniture at a scale the app never reaches, and 10px on a 600px-wide panel reads as an accident rather than a decision.
- **`--lp-r-pill` (999px)** — same reservation as the app: dots, pips, tracks, and tag-shaped chips.

The nesting is the point: a 14px panel contains 9px cards contains 6px rows, each step visibly smaller than its container, which is what makes a demo panel read as a window into the app rather than as a slide.

## Components

### Buttons
- **Shape:** 7px radius, 1px border in `--line` at rest.
- **Default:** `--panel-2` background, `--ink` text; hovers to `--panel-3`. This is the button used almost everywhere (composer actions, side-pane actions, dialog buttons).
- **Primary/accent:** `--accent` background, `--accent-ink` text, bold weight — reserved for the single most committed action in context (send, sign-in, save-project, permissions-modal primary). Hover deepens to `--accent-strong`.
- **Danger/stop:** `--danger-bg` background, `--bad` text, `--danger-line` border — used only for the stop-generation control.
- **Ghost/link:** no border or background, underlined text in `--ink`, turns `--accent` on hover — used for actions embedded in a sentence (e.g. inline links in copy).
- **Disabled:** 0.45 opacity, `not-allowed` cursor, no hover response.

### Chips
- **Style:** transparent background, 1px `--line` border, pill radius, 12px text, no fill at rest — chips are labels first, not buttons.
- **State:** `chip-me` is bold (marks "you" in presence); `chip-empty` is dashed-border and faint (marks an unfilled slot); on the topbar, chips take `--on-topbar-fill` and `--on-topbar-line` instead of transparent-on-`--line`, so they stay legible whichever way the bar has resolved.
- **Policy chips** (read-only / ask / auto / custom) reuse this shape but carry semantic color: `auto` is the one policy state styled with `--bad` (a shared agent editing unattended is treated as the state that should visually stand out).
- **`chip-warn`** carries `--warn` text on a border mixed 45% from the same hue. It marks a limitation rather than a failure — a read-only workspace, not a broken one — and is the reason `--bad` stays reserved for things that actually went wrong.

### Cards / Containers
- **Corner Style:** `--radius` (9–10px) for most cards (side-room-card, invite-row, member-row, side-project-form); 12px for modals specifically.
- **Background:** `--panel` for top-level surfaces (modal), `--panel-2` for cards nested one level in (list rows inside a panel).
- **Shadow Strategy:** none — see Elevation & Depth. Cards are separated by border + tint, never shadow.
- **Border:** 1px `--line` on every card; dashed `--line` marks an explicit "empty/placeholder" state (side-empty, dead invite rows use faint + strikethrough instead).
- **Internal Padding:** 8–14px depending on density (list rows tighter, forms and empty-states looser).

### The pip (shared status dot)
A 7px round dot, `flex: none`, carrying state in one glyph wherever the app reports it: a collapsed tool row, a member's presence, a connected workspace. Unmodified it is `--ink-faint`, which is the honest default for *nothing is happening here* — offline, idle, not yet run — and it takes `--ok` / `--bad` / `--accent` for the states that are. **It is never the only carrier of a state:** the text beside it always says the same thing, so the dot is redundancy, not information. One class, `.pip`; there is no second dot construction in the system.

### Connected-workspace card
The connected state of the workspace panel, built deliberately like the repository row someone clicked to reach it: pip and name on the left, a state chip on the right, kind and online/offline underneath, all inside a `--panel-2` card at `--radius`. The card stays quiet while the connection is healthy — only the two degraded write-access states take colour — so the eye lands on the connection that needs something rather than on the one that is fine. Write access is three-valued: writable (plain chip), read-only (`chip-warn`), and **unchecked** (`chip-empty`, the dashed unfilled-slot cue), because a connection made before the app started asking has never been asked and saying "no" would be as false as saying "yes".

### Inputs / Fields
- **Style:** `--bg` background (not `--panel` — inputs sit visually "below" the surface they're on), 1px `--line` border, 7px radius.
- **Focus:** border color shifts to `--accent`, no glow/ring — a simple, quiet state change.
- **Error/Disabled:** no dedicated input error state defined yet; disabled state is not distinctly styled for inputs (only buttons define `:disabled` styling).

### Navigation (side panel)
- Left nav items (`side-item`) are full-width rows, no border by default; the active row gets a `--panel-2` fill, nothing else changes (no accent bar, no bold text) — deliberately understated so the active state doesn't compete with unread/status signals elsewhere in the row.
- Section labels are uppercase, 11px, `--ink-faint`, 0.08em tracking — the same label treatment used for modal section headings, so the two contexts feel like one system.
- **A project row is a disclosure.** The whole name row is the control — caret, folder mark, and name inside one button — with the project's `+` and `⋯` actions as siblings beside it rather than nested inside. It takes the pane's hover fill but explicitly *not* the pane's hover border, because an outlined box around a name reads as a text field. Collapsed, the row shows the count of rooms it is hiding, since the caret alone says nothing about how much is behind it.
- Which projects are collapsed is a **per-browser view preference** in `localStorage`, never part of synced room state — it describes the viewer, not the project. Opening a room always reveals it, once per room opened.

### Topbar
The room's header bar. It inverts with the theme like every other surface (`--topbar`: white in light, `#050b14` in dark), so it is a *structural* landmark, not a chromatic one — its constancy comes from position and construction rather than from staying dark. What is fixed is the way controls on it are drawn: chips, buttons, and the token gauge take the named `--on-topbar-*` translucencies of the bar's own ink (fill 0.06/0.08, hover 0.11/0.15, line 0.18, track 0.22, well 0.04) rather than the normal panel tokens, which would either vanish or clash. The same tokens resolve dark-on-light or light-on-dark, so one rule serves both themes. The logo tints (`--logo-mid/key/lift`) are the exception that really is fixed: identical values in both themes, tuned once to read on either bar.

### Landing controls (Persuade mode)
- **Primary button:** 48px tall, 0–22px padding, `--lp-r-md` (8px), 16px/600 text with −0.01em tracking. On pale acts it is `--accent` on `--accent-ink`; on the stage and in the hero it swaps to `--lp-stage-accent` on `--lp-on-stage-accent`. Hover deepens the fill and lifts the button 1px (`translateY(-1px)`), returning to 0 on `:active` — the one press affordance in the system, and the only place a control moves.
- **Default button:** same shape and height, `--panel-2` fill with a `--line-strong` border, hovering to `--panel-3`. This is the app's default button grown to landing scale, unchanged in construction.
- **Ghost button:** transparent, bordered in `--lp-stage-line`, `--lp-stage-ink` text; hover fills with `--lp-stage-fill` and turns the border accent. Stage-only — it depends on a dark ground to read.
- **Small button:** 34px, `--lp-r-sm`, 13px text; used in the nav and inside demos. Grows to 44px under a coarse pointer, the accessibility floor for a touch target.
- **Text link button:** no border or fill, 13px/600, underlined at 40% currentColor and going solid on hover, colored to `--accent` (or `--lp-stage-accent` on the stage). Minimum 24px target, 44px under a coarse pointer — the underline keeps its size, only the hit area grows.
- **Focus:** a 2px `--accent` outline at 3px offset with a 6px corner, switching to `--lp-stage-accent` inside a stage act. The landing owns its browser surfaces deliberately: selection color, caret color, and scrollbar thinness are all set from tokens rather than left to the UA.

### Demo panel (landing signature component)
The recurring container that makes every claim on the landing a working demonstration instead of a feature card. Construction: 1px `--line` border, `--lp-r-xl` (14px), `--panel` fill, `overflow: hidden`, no shadow. On a stage act it re-skins to `--lp-stage-line` and `--lp-stage-2` and nothing else changes.

Each panel wears a **panel bar** — an 11px uppercase label strip in `--ink-faint` on `--panel-2`, separated by a 1px line, which can also be applied at the foot (`.lp-panel-foot` flips the border to the top edge). The bar carries the panel's identity on the left and a live-presence dot in `--ok` on the right.

The bar's left slot also carries the **Illustration chip**: a dashed `--line-strong` pill, 11px/700 uppercase, no fill. Every demo panel on the landing carries one. This is not decoration and not a disclaimer bolted on — PRODUCT.md records no evidence on hand, so a fabricated room has to say so in its own chrome, and it borrows the app's existing dashed-border cue for "unfilled slot" rather than inventing a new one. **A new demo panel gets the chip or does not ship.**

### Workflow canvas (landing)
The room's agent graph at page scale, built as the app's editor is: a canvas of
agent cards, typed wires between them, and an inspector for the selected card.
The canvas holds one fixed coordinate space (`WF_CANVAS`) and every card's
position *and size* is a percentage of it, so a wire can never point at where a
card used to be. Cards are fixed boxes — the brief takes exactly two lines
whether it is long, short or absent, and the MCP chip is pushed to the bottom
edge — because a card that grows with its text stops being a node on a canvas.

Link kind is one decision carried on a custom property (`--lp-wire`), read by
the wire, its arrowhead, its label and its legend swatch alike: `delegates` is
the stage accent, `reviews` is `--lp-stage-warn`, `handoff` is `--lp-stage-ok`,
`custom` is `--lp-stage-faint`. The legend names all four and marks `custom` as
prompt-only, because three of the kinds change what runs and one only changes
what the agents are told; drawing them identically would be a lie about the
system. Below 760px the canvas becomes the list it describes and the wires drop
out — a scaled canvas with unreadable labels is worse than no canvas.

Depth here is ground, not shadow: the canvas is mixed darker than the panel it
sits in, and the cards sit at the panel's own value on top of it.

### Landing state graphics
- **Outcome pip:** a 7px dot that is `--lp-stage-faint` when idle, pulses in `--lp-stage-accent` while a vote is open, and lands on `--lp-stage-ok` / `--lp-stage-bad` — the app's pip vocabulary at page scale, color carrying the state and animation carrying "in progress."
- **Vote control:** 36px, `--lp-r-sm`, translucent stage fill; once cast, the chosen option's border and text turn `--lp-stage-ok` or `--lp-stage-bad` while the unchosen one recedes to `--lp-stage-faint` on `--lp-stage-line-soft`. Neither is faded, and neither uses the native `disabled` attribute — the control stays focusable under `aria-disabled` and its click handler no-ops.
- **Timeline node:** an 11px ring — `--panel` fill with a `--line-strong` border unlit, filling to `--accent` when reached, and staying hollow-with-accent-border for the "quiet" steps (the hours nothing happened), so the durable turn's waiting is visible as a different kind of node rather than as a gap. **The track is assembled from each node's own segment** rather than drawn once behind them all, which is what lets the quiet step carry a dashed rail instead of a gap the eye reads as a fault; the same construction turns on its side below 820px.
- **Grant strip:** the app's "Running without asking" row, reproduced when a vote to *approve and stop asking* clears the bar — tool name, minutes left, uses left. Standing authority the room cannot see is indistinguishable from no gate at all, so it is drawn rather than described.
- **Scroll spine:** a fixed 2px rail in the left gutter with an accent fill that tracks scroll and a 9px head. It is the hero's convergence continued down the page; it is the only element that persists across all acts.

### Motion (landing)
One easing token (`--lp-ease`, `cubic-bezier(0.16, 1, 0.3, 1)`) and one entrance grammar: `.lp-reveal` translates 18px up and fades in over 700ms, with two 90ms stagger steps. Every region uses it once; chapters differ by what their demo *does*, not by a second entrance effect. Under `prefers-reduced-motion: reduce` all animation and transition durations collapse to 0.001ms, reveals start opaque and in place, and the looping scroll cue is removed outright — the page is complete and readable before any motion runs.

## Do's and Don'ts

### Do:
- **Do** reuse the committed semantic colors (`ok`/`bad`/`warn`/`mine-line`) verbatim for any new approve/deny/warning/own-content state — never introduce a second "success green."
- **Do** build new surfaces from border + background-tint (`panel`/`panel-2`/`panel-3`), not shadow.
- **Do** keep new interactive controls at 7px radius and new containing surfaces at 9–10px, reserving pill radius for chips/tags/toggles only.
- **Do** give any new clickable or typable control a `--line-strong` border, and any new divider `--line`.
- **Do** reach for a quieter token when something should recede — never an `opacity` on text.
- **Do** keep the topbar's `--on-topbar-*` translucency set to the topbar, and the `--lp-stage-*` set to the landing; each is a ground-specific vocabulary and neither travels.
- **Do** declare a new landing value as a `--lp-*` token in the `.lp` block, next to the step it belongs beside, before using it anywhere in the file.
- **Do** put every landing demo panel's dashed **Illustration** chip in its panel bar — the page has no evidence to show, and a fabricated room must label itself.
- **Do** scale landing controls up under `(pointer: coarse)` (44px controls and links alike) and leave the app's compact heights alone.

### Don't:
- **Don't** introduce a second typeface for code/mono content — the system deliberately reuses Inter everywhere, distinguishing "code-like" content by size and tint only.
- **Don't** add ambient drop-shadows to cards, panels, or modals. The shadow tokens are reserved for elements that float above the layout (see Elevation & Depth), and a shadow written as a literal `rgba()` is a bug — it will not theme.
- **Don't** invent a color or a size that isn't already a decision. Colors have exactly three token blocks — `:root`, `:root[data-theme="dark"]`, and the `.lp` scope (plus its two-line dark override) — and a color outside them is a value nobody decided. Sizes are governed by the ramp rather than by where they are written: `landing.css` names every step as a token, while `styles.css` still spells its steps as literals, so in the app shell the test is "is this a step on the ramp?", not "is this a `var()`?"
- **Don't** put a colored `border-left` above 1px on a card or list row. Tool status is carried by the pip; the hairline edge only echoes it.
- **Don't** treat the topbar as a fixed dark bar. It inverts with the theme; its landmark quality comes from position and from the `--on-topbar-*` construction, not from a color that never changes.
- **Don't** describe the landing's stage as "the topbar color." It is the landing's own committed dark ground (`--lp-stage`), unrelated to `--topbar` — which is white in light mode — and it is the only surface in the system that stays dark in both themes.
- **Don't** let a `--lp-*` token onto an app surface, or a landing **display** step into the app shell. The UI ramp is shared, so a 13px row is 13px in both places; what must not cross is the landing's display scale, its stage palette, and its coarse-pointer control heights.
- **Don't** add an ambient shadow to a landing panel to make it "pop." Ground color (pale / tinted / stage) is this system's entire depth vocabulary at page scale.
- **Don't** give a landing chapter a second entrance effect. One reveal grammar, used once per region; the demo carries the interest.
