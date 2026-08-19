/**
 * Guards the GitHub App JWT/token minting, the PEM handling, repo-ref
 * parsing, and the read-only workspace provider in src/server/github.ts.
 *
 * Every network call in this suite is an injected stub — nothing here ever
 * makes a real HTTP request, so it runs offline and needs no credentials.
 *
 * Run: npm run check:github
 */
import {
  appJwt,
  GithubProvider,
  installationToken,
  parseRepoRef,
  pemToPkcs8,
  type GithubConfig,
} from "../src/server/github";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function wrapPem(base64: string, label: string): string {
  const lines = base64.match(/.{1,64}/g) ?? [base64];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join("\n");
}

/** A real PKCS#8 RSA private key, generated locally with WebCrypto — used to
 * prove appJwt/installationToken actually sign, not just to satisfy a shape
 * check. Nothing here ever leaves the process. */
async function makePkcs8Pem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  return wrapPem(arrayBufferToBase64(pkcs8), "PRIVATE KEY");
}

// The header is all pemToPkcs8 needs to reject this — the body never has to
// be a real PKCS#1 key.
const PKCS1_PEM = wrapPem(btoa("not a real key, only the header matters here"), "RSA PRIVATE KEY");

/** A stub fetch that records how many times it was called. */
function makeStub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const state = { calls: 0 };
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    state.calls++;
    return handler(String(input), init);
  }) as typeof fetch;
  return { state, fetchImpl };
}

