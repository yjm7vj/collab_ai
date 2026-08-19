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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync, existsSync } from "node:fs";
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

/**
 * `writable` controls what queryPermission reports.
 *
 * This matters more than it looks. An earlier version of this mock had no
 * permission methods at all, so the provider's `hasWritePermission` call threw
 * a TypeError, the outer catch turned it into a generic failure, and the
 * "write refused" assertion passed — while testing nothing but the mock's own
 * incompleteness. A read-only workspace and a broken handle must not be
 * indistinguishable to this suite.
 */
function mockDir(abs: string, writable: boolean): any {
  return {
    kind: "directory",
    async queryPermission(d?: { mode?: string }) {
      if (d?.mode === "readwrite") return writable ? "granted" : "denied";
      return "granted";
    },
    async requestPermission(d?: { mode?: string }) {
      if (d?.mode === "readwrite") return writable ? "granted" : "denied";
      return "granted";
    },
    async *entries() {
      for (const name of readdirSync(abs)) {
        const p = join(abs, name);
        yield [
          name,
          statSync(p).isDirectory() ? mockDir(p, writable) : mockFile(p),
        ] as const;
      }
    },
    async getDirectoryHandle(name: string) {
      const p = join(abs, name);
      if (!statSync(p).isDirectory()) throw new Error("not a directory");
      return mockDir(p, writable);
    },
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      const p = join(abs, name);
      if (opts?.create && !existsSync(p)) writeFileSync(p, "");
      if (!statSync(p).isFile()) throw new Error("not a file");
      return mockFile(p);
    },
    async removeEntry(name: string) {
      rmSync(join(abs, name), { force: true });
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
    async createWritable() {
      let acc = "";
      return {
        async write(chunk: unknown) { acc += String(chunk); },
        async close() { writeFileSync(abs, acc); },
      };
    },
  };
}

const root = mockDir(ROOT, false);
const writableRoot = mockDir(ROOT, true);
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

  console.log("\nwrites on a read-only workspace");
  const ro = await performFsRequest(root, { op: "write", path: "src/index.ts", content: "x", deny: DENY });
  must("refused", ro.ok === false, ro);
  // The exact message matters: it distinguishes "you shared this read-only"
  // from any other failure, which is the whole point of the earlier fix.
  must(
    "refused for the right reason, not a broken handle",
    ro.ok === false && ro.error.includes("read-only"),
    ro,
  );
  must(
    "and the file on disk is untouched",
    readFileSync(join(ROOT, "src/index.ts"), "utf8").includes("greet"),
  );

  console.log("\nwrites on a writable workspace");
  const okw = await performFsRequest(writableRoot, {
    op: "write", path: "src/new.ts", content: "export const added = 1;\n",
  });
  must("write succeeds", okw.ok === true, okw);
  must(
    "and the bytes actually reached disk",
    existsSync(join(ROOT, "src/new.ts")) &&
      readFileSync(join(ROOT, "src/new.ts"), "utf8").includes("added"),
  );

  const ed = await performFsRequest(writableRoot, {
    op: "edit", path: "src/new.ts", oldText: "added = 1", newText: "added = 2", deny: DENY,
  });
  must("edit applies a unique span", ed.ok === true, ed);
  must(
    "edit changed the file",
    readFileSync(join(ROOT, "src/new.ts"), "utf8").includes("added = 2"),
  );

  const missing = await performFsRequest(writableRoot, {
    op: "edit", path: "src/new.ts", oldText: "not-present-anywhere", newText: "x", deny: DENY,
  });
  must("edit refuses a span that is not there", missing.ok === false, missing);

  const rm = await performFsRequest(writableRoot, { op: "remove", path: "src/new.ts", deny: DENY });
  must("remove succeeds", rm.ok === true, rm);
  must("and the file is gone", !existsSync(join(ROOT, "src/new.ts")));

  console.log("\nwrites cannot reach a denied path even when writable");
  const denied = await performFsRequest(writableRoot, {
    op: "write", path: ".env", content: "OWNED=1", deny: DENY,
  });
  must("write to .env refused", denied.ok === false, denied);
  must(
    "and .env still holds its original contents",
    readFileSync(join(ROOT, ".env"), "utf8").includes(CANARY),
  );

  rmSync(ROOT, { recursive: true, force: true });
  console.log(bad === 0 ? "\nno leaks found\n" : `\n${bad} LEAK(S)\n`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();
