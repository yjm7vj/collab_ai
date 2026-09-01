/**
 * Guard checks for the workspace path policy — the only thing standing
 * between a crafted path from the model or a room member and a file outside
 * the workspace, or a secret inside it.
 *
 * Run: npx esbuild scripts/check-workspace.ts --bundle --format=esm --platform=node --outfile=node_modules/.cache/check-workspace.mjs --log-level=warning && node node_modules/.cache/check-workspace.mjs
 */
import {
  DEFAULT_DENY,
  DEFAULT_PATH_POLICY,
  FS_LIMITS,
  clampRequest,
  findUniqueText,
  matchGlob,
  normalizePath,
  pathDecision,
  sanitizePathPolicy,
  type FsRequest,
} from "../src/shared/workspace";
import { MockProvider, PendingRequests } from "../src/server/workspace";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

console.log("\npath normalisation — accepts");
check('"" normalises to ""', normalizePath("") === "", normalizePath(""));
check('"." normalises to ""', normalizePath(".") === "", normalizePath("."));
check('"./" normalises to ""', normalizePath("./") === "", normalizePath("./"));
check(
  '"src/index.ts" is unchanged',
  normalizePath("src/index.ts") === "src/index.ts",
  normalizePath("src/index.ts"),
);
check(
  '"src\\\\index.ts" normalises to "src/index.ts"',
  normalizePath("src\\index.ts") === "src/index.ts",
  normalizePath("src\\index.ts"),
);
check('"a//b" collapses to "a/b"', normalizePath("a//b") === "a/b", normalizePath("a//b"));
check('"a/./b" collapses to "a/b"', normalizePath("a/./b") === "a/b", normalizePath("a/./b"));
check('"a/b/" strips trailing slash to "a/b"', normalizePath("a/b/") === "a/b", normalizePath("a/b/"));
check('"./a/b" collapses to "a/b"', normalizePath("./a/b") === "a/b", normalizePath("./a/b"));

console.log("\nexact edit matching");
const uniqueMatch = findUniqueText("before\n#rebind(uid: string)\nafter", "#rebind");
check("a unique short span is accepted", uniqueMatch.ok && uniqueMatch.index === 7, uniqueMatch);
check("an empty span is rejected explicitly", findUniqueText("text", "").reason === "empty");
check("a missing span is rejected", findUniqueText("text", "missing").reason === "missing");
check("a duplicated span is rejected", findUniqueText("dup\ndup", "dup").reason === "ambiguous");

console.log("\npath normalisation — rejects");
const rejects: unknown[] = [
  "../etc/passwd",
  "a/../../b",
  "a/..",
  "..",
  "/etc/passwd",
  "\\etc\\passwd",
  "C:/Windows",
  "c:x",
  "//server/share",
  "\\\\server\\share",
  "a/\u0000b",
  42,
  null,
  undefined,
  {},
  [],
  true,
];
for (const input of rejects) {
  check(`${JSON.stringify(input)} normalises to null`, normalizePath(input) === null, normalizePath(input));
}

// "...." is a literal four-dot segment, not a ".." traversal segment, so it is
// not special-cased — the only thing rejected is a segment that is *exactly*
// "..". A directory or file that happens to be named "...." stays inside the
// workspace: it is never interpreted as "go up", so nothing escapes the root.
check(
  '"....//etc" is not a traversal, normalises to "..../etc"',
  normalizePath("....//etc") === "..../etc",
  normalizePath("....//etc"),
);
check(
  '"a/....//b" is not a traversal, normalises to "a/..../b"',
  normalizePath("a/....//b") === "a/..../b",
  normalizePath("a/....//b"),
);

