# Gates: scalable backend foundation

OWNS: supabase/**, scripts/check-backend-schema.ts, package.json

Scope: Persist a secure, versioned Supabase control-plane schema and local configuration without pushing or deploying.

- [x] G1: The backend migration contains the complete control-plane tables and security controls.
  CHECK: npm run check:backend
  EXPECT: backend schema verification passed
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=2889e2b8141e/40 entries; EXPECT=matched; output-sha256=e1f14c33a2f78da8f6d54e36a7d60d30a8d69f0ace5f6e72f8c84dfafddbf608; output-bytes=263

- [x] G2: The existing Worker application still typechecks after the backend foundation is added.
  CHECK: npm run typecheck && echo __TYPECHECK_PASSED__
  EXPECT: __TYPECHECK_PASSED__
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=2889e2b8141e/40 entries; EXPECT=matched; output-sha256=dde38ff52cf9336bf4063f24157cc9cfddbe1ee65b1c7a6d8d2f58633ff326f3; output-bytes=1701

- [x] G3: The application build remains successful.
  CHECK: npm run build
  EXPECT: built in
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=2889e2b8141e/40 entries; EXPECT=matched; output-sha256=1363600de5548d3f50a1700d7a61a7293b977c0b4564b2fd6005079209ec5669; output-bytes=1393

- [x] G4: The working tree contains no whitespace errors in the changes.
  CHECK: git diff --check && echo __DIFF_CHECK_PASSED__
  EXPECT: __DIFF_CHECK_PASSED__
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\Govinda\Documents\collab_ai; path=2889e2b8141e/40 entries; EXPECT=matched; output-sha256=fbe9a0ebfda03ec39f5934c90cfb1517ea769d0d89c1497376ee4b207dfe9083; output-bytes=356

- [x] G5: No repository changes are pushed or deployed.
  EVIDENCE: Confirmed by local git status; local HEAD and origin/main are both 5fd371c, and no push/deploy command was executed.
