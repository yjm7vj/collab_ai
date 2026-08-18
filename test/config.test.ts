/**
 * Guards the class of bug that `SELF.fetch` integration tests in
 * access.test.ts CANNOT catch: static routing configuration in
 * wrangler.jsonc.
 *
 * Those tests run against whatever config the test pool loaded at start-up;
 * they cannot tell you "this config is right", only "this config, whatever
 * it is, behaves consistently." This file reads wrangler.jsonc straight off
 * disk and asserts on the actual values, so a bad edit to the config itself
 * — the kind that once made every /api/* request bypass the Worker in
 * production — fails here even if nothing else caught it.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
// Read as a raw string at build time (Vite's `?raw` loader) rather than via
// `node:fs` at runtime. `node:fs`'s file-URL handling in this test runtime
// does not round-trip Windows drive-letter paths correctly (`file:///C:/…`
// converts back to `/C:/…`, which doesn't exist on disk), so `readFileSync`
// cannot reliably open an absolute path here. `?raw` sidesteps that
// entirely — Vite reads the file itself and inlines its exact current
// contents as a string, which is what "read wrangler.jsonc from disk" is
// actually after: the real, current file, not a copy baked in some other way.
// Typed by vite/client's ambient `declare module '*?raw'`, included via
// tsconfig.test.json.
import wranglerRaw from "../wrangler.jsonc?raw";

/**
 * wrangler.jsonc is JSON with comments (JSONC), which `JSON.parse` rejects
 * outright. This strips both line comments and block comments that fall
 * outside string literals, tracking string/escape state char-by-char so a
 * comment marker
 * inside a quoted value (or a `/` right before a closing quote) is never
 * mistaken for the start of a comment. It is deliberately not a general
 * JSONC parser — this test only ever reads this one file.
 */
function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    const next = source[i + 1];

    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      continue;
    }

    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      out += c;
      if (c === "\\") {
        // Copy the escaped character verbatim without inspecting it, so an
        // escaped quote (\") can't be mistaken for the end of the string.
        if (next !== undefined) out += next;
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }

  return out;
}

type WranglerConfig = {
  assets?: {
    run_worker_first?: string[];
    not_found_handling?: string;
  };
  durable_objects?: {
    bindings?: { name: string; class_name: string }[];
  };
  migrations?: { tag: string }[];
};

function readWranglerConfig(): WranglerConfig {
  return JSON.parse(stripJsonComments(wranglerRaw)) as WranglerConfig;
}

describe("wrangler.jsonc routing config", () => {
  const config = readWranglerConfig();

  it('run_worker_first includes "/agents/*"', () => {
    expect(config.assets?.run_worker_first).toContain("/agents/*");
  });

  // Without this exact entry, the asset server (which is also the SPA
  // fallback) answers every /api/* request itself and the Worker never sees
  // it — so /api/rooms silently stops working and no room can ever be
  // created. This precise regression shipped to production once already
  // (a routing config change made every /api/* request bypass the Worker),
  // and manual browser testing was the only thing that caught it. That is
  // exactly the failure mode this test exists to make impossible to miss.
  it('run_worker_first includes "/api/*"', () => {
    expect(config.assets?.run_worker_first).toContain("/api/*");
  });

  it('not_found_handling is "single-page-application"', () => {
    expect(config.assets?.not_found_handling).toBe("single-page-application");
  });

  it('declares a Durable Object binding named "Room"', () => {
    const bindings = config.durable_objects?.bindings ?? [];
    const roomBinding = bindings.find((b) => b.name === "Room");
    expect(roomBinding).toBeDefined();
    expect(roomBinding?.class_name).toBe("Room");
  });

  it('has a non-empty migrations array whose first tag is "v1"', () => {
    expect(Array.isArray(config.migrations)).toBe(true);
    expect(config.migrations?.length ?? 0).toBeGreaterThan(0);
    expect(config.migrations?.[0]?.tag).toBe("v1");
  });
});

/**
 * Tests must never be able to reach the real Anthropic API.
 *
 * The pool loads the local secrets file when it reads wrangler.jsonc, and on a
 * developer's machine that file holds a real, billable API key. The fake
 * bindings in vitest.config.ts exist to shadow it. If that shadowing ever stops
 * working, a future test that triggers an agent turn would spend real money
 * silently — and would behave differently in CI, where no such file exists.
 *
 * This asserts the shadowing holds rather than trusting it.
 */
describe("test secrets are fake", () => {
  it("uses the fake Anthropic key, never a real one", () => {
    expect(env.ANTHROPIC_API_KEY).toBe("test-key-not-real");
    // A real key looks like `sk-ant-...`. Anything of that shape is live.
    expect(env.ANTHROPIC_API_KEY.startsWith("sk-ant-")).toBe(false);
  });

  it("uses the fake room secret, so local and CI sign identically", () => {
    expect(env.ROOM_SECRET).toBe("test-secret-not-real-but-long-enough-to-sign-with");
  });
});
