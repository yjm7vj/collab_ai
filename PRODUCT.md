# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: **groups of non-engineers who own files that live in a Git repository** and who cannot, or will not, use GitHub to change them. Docs sites and help centres, marketing and pricing copy, policy and handbook content, localisation strings, product configuration, status-page and incident templates. These files are owned by marketing, support, legal, compliance, finance, People Ops or regional leads, and today every change routes through an engineer in a chat thread.

The defining trait is not "non-technical". It is that **the change requires someone's approval whether or not an agent is involved**, and the people whose approval is required cannot read a diff, sit in different timezones, and are not all online at once.

Secondary: any small group that wants one shared agent in one conversation. The mechanics are general, but the product is not designed around them, and design decisions resolve in favour of the primary group.

Explicitly not the target: software engineers changing application code. They already hold a per-person agent with no gate and a stronger review primitive in the pull request, so the approval gate is pure friction for them.

## Product Purpose

Reconciles two facts: N humans produce input concurrently, but an agent has one linear conversation and takes one action at a time. The room shares one agent and one conversation. The agent can edit a shared document or files in a connected workspace (a local folder, or a GitHub repo via a GitHub App), but a write goes to a group vote first, unless the room has set auto-accept.

For the primary user the purpose is narrower and more concrete: **let a group of non-engineers change repo-backed files in plain language, and make the group's approval the review step**, so that a branch and a pull request come out of a conversation the approvers could actually take part in.

Success is a change that today takes a chat thread, a borrowed engineer, a pull request nobody in the thread can read, and a sign-off recorded nowhere — landing instead as one room conversation with the approval attached to it.

## Positioning

**The vote is the product, and it is only worth its cost where approval was already mandatory.**

Most multiplayer/collab AI tools give each person their own agent or session. This product gives a group one shared agent with one shared history, where write actions are proposals the room votes on. The consequence a neighbouring product cannot truthfully copy: because a turn is a persisted state machine rather than a suspended request, a vote can arrive minutes or hours later, from a different device, in a different invocation, and the turn resumes correctly. Approval is therefore genuinely asynchronous, which is the only shape in which a group spread across roles and timezones can approve anything at all.

Against the alternatives available to the primary user:

- **A per-person agent** (Claude Code, Cursor, a chat assistant) produces the change but has no group, no approval and no record, and its operator is the engineer the group was trying not to need.
- **GitHub pull requests** are the right review tool for code and unusable by the people whose approval is actually required here. The diff, the branch and the review UI are the barrier, not the mechanism.
- **A shared document** (Google Docs, Notion) gives concurrent editing and comments, but no agent, no execution, and no path into the repository the change has to land in.
- **Chat plus a ticket** is what these groups do today: the discussion, the artefact and the approval live in three tools and get reconciled by hand, late and badly.

This product collapses those into one place where the conversation, the change and the sign-off are the same record.

The disqualifying test for any proposed use case: *would this group need someone's approval even if the agent did not exist?* If yes, the gate is free and this is the cheapest way to satisfy it. If no, the gate is a tax and a single-player agent wins.

## Operating Context

- A room is a Durable Object (Cloudflare Workers, SQLite storage backend) holding the transcript, conversation history, membership/roles/invites, inbox/turn state, and synced RoomState (presence, doc, workspace, open votes).
- Messages from multiple speakers are tagged `[Name]:` and merged into a single user turn.
- Messages sent while the agent is working queue into an inbox and fold into the next turn — nothing is dropped, no turn is split mid-flight.
- Gated tool calls (e.g. file/document writes) become proposals; the room votes, or an auto-accept room lets the write proceed immediately.
- Workspace providers: a local folder relay, or a connected GitHub repo (via a GitHub App — branches, PRs, contents API). The GitHub provider is the one the primary user depends on: the agent does the Git work the group cannot, and the room's vote is what authorises it.
- Approval is asynchronous by default. Approvers are routinely on a phone, in another timezone, and absent at the moment the proposal is made.
- Invite-based access: invite links/codes bring people into a room; roles and capabilities are read from a shared access policy (`src/shared/access.ts`). An approver typically arrives by invite link with no prior account, no repo access and no Git knowledge.
- Runs on Cloudflare Workers Free tier + Durable Objects (SQLite backend, free-tier eligible). Free limits: 100k requests/day, 13,000 GB-s compute, 5M row reads, 100k row writes, 5 GB storage. Idle rooms hibernate.
- The header gauge tracks Anthropic token spend, the actual dominant cost.
- Room settings (model, spend policy, workflow presets) are shared across the room and every change is announced in the transcript with who made it. Changes are only accepted while the agent is idle.

## Capabilities and Constraints

- Real-time multiplayer chat with a single shared AI agent (Anthropic API).
- Shared document editing and file/workspace editing (local folder or GitHub), gated behind room votes unless auto-accept is set.
- Streaming model responses; a mock mode (`ANTHROPIC_API_KEY=mock`) exercises streaming, approval pause, voting, and resumption without a real API key.
- The transcript records who said what and who approved what, and is the nearest thing the product has to an audit record. Whether it is exportable, retained, or sufficient for any external standard is **undecided** — no retention, export or audit guarantee exists, and none may be claimed.
- Auto-accept switches the differentiating mechanic off. It stays available, but it is not the configuration the primary user is served by and should not sit on the default onboarding path.
- The product is **Huddle.AI**. The repo, the Worker and the localStorage keys still carry the older `collab_ai` name; only the user-facing name has moved.

## Evidence on Hand

None. No testimonials, case studies, press, marketing assets, named customers or pilot results exist yet — do not fabricate any. The user situations recorded above are targets derived from the product's mechanics, not observed deployments, and must never be presented as customers or as proof.

## Product Principles

1. One room, one shared agent, one shared history — never fork per-person sessions.
2. Writes are proposals, not unilateral actions, unless the room explicitly opts into auto-accept.
3. A turn is durable, resumable state, not a live in-memory wait — design and copy should never imply votes must happen "right now" or the turn is lost.
4. Nothing a person says is ever silently dropped, even mid-turn.
5. Shared settings changes are always visible in the transcript — no silent configuration drift.
6. The approver never has to understand Git. Branches, diffs, commits and pull requests are the agent's work and the room's outcome, never something the room is asked to operate.

## Accessibility & Inclusion

No specific accessibility standard confirmed yet.
