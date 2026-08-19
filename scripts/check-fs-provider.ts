/**
 * Guards the host-side file provider against the leak that mattered most:
 * `search` and `list` walk the tree themselves, so neither names a path the
 * server can police before the request is sent. Without the deny globs the
 * room supplies, searching for a secret returns the contents of exactly the
 * files the deny list exists to protect, and listing names them.
 *
 * Runs the REAL client provider against a mock handle backed by a throwaway
 * folder on disk — the picker needs a native dialog no test can open, but
 * every code path below it is the shipping one.
 *
 * Run: npm run check:fs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performFsRequest } from "../src/client/workspace";
import { DEFAULT_PATH_POLICY } from "../src/shared/workspace";

/** Build a throwaway project containing exactly the things that must not leak. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "collab-fs-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "certs"));
  mkdirSync(join(dir, ".ssh"));
  const nl = "\n";
  writeFileSync(join(dir, "src/index.ts"), "export const greet = () => 'hello';" + nl);
  writeFileSync(join(dir, "README.md"), "# Demo" + nl);
  writeFileSync(join(dir, ".env"), "DB_PASSWORD=" + CANARY + nl);
  writeFileSync(join(dir, "certs/server.pem"), "-----BEGIN PRIVATE KEY-----" + nl + CANARY + nl);
  writeFileSync(join(dir, ".ssh/id_rsa"), "ssh-rsa " + CANARY + nl);
  return dir;
}

const CANARY = "CANARY-MUST-NOT-APPEAR";
const ROOT = makeFixture();

function mockDir(abs: string): any {
  return {
    kind: "directory",
    async *entries() {
      for (const name of readdirSync(abs)) {
        const p = join(abs, name);
        yield [name, statSync(p).isDirectory() ? mockDir(p) : mockFile(p)] as const;
      }
    },
    async getDirectoryHandle(name: string) {
      const p = join(abs, name);
      if (!statSync(p).isDirectory()) throw new Error("not a directory");
      return mockDir(p);
    },
    async getFileHandle(name: string) {
      const p = join(abs, name);
      if (!statSync(p).isFile()) throw new Error("not a file");
      return mockFile(p);
    },
  };
}

function mockFile(abs: string): any {
  return {
    kind: "file",
    async getFile() {
      const buf = readFileSync(abs);
      const mk = (b: Buffer): any => ({
        size: b.length,
        async text() { return b.toString("utf8"); },
        slice: (s: number, e: number) => mk(b.subarray(s, e)),
      });
      return mk(buf);
    },
  };
}

const root = mockDir(ROOT);
const DENY = [...DEFAULT_PATH_POLICY.deny];
const SECRETS = [CANARY];

let bad = 0;
const must = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) { bad++; console.log(`  LEAK ${name}${detail === undefined ? "" : " — " + JSON.stringify(detail)}`); }
  else console.log(`  ok   ${name}`);
};
const leaks = (s: string) => SECRETS.some((x) => s.includes(x));

async function main() {
  console.log("\nlisting the workspace");
  const ls = await performFsRequest(root, { op: "list", path: "", depth: 3, deny: DENY });
  const listing = ls.ok ? ls.data : ls.error;
  console.log("  " + listing.replace(/\n/g, "\n  "));
  for (const hidden of [".env", "id_rsa", "server.pem", ".ssh"]) {
    must(`listing hides ${hidden}`, !listing.includes(hidden), listing);
  }
  must("listing still shows ordinary source", listing.includes("src/index.ts"));

  console.log("\nordinary source is readable");
  const src = await performFsRequest(root, { op: "read", path: "src/index.ts", offset: 0, limit: 64000 });
  must("read src/index.ts succeeds", src.ok === true);
  must("returns real contents", src.ok === true && src.data.includes("greet"));

  console.log("\nsearch must not surface denied files");
  // CANARY is deliberately among these: a pattern that matches nothing would
  // make every assertion below pass while proving nothing at all.
  for (const pattern of [CANARY, "DB_PASSWORD", "PRIVATE KEY", "ssh-rsa"]) {
    const r = await performFsRequest(root, { op: "search", pattern, glob: "", max: 100, deny: DENY });
    const body = r.ok ? r.data : r.error;
    must(`search "${pattern}" leaks nothing`, !leaks(body), body.slice(0, 160));
  }

  console.log("\nsearch with a glob aimed straight at a secret");
  for (const glob of ["**/.env", "certs/**", ".ssh/**", "**"]) {
    const r = await performFsRequest(root, { op: "search", pattern: CANARY, glob, max: 100, deny: DENY });
    const body = r.ok ? r.data : r.error;
    must(`glob "${glob}" leaks nothing`, !leaks(body), body.slice(0, 160));
  }

  console.log("\nsearch with the deny list stripped (proves the filter is what stops it)");
  const naked = await performFsRequest(root, { op: "search", pattern: CANARY, glob: "", max: 100, deny: [] });
  const nakedBody = naked.ok ? naked.data : naked.error;
  // The control. If this does NOT leak, the fixture and the patterns have
  // drifted apart and every assertion above is passing vacuously.
  must("without the deny list it DOES leak (proves the suite is not vacuous)", leaks(nakedBody), nakedBody.slice(0, 120));

  console.log("\ntraversal out of the workspace");
  for (const p of ["../secrets.txt", "../../etc/passwd", "/etc/passwd", "a/../../b"]) {
    const r = await performFsRequest(root, { op: "read", path: p, offset: 0, limit: 1000 });
    must(`read "${p}" refused`, r.ok === false, r);
  }

  console.log("\nwrites are not enabled in this phase");
  const w = await performFsRequest(root, { op: "write", path: "src/index.ts", content: "x" });
  must("write refused", w.ok === false, w);

  rmSync(ROOT, { recursive: true, force: true });
  console.log(bad === 0 ? "\nno leaks found\n" : `\n${bad} LEAK(S)\n`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();
