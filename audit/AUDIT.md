# Technical Audit — collab_ai web client

Scope: `src/client/**` plus `index.html`. Every figure below was measured from source by the scripts in `audit/`, not estimated. Raw measurements are in `audit/*.json`.

## Audit Health Score

| # | Dimension | Score | Key Finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 1 | No visible focus indicator exists anywhere in the stylesheet |
| 2 | Performance | 2 | Append-heavy transcript renders unvirtualized; render-blocking font import |
| 3 | Responsive Design | 2 | 86 px-based font sizes against 1 `rem`; text resize breaks fixed-height controls |
| 4 | Theming | 3 | Strong token system; the floating shadow and logo stay light-theme in dark mode |
| 5 | Implementation Integrity | 3 | Coherent, product-specific system; isolated shortcuts and scale sprawl |
| **Total** | | **11/20** | **Acceptable (significant work needed)** |

## Implementation Integrity Verdict

**Pass.** This implementation expresses a coherent, product-specific system rather than a generic template. The evidence is concrete: the component vocabulary is domain-driven (vote cards with cast state, diff rows, tool-status pips, policy chips whose `auto` state is deliberately styled with the danger color, presence chips that mark "you"), the stylesheet carries intent comments explaining *why* a treatment was chosen, and the token layer is genuinely semantic (`--approval-bg`, `--mine-line`, `--diff-new-ink`) rather than a renamed Tailwind scale. Nothing here is interchangeable with an unrelated product.

The detector's 49 findings support this reading rather than undercutting it: **44 of 49 are advisory design-system drift** (font sizes and radii outside the scale documented in `DESIGN.md`), and **5 are real warnings** — 3 `side-tab` accent borders, 1 `overused-font` (Inter), 1 `layout-transition`. The drift is largely a *documentation* gap: `DESIGN.md` records 3 type steps and 5 radius steps, while the CSS actually uses 9 distinct font sizes and 8 distinct radii. Two of those advisory clusters are worth acting on as genuine scale sprawl; the rest resolve by correcting the design doc.

## Executive Summary

- Audit Health Score: **11/20** (Acceptable — significant work needed)
- **Total issues: 29** — P0 1 · P1 8 · P2 13 · P3 7
- Contrast: 74 token pairs measured across both themes, **27 below threshold** (20 in light, 7 in dark — the light theme is materially weaker)
- Accessible names: 88 interactive elements inventoried, **6 form controls with no programmatic label**, 4 of which rely on a placeholder alone
- Motion: 4 transitions, 2 infinite animations, **0 `prefers-reduced-motion` blocks**
- Theming: 58 tokens defined, **0 color literals in the TSX**, 23 literals outside `:root` in the CSS

**Top 5 critical issues**

1. No focus indicator exists anywhere — `outline: none` on inputs with no replacement, and no focus styling at all on buttons (P0)
2. The primary button fails AA: white on `--accent` measures 3.86:1 (P1)
3. A `role="button"` div has no `tabIndex` or key handler — unreachable by keyboard (P1)
4. Streaming agent output and incoming messages are never announced — no `aria-live` anywhere (P1)
5. Muted and opacity-faded text falls as low as 2.43:1 in the light theme (P1)

## Detailed Findings by Severity

### [P0] No visible focus indicator anywhere in the application

- **Location**: src/client/styles.css:111 (`input:focus, textarea:focus { outline: none }`)
- **Category**: Accessibility
- **Impact**: `outline: none` removes the browser default on inputs and textareas, replacing it only with a border-color shift. Buttons — the overwhelming majority of controls in this UI — receive no focus treatment at all: the stylesheet contains exactly one `focus` selector and zero `:focus-visible` rules. A keyboard user tabbing through a room cannot tell which control is focused, anywhere in the app.
- **WCAG/Standard**: 2.4.7 Focus Visible (Level AA) — failed
- **Recommendation**: Add a global `:focus-visible` rule with a 2px `--accent` outline and `outline-offset: 2px`, then restore a distinct focus treatment for inputs rather than relying on the border-color change alone.
- **Suggested command**: `/impeccable harden`

### [P1] Primary button text fails AA contrast

