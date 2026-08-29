# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Small groups of people (friends, teams) who want to collaborate with one shared AI agent in real time, inside a single conversation room. Everyone talks into the same conversation; the agent replies to the room, not to an individual.

## Product Purpose

Reconciles two facts: N humans produce input concurrently, but an agent has one linear conversation and takes one action at a time. The room shares one agent and one conversation. The agent can edit a shared document or files in a connected workspace (local folder or GitHub), but a write goes to a group vote first, unless the room has set auto-accept.

## Positioning

Most multiplayer/collab AI tools give each person their own agent or session. This product gives a group one shared agent with one shared history, where write actions are proposals the room votes on — and a turn is a persisted state machine (not a suspended request), so a vote can arrive minutes later, in a different invocation, and the turn resumes correctly.

## Operating Context

- A room is a Durable Object (Cloudflare Workers, SQLite storage backend) holding the transcript, conversation history, membership/roles/invites, inbox/turn state, and synced RoomState (presence, doc, workspace, open votes).
- Messages from multiple speakers are tagged `[Name]:` and merged into a single user turn.
- Messages sent while the agent is working queue into an inbox and fold into the next turn — nothing is dropped, no turn is split mid-flight.
- Gated tool calls (e.g. file/document writes) become proposals; the room votes, or an auto-accept room lets the write proceed immediately.
- Workspace providers: a local folder relay, or a connected GitHub repo (via a GitHub App — branches, PRs, contents API).
- Runs on Cloudflare Workers Free tier + Durable Objects (SQLite backend, free-tier eligible). Free limits: 100k requests/day, 13,000 GB-s compute, 5M row reads, 100k row writes, 5 GB storage. Idle rooms hibernate.
- The header gauge tracks Anthropic token spend, the actual dominant cost.
- Room settings (model, spend policy, workflow presets) are shared across the room and every change is announced in the transcript with who made it. Changes are only accepted while the agent is idle.
- Invite-based access: invite links/codes bring people into a room; roles and capabilities are read from a shared access policy (`src/shared/access.ts`).

## Capabilities and Constraints

- Real-time multiplayer chat with a single shared AI agent (Anthropic API).
- Shared document editing and file/workspace editing (local folder or GitHub), gated behind room votes unless auto-accept is set.
- Streaming model responses; a mock mode (`ANTHROPIC_API_KEY=mock`) exercises streaming, approval pause, voting, and resumption without a real API key.
- The product is **Huddle.AI**. The repo, the Worker and the localStorage keys still carry the older `collab_ai` name; only the user-facing name has moved.

## Evidence on Hand

None. No testimonials, case studies, press, or marketing assets exist yet — do not fabricate any.

## Product Principles

1. One room, one shared agent, one shared history — never fork per-person sessions.
2. Writes are proposals, not unilateral actions, unless the room explicitly opts into auto-accept.
3. A turn is durable, resumable state, not a live in-memory wait — design and copy should never imply votes must happen "right now" or the turn is lost.
4. Nothing a person says is ever silently dropped, even mid-turn.
5. Shared settings changes are always visible in the transcript — no silent configuration drift.

## Accessibility & Inclusion

No specific accessibility standard confirmed yet.