console.log("\nglob matching");
check('"**/*.pem" matches "key.pem"', matchGlob("**/*.pem", "key.pem"));
check('"**/*.pem" matches "certs/key.pem"', matchGlob("**/*.pem", "certs/key.pem"));
check('"**/*.pem" matches "a/b/c/key.pem"', matchGlob("**/*.pem", "a/b/c/key.pem"));
check('"*.ts" matches "index.ts"', matchGlob("*.ts", "index.ts"));
check('"*.ts" does not match "src/index.ts"', !matchGlob("*.ts", "src/index.ts"));
check('"**/.ssh/**" matches ".ssh/id_rsa"', matchGlob("**/.ssh/**", ".ssh/id_rsa"));
check('"**/.ssh/**" matches "home/user/.ssh/config"', matchGlob("**/.ssh/**", "home/user/.ssh/config"));
check('"src/**" matches "src/a.ts"', matchGlob("src/**", "src/a.ts"));
check('"src/**" matches "src/a/b.ts"', matchGlob("src/**", "src/a/b.ts"));
check('"src/**" does not match "test/a.ts"', !matchGlob("src/**", "test/a.ts"));
check('"?.ts" matches "a.ts"', matchGlob("?.ts", "a.ts"));
check('"?.ts" does not match "ab.ts"', !matchGlob("?.ts", "ab.ts"));
check('"**/*.PEM" matches "key.pem" (case-insensitive)', matchGlob("**/*.PEM", "key.pem"));
check('"**/*.pem" matches "KEY.PEM" (case-insensitive)', matchGlob("**/*.pem", "KEY.PEM"));
check('"a+b.txt" matches "a+b.txt" (literal +)', matchGlob("a+b.txt", "a+b.txt"));
check('"a+b.txt" does not match "aab.txt"', !matchGlob("a+b.txt", "aab.txt"));

console.log("\ndefault deny list");
const denied = [
  ".env",
  "app/.env.production",
  ".dev.vars",
  "certs/server.pem",
  "id_rsa",
  ".ssh/id_ed25519",
  ".aws/credentials",
  ".git/config",
  ".npmrc",
  ".git/credentials",
  ".git-credentials",
  "service-account-key.json",
];
for (const p of denied) {
  check(`"${p}" is denied by DEFAULT_PATH_POLICY`, pathDecision(DEFAULT_PATH_POLICY, p, false) === "deny");
}
// Opened up deliberately: git history and dependency source are legitimately
// useful to read. The credential-bearing files inside .git stay denied above,
// which is the whole reason .git could be opened at all.
for (const p of [
  ".git/HEAD",
  ".git/refs/heads/main",
  ".git/logs/HEAD",
  "node_modules/left-pad/index.js",
  "node_modules/.bin/tsc",
]) {
  check(`"${p}" is readable`, pathDecision(DEFAULT_PATH_POLICY, p, false) === "allow", pathDecision(DEFAULT_PATH_POLICY, p, false));
}

check(
  '"src/index.ts" is not denied',
  pathDecision(DEFAULT_PATH_POLICY, "src/index.ts", false) !== "deny",
  pathDecision(DEFAULT_PATH_POLICY, "src/index.ts", false),
);
check(
  '"README.md" is not denied',
  pathDecision(DEFAULT_PATH_POLICY, "README.md", false) !== "deny",
  pathDecision(DEFAULT_PATH_POLICY, "README.md", false),
);

console.log("\nreads versus writes");
check(
  'reading "src/index.ts" is "allow"',
  pathDecision(DEFAULT_PATH_POLICY, "src/index.ts", false) === "allow",
  pathDecision(DEFAULT_PATH_POLICY, "src/index.ts", false),
);
// A path only matched by an allow rule is readable but not automatically
// writable — a write there must still be voted on.
check(
  'writing "src/index.ts" is "ask", not "allow"',
  pathDecision(DEFAULT_PATH_POLICY, "src/index.ts", true) === "ask",
  pathDecision(DEFAULT_PATH_POLICY, "src/index.ts", true),
);
check(
  'reading a denied path is "deny"',
  pathDecision(DEFAULT_PATH_POLICY, ".env", false) === "deny",
  pathDecision(DEFAULT_PATH_POLICY, ".env", false),
);
check(
  'writing a denied path is "deny"',
  pathDecision(DEFAULT_PATH_POLICY, ".env", true) === "deny",
  pathDecision(DEFAULT_PATH_POLICY, ".env", true),
);
check(
  'reading a traversal path is "deny", never "ask"',
  pathDecision(DEFAULT_PATH_POLICY, "../x", false) === "deny",
  pathDecision(DEFAULT_PATH_POLICY, "../x", false),
);
check(
  'writing a traversal path is "deny", never "ask"',
  pathDecision(DEFAULT_PATH_POLICY, "../x", true) === "deny",
  pathDecision(DEFAULT_PATH_POLICY, "../x", true),
);

console.log("\npolicy sanitisation");
for (const bad of [null, {}, 42]) {
  const p = sanitizePathPolicy(bad);
  check(
    `sanitizePathPolicy(${JSON.stringify(bad)}) contains every DEFAULT_DENY entry`,
    DEFAULT_DENY.every((g) => p.deny.includes(g)),
    p.deny,
  );
}

