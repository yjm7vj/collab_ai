# Project instructions

## unlazy skill: solo by default, orchestrated on explicit request

**Default is solo mode** — one `GATES.md` for the task at hand. In solo mode,
do not read `references/orchestration.md`, `references/dispatch.md`, or
`references/parallel.md`; do not build a Depth Tree or write a `PLAN.md`; do
not dispatch subagents or use `--claim`/`--scope`.

**Orchestrated or parallel mode is opt-in.** Enter it only when the user writes
one of these in *that same message*:

- `orchestrate` / `full orchestration`
- `tree N` (N = requested depth)
- `parallel`

Do not carry the opt-in forward to later messages. Each orchestrated run needs
its own trigger; absent one, fall back to solo.

**Before any fan-out, stop and confirm.** Cost grows with tree depth — every
leaf is a cold subagent that re-derives context from scratch. So once the tree
is drafted but before dispatching anything, report:

- the proposed depth and the leaf count at each level,
- what each leaf owns,
- which references the mode requires loading (~11.5k tokens for all of them).

Then wait for the user's go-ahead. Do not open a dispatch wave before it.

If the tree comes out wider or deeper than the user asked for, say so and
propose the smaller version rather than silently building the large one.

## General

No gates for trivial edits or factual replies. Use a ledger only when quiet
incompleteness would actually cost a rework cycle.
