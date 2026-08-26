---
name: collab_ai
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
  topbar: "#1f2937"
  topbar-ink: "#ffffff"
  on-topbar-ink-dim: "#c2cedd"
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
typography:
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.08em"
  mono:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
rounded:
  sm: "7px"
  md: "9px"
  lg: "10px"
  xl: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
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
---

# Design System: collab_ai

## Overview

**Creative North Star: "The Shared Desk"**

collab_ai is not a dashboard people report to — it's a desk several people sit around, with the AI agent as one more hand on the same document. The visual system already in place backs this up: everyone reads off the same calm, cool-toned surface, the topbar is the one fixed "room" landmark, and every meaningful state — thinking, awaiting approval, denied, mine — gets a specific, quiet color rather than an alert-style callout. Nothing yells. Status is legible at a glance (a pip, a border color, a dashed outline) so the room can stay focused on the conversation and the document instead of the chrome around them.

The palette and type scale are a considered, working system already — cool blue-white surfaces, a single sky-blue accent, tinted state colors (ok/bad/warn) reused consistently for votes, tool results, and diffs. It is not treated as final identity; color values here are documented as the current source of truth, not locked doctrine, and may be revisited.

**Key Characteristics:**
- Cool, pale blue-white surfaces at rest; a dark slate topbar as the one fixed landmark
- One accent color, reused everywhere action or "live" state needs to read (send button, focus ring, active tab, presence)
- Flat by default — structure comes from border + background-tint, not shadow
- Every state (ok / bad / warn / mine / auto-accept) has one committed color, reused verbatim across chat, votes, diffs, and chips
- Full parallel dark theme via `[data-theme="dark"]`, not an afterthought

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
- **Topbar** (`--topbar`, `#1f2937` / `#050b14`): the header bar's own dark surface — fixed across both themes, the one place that doesn't invert. Controls on it draw from the `--on-topbar-*` set (well, fill, fill-hover, line, line-soft, track, ink-dim) rather than ad-hoc translucency, and the logo tints (`--logo-mid/key/lift`) are tuned against it once and never remapped.

### Semantic (state colors, committed and reused)
- **Ok** (`--ok`, `#297e50` / `#6bc48c`): approve votes, online presence dot, successful tool runs.
- **Bad** (`--bad`, `#cf322d` / `#ff766d`): deny votes, errors, denied tools, the stop button.
- **Warn** (`--warn`, `#966710` / `#ffd36e`): awaiting-approval status, permission warnings.
- **Mine Line** (`--mine-line`, `#9fc6f3`): border accent marking the current user's own messages.
- **Diff Old / Diff New**: dedicated red/green pairs for proposed-change diffs, distinct from the general ok/bad pair so a diff always reads as a diff.

### Named Rules
**The One State, One Color Rule.** Ok/bad/warn/mine map to exactly one meaning each, reused verbatim across chat, votes, tool results, and diffs. Never introduce a second color for "success" or borrow ok/bad for something that isn't actually approve/deny.

**The No-Fade Rule.** Quiet is a token, never an `opacity`. `--ink-faint` is the quietest legible tier and already sits at the contrast floor, so fading it produces unreadable text rather than a subtler one. Only `:disabled` may fade, because WCAG exempts it. Where something needs to read as degraded — a revoked invite, a viewer chip, a denied tool — the non-color cue carries it: strikethrough, a dashed border, the status pip.

**The Boundary Rule.** `--line` divides; `--line-strong` bounds. If a user can click it or type into it and its fill does not separate it from the surface behind it, its border is what identifies the control and takes `--line-strong`.

## Typography

**Body Font:** Inter (with ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif fallback)
**Mono role:** also Inter — there is no distinct monospace face; tool names, diffs, doc bodies, and revision stamps use the same sans font at a smaller size instead of switching families.

**Character:** One typeface throughout, doing all the work through size, weight, and color rather than a second face. Utilitarian and calm, matching the "shared desk" instrumentation feel rather than an editorial or marketing voice.

### Hierarchy
- **Title** (600, 22px): gate/sign-in headline, modal `h2` (16px variant for in-modal headings).
- **Body** (400, 15px, line-height 1.55): default reading size for chat text and prose.
- **Label** (600–700, 11–13px, uppercase + 0.08em tracking for section kickers): side-panel section labels, modal section headings, field labels.
- **Meta/Mono** (400–600, 11–12px): timestamps, tool names, revision stamps, diff text — same face as body, smaller and quieter.

### Named Rules
**The One Face Rule.** Every weight of hierarchy — including code-like content (tool names, diffs, doc bodies) — stays on the Inter stack. Don't introduce a monospace font; distinguish "code-like" content by size and background tint instead.

## Layout

A two-column shell: a fixed-height topbar, then a body split into `columns` — the main chat/workspace area and an optional right-hand document pane (`minmax(0, 1fr) minmax(0, 380px)`), collapsible to a single column. Inside the main area, an optional left `side-shell` (rooms/projects nav, 276px fixed) sits beside the active chat.

Density is compact and functional: 12–16px padding on chrome (topbar, headers, composer), 8–14px gaps between related controls. Cards and list rows use small internal padding (8–12px) rather than generous whitespace — this is a working tool, not a marketing surface.