// A client cannot shrink the deny list by sending an empty array for it.
const shrunk = sanitizePathPolicy({ deny: [] });
check(
  "sanitizePathPolicy({deny: []}) still contains every DEFAULT_DENY entry",
  DEFAULT_DENY.every((g) => shrunk.deny.includes(g)),
  shrunk.deny,
);

const extended = sanitizePathPolicy({ deny: ["custom/**"] });
check(
  "sanitizePathPolicy({deny: ['custom/**']}) keeps the custom entry",
  extended.deny.includes("custom/**"),
  extended.deny,
);
check(
  "sanitizePathPolicy({deny: ['custom/**']}) also keeps every default",
  DEFAULT_DENY.every((g) => extended.deny.includes(g)),
  extended.deny,
);

const dropped = sanitizePathPolicy({ deny: [123, "ok", "x".repeat(201), "y".repeat(199)] });
check(
  "non-string and over-long deny entries are dropped, valid ones kept",
  dropped.deny.includes("ok") && dropped.deny.includes("y".repeat(199)) &&
    !dropped.deny.includes("x".repeat(201)) &&
    !(dropped.deny as unknown[]).includes(123),
  dropped.deny.filter((d) => !DEFAULT_DENY.includes(d)),
);

const badFallback = sanitizePathPolicy({ fallback: "nonsense" });
check(
  'sanitizePathPolicy({fallback: "nonsense"}) falls back to "ask"',
  badFallback.fallback === "ask",
  badFallback.fallback,
);

const okFallback = sanitizePathPolicy({ fallback: "deny" });
check(
  'sanitizePathPolicy({fallback: "deny"}) keeps a valid fallback',
  okFallback.fallback === "deny",
  okFallback.fallback,
);

const nonArrayAllow = sanitizePathPolicy({ allow: "not-an-array" });
check(
  "sanitizePathPolicy with a non-array allow falls back to the default allow",
  nonArrayAllow.allow.length === DEFAULT_PATH_POLICY.allow.length &&
    nonArrayAllow.allow.every((g, i) => g === DEFAULT_PATH_POLICY.allow[i]),
  nonArrayAllow.allow,
);

console.log("\nrequest clamping");
{
  const listDeep = clampRequest({ op: "list", path: "src", depth: 99 });
  check(
    "list depth of 99 clamps to FS_LIMITS.listDepth",
    listDeep.op === "list" && listDeep.depth === FS_LIMITS.listDepth,
    listDeep,
  );

  const listNeg = clampRequest({ op: "list", path: "src", depth: -5 });
  check("list depth of -5 clamps to 0", listNeg.op === "list" && listNeg.depth === 0, listNeg);

  const readBig = clampRequest({ op: "read", path: "a", offset: 0, limit: 10_000_000 });
  check(
    "read limit of 10_000_000 clamps to FS_LIMITS.readBytes",
    readBig.op === "read" && readBig.limit === FS_LIMITS.readBytes,
    readBig,
  );

  const readZero = clampRequest({ op: "read", path: "a", offset: 0, limit: 0 });
  check("read limit of 0 clamps to 1", readZero.op === "read" && readZero.limit === 1, readZero);

  const readNegOffset = clampRequest({ op: "read", path: "a", offset: -1, limit: 10 });
  check(
    "read offset of -1 clamps to 0",
    readNegOffset.op === "read" && readNegOffset.offset === 0,
    readNegOffset,
  );

  const searchBig = clampRequest({ op: "search", pattern: "x", glob: "", max: 9999 });
  check(
    "search max of 9999 clamps to FS_LIMITS.searchMatches",
    searchBig.op === "search" && searchBig.max === FS_LIMITS.searchMatches,
    searchBig,
  );

  const nanDepth = clampRequest({ op: "list", path: "a", depth: Number.NaN });
  check(
    "NaN list depth does not produce NaN",
    nanDepth.op === "list" && Number.isFinite(nanDepth.depth),
    nanDepth,
  );

  const undefLimit = clampRequest({ op: "read", path: "a", offset: 0, limit: undefined } as unknown as FsRequest);
  check(
    "undefined read limit does not produce NaN, clamps to the maximum",
    undefLimit.op === "read" && undefLimit.limit === FS_LIMITS.readBytes,
    undefLimit,
  );

  const stringMax = clampRequest({ op: "search", pattern: "x", glob: "", max: "lots" } as unknown as FsRequest);
  check(
    "string search max does not produce NaN, clamps to the maximum",
    stringMax.op === "search" && stringMax.max === FS_LIMITS.searchMatches,
    stringMax,
  );

  const stringOffset = clampRequest(
    { op: "read", path: "a", offset: "neg", limit: 10 } as unknown as FsRequest,
  );
  check(
    "string read offset does not produce NaN, clamps to 0",
    stringOffset.op === "read" && stringOffset.offset === 0,
    stringOffset,
  );
}

