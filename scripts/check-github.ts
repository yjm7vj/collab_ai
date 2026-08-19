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
  commitFile,
  deleteFile,
  ensureBranch,
  fileSha,
  GithubProvider,
  installationToken,
  openPullRequest,
  parseRepoRef,
  pemToPkcs8,
  refHead,
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

  console.log("\nbranch and ref resolution");
  {
    // "HEAD" makes two calls: the repo lookup for default_branch, then the
    // ref lookup against whatever branch name that returned. The stub
    // returns "trunk" specifically (not "main") so a hardcoded "main" in
    // the implementation would be caught by the second assertion.
    const seenUrls: string[] = [];
    const headStub = makeStub((url) => {
      seenUrls.push(url);
      if (seenUrls.length === 1) {
        return new Response(JSON.stringify({ default_branch: "trunk" }), { status: 200 });
      }
      return new Response(JSON.stringify({ object: { sha: "deadbeef" } }), { status: 200 });
    });
    const headRes = await refHead("test-token", { owner: "acme", repo: "widgets", ref: "HEAD" }, headStub.fetchImpl);
    check("refHead('HEAD') resolves the default branch's sha", headRes.ok === true && headRes.sha === "deadbeef", headRes);
    check("refHead('HEAD') makes two calls", headStub.state.calls === 2, headStub.state.calls);
    check(
      "the second call targets the stub's default_branch ('trunk'), not a hardcoded 'main'",
      seenUrls.length === 2 && seenUrls[1]!.includes("/heads/trunk") && !seenUrls[1]!.includes("/heads/main"),
      seenUrls,
    );

    const explicitUrls: string[] = [];
    const explicitStub = makeStub((url) => {
      explicitUrls.push(url);
      return new Response(JSON.stringify({ object: { sha: "cafef00d" } }), { status: 200 });
    });
    const explicitRes = await refHead(
      "test-token",
      { owner: "acme", repo: "widgets", ref: "main" },
      explicitStub.fetchImpl,
    );
    check("refHead with an explicit ref resolves its sha", explicitRes.ok === true && explicitRes.sha === "cafef00d", explicitRes);
    check("refHead with an explicit ref skips the repo lookup (one call)", explicitStub.state.calls === 1, explicitStub.state.calls);

    const notFound = makeStub(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const notFoundRes = await refHead("test-token", { owner: "acme", repo: "widgets", ref: "main" }, notFound.fetchImpl);
    check("refHead 404 yields ok:false", notFoundRes.ok === false, notFoundRes);
  }

  console.log("\nfile sha");
  {
    const ref = { owner: "acme", repo: "widgets", ref: "HEAD" };

    const found = makeStub(() => new Response(JSON.stringify({ sha: "abc123" }), { status: 200 }));
    const foundRes = await fileSha("test-token", ref, "docs/readme.md", "collab-ai", found.fetchImpl);
    check("200 yields the sha", foundRes.ok === true && foundRes.sha === "abc123", foundRes);

    // Missing is not failure: a 404 here just means the write that follows
    // will create the file rather than update it.
    const missing = makeStub(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const missingRes = await fileSha("test-token", ref, "docs/new.md", "collab-ai", missing.fetchImpl);
    check("404 yields ok:true with sha:null (missing, not failed)", missingRes.ok === true && missingRes.sha === null, missingRes);

    const serverError = makeStub(() => new Response("<html>boom</html>", { status: 500 }));
    const serverErrorRes = await fileSha("test-token", ref, "docs/readme.md", "collab-ai", serverError.fetchImpl);
    check("500 yields ok:false", serverErrorRes.ok === false, serverErrorRes);
  }

  console.log("\ncommit encoding");
  {
    const ref = { owner: "acme", repo: "widgets", ref: "HEAD" };
    // An emoji (well outside Latin-1) and an accented letter (just outside
    // it) — exactly the input that breaks a plain `btoa(text)`.
    const content = "café report \u{1F680} done";

    let putBody: { message?: string; branch?: string; sha?: string; content?: string } | null = null;
    const stub = makeStub((url, init) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") {
        putBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ commit: { sha: "newsha" } }), { status: 200 });
      }
      // fileSha's lookup: pretend the file is new.
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    });
    const res = await commitFile("test-token", ref, "collab-ai", "notes.txt", content, "Update notes.txt via collab_ai", stub.fetchImpl);
    check("commitFile succeeds", res.ok === true && res.commitSha === "newsha", res);

    const decoded =
      putBody && typeof putBody.content === "string"
        ? new TextDecoder().decode(Uint8Array.from(atob(putBody.content), (c) => c.charCodeAt(0)))
        : null;
    check(
      "base64 content round-trips the exact original string through UTF-8 (the bug a plain btoa introduces silently)",
      decoded === content,
      { content, decoded },
    );
  }

  console.log("\nbranch creation");
  {
    const ref = { owner: "acme", repo: "widgets", ref: "HEAD" };

    const created = makeStub(() => new Response(JSON.stringify({ ref: "refs/heads/collab-ai" }), { status: 201 }));
    const createdRes = await ensureBranch("test-token", ref, "collab-ai", "sha1", created.fetchImpl);
    check("201 yields created:true", createdRes.ok === true && createdRes.created === true, createdRes);

    const exists = makeStub(() => new Response(JSON.stringify({ message: "Reference already exists" }), { status: 422 }));
    const existsRes = await ensureBranch("test-token", ref, "collab-ai", "sha1", exists.fetchImpl);
    check("422 'already exists' yields ok:true created:false", existsRes.ok === true && existsRes.created === false, existsRes);

    const otherError = makeStub(() =>
      new Response(JSON.stringify({ message: "Validation failed: sha invalid" }), { status: 422 }),
    );
    const otherRes = await ensureBranch("test-token", ref, "collab-ai", "sha1", otherError.fetchImpl);
    check("422 for another reason yields ok:false", otherRes.ok === false, otherRes);
  }

  console.log("\nwrites respect the deny list");
  {
    const ref = { owner: "acme", repo: "widgets", ref: "HEAD" };
    const DENY = ["**/.env"];
    const neverCalled = makeStub(() => new Response("should never be reached", { status: 200 }));
    const provider = new GithubProvider("test-token", ref, DENY, "collab-ai", neverCalled.fetchImpl);

    const res = await provider.perform({ op: "write", path: ".env", content: "SECRET=1" });
    check("write to .env is refused", res.ok === false, res);
    // Same property the read path guards: a denied write must never reach
    // the network, so nothing about the attempt (not even that the room
    // tried) is observable to whatever is downstream of fetch.
    check("write to .env never calls fetch", neverCalled.state.calls === 0, neverCalled.state.calls);
  }

  console.log("\npull requests");
  {
    const ref = { owner: "acme", repo: "widgets", ref: "main" };

    const opened = makeStub(() =>
      new Response(JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/7", number: 7 }), { status: 201 }),
    );
    const openedRes = await openPullRequest("test-token", ref, "collab-ai", "main", "Title", "Body", opened.fetchImpl);
    check(
      "201 yields the html_url and number",
      openedRes.ok === true && openedRes.url.includes("/pull/7") && openedRes.number === 7,
      openedRes,
    );

    const already = makeStub(() =>
      new Response(
        JSON.stringify({ message: "A pull request already exists for acme:collab-ai." }),
        { status: 422 },
      ),
    );
    const alreadyRes = await openPullRequest("test-token", ref, "collab-ai", "main", "Title", "Body", already.fetchImpl);
    check(
      "422 existing-PR yields ok:false and names the branch",
      alreadyRes.ok === false && alreadyRes.error.includes("collab-ai"),
      alreadyRes,
    );
  }

  // NOTE ON THIS SECTION'S NAME: this used to be "provider is read-only" and
  // asserted write/edit/remove were refused. The spec for this change
  // replaces those refusals with real implementations (writes land on a
  // working branch, never on the default branch, and become a pull request
  // for a human to review) — so the old assertions describe behaviour that
  // no longer exists. Rather than leave stale checks that would always fail,
  // this section now exercises the real write/edit/remove flow end to end
  // against a stubbed GitHub API. See the final report for this deviation.
  console.log("\nprovider write/edit/remove perform real operations on a working branch");
  {
    const ref = { owner: "acme", repo: "widgets", ref: "main" };

    // write: brand-new file. fileSha's GET 404s (file doesn't exist yet), so
    // commitFile's PUT must be sent with no `sha`.
    {
      const calls: string[] = [];
      let putBody: { message?: string; branch?: string; sha?: string; content?: string } | null = null;
      const stub = makeStub((url, init) => {
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url}`);
        if (method === "GET" && url.includes("/git/ref/heads/main")) {
          return new Response(JSON.stringify({ object: { sha: "basesha" } }), { status: 200 });
        }
        if (method === "POST" && url.endsWith("/git/refs")) {
          return new Response(JSON.stringify({ ref: "refs/heads/collab-ai" }), { status: 201 });
        }
        if (method === "GET" && url.includes("/contents/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (method === "PUT") {
          putBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ commit: { sha: "commitsha1" } }), { status: 200 });
        }
        return new Response("unexpected request", { status: 500 });
      });
      const provider = new GithubProvider("test-token", ref, [], "collab-ai", stub.fetchImpl);
      const res = await provider.perform({ op: "write", path: "notes.txt", content: "hello" });
      check("write creates the branch then commits, reporting it", res.ok === true && res.data.includes("collab-ai"), res);
      check(
        "write resolves the base branch and creates the working branch before committing",
        calls.some((c) => c.includes("/git/ref/heads/main")) && calls.some((c) => c.includes("/git/refs")),
        calls,
      );
      check("write of a brand-new file sends no sha", putBody !== null && !("sha" in putBody), putBody);
    }

    // edit: reads from the *working* branch (not #ref's branch), applies the
    // unique-match-or-reject contract, then commits.
    {
      const stub = makeStub((url, init) => {
        const method = init?.method ?? "GET";
        if (method === "GET" && url.includes("/git/ref/heads/main")) {
          return new Response(JSON.stringify({ object: { sha: "basesha" } }), { status: 200 });
        }
        if (method === "POST" && url.endsWith("/git/refs")) {
          // Already exists from a prior approved edit — still success.
          return new Response(JSON.stringify({ message: "Reference already exists" }), { status: 422 });
        }
        if (method === "GET" && url.includes("/contents/") && url.includes("ref=collab-ai")) {
          return new Response(
            JSON.stringify({ sha: "filesha1", content: btoa("line one\nline two\n") }),
            { status: 200 },
          );
        }
        if (method === "PUT") {
          return new Response(JSON.stringify({ commit: { sha: "commitsha2" } }), { status: 200 });
        }
        return new Response("unexpected request", { status: 500 });
      });
      const provider = new GithubProvider("test-token", ref, [], "collab-ai", stub.fetchImpl);
      const res = await provider.perform({ op: "edit", path: "notes.txt", oldText: "line one", newText: "line ONE" });
      check("edit against a unique match succeeds", res.ok === true, res);

      const ambiguousStub = makeStub((url, init) => {
        const method = init?.method ?? "GET";
        if (method === "GET" && url.includes("/git/ref/heads/main")) {
          return new Response(JSON.stringify({ object: { sha: "basesha" } }), { status: 200 });
        }
        if (method === "POST" && url.endsWith("/git/refs")) {
          return new Response(JSON.stringify({ message: "Reference already exists" }), { status: 422 });
        }
        if (method === "GET" && url.includes("/contents/")) {
          return new Response(JSON.stringify({ sha: "filesha1", content: btoa("dup\ndup\n") }), { status: 200 });
        }
        return new Response("edit must not commit an ambiguous match", { status: 500 });
      });
      const ambiguousProvider = new GithubProvider("test-token", ref, [], "collab-ai", ambiguousStub.fetchImpl);
      const ambiguousRes = await ambiguousProvider.perform({ op: "edit", path: "notes.txt", oldText: "dup", newText: "x" });
      check("edit with an ambiguous match is refused and never commits", ambiguousRes.ok === false, ambiguousRes);

      const missingStub = makeStub((url, init) => {
        const method = init?.method ?? "GET";
        if (method === "GET" && url.includes("/git/ref/heads/main")) {
          return new Response(JSON.stringify({ object: { sha: "basesha" } }), { status: 200 });
        }
        if (method === "POST" && url.endsWith("/git/refs")) {
          return new Response(JSON.stringify({ message: "Reference already exists" }), { status: 422 });
        }
        if (method === "GET" && url.includes("/contents/")) {
          return new Response(JSON.stringify({ sha: "filesha1", content: btoa("nothing to match here\n") }), { status: 200 });
        }
        return new Response("edit must not commit a missing match", { status: 500 });
      });
      const missingProvider = new GithubProvider("test-token", ref, [], "collab-ai", missingStub.fetchImpl);
      const missingRes = await missingProvider.perform({ op: "edit", path: "notes.txt", oldText: "not present", newText: "x" });
      check("edit with no match is refused and never commits", missingRes.ok === false, missingRes);
    }

    // remove: looks up the current sha, then DELETEs with it.
    {
      const stub = makeStub((url, init) => {
        const method = init?.method ?? "GET";
        if (method === "GET" && url.includes("/git/ref/heads/main")) {
          return new Response(JSON.stringify({ object: { sha: "basesha" } }), { status: 200 });
        }
        if (method === "POST" && url.endsWith("/git/refs")) {
          return new Response(JSON.stringify({ message: "Reference already exists" }), { status: 422 });
        }
        if (method === "GET" && url.includes("/contents/")) {
          return new Response(JSON.stringify({ sha: "filesha1" }), { status: 200 });
        }
        if (method === "DELETE") {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response("unexpected request", { status: 500 });
      });
      const provider = new GithubProvider("test-token", ref, [], "collab-ai", stub.fetchImpl);
      const res = await provider.perform({ op: "remove", path: "notes.txt" });
      check("remove succeeds and reports the branch", res.ok === true && res.data.includes("collab-ai"), res);
    }
  }

  console.log("\nprovider openPr");
  {
    // ref.ref is a concrete branch, so resolving the PR base costs no
    // network call — only the POST to /pulls should happen.
    const ref = { owner: "acme", repo: "widgets", ref: "main" };
    let prBody: { base?: string; head?: string } | null = null;
    const stub = makeStub((url, init) => {
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/pulls")) {
        prBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/9", number: 9 }),
          { status: 201 },
        );
      }
      return new Response("unexpected request", { status: 500 });
    });
    const provider = new GithubProvider("test-token", ref, [], "collab-ai", stub.fetchImpl);
    const res = await provider.openPr("Room-approved changes", "Opened by collab_ai.");
    check("openPr succeeds and reports the PR number and url", res.ok === true && res.data.includes("#9"), res);
    check("openPr requests collab-ai into main", prBody !== null && prBody.head === "collab-ai" && prBody.base === "main", prBody);
    check("openPr makes exactly one call when the base is a concrete branch", stub.state.calls === 1, stub.state.calls);
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
    const listProvider = new GithubProvider("test-token", ref, DENY, "collab-ai", listStub.fetchImpl);
    const listRes = await listProvider.perform({ op: "list", path: "", depth: 0, deny: DENY });
    const listBody = listRes.ok ? listRes.data : listRes.error;
    check("list includes src/index.ts", listRes.ok === true && listBody.includes("src/index.ts"), listBody);
    check("list excludes .env", !listBody.includes(".env"), listBody);
    check("list excludes .ssh", !listBody.includes(".ssh"), listBody);

    const readStub = makeStub(() => new Response("should never be reached", { status: 200 }));
    const readProvider = new GithubProvider("test-token", ref, DENY, "collab-ai", readStub.fetchImpl);
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
    const provider = new GithubProvider("test-token", ref, [], "collab-ai", throwingStub);

    let threw = false;
    let res: Awaited<ReturnType<typeof provider.perform>> | undefined;
    try {
      res = await provider.perform({ op: "list", path: "", depth: 0, deny: [] });
    } catch {
      threw = true;
    }
    check("a throwing fetch does not propagate", !threw);
    check("a throwing fetch yields ok:false", res !== undefined && res.ok === false, res);

    const writeProvider = new GithubProvider("test-token", ref, [], "collab-ai", throwingStub);
    let writeThrew = false;
    let writeRes: Awaited<ReturnType<typeof writeProvider.perform>> | undefined;
    try {
      writeRes = await writeProvider.perform({ op: "write", path: "a.txt", content: "x" });
    } catch {
      writeThrew = true;
    }
    check("a throwing fetch on write does not propagate", !writeThrew);
    check("a throwing fetch on write yields ok:false", writeRes !== undefined && writeRes.ok === false, writeRes);
  }

  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
