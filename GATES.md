# Gates: Local companion terminal

OWNS: companion/**, src/client/TerminalPanel.tsx, src/client/RoomView.tsx, src/client/components.tsx, src/client/styles.css, src/shared/terminal.ts, src/shared/protocol.ts, src/shared/access.ts, src/server/room.ts, src/server/tools.ts, scripts/check-terminal.ts, package.json, package-lock.json

Scope: Add a secure, room-aware terminal backed by a free local companion, accessible directly after the IDE button.

- [x] G0: This ledger states outcomes that can fail
  CHECK: node .agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: gate-lint exit=0, LINT OK with one expected manual-gate warning

- [x] G1: Terminal protocol, command classification, companion boundary, and relay authorization checks pass
  CHECK: npm run check:terminal
  EXPECT: terminal checks passed
  EVIDENCE: npm run check:terminal exit=0, terminal checks passed

- [x] G2: Existing application behavior remains covered by the complete test suite
  CHECK: npm test
  EXPECT: backend schema checks passed
  EVIDENCE: npm test exit=0, all checks passed

- [x] G3: TypeScript accepts the application and generated Worker bindings
  CHECK: npm run typecheck
  EXPECT: No errors
  EVIDENCE: npm run typecheck exit=0

- [x] G4: The production client and Worker bundle builds successfully
  CHECK: npm run build
  EXPECT: built in
  EVIDENCE: npm run build exit=0

- [x] G5: The Terminal button appears directly after IDE and opens a usable terminal with pairing, command approvals, session metadata, and room visibility controls
  EVIDENCE: Local browser check confirmed the button follows IDE and opens the pairing interface without console errors; companion PTY and agent-command smoke tests passed on Windows PowerShell.