/** Narrow an FsResponse to its success payload, or null on failure. */
function dataOf(res: { ok: boolean; data?: string; error?: string }): string | null {
  return res.ok ? res.data ?? null : null;
}

async function main() {
  console.log("\npending requests");
  {
    const pr = new PendingRequests();
    const opened = pr.open(FS_LIMITS.timeoutMs);
    pr.settle(opened.id, { ok: true, data: "hello" });
    const res = await opened.promise;
    check("open then settle resolves with the settled value", dataOf(res) === "hello", res);

    let threw = false;
    try {
      pr.settle("unknown-id", { ok: true, data: "x" });
    } catch {
      threw = true;
    }
    check("settling an unknown id is a no-op and does not throw", !threw);

    const pr2 = new PendingRequests();
    const twice = pr2.open(FS_LIMITS.timeoutMs);
    pr2.settle(twice.id, { ok: true, data: "first" });
    pr2.settle(twice.id, { ok: false, error: "second settle should be ignored" });
    const res2 = await twice.promise;
    check(
      "settling the same id twice is a no-op the second time",
      dataOf(res2) === "first",
      res2,
    );

    const pr3 = new PendingRequests();
    const a = pr3.open(FS_LIMITS.timeoutMs);
    const b = pr3.open(FS_LIMITS.timeoutMs);
    check("size counts outstanding requests before they settle", pr3.size === 2, pr3.size);
    pr3.failAll("boom");
    const [ra, rb] = await Promise.all([a.promise, b.promise]);
    check(
      "failAll resolves outstanding requests with ok:false",
      ra.ok === false && rb.ok === false,
      [ra, rb],
    );
    check("failAll empties the map", pr3.size === 0, pr3.size);

    // A very short timeout so this check runs fast rather than waiting out
    // FS_LIMITS.timeoutMs.
    const pr4 = new PendingRequests();
    const neverSettled = pr4.open(20);
    let settledRejected = false;
    let timeoutResult: { ok: boolean } | null = null;
    try {
      timeoutResult = await neverSettled.promise;
    } catch {
      settledRejected = true;
    }
    check(
      "a request that is never settled resolves (not rejects) with ok:false after its timeout",
      !settledRejected && timeoutResult !== null && timeoutResult.ok === false,
      timeoutResult,
    );
    check("no promise from PendingRequests rejects", !settledRejected);
  }

  console.log("\nmock provider");
  {
    const files: Record<string, string> = {
      "readme.md": "hello world\nsecond line\nHELLO again",
      "src/index.ts": "export const x = 1;",
      "src/util.ts": "export function util() {}",
      "src/deep/a.ts": "// a",
      "src/deep/more/b.ts": "// b",
      "notes.txt": "just some notes",
    };
    const mp = new MockProvider(files);

    const readKnown = await mp.perform({ op: "read", path: "readme.md", offset: 0, limit: 1000 });
    check(
      "read of a known file returns its contents",
      dataOf(readKnown) === files["readme.md"],
      readKnown,
    );

    const readUnknown = await mp.perform({ op: "read", path: "nope.txt", offset: 0, limit: 1000 });
    check("read of an unknown file returns ok:false", readUnknown.ok === false, readUnknown);

    const readSliced = await mp.perform({ op: "read", path: "readme.md", offset: 6, limit: 5 });
    check("read honours offset and limit", dataOf(readSliced) === "world", readSliced);

    const listDepth0 = await mp.perform({ op: "list", path: "src", depth: 0 });
    const depth0Entries = (dataOf(listDepth0) ?? "").split("\n").filter(Boolean).sort();
    check(
      "list respects depth and returns only direct children at depth 0",
      depth0Entries.join(",") === ["src/index.ts", "src/util.ts"].sort().join(","),
      depth0Entries,
    );

    const listDepth2 = await mp.perform({ op: "list", path: "src", depth: 2 });
    check(
      "list respects a deeper depth and returns entries under the given path",
      (dataOf(listDepth2) ?? "").includes("src/deep/more/b.ts"),
      listDepth2,
    );

    const manyFiles: Record<string, string> = {};
    for (let i = 0; i < FS_LIMITS.listEntries + 10; i++) manyFiles[`bulk/f${i}.txt`] = "x";
    const mpBig = new MockProvider(manyFiles);
    const listBig = await mpBig.perform({ op: "list", path: "bulk", depth: 0 });
    const bigLines = (dataOf(listBig) ?? "").split("\n");
    check(
      "list truncates at FS_LIMITS.listEntries and says how many were hidden",
      bigLines.length === FS_LIMITS.listEntries + 1 && bigLines.at(-1) === "(10 more entries not shown)",
      bigLines.at(-1),
    );

    const search1 = await mp.perform({ op: "search", pattern: "hello", glob: "", max: 100 });
    const search1Data = dataOf(search1) ?? "";
    check(
      "search finds a substring case-insensitively",
      search1Data.includes("readme.md:1:") && search1Data.includes("readme.md:3:"),
      search1,
    );

    const searchMax = await mp.perform({ op: "search", pattern: "e", glob: "", max: 2 });
    check(
      "search respects max",
      (dataOf(searchMax) ?? "").split("\n").filter(Boolean).length === 2,
      searchMax,
    );

    const searchGlob = await mp.perform({ op: "search", pattern: "export", glob: "src/*.ts", max: 100 });
    const searchGlobData = dataOf(searchGlob) ?? "";
    check(
      "search with a glob only returns matching paths",
      searchGlobData.includes("src/index.ts") &&
        searchGlobData.includes("src/util.ts") &&
        !searchGlobData.includes("src/deep"),
      searchGlob,
    );

    const editOk = await mp.perform({
      op: "edit",
      path: "notes.txt",
      oldText: "some notes",
      newText: "great notes",
    });
    check("edit replaces a unique span", editOk.ok === true, editOk);
    const afterEdit = await mp.perform({ op: "read", path: "notes.txt", offset: 0, limit: 1000 });
    check("the edit actually changed the file", dataOf(afterEdit) === "just great notes", afterEdit);

    const editMissing = await mp.perform({
      op: "edit",
      path: "notes.txt",
      oldText: "does not exist",
      newText: "x",
    });
    check("edit rejects when the span is missing", editMissing.ok === false, editMissing);

    await mp.perform({ op: "write", path: "dup.txt", content: "aa bb aa" });
    const editDup = await mp.perform({ op: "edit", path: "dup.txt", oldText: "aa", newText: "zz" });
    check("edit rejects when the span appears more than once", editDup.ok === false, editDup);

    const writeNew = await mp.perform({ op: "write", path: "fresh.txt", content: "brand new" });
    check("write succeeds", writeNew.ok === true, writeNew);
    const readAfterWrite = await mp.perform({ op: "read", path: "fresh.txt", offset: 0, limit: 1000 });
    check(
      "write then read returns the written contents",
      dataOf(readAfterWrite) === "brand new",
      readAfterWrite,
    );

    const removeOk = await mp.perform({ op: "remove", path: "fresh.txt" });
    check("remove succeeds", removeOk.ok === true, removeOk);
    const readAfterRemove = await mp.perform({ op: "read", path: "fresh.txt", offset: 0, limit: 1000 });
    check("remove then read returns ok:false", readAfterRemove.ok === false, readAfterRemove);
  }

  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

/**
 * A search names no single path, so it is the one operation the server cannot
 * police before the request leaves. These checks guard the compensating
 * control: the deny globs always travel with the request.
 */
console.log("\nsearch carries the deny list");
{
  const withDeny = clampRequest({
    op: "search", pattern: "x", glob: "", max: 10, deny: ["**/.env"],
  });
  check(
    "an explicit deny list survives clamping",
    withDeny.op === "search" && withDeny.deny.includes("**/.env"),
    withDeny,
  );

  // A frame that omits or corrupts `deny` must not produce a search that reads
  // everything — it falls back to the full default list.
  for (const bad of [undefined, null, "nope", 42, {}] as unknown[]) {
    const r = clampRequest({
      op: "search", pattern: "x", glob: "", max: 10, deny: bad as string[],
    });
    check(
      `deny of ${JSON.stringify(bad)} falls back to the defaults`,
      r.op === "search" && DEFAULT_DENY.every((d) => r.deny.includes(d)),
      r.op === "search" ? r.deny.length : r,
    );
  }

  const mixed = clampRequest({
    op: "search", pattern: "x", glob: "", max: 10,
    deny: ["**/.env", 7 as unknown as string, null as unknown as string],
  });
  check(
    "non-string entries are dropped rather than poisoning the list",
    mixed.op === "search" && mixed.deny.every((d) => typeof d === "string"),
    mixed,
  );
}
