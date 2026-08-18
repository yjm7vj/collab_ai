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
  matchGlob,
  normalizePath,
  pathDecision,
  sanitizePathPolicy,
} from "../src/shared/workspace";

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

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
