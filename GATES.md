# Gates: accurate context usage and unified workspace IDE

OWNS: src/server/model.ts, src/server/room.ts, src/shared/context.ts, src/client/RoomView.tsx, src/client/components.tsx, src/client/IdePanel.tsx, src/client/styles.css, test/context-workspace-ui.test.ts

Scope: Keep the room's token indicator tied to the main prompt, recount it after compaction, and expose the existing editor as an IDE inside the unified Workspace experience.

- [x] G1: Token usage displays exact used and available counts, and a compacted context refill updates from an exact prompt recount without worker calls corrupting it.
  CHECK: npx vitest run test/context-workspace-ui.test.ts -t "context token accounting" && echo __TOKEN_TESTS_PASSED__
  EXPECT: __TOKEN_TESTS_PASSED__
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=31931dd27456/39 entries; EXPECT=matched; output-sha256=1f090a63757a439bd47d65317634227f4486d3cd77dc2a9c9483c5b123fde3f7; output-bytes=422

- [x] G2: The Workspace panel contains both connection controls and the IDE, and the chat action immediately to the right of Workspace opens the IDE view.
  CHECK: npx vitest run test/context-workspace-ui.test.ts -t "unified workspace IDE" && npm run check:workspace && echo __WORKSPACE_IDE_TESTS_PASSED__
  EXPECT: __WORKSPACE_IDE_TESTS_PASSED__
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=31931dd27456/39 entries; EXPECT=matched; output-sha256=b201c9474be44744fa5f656740c8240cf8466572dcea0da62af3f361ec3ec14b; output-bytes=6721

- [x] G3: The application typechecks.
  CHECK: npm run typecheck && echo __TYPECHECK_PASSED__
  EXPECT: __TYPECHECK_PASSED__
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=31931dd27456/39 entries; EXPECT=matched; output-sha256=33663280b5c6c4d9ae7f04e3f292fefdcf674f5ac54c6582ffafda5f18d84091; output-bytes=1709

- [x] G4: The application builds successfully.
  CHECK: npm run build
  EXPECT: built in
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=31931dd27456/39 entries; EXPECT=matched; output-sha256=97d1d936705dfdf19f9aeb2b96b5ef56d875357cfaac63ec2190c4eaa5039882; output-bytes=1393

- [x] G5: The changes contain no whitespace errors.
  CHECK: git diff --check && echo __DIFF_CHECK_PASSED__
  EXPECT: __DIFF_CHECK_PASSED__
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=31931dd27456/39 entries; EXPECT=matched; output-sha256=0378ac4956e458fd506d2b41a183af50cc71501101618e0a9b6f743d83b5b2bd; output-bytes=1612