async function main() {
  console.log("\npem handling");
  {
    const pkcs1 = pemToPkcs8(PKCS1_PEM);
    check("PKCS#1 header is rejected", pkcs1.ok === false);
    check(
      "PKCS#1 error mentions the openssl pkcs8 conversion",
      pkcs1.ok === false && pkcs1.error.includes("openssl pkcs8"),
      pkcs1,
    );

    const pkcs8Pem = await makePkcs8Pem();
    const pkcs8 = pemToPkcs8(pkcs8Pem);
    check("PKCS#8 header decodes to bytes", pkcs8.ok === true && pkcs8.bytes.length > 0, pkcs8.ok);

    const garbage = pemToPkcs8("this is not a pem at all, just some words");
    check("garbage input is rejected", garbage.ok === false, garbage);

    const empty = pemToPkcs8("");
    check("empty string is rejected", empty.ok === false, empty);
  }

  console.log("\nrepo refs");
  {
    const accepted: Array<[string, { owner: string; repo: string; ref: string }]> = [
      ["owner/repo", { owner: "owner", repo: "repo", ref: "HEAD" }],
      ["owner/repo@main", { owner: "owner", repo: "repo", ref: "main" }],
      // Slashes are legal in refs (e.g. "feature/x").
      ["owner/repo@feature/x", { owner: "owner", repo: "repo", ref: "feature/x" }],
    ];
    for (const [input, expected] of accepted) {
      const got = parseRepoRef(input);
      check(`parses ${JSON.stringify(input)}`, JSON.stringify(got) === JSON.stringify(expected), got);
    }

    const rejected: unknown[] = [
      "",
      "owner",
      "owner/repo@..",
      "own er/repo",
      "owner/repo@a/../b",
      42,
      null,
      "a".repeat(200) + "/repo",
    ];
    for (const input of rejected) {
      const got = parseRepoRef(input);
      check(`rejects ${JSON.stringify(input)}`, got === null, got);
    }
  }

  console.log("\ninstallation token");
  {
    const cfg: GithubConfig = { appId: "app-123", privateKeyPem: await makePkcs8Pem() };

    // Sanity check that appJwt itself can sign with the generated key before
    // trusting the installationToken tests that depend on it.
    const jwt = await appJwt(cfg);
    check("appJwt produces a three-part JWT", jwt.split(".").length === 3, jwt);

    const created = makeStub(() =>
      new Response(JSON.stringify({ token: "ghs_abc123", expires_at: "2026-01-01T00:00:00Z" }), { status: 201 }),
    );
    const createdRes = await installationToken(cfg, "999", created.fetchImpl);
    check(
      "201 with a token yields ok:true and the token",
      createdRes.ok === true && createdRes.token === "ghs_abc123",
      createdRes,
    );

    const notFound = makeStub(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const notFoundRes = await installationToken(cfg, "999", notFound.fetchImpl);
    check(
      "404 with a JSON message yields ok:false containing that message",
      notFoundRes.ok === false && notFoundRes.error.includes("Not Found"),
      notFoundRes,
    );

    const serverError = makeStub(() => new Response("<html>internal error</html>", { status: 500 }));
    let threw = false;
    let serverErrorRes: Awaited<ReturnType<typeof installationToken>> | undefined;
    try {
      serverErrorRes = await installationToken(cfg, "999", serverError.fetchImpl);
    } catch {
      threw = true;
    }
    check("500 with a non-JSON body does not throw", !threw);
    check(
      "500 with a non-JSON body still yields ok:false",
      serverErrorRes !== undefined && serverErrorRes.ok === false,
      serverErrorRes,
    );
  }

  console.log("\nprovider is read-only");
  {
    const ref = { owner: "acme", repo: "widgets", ref: "HEAD" };
    const neverCalled = makeStub(() => new Response("should never be reached", { status: 200 }));
    const provider = new GithubProvider("test-token", ref, [], neverCalled.fetchImpl);

    const w = await provider.perform({ op: "write", path: "a.txt", content: "x" });
    check("write refused, mentions read-only", w.ok === false && w.error.toLowerCase().includes("read-only"), w);

    const e = await provider.perform({ op: "edit", path: "a.txt", oldText: "a", newText: "b" });
    check("edit refused, mentions read-only", e.ok === false && e.error.toLowerCase().includes("read-only"), e);

    const r = await provider.perform({ op: "remove", path: "a.txt" });
    check("remove refused, mentions read-only", r.ok === false && r.error.toLowerCase().includes("read-only"), r);
  }

  console.log("\nprovider honours the deny list");
  {
    const ref = { owner: "acme", repo: "widgets", ref: "HEAD" };
    const DENY = ["**/.env", "**/.ssh/**"];

    const listStub = makeStub(() =>
      new Response(
        JSON.stringify([
          { name: ".env", path: ".env", type: "file" },
          { name: "index.ts", path: "src/index.ts", type: "file" },
          { name: ".ssh", path: ".ssh", type: "dir" },
        ]),
        { status: 200 },
      ),
    );
    const listProvider = new GithubProvider("test-token", ref, DENY, listStub.fetchImpl);
    const listRes = await listProvider.perform({ op: "list", path: "", depth: 0, deny: DENY });
    const listBody = listRes.ok ? listRes.data : listRes.error;
    check("list includes src/index.ts", listRes.ok === true && listBody.includes("src/index.ts"), listBody);
    check("list excludes .env", !listBody.includes(".env"), listBody);
    check("list excludes .ssh", !listBody.includes(".ssh"), listBody);

    const readStub = makeStub(() => new Response("should never be reached", { status: 200 }));
    const readProvider = new GithubProvider("test-token", ref, DENY, readStub.fetchImpl);
    const readRes = await readProvider.perform({ op: "read", path: ".env", offset: 0, limit: 1000 });
    check("read of .env is refused", readRes.ok === false, readRes);
    // This is the property that actually matters: a denied path must never
    // become a network call. If the refusal happened only after fetching,
    // a compromised or merely logging fetch layer downstream would still
    // have seen the file's contents on the wire before the answer was
    // discarded — so the assertion is on the stub's call count, not just
    // on the response shape.
    check("read of .env never calls fetch", readStub.state.calls === 0, readStub.state.calls);
  }

  console.log("\nprovider never throws");
  {
    const ref = { owner: "acme", repo: "widgets", ref: "HEAD" };
    const throwingStub = (async () => {
      throw new Error("network exploded");
    }) as typeof fetch;
    const provider = new GithubProvider("test-token", ref, [], throwingStub);

    let threw = false;
    let res: Awaited<ReturnType<typeof provider.perform>> | undefined;
    try {
      res = await provider.perform({ op: "list", path: "", depth: 0, deny: [] });
    } catch {
      threw = true;
    }
    check("a throwing fetch does not propagate", !threw);
    check("a throwing fetch yields ok:false", res !== undefined && res.ok === false, res);
  }

  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
