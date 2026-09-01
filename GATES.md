# Gates: isolated Linux terminal

OWNS: GATES.md, package.json, package-lock.json, wrangler.jsonc, worker-configuration.d.ts, src/server/index.ts, src/server/room.ts, src/server/terminal.ts, src/worker-env.d.ts, src/shared/protocol.ts, src/client/RoomView.tsx, src/client/components.tsx, src/client/IdePanel.tsx, src/client/TerminalPanel.tsx, src/client/styles.css, test/context-workspace-ui.test.ts, test/terminal-auth.test.ts

Scope: Preserve the Workspace connection experience and replace the separate IDE with an authenticated, room-isolated Linux terminal backed by Cloudflare Sandbox.

- [x] G0: This ledger contains outcome checks that can fail.
  CHECK: node .agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=31931dd27456/39 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] G1: Workspace still exposes local and GitHub connections, while the right-hand action is Terminal and no IDE UI remains.
  CHECK: npx vitest run test/context-workspace-ui.test.ts -t "workspace and terminal" && echo __TERMINAL_UI_PASSED__
  EXPECT: __TERMINAL_UI_PASSED__
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=31931dd27456/39 entries; EXPECT=matched; output-sha256=3f2f504e6474b6ac37e0ab308e833217d8aba5961eb564d9b842a784ca8d772f; output-bytes=820

- [x] G2: Terminal creation and WebSocket attachment require a valid current room admin and use a room-derived Sandbox instead of client-selected authority.
  CHECK: npx vitest run test/terminal-auth.test.ts && echo __TERMINAL_AUTH_PASSED__
  EXPECT: __TERMINAL_AUTH_PASSED__
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=31931dd27456/39 entries; EXPECT=matched; output-sha256=ba5efd321ed6f58747d8bd3b3832f5717f75b9c01f4a5f5c09766e8dfe7c70a3; output-bytes=2011

- [x] G3: The complete application checks and integration tests pass.
  CHECK: npm test && npm run test:integration && echo __FULL_TESTS_PASSED__
  EXPECT: __FULL_TESTS_PASSED__
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=31931dd27456/39 entries; EXPECT=matched; output-sha256=410d91ccb4e32d086dcf64d1e746782da344a01dcadabbf32939ac10a9be8695; output-bytes=42906

- [x] G4: The Worker and client typecheck and build with matching Sandbox preview package and container configuration.
  CHECK: npm run typecheck && npm run build && echo __TERMINAL_BUILD_PASSED__
  EXPECT: __TERMINAL_BUILD_PASSED__
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=31931dd27456/39 entries; EXPECT=matched; output-sha256=59b5b2af01eca657fe0fce00041effc36444382c2bd0eb6b5492a2b3ebe27da7; output-bytes=3586

- [x] G5: The release diff has no unresolved merge markers or whitespace errors.
  CHECK: git diff --check && git diff --name-only --diff-filter=U && echo __TERMINAL_DIFF_PASSED__
  EXPECT: __TERMINAL_DIFF_PASSED__
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=31931dd27456/39 entries; EXPECT=matched; output-sha256=ed86b0ea444ba4ced1e22139915cdcc15a1cd27d0ffc5c9183aab4e6a3816497; output-bytes=2073