- **Location**: src/client/styles.css:847 (`.send`), also `.primary`, `.side-icon-btn`, `.gate-card > button`
- **Category**: Accessibility
- **Impact**: `--accent-ink` (#ffffff) on `--accent` (#1683e8) measures **3.86:1**. This is the send button, the sign-in button and every primary modal action — the most important control on each surface is the one that fails.
- **WCAG/Standard**: 1.4.3 Contrast (Minimum), Level AA — needs 4.5:1
- **Recommendation**: Darken `--accent` for the light theme to roughly #0f6fd0 or darker (`--accent-strong` at #0f62c4 already measures well); or keep the hue and use the darker value as the button fill.
- **Suggested command**: `/impeccable colorize`

### [P1] Tool disclosure row is a div with role="button" and no keyboard support

- **Location**: src/client/components.tsx:744
- **Category**: Accessibility
- **Impact**: `<div className="tool-head" onClick={...} role="button">` announces itself as a button to assistive tech but has no `tabIndex`, no `onKeyDown`, and no `aria-expanded`. It cannot be focused or activated by keyboard at all, so keyboard and screen-reader users cannot expand any tool block to see what the agent actually did — core content in a product whose whole premise is reviewing agent actions.
- **WCAG/Standard**: 2.1.1 Keyboard (Level A) — failed; 4.1.2 Name, Role, Value
- **Recommendation**: Make it a real `<button>` (it already has `border: none; background: none` styling available), and add `aria-expanded={open}`.
- **Suggested command**: `/impeccable harden`

### [P1] Six form controls have no programmatic label

- **Location**: src/client/components.tsx:207, 280, 435, 935, 1229; src/client/Settings.tsx:209
- **Category**: Accessibility
- **Impact**: Of 24 form controls, 6 have no `aria-label`, no `<label htmlFor>`, and no wrapping `<label>`. Four (the name inputs, project-name input, and the composer textarea) rely on a `placeholder` alone, which disappears as soon as the user types and is an accessible-name source of last resort. The member role `<select>` and the temperature `<input type="range">` have no name at all — a screen reader announces the role picker with no indication of whose role it changes.
- **WCAG/Standard**: 1.3.1 Info and Relationships (A), 3.3.2 Labels or Instructions (A), 4.1.2 (A)
- **Recommendation**: Add `aria-label` to the composer textarea, name inputs, and the temperature slider; give the role select an `aria-label` that includes the member name (e.g. `aria-label={`Role for ${m.name}`}`).
- **Suggested command**: `/impeccable harden`

*(Verified against false positives: the policy-mode radios (components.tsx:1355), the per-tool radios (1379) and the workspace write checkbox (1516) are all wrapped in `<label>` elements and are correctly labelled — they are excluded from this count. Four of the five range sliders in Settings.tsx are likewise wrapped in `<label className="field">`.)*

### [P1] No live region for streaming output, incoming messages, or vote state

- **Location**: src/client/components.tsx:533 (`Transcript`), src/client/RoomView.tsx:375 (status in `.bar`)
- **Category**: Accessibility
- **Impact**: The stylesheet and TSX contain zero `aria-live` regions. In a product built specifically so that *several people and an agent* talk into one conversation, a screen-reader user is never told that someone else spoke, that the agent started thinking, that a tool run finished, or that a vote opened and needs their input. The status text in the header changes silently. This is the product's central interaction being invisible to assistive tech.
- **WCAG/Standard**: 4.1.3 Status Messages (Level AA)
- **Recommendation**: Wrap the transcript's newest-entry region in `aria-live="polite"`, and give the header status element `role="status"`. Announce open votes with `aria-live="assertive"` since they block the turn.
- **Suggested command**: `/impeccable harden`

### [P1] Dialogs lack aria-modal, an accessible name, focus trapping, and Escape

- **Location**: src/client/components.tsx:1037, 1195, 1324, 1494; src/client/Settings.tsx:74
- **Category**: Accessibility
- **Impact**: Five dialogs set `role="dialog"` but none sets `aria-modal="true"` or `aria-labelledby` pointing at its own `<h2>`, none traps focus, and none handles Escape. Focus stays behind the scrim, so a keyboard user tabs invisibly through the page underneath. Click-outside-to-close (`.modal-scrim` `onClick`) is a mouse-only affordance with no keyboard equivalent.
- **WCAG/Standard**: 2.1.2 No Keyboard Trap (inverse — focus is not contained), 2.4.3 Focus Order (A), 4.1.2 (A)
- **Recommendation**: Add `aria-modal="true"` and `aria-labelledby` to each dialog, move focus into the dialog on open and restore it on close, and add an Escape key handler alongside the existing scrim click.
- **Suggested command**: `/impeccable harden`

### [P1] Muted text fails AA across the light theme

- **Location**: src/client/styles.css:12 (`--ink-faint`), used by `.rev`, `.doc-empty`, `.tool-summary`, `.empty-sub`, `.sys`, `.gauge-text`
- **Category**: Accessibility
- **Impact**: `--ink-faint` measures 3.52:1 on `--panel`, 3.36:1 on `--panel-2`, and 3.22:1 on `--bg` — all below the 4.5:1 minimum. `--accent` as text also fails (3.86:1 on panel, 3.53:1 on bg, 3.43:1 on `--panel-3`), which affects `.agent-who`, `.approval-tool`, `.status-thinking` and `.field-value`. `--warn`, `--bad` and `--success-ink` as text all land between 3.77:1 and 4.41:1. The dark theme is much healthier: only 7 of 37 pairs fail there versus 20 of 37 in light.
- **WCAG/Standard**: 1.4.3 Contrast (Minimum), Level AA
- **Recommendation**: Darken the light-theme values of `--ink-faint`, `--accent`, `--warn`, `--bad` and `--success-ink`. `audit/contrast.json` lists every failing pair with its measured ratio and the rule that composes it.
- **Suggested command**: `/impeccable colorize`

### [P1] Opacity-faded text lands far below the contrast floor

- **Location**: src/client/styles.css:95 (`button:disabled`), :1524 (`.tool-disclosure`), :1562 (`.steps-hidden`), :722 (`.tool-denied`)
- **Category**: Accessibility
- **Impact**: Fading is applied on top of already-muted ink, and the two compound. Measured against their real backdrops: `.tool-disclosure` at 2.43:1, `.steps-hidden` at 2.61:1, `button:disabled` at 2.68:1, `.tool-denied` at 3.54:1, `.invite-dead` at 3.57:1, `.chip-viewer` at 4.14:1. The disclosure triangle is the affordance that tells a user a tool block can be opened, and it is the least legible thing on the surface.
- **WCAG/Standard**: 1.4.3 (AA). Disabled controls are exempt, but `.tool-disclosure`, `.steps-hidden` and `.tool-denied` are not — they convey live information.
- **Recommendation**: Drop the `opacity` on the non-disabled cases and pick a token that already meets contrast, rather than stacking a fade on `--ink-faint`.
- **Suggested command**: `/impeccable colorize`

### [P1] No prefers-reduced-motion support, with two infinite animations running

- **Location**: src/client/styles.css:687 (`@keyframes pulse`), :689, :1017 (`.worker-running .worker-dot`)
- **Category**: Accessibility
- **Impact**: The stylesheet has **0** `prefers-reduced-motion` blocks against 4 transitions and 2 infinite animations. The `pulse` animation runs indefinitely on the typing indicator and on every running worker dot — so during a long agent turn, a user with vestibular sensitivity sees continuous looping motion with no way to stop it.
- **WCAG/Standard**: 2.3.3 Animation from Interactions (AAA); `prefers-reduced-motion` is the established platform contract
- **Recommendation**: Add a `@media (prefers-reduced-motion: reduce)` block that replaces `pulse` with a static opacity state — keep the state legible rather than killing all motion with a blanket `0.01ms` override.
- **Suggested command**: `/impeccable animate`

### [P2] Input and select borders are not perceivable

- **Location**: src/client/styles.css:97 (`input, textarea`), :1119 (`select`)
- **Category**: Accessibility
- **Impact**: `--line` on `--bg` measures **1.28:1** in light and 1.58:1 in dark; on `--panel` it is 1.39:1 / 1.48:1. Text fields are identified only by that border plus a subtle background shift, so the boundary of an interactive control is effectively invisible to a low-vision user.
- **WCAG/Standard**: 1.4.11 Non-text Contrast (Level AA) — needs 3:1 for control boundaries
- **Recommendation**: Introduce a dedicated `--line-strong` token at ≥3:1 against `--bg` for input, select and textarea borders, leaving `--line` for decorative dividers.
- **Suggested command**: `/impeccable colorize`

### [P2] The transcript is not virtualized

- **Location**: src/client/components.tsx:557 (`entries.map`)
- **Category**: Performance
- **Impact**: Every entry renders a DOM node for the life of the room. The README states the transcript is append-heavy and broadcast as deltas precisely because it grows large — but the client keeps the entire history mounted. `EntryView` is correctly memoized with a stable `key`, so re-render cost is controlled; node count and memory are not. A long session degrades scroll and layout cost linearly.
- **Recommendation**: Windowed rendering over the transcript, or cap the mounted range with a "load earlier" affordance at the top.
- **Suggested command**: `/impeccable optimize`

### [P2] Google Fonts loaded via a render-blocking CSS @import

- **Location**: src/client/styles.css:1; index.html
- **Category**: Performance
- **Impact**: `@import url("https://fonts.googleapis.com/css2?family=Inter...")` at the top of the stylesheet serializes the request chain — the browser must fetch and parse `styles.css` before it discovers the font request. `index.html` has no `preconnect` to `fonts.googleapis.com` or `fonts.gstatic.com`, adding a full connection setup to the critical path. Five weights (400–800) are requested.
- **Recommendation**: Move the font to a `<link rel="preconnect">` + `<link rel="stylesheet">` pair in `index.html`, and drop the weights the UI never uses.
- **Suggested command**: `/impeccable optimize`

### [P2] Unthrottled scroll handler performs three layout reads per event

- **Location**: src/client/components.tsx:546 (`onScroll`)
- **Category**: Performance
- **Impact**: The handler reads `scrollHeight`, `scrollTop` and `clientHeight` on every scroll event to maintain the scroll-pinning flag. On a long transcript these forced layout reads fire at full scroll frequency. The `useLayoutEffect` at :555 also runs on every render with no dependency array, reading and writing scroll position each time.
- **Recommendation**: Throttle the handler to one read per animation frame, or track pinning with an `IntersectionObserver` sentinel at the bottom of the list.
- **Suggested command**: `/impeccable optimize`

### [P2] Type and control sizing are almost entirely px-based

- **Location**: src/client/styles.css:80 (`font: 15px/1.55`), plus 86 `font-size: Npx` declarations
- **Category**: Responsive
- **Impact**: The stylesheet contains **86 pixel font sizes and exactly one `rem`** (a `max-height`). A user who raises their browser's default font size sees no change at all. Compounding it, at least 10 text-bearing controls carry fixed pixel heights (`.theme-toggle` 32px, `.room-chip` 34px, `.doc-close` 28px, `.linkbtn` 28px, `.policy-chip` 32px, `.gauge` 32px), so when text does scale — via zoom or text-only zoom — the content clips rather than the control growing.
- **WCAG/Standard**: 1.4.4 Resize Text (AA), 1.4.12 Text Spacing (AA)
- **Recommendation**: Move the type scale to `rem` and convert the fixed heights to `min-height` with padding, so controls grow with their content.
- **Suggested command**: `/impeccable adapt`

### [P2] Two touch targets fall below the AA minimum

- **Location**: src/client/styles.css:466 (`.side-small-action`, 21px), :585 (`.side-form-actions button`, 23px)
- **Category**: Responsive
- **Impact**: 28 interactive rules were measured. Two resolve below the 24px minimum, and 24 fall below the 44px enhanced target. The two AA failures are both in the side panel, where project creation and its confirm/cancel actions live — small, close-set controls on the surface most likely to be used on a phone.
- **WCAG/Standard**: 2.5.8 Target Size (Minimum), Level AA — 24×24 CSS px
- **Recommendation**: Raise both to a 24px minimum box via padding; consider 44px for the touch breakpoints.
- **Suggested command**: `/impeccable adapt`

*(Verified against false positives: `.theme-toggle-track` (16px) and `.theme-toggle-thumb` (12px) are decorative children of the 32px `.theme-toggle` button, and `.ws-repo-tag` / `.ws-repo-branch` are non-interactive labels — none are targets, and all are excluded from the count above.)*

### [P2] The token gauge animates `width`, a layout-triggering property

- **Location**: src/client/styles.css:955 (`.gauge-fill`)
- **Category**: Performance
- **Impact**: `transition: width 300ms ease` forces layout on every frame of the fill animation. This is the one transition in the file on a layout property (confirmed independently by the bundled detector's `layout-transition` rule), and it runs whenever token spend updates — which, during a streaming turn, is often.
- **Recommendation**: Animate `transform: scaleX()` against a fixed-width track instead, which composites without reflow.
- **Suggested command**: `/impeccable optimize`

### [P2] Error banner can only be dismissed by mouse

- **Location**: src/client/RoomView.tsx:460
- **Category**: Accessibility
- **Impact**: `<div className="banner error" onClick={() => setError(null)}>` is the dismiss affordance for error messages, on a non-focusable element with no key handler and no indication that it is clickable at all.
- **WCAG/Standard**: 2.1.1 Keyboard (Level A)
- **Recommendation**: Add a real dismiss `<button>` inside the banner, and give the banner `role="alert"` so the error is announced.
- **Suggested command**: `/impeccable harden`

### [P2] The floating shadow is hard-coded and stays light in dark mode

- **Location**: src/client/styles.css:925 (`.doc-reopen`)
- **Category**: Theming
- **Impact**: `box-shadow: 0 8px 24px rgba(31, 41, 55, 0.12)` is written as a literal rather than using the `--shadow` token, which is themed (`rgba(0,0,0,0.42)` in dark). The one floating element in the app therefore keeps a pale light-theme shadow against the dark background, where it reads as a faint halo instead of depth.
- **Recommendation**: Use `var(--shadow)`, or add a second themed token if a tighter floating shadow is wanted.
- **Suggested command**: `/impeccable polish`

### [P2] The logo hard-codes three blues and cannot theme

- **Location**: src/client/styles.css:268, 281, 288, 295 (`.logo-mark span`)
- **Category**: Theming
- **Impact**: The four logo squares use `#2d96ee`, `#1683e8` (twice) and `#7dc6ff` as literals. `#1683e8` is byte-identical to `--accent`, so the same color is defined in two places and will silently drift the moment the accent is retuned — which is likely, given the palette is explicitly open to change. The logo also cannot respond to the dark theme.
- **Recommendation**: Replace with `var(--accent)` and two derived tints defined as tokens.
- **Suggested command**: `/impeccable polish`

### [P2] The room view has no heading structure

- **Location**: src/client/RoomView.tsx:375
- **Category**: Accessibility
- **Impact**: `<h1>` appears only on the three gate screens (Landing, JoinGate, SignInGate). Once inside a room — the app's primary surface — there is no `h1` and no headings at all outside modal dialogs. Screen-reader users cannot navigate the page by heading, and the room has no announced title.
- **WCAG/Standard**: 1.3.1 Info and Relationships (A); 2.4.6 Headings and Labels (AA)
- **Recommendation**: Give the room a visually-hidden `<h1>` naming the room, and promote the transcript and document panes to labelled regions.
- **Suggested command**: `/impeccable harden`

### [P2] Side navigation consumes a fixed 260px band on phones

- **Location**: src/client/styles.css:1180 (`.side-shell` at max-width 760px)
- **Category**: Responsive
- **Impact**: Below 760px the nav becomes a fixed 260px row stacked above the chat. On a 640px-tall viewport that is over 40% of the screen spent on navigation before a single message is visible, and it cannot be collapsed. The document pane takes a further fixed 240px row below 860px.
- **Recommendation**: Make the mobile nav a collapsible drawer or a short horizontal strip rather than a fixed block.
- **Suggested command**: `/impeccable adapt`

### [P2] No breakpoint below 760px

- **Location**: src/client/styles.css:1141, :1166
- **Category**: Responsive
- **Impact**: The stylesheet defines exactly two breakpoints (860px and 760px). Between 760px and a 360–390px phone the header packs a gauge, policy chip, workspace chip, presence list, rename control and five buttons into a wrapping flex row with no further adaptation. `overflow-x: auto` on `.bar-control-group` prevents page-level blowout, so this degrades rather than breaks — but it degrades into a cramped, horizontally-scrolling header on the most common viewport size.
- **Recommendation**: Add a narrow breakpoint that collapses secondary header controls behind a single overflow menu.
- **Suggested command**: `/impeccable adapt`

### [P3] The topbar translucency ladder is untokenized

- **Location**: src/client/styles.css:174, 244, 246, 329, 331, 1214, 1216, 1232, 1233, 1258, 1268, 1270, 1373, 1381, 1385
- **Category**: Theming
- **Impact**: Fifteen `rgba(255,255,255,α)` literals across eight distinct alpha values (0.035, 0.045, 0.07, 0.08, 0.09, 0.12, 0.14, 0.16, 0.18, 0.2, 0.22) implement the topbar's translucent control treatment. The intent is deliberate and documented in `DESIGN.md`, but the values are ad hoc — several pairs differ by 0.01 with no visible reason.
- **Recommendation**: Define three tokens (`--on-topbar-fill`, `--on-topbar-fill-hover`, `--on-topbar-line`) and collapse the ladder onto them.
- **Suggested command**: `/impeccable extract`

### [P3] `--mono` is an alias for `--sans`

- **Location**: src/client/styles.css:36
- **Category**: Implementation Integrity
- **Impact**: `--mono: var(--sans)` means every place that reaches for `var(--mono)` — tool names, diffs, the document body, revision stamps, invite URLs — is asking for a monospace face and silently receiving a proportional one. Diff rows and the document pane show code-like content in proportional type, so columns do not align. The token name misrepresents what it delivers, which is a trap for the next person editing it.
- **Recommendation**: Either point `--mono` at a real monospace stack, or rename it to something honest like `--code` if the single-face choice is deliberate (`DESIGN.md` currently codifies it as deliberate).
- **Suggested command**: `/impeccable typeset`

### [P3] `theme-color` matches neither theme

- **Location**: index.html
- **Category**: Theming
- **Impact**: `<meta name="theme-color" content="#101827">` is a single value that matches neither `--topbar` in light (#1f2937) nor in dark (#050b14), and there is no `media="(prefers-color-scheme: dark)"` variant. Mobile browser chrome will not match the app bar in either theme.
- **Recommendation**: Ship two `theme-color` meta tags keyed to `prefers-color-scheme`, using the actual topbar values.
- **Suggested command**: `/impeccable polish`

### [P3] Three side-tab accent borders flagged by the detector

- **Location**: src/client/styles.css:720, 721, 723 (`.tool-ok`, `.tool-error`, `.tool-running`)
- **Category**: Implementation Integrity
- **Impact**: `border-left: 3px solid var(--ok)` and siblings trip the detector's `side-tab` rule, which flags a thick one-sided colored border as a recognizable tell of generated UI. Here the usage is defensible — it encodes tool status and is paired with a matching `.tool-pip` dot — but three near-identical variants plus the pip is redundant signalling.
- **Recommendation**: Keep the pip as the status carrier and reduce the border to 1–2px, or drop it and let the pip do the work alone.
- **Suggested command**: `/impeccable quieter`

### [P3] Inter is the default-choice typeface

- **Location**: src/client/styles.css:1, :35
- **Category**: Implementation Integrity
- **Impact**: The detector's `overused-font` rule flags Inter as the most common tell of AI-generated design. It is a perfectly serviceable UI face and the single-face system is documented as intentional, so this is a positioning question, not a defect — but the product currently has no typographic differentiation at all.
- **Recommendation**: If the palette is being reconsidered anyway, this is the moment to pair a distinctive face for the room title and headings while keeping Inter for UI body text.
- **Suggested command**: `/impeccable typeset`

### [P3] DESIGN.md under-documents the real type and radius scales

- **Location**: audit/detector-summary.json (43 advisory findings); src/client/styles.css
- **Category**: Implementation Integrity
- **Impact**: `DESIGN.md` records 3 typography roles and 5 radius steps. The CSS actually uses 9 distinct font sizes (10, 11, 12, 13, 14, 15, 16, 18, 22px) and 8 distinct radii (2, 6, 7, 8, 9, 10, 12, 14px, plus 999px). This is what generates 43 of the detector's 49 findings. Two problems overlap: the design doc is incomplete, and the underlying scale has genuinely sprawled — 6px, 7px, 8px, 9px and 10px radii are not five meaningfully different shapes.
- **Recommendation**: Consolidate to 3 radius steps and a 6-step type ramp in the CSS, then re-run `/impeccable document` so the design doc records the consolidated scale and the advisory noise clears.
- **Suggested command**: `/impeccable extract`

### [P3] Five range sliders carry no visible value affordance for keyboard users

- **Location**: src/client/Settings.tsx:209, 272, 315, 336, 358
- **Category**: Accessibility
- **Impact**: The sliders show their current value in an adjacent `.field-value` span, but none carries `aria-valuetext`, so a screen reader announces a bare number without units or meaning (e.g. "0.85" rather than "temperature 0.85"). Four of five are correctly wrapped in `<label className="field">`, so the name is present — only the value is opaque.
- **WCAG/Standard**: 4.1.2 Name, Role, Value (Level A)
- **Recommendation**: Add `aria-valuetext` mirroring the visible `.field-value` text.
- **Suggested command**: `/impeccable harden`

## Patterns & Systemic Issues

1. **Focus is an unimplemented dimension, not a set of gaps.** One `focus` selector exists in 1,679 lines of CSS, and it removes an outline. This is not a handful of missed controls — the keyboard state was never designed.
2. **The light theme carries almost three times the contrast debt of the dark theme** (20 failing pairs versus 7). The dark palette was tuned; the light one appears to have been chosen for its pale, calm character without checking ink against it.
3. **Opacity is used as a styling shortcut on already-muted ink.** Six separate rules fade `--ink-faint` or `--ink` further, and every one of them lands below the contrast floor. A "quieter" token would solve this once instead of six times.
4. **The scale has sprawled where the tokens have not.** Colors are rigorously tokenized (0 literals in the TSX, 58 tokens), but radii and font sizes are written as literals throughout — 9 type steps and 8 radii, none of them tokens. The discipline applied to color never reached the other primitives.
5. **ARIA is present structurally but absent dynamically.** Landmarks, `role="dialog"`, `aria-label` on nav and aside, and `aria-hidden` on decorative elements are all done correctly — while the live, changing parts of the app (messages arriving, status changing, votes opening) announce nothing.

## Positive Findings

- **Color tokenization is genuinely rigorous.** 58 tokens, a complete parallel dark theme, `color-scheme` declared for both, and **zero color literals in the entire client TSX** — every color in the React tree comes from the token layer.
- **The token vocabulary is semantic, not decorative.** `--approval-bg`, `--mine-line`, `--diff-new-ink`, `--danger-line` name what they mean in this product, and the state colors are reused consistently across chat, votes, tool results and diffs.
- **Transcript rendering is done well.** `EntryView` is `memo`-wrapped with a stable `key={entry.id}`, and the scroll-pinning logic deliberately avoids yanking the view away from someone reading back — a thoughtful detail most chat UIs get wrong.
- **Landmark structure is real**: `<main>`, `<header>`, `<nav aria-label="Projects">`, `<aside aria-label="Workspace navigation">`, `lang="en"`, and `aria-hidden="true"` correctly applied to the decorative status pip.
- **No image assets at all** — the logo is composed from CSS boxes, so there is no image-optimization or lazy-loading debt anywhere in the project.
- **Grid sizing is defensively written.** `minmax(0, 1fr)` appears throughout, which is the correct guard against grid blowout, and `overflow-x: auto` is applied to the toolbars that need it.
- **The stylesheet documents its own intent.** Several rules carry comments explaining *why* a treatment was chosen (why viewer chips are subtle, why the offline workspace chip reads as degraded, why the collapsed tool row is quiet). This is unusual and worth preserving.

## Recommended Actions

1. **[P0/P1] `/impeccable harden`** — Focus indicators app-wide, the `role="button"` div at components.tsx:744, six unlabeled form controls, dialog semantics (`aria-modal`, `aria-labelledby`, focus trap, Escape), live regions for streaming output and votes, and the keyboard-inaccessible error banner. This is the largest single block of work and covers the P0 plus five P1s.
2. **[P1] `/impeccable colorize`** — Retune the light theme against measured contrast: `--accent` (the primary button fails at 3.86:1), `--ink-faint`, `--warn`, `--bad`, `--success-ink`, plus a `--line-strong` for input boundaries. `audit/contrast.json` has every failing pair. Since the palette is explicitly open to change, doing this before other visual work avoids reworking it twice.
3. **[P1] `/impeccable animate`** — Add a `prefers-reduced-motion` block that gives the two infinite `pulse` animations a static alternative preserving their state meaning.
4. **[P2] `/impeccable optimize`** — Transcript virtualization, the render-blocking font `@import`, the unthrottled scroll reads, and the `width` transition on the gauge.
5. **[P2] `/impeccable adapt`** — Move the type scale to `rem`, convert fixed control heights to `min-height`, raise the two sub-24px targets, and add a narrow-viewport breakpoint with a collapsible mobile nav.
6. **[P3] `/impeccable extract`** — Tokenize the radius and type scales (consolidating 8 radii and 9 sizes), and the topbar translucency ladder.
7. **[P3] `/impeccable typeset`** — Resolve `--mono` (real monospace, or an honest rename), and decide whether Inter alone is the intended typographic position.
8. **[P3] `/impeccable polish`** — Final pass: the hard-coded floating shadow, the logo's literal blues, and the `theme-color` meta tags.
