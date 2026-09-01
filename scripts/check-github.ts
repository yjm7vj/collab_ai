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
  appSlug,
  appJwt,
  commitFile,
  deleteFile,
  ensureBranch,
  fileSha,
  GithubProvider,
  installationToken,
  openPullRequest,
  listInstallationRepos,
  listUserInstallations,
  listUserRepos,
  parseRepoRef,
  pemToPkcs8,
  refHead,
  repoAccess,
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

    const appInfo = makeStub(() =>
      new Response(JSON.stringify({ slug: "huddle-ai" }), { status: 200 }),
    );
    const slugRes = await appSlug(cfg, appInfo.fetchImpl);
    check("appSlug reads the authenticated App slug", slugRes.ok === true && slugRes.slug === "huddle-ai", slugRes);

    const malformedAppInfo = makeStub(() =>
      new Response(JSON.stringify({ slug: "../../not-a-slug" }), { status: 200 }),
    );
    const malformedSlugRes = await appSlug(cfg, malformedAppInfo.fetchImpl);
    check("appSlug rejects malformed slugs", malformedSlugRes.ok === false, malformedSlugRes);

    const userInstallations = makeStub(() => new Response(JSON.stringify({
      total_count: 1,
      installations: [{
        id: 158090581,
        target_type: "User",
        account: { id: 42, login: "octocat" },
      }],
    }), { status: 200 }));
    const userInstallationsRes = await listUserInstallations("user-token", userInstallations.fetchImpl);
    check(
      "listUserInstallations maps installations accessible to the user",
      userInstallationsRes.ok === true
        && userInstallationsRes.installations[0]?.id === "158090581"
        && userInstallationsRes.installations[0]?.accountId === "42",
      userInstallationsRes,
    );

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

  console.log("\nrepository access");
  {
    // The whole point of this call: a repository that reads perfectly but
    // cannot be pushed to. Every field below is what GitHub actually returns
    // for a read-only grant, and `canPush` is the one bit that separates it
    // from a writable one.
    const readOnly = makeStub(() =>
      new Response(
        JSON.stringify({ default_branch: "trunk", permissions: { admin: false, push: false, pull: true } }),
        { status: 200 },
      ),
    );
    const readOnlyRes = await repoAccess("test-token", { owner: "acme", repo: "widgets", ref: "HEAD" }, readOnly.fetchImpl);
    check(
      "a repository with permissions.push false reports canPush false",
      readOnlyRes.ok === true && readOnlyRes.access.canPush === false,
      readOnlyRes,
    );
    check(
      "the default branch comes back alongside it",
      readOnlyRes.ok === true && readOnlyRes.access.defaultBranch === "trunk",
      readOnlyRes,
    );

    const writable = makeStub(() =>
      new Response(
        JSON.stringify({ default_branch: "main", permissions: { admin: false, push: true, pull: true } }),
        { status: 200 },
      ),
    );
    const writableRes = await repoAccess("test-token", { owner: "acme", repo: "widgets", ref: "HEAD" }, writable.fetchImpl);
    check(
      "a repository with permissions.push true reports canPush true",
      writableRes.ok === true && writableRes.access.canPush === true,
      writableRes,
    );

    // A response carrying no permissions block at all is the shape that
    // matters most here: reading it as "may push" would put the room straight
    // back to discovering the truth at commit time.
    const noPermissions = makeStub(() =>
      new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }),
    );
    const noPermissionsRes = await repoAccess(
      "test-token",
      { owner: "acme", repo: "widgets", ref: "HEAD" },
      noPermissions.fetchImpl,
    );
    check(
      "an absent permissions block reports canPush false, never true",
      noPermissionsRes.ok === true && noPermissionsRes.access.canPush === false,
      noPermissionsRes,
    );

    // The exact 403 an App installation returns when it holds Contents:Read.
    const forbidden = makeStub(() =>
      new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 }),
    );
    const forbiddenRes = await repoAccess("test-token", { owner: "acme", repo: "widgets", ref: "HEAD" }, forbidden.fetchImpl);
    check(
      "a 403 yields ok:false carrying GitHub's own message",
      forbiddenRes.ok === false && forbiddenRes.error.includes("not accessible by integration"),
      forbiddenRes,
    );

    const missing = makeStub(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const missingRes = await repoAccess("test-token", { owner: "acme", repo: "widgets", ref: "HEAD" }, missing.fetchImpl);
    check("a 404 yields ok:false", missingRes.ok === false, missingRes);
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

  console.log("\nlisting a user's repositories");
  {
    const okStub = (body: unknown, status = 200) =>
      (async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;

    const res = await listUserRepos("user-token", okStub([
      { full_name: "ada/analytical-engine", private: false, default_branch: "main" },
      { full_name: "ada/notes", private: true, default_branch: "trunk" },
    ]));
    check("listUserRepos maps a normal response", res.ok === true && res.repos.length === 2, res);
    check(
      "listUserRepos carries fullName, private and defaultBranch",
      res.ok === true &&
        res.repos[0]!.fullName === "ada/analytical-engine" &&
        res.repos[0]!.private === false &&
        res.repos[1]!.private === true &&
        res.repos[1]!.defaultBranch === "trunk",
      res,
    );

    // GitHub is a third party. A malformed or hostile-shaped response must
    // produce a short list, never a crash and never entries with a missing
    // name that the picker would render as an empty clickable row.
    const messy = await listUserRepos("user-token", okStub([
      null,
      "not-an-object",
      { private: true },
      { full_name: "" },
      { full_name: "ada/ok" },
      42,
    ]));
    check(
      "listUserRepos drops every malformed entry",
      messy.ok === true && messy.repos.length === 1 && messy.repos[0]!.fullName === "ada/ok",
      messy,
    );
    check(
      "a repo with no default_branch gets an empty string, not undefined",
      messy.ok === true && messy.repos[0]!.defaultBranch === "",
      messy,
    );

    const notArray = await listUserRepos("user-token", okStub({ message: "nope" }));
    check("a non-array body yields an empty list, not a throw", notArray.ok === true && notArray.repos.length === 0, notArray);

    const failed = await listUserRepos("user-token", okStub({ message: "Bad credentials" }, 401));
    check("a 401 yields ok:false", failed.ok === false, failed);

    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    let threw = false;
    let thrownRes: Awaited<ReturnType<typeof listUserRepos>> | undefined;
    try {
      thrownRes = await listUserRepos("user-token", throwing);
    } catch {
      threw = true;
    }
    check("a throwing fetch does not propagate out of listUserRepos", !threw);
    check("a throwing fetch yields ok:false", thrownRes !== undefined && thrownRes.ok === false, thrownRes);

    // The token is a live credential against someone's account. It belongs in
    // the Authorization header and absolutely nowhere else — not in the query
    // string, where it would land in logs and proxies.
    let seenUrl = "";
    let seenAuth = "";
    const recording = (async (input: unknown, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = String(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await listUserRepos("super-secret-token", recording);
    check("the token never appears in the request URL", !seenUrl.includes("super-secret-token"), seenUrl);
    check("the token is sent as a bearer credential", seenAuth.includes("super-secret-token"), seenAuth);

    let installationUrls: string[] = [];
    const installationPages = (async (input: unknown, init?: RequestInit) => {
      installationUrls.push(String(input));
      const page = new URL(String(input)).searchParams.get("page");
      const body = page === "1"
        ? { total_count: 101, repositories: Array.from({ length: 100 }, (_, i) => ({ full_name: `private/repo-${i}`, private: true, default_branch: "main" })) }
        : { total_count: 101, repositories: [{ full_name: "private/repo-100", private: true, default_branch: "main" }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const installed = await listInstallationRepos("installation-token", installationPages);
    check("listInstallationRepos reads the installation repository response", installed.ok === true && installed.repos.length === 101, installed);
    check("listInstallationRepos paginates beyond 100 repositories", installationUrls.length === 2 && installationUrls[1]!.includes("page=2"), installationUrls);
    check("listInstallationRepos preserves private repository markers", installed.ok === true && installed.repos.every((repo) => repo.private), installed);
  }

  console.log("\nreceiver safety (the workerd Illegal-invocation class of bug)");
  {
    // Reproduces what workerd enforces and Node does not: the runtime's
    // `fetch` is a native function with a receiver requirement. Store it on
    // an object and call it back as `obj.f(url)` and the receiver becomes
    // that object, which workerd rejects at runtime with "Illegal
    // invocation: function called with incorrect `this` reference".
    //
    // Every other check in this file injects its own fetch stub, and a stub
    // is an ordinary function that ignores `this` — so this whole class of
    // bug is invisible to them. It reached production once already, in the
    // provider's read path, and this section exists so it cannot again.
    const realFetch = globalThis.fetch;
    let sawWrongReceiver = false;

    // A stand-in that is receiver-sensitive the way the real one is. Must be
    // a normal function, not an arrow, or there is no `this` to inspect.
    globalThis.fetch = function (this: unknown, input: unknown) {
      if (this !== undefined && this !== globalThis) {
        sawWrongReceiver = true;
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      }
      const url = String(input);
      const body = url.includes("/contents") ? "[]" : JSON.stringify({ default_branch: "main" });
      return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    } as unknown as typeof fetch;

    try {
      // The control. Without this, a passing assertion below would prove
      // nothing — it could just mean the stand-in is not actually
      // receiver-sensitive. This must fail, loudly, in the same way workerd
      // would, or the real check is worthless.
      let controlCaught = false;
      const holder = { f: globalThis.fetch };
      try {
        await holder.f("https://api.github.com/anything");
      } catch (err) {
        controlCaught = err instanceof TypeError && /Illegal invocation/.test(err.message);
      }
      check("control: calling fetch as a method of another object is caught", controlCaught);

      sawWrongReceiver = false;
      // No fetchImpl argument on purpose — this is the path production takes.
      const provider = new GithubProvider("user-token", { owner: "ada", repo: "engine", ref: "" }, []);
      const listed = await provider.perform({ op: "list", path: "", depth: 1, deny: [] });

      check("the provider never calls fetch with a wrong receiver", !sawWrongReceiver);
      check(
        "listing through a default-constructed provider succeeds",
        listed.ok === true,
        listed,
      );
      check(
        "no result mentions an illegal invocation",
        !JSON.stringify(listed).includes("Illegal invocation"),
        listed,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("\nsearch falls back to a tree walk");
  {
    // These drive the provider through its public `perform` API rather than
    // any private method, so they keep testing the behaviour even if the
    // internals are reshaped.
    type Fixture = { path: string; text: string; size?: number };

    /**
     * A stand-in GitHub serving the endpoints a tree-walk search touches. It
     * records every URL, so a test can assert what was NOT called — the only
     * way to prove a file's contents were never fetched at all.
     */
    function treeStub(files: Fixture[], opts: { codeSearchStatus?: number; truncated?: boolean } = {}) {
      const urls: string[] = [];
      const fetchImpl = (async (input: unknown) => {
        const url = String(input);
        urls.push(url);
        const jsonRes = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

        if (url.includes("/search/code")) {
          const status = opts.codeSearchStatus ?? 403;
          if (status !== 200) return jsonRes({ message: "rate limited" }, status);
          return jsonRes({ items: files.map((f) => ({ path: f.path })) });
        }
        if (url.includes("/git/trees/")) {
          return jsonRes({
            truncated: opts.truncated ?? false,
            tree: files.map((f) => ({
              path: f.path,
              type: "blob",
              sha: `sha-${f.path}`,
              size: f.size ?? f.text.length,
            })),
          });
        }
        if (url.includes("/git/blobs/")) {
          const sha = decodeURIComponent(url.split("/git/blobs/")[1] ?? "");
          const file = files.find((f) => `sha-${f.path}` === sha);
          if (!file) return jsonRes({ message: "Not Found" }, 404);
          return jsonRes({ content: btoa(file.text), encoding: "base64" });
        }
        // The repository itself, for resolveBranchName.
        return jsonRes({ default_branch: "main" });
      }) as unknown as typeof fetch;
      return { urls, fetchImpl };
    }

    const searchRef = { owner: "ada", repo: "engine", ref: "" };
    const files: Fixture[] = [
      { path: "src/index.ts", text: "const answer = 42;\nexport const NEEDLE = 1;" },
      { path: "src/other.ts", text: "nothing here" },
      { path: "README.md", text: "a NEEDLE in the readme" },
    ];

    {
      const { urls, fetchImpl } = treeStub(files, { codeSearchStatus: 403 });
      const provider = new GithubProvider("t", searchRef, [], "collab-ai", fetchImpl);
      const res = await provider.perform({ op: "search", pattern: "NEEDLE", glob: "", max: 50, deny: [] });
      check("a 403 from code search does not surface as an error", res.ok === true, res);
      check(
        "the tree walk finds matches the code search could not return",
        res.ok === true && res.data.includes("src/index.ts:2") && res.data.includes("README.md:1"),
        res,
      );
      check("the fallback fetched the git tree", urls.some((u) => u.includes("/git/trees/")), urls.length);
    }

    {
      // "HEAD" is what parseRepoRef puts in `ref` for a plain "owner/repo",
      // which is the shape almost every room actually has. If that counted as
      // an explicit branch the code-search fast path would be dead code, and
      // every search would pay for a tree walk it did not need.
      const { urls, fetchImpl } = treeStub(files, { codeSearchStatus: 200 });
      const provider = new GithubProvider("t", { ...searchRef, ref: "HEAD" }, [], "collab-ai", fetchImpl);
      const res = await provider.perform({ op: "search", pattern: "NEEDLE", glob: "", max: 50, deny: [] });
      check("HEAD is not treated as an explicit branch", urls.some((u) => u.includes("/search/code")), urls);
      // The code-search path answers with paths, not matched lines — GitHub
      // does not return a line number for every hit. Assert that shape rather
      // than the tree walk's.
      check("a HEAD room still gets results", res.ok === true && res.data.includes("src/index.ts"), res);
    }

    {
      // GitHub's code search index only covers the default branch, so on an
      // explicit branch it would confidently answer from the wrong code.
      const { urls, fetchImpl } = treeStub(files, { codeSearchStatus: 200 });
      const provider = new GithubProvider("t", { ...searchRef, ref: "feature-x" }, [], "collab-ai", fetchImpl);
      const res = await provider.perform({ op: "search", pattern: "NEEDLE", glob: "", max: 50, deny: [] });
      check("an explicit branch never calls the code-search endpoint", !urls.some((u) => u.includes("/search/code")), urls);
      check("an explicit branch still returns matches", res.ok === true && res.data.includes("NEEDLE"), res);
    }

    {
      // THE SECURITY CHECK. The deny list is what keeps .env and private keys
      // out of a room, and a search walks the tree itself rather than naming
      // one path the server can police — so if the walk ignored deny, every
      // secret in the repository would be one search away.
      const secrets: Fixture[] = [
        { path: ".env", text: "DB_PASSWORD=NEEDLE-secret" },
        { path: "deploy/id_rsa", text: "NEEDLE private key" },
        { path: "src/app.ts", text: "const NEEDLE = true;" },
      ];
      const deny = [".env", ".env.*", "id_rsa*", "**/id_rsa*"];
      const { urls, fetchImpl } = treeStub(secrets, { codeSearchStatus: 403 });
      const provider = new GithubProvider("t", searchRef, [], "collab-ai", fetchImpl);
      const res = await provider.perform({ op: "search", pattern: "NEEDLE", glob: "", max: 50, deny });

      check("a denied file never appears in search results", res.ok === true && !res.data.includes(".env"), res);
      check("a denied key file never appears in search results", res.ok === true && !res.data.includes("id_rsa"), res);
      check("the undenied file still matches", res.ok === true && res.data.includes("src/app.ts"), res);
      // Stronger than checking the output: a denied file must never be
      // FETCHED, so its contents never enter the Worker's memory at all.
      check(
        "a denied file's contents are never even requested",
        !urls.some((u) => u.includes("sha-.env") || u.includes("id_rsa")),
        urls.filter((u) => u.includes("/git/blobs/")),
      );
      // Control: prove the fixture would have revealed the secret without deny.
      const open = treeStub(secrets, { codeSearchStatus: 403 });
      const openProvider = new GithubProvider("t", searchRef, [], "collab-ai", open.fetchImpl);
      const openRes = await openProvider.perform({ op: "search", pattern: "NEEDLE", glob: "", max: 50, deny: [] });
      check(
        "control: with no deny list the same search does reach .env",
        openRes.ok === true && openRes.data.includes(".env"),
        openRes,
      );
    }

    {
      const { fetchImpl } = treeStub(files, { codeSearchStatus: 403 });
      const provider = new GithubProvider("t", searchRef, [], "collab-ai", fetchImpl);
      const res = await provider.perform({ op: "search", pattern: "NEEDLE", glob: "**/*.md", max: 50, deny: [] });
      check(
        "a glob narrows the tree walk",
        res.ok === true && res.data.includes("README.md") && !res.data.includes("src/index.ts"),
        res,
      );
    }

    {
      // A partial answer that looks complete is worse than a clear refusal.
      const many: Fixture[] = [];
      for (let i = 0; i < 200; i++) many.push({ path: `src/f${i}.ts`, text: "NEEDLE" });
      const { urls, fetchImpl } = treeStub(many, { codeSearchStatus: 403 });
      const provider = new GithubProvider("t", searchRef, [], "collab-ai", fetchImpl);
      const res = await provider.perform({ op: "search", pattern: "NEEDLE", glob: "", max: 50, deny: [] });
      // Over the cap the search must NOT grep: every candidate file costs a
      // subrequest, and a whole agent turn shares one budget — a hundred-file
      // search ends the turn instead of answering it. The tree request has
      // already been paid for though, so naming the matching paths costs
      // nothing and beats refusing outright.
      check("an over-cap search still answers rather than erroring", res.ok === true, res);
      check(
        "an over-cap search fetches no file contents at all",
        !urls.some((u) => u.includes("/git/blobs/")),
        urls.filter((u) => u.includes("/git/blobs/")).length,
      );
      check("an over-cap search names matching paths", res.ok === true && res.data.includes("src/f0.ts"), res);
      check("an over-cap search says how many matched", res.ok === true && res.data.includes("200"), res);
      // The wording has to stop the agent reporting these as confirmed hits:
      // they matched the glob, not the search term.
      check(
        "an over-cap search says the contents were not searched",
        res.ok === true && /paths only|not.*search|too many to search/i.test(res.data),
        res,
      );
      check("an over-cap search suggests narrowing with a glob", res.ok === true && /glob/i.test(res.data), res);
    }

    {
      // The pattern comes from a model. Compiling model-supplied text as a
      // regular expression is both a correctness surprise and a denial-of-
      // service risk, so it must be matched literally.
      const dotted: Fixture[] = [
        { path: "a.ts", text: "abc" },
        { path: "b.ts", text: "a.c" },
      ];
      const { fetchImpl } = treeStub(dotted, { codeSearchStatus: 403 });
      const provider = new GithubProvider("t", searchRef, [], "collab-ai", fetchImpl);
      const res = await provider.perform({ op: "search", pattern: "a.c", glob: "", max: 50, deny: [] });
      check("the pattern is matched literally, not as a regex", res.ok === true && !res.data.includes("a.ts"), res);
      check("the literal match still hits", res.ok === true && res.data.includes("b.ts"), res);
    }

    {
      // One unreadable file must not fail the whole search.
      const base = treeStub([{ path: "src/real.ts", text: "NEEDLE here" }], { codeSearchStatus: 403 });
      const wrapped = (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/git/blobs/missing")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/trees/")) {
          return new Response(
            JSON.stringify({
              truncated: false,
              tree: [
                { path: "src/missing.ts", type: "blob", sha: "missing", size: 10 },
                { path: "src/real.ts", type: "blob", sha: "sha-src/real.ts", size: 11 },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return base.fetchImpl(input as RequestInfo, init);
      }) as unknown as typeof fetch;
      const provider = new GithubProvider("t", searchRef, [], "collab-ai", wrapped);
      const res = await provider.perform({ op: "search", pattern: "NEEDLE", glob: "", max: 50, deny: [] });
      check("one unfetchable file does not fail the search", res.ok === true, res);
      check("the readable file still matches", res.ok === true && res.data.includes("src/real.ts"), res);
    }

    {
      const binary: Fixture[] = [
        { path: "logo.png", text: "NEEDLE" },
        { path: "src/keep.ts", text: "NEEDLE" },
      ];
      const { urls, fetchImpl } = treeStub(binary, { codeSearchStatus: 403 });
      const provider = new GithubProvider("t", searchRef, [], "collab-ai", fetchImpl);
      const res = await provider.perform({ op: "search", pattern: "NEEDLE", glob: "", max: 50, deny: [] });
      check("a binary file is never fetched", !urls.some((u) => u.includes("logo.png")), urls);
      check("the source file is still searched", res.ok === true && res.data.includes("src/keep.ts"), res);
    }
  }

  console.log("\nreads follow the working branch once it exists");
  {
    // Writes land on the working branch so nothing here can change a
    // repository's default branch without a pull request. That is right, but
    // it means a room that has just approved an edit must read that branch
    // too — otherwise it re-reads the file it changed, sees the old text, and
    // concludes its own vote failed. That happened in production.
    function recordingStub() {
      const urls: string[] = [];
      const fetchImpl = (async (input: unknown) => {
        const url = String(input);
        urls.push(url);
        const body = url.includes("/contents")
          ? JSON.stringify({ content: btoa("hello from the branch"), encoding: "base64" })
          : JSON.stringify({ default_branch: "main" });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      return { urls, fetchImpl };
    }

    const baseRef = { owner: "ada", repo: "engine", ref: "" };

    {
      const { urls, fetchImpl } = recordingStub();
      const provider = new GithubProvider("t", baseRef, [], "collab-ai", fetchImpl, true);
      const res = await provider.perform({ op: "read", path: "src/index.ts", offset: 0, limit: 1000 });
      check("a read succeeds when pointed at the working branch", res.ok === true, res);
      check(
        "the read asks GitHub for the working branch",
        urls.some((u) => u.includes("/contents") && u.includes("collab-ai")),
        urls,
      );
    }

    {
      // The default. A room that has never written must not ask for a branch
      // that does not exist, or every read 404s.
      const { urls, fetchImpl } = recordingStub();
      const provider = new GithubProvider("t", baseRef, [], "collab-ai", fetchImpl, false);
      await provider.perform({ op: "read", path: "src/index.ts", offset: 0, limit: 1000 });
      check(
        "without the flag a read never asks for the working branch",
        !urls.some((u) => u.includes("/contents") && u.includes("collab-ai")),
        urls,
      );
    }

    {
      // A pull request whose base was the working branch would be a pull
      // request from a branch into itself, so openPr must keep resolving the
      // BASE branch even when reads have been redirected.
      const { urls, fetchImpl } = recordingStub();
      const provider = new GithubProvider("t", baseRef, [], "collab-ai", fetchImpl, true);
      await provider.openPr("title", "body").catch(() => undefined);
      const resolved = urls.filter((u) => !u.includes("/contents") && !u.includes("/pulls"));
      check(
        "openPr still resolves the base branch, not the working branch",
        resolved.every((u) => !u.includes("collab-ai")),
        resolved,
      );
    }
  }

  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