Responsive collapse happens at two breakpoints: 860px stacks the topbar controls and turns the chat/doc split into stacked rows; 760px lets the topbar wrap and turns the left nav into a fixed-height panel above the chat instead of beside it.

## Elevation & Depth

**The Flat-By-Default Rule.** Structure comes from `border` + background-tint (panel / panel-2 / panel-3), not shadow. Cards, modals, and panels sit flush against their neighbors with a 1px `--line` border; there is no ambient card shadow anywhere in the system. Shadow is reserved for things that genuinely float above the layout flow, and each depth is a token so it themes: `--shadow` for the deepest overlay, `--shadow-float` for a control hovering over a pane (the reopen-document button), `--shadow-node` for a draggable workflow node. Every one of them has a dark-theme value — a literal `rgba()` shadow would stay light-theme pale on a dark ground, which is exactly the bug this token set exists to prevent. Ordinary surfaces still take none of them.

## Shapes

Two radius steps cover almost everything: **7px** for interactive controls (buttons, inputs, chips-as-controls, selects) and a slightly larger **9–10px** (`--radius`) for containing surfaces (cards, modals corners use 12px, invite/member rows use `--radius`). Fully pill-shaped (`999px`) radius is reserved for status chips, presence pills, and toggle tracks — anything that reads as a small, discrete tag rather than a container. Corners are consistently rounded; nothing in the system uses a sharp 0px corner.

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
- **State:** `chip-me` is bold (marks "you" in presence); `chip-empty` is dashed-border and faint (marks an unfilled slot); on the dark topbar, chips get a translucent white fill instead of transparent, since transparent would disappear against the dark bar.
- **Policy chips** (read-only / ask / auto / custom) reuse this shape but carry semantic color: `auto` is the one policy state styled with `--bad` (a shared agent editing unattended is treated as the state that should visually stand out).

### Cards / Containers
- **Corner Style:** `--radius` (9–10px) for most cards (side-room-card, invite-row, member-row, side-project-form); 12px for modals specifically.
- **Background:** `--panel` for top-level surfaces (modal), `--panel-2` for cards nested one level in (list rows inside a panel).
- **Shadow Strategy:** none — see Elevation & Depth. Cards are separated by border + tint, never shadow.
- **Border:** 1px `--line` on every card; dashed `--line` marks an explicit "empty/placeholder" state (side-empty, dead invite rows use faint + strikethrough instead).
- **Internal Padding:** 8–14px depending on density (list rows tighter, forms and empty-states looser).

### Inputs / Fields
- **Style:** `--bg` background (not `--panel` — inputs sit visually "below" the surface they're on), 1px `--line` border, 7px radius.
- **Focus:** border color shifts to `--accent`, no glow/ring — a simple, quiet state change.
- **Error/Disabled:** no dedicated input error state defined yet; disabled state is not distinctly styled for inputs (only buttons define `:disabled` styling).

### Navigation (side panel)
- Left nav items (`side-item`) are full-width rows, no border by default; the active row gets a `--panel-2` fill, nothing else changes (no accent bar, no bold text) — deliberately understated so the active state doesn't compete with unread/status signals elsewhere in the row.
- Section labels are uppercase, 11px, `--ink-faint`, 0.08em tracking — the same label treatment used for modal section headings, so the two contexts feel like one system.

### Topbar (signature component)
The one element that does not follow the light/dark surface swap: `--topbar` (`#1f2937`) and `--topbar-ink` (white) stay fixed regardless of theme, so the room's "landmark" bar reads identically whether the rest of the UI is in light or dark mode. Controls inside it (chips, buttons, the token gauge) get a translucent-white treatment (`rgba(255,255,255,0.08–0.2)`) instead of the normal panel colors, since the normal light-mode panel tokens would be invisible against a dark bar.

## Do's and Don'ts

### Do:
- **Do** reuse the committed semantic colors (`ok`/`bad`/`warn`/`mine-line`) verbatim for any new approve/deny/warning/own-content state — never introduce a second "success green."
- **Do** build new surfaces from border + background-tint (`panel`/`panel-2`/`panel-3`), not shadow.
- **Do** keep new interactive controls at 7px radius and new containing surfaces at 9–10px, reserving pill radius for chips/tags/toggles only.
- **Do** give any new clickable or typable control a `--line-strong` border, and any new divider `--line`.
- **Do** reach for a quieter token when something should recede — never an `opacity` on text.
- **Do** keep the topbar's translucent-white control treatment isolated to the topbar; don't reuse it on light surfaces.

### Don't:
- **Don't** introduce a second typeface for code/mono content — the system deliberately reuses Inter everywhere, distinguishing "code-like" content by size and tint only.
- **Don't** add ambient drop-shadows to cards, panels, or modals. The shadow tokens are reserved for elements that float above the layout (see Elevation & Depth), and a shadow written as a literal `rgba()` is a bug — it will not theme.
- **Don't** write a color literal outside the `:root` blocks. The stylesheet currently has zero, and the topbar's translucent treatment has named tokens so it stays that way.
- **Don't** put a colored `border-left` above 1px on a card or list row. Tool status is carried by the pip; the hairline edge only echoes it.
- **Don't** style the topbar's light/dark swap the same as the rest of the app — it intentionally stays a fixed dark surface in both themes.
