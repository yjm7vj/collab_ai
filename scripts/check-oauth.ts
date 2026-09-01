/**
 * Guard checks for src/server/oauth.ts — derived uids, authorize URLs, code
 * exchange, profile fetching, and the signed state parameter.
 *
 * Every network call in this suite is an injected stub — nothing here ever
 * makes a real HTTP request, so it runs offline and needs no credentials.
 *
 * Run: npm run check:oauth
 */
import { mintToken } from "../src/server/auth";
import {
  authorizeUrl,
  deriveUid,
  exchangeCode,
  fetchProfile,
  githubAppAuthorizeUrl,
  GITHUB_REPO_SCOPE,
  GITHUB_REPO_STATE_ROLE,
  isConfigured,
  isRepoConnectState,
  repoAuthorizeUrl,
  signState,
  verifyState,
} from "../src/server/oauth";
import { githubRepositoryAuthorization } from "../src/server/github-config";
import { UID_RE } from "../src/shared/protocol";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** A stub fetch that records how many times it was called and with what. */
function makeStub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const state = { calls: 0, requests: [] as Array<{ url: string; init?: RequestInit }> };
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    state.calls++;
    const url = String(input);
    state.requests.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { state, fetchImpl };
}

async function main() {
  console.log("\nderived uids");
  {
    const a1 = await deriveUid("github", "12345");
    const a2 = await deriveUid("github", "12345");
    check("deriveUid is deterministic", a1 === a2, { a1, a2 });

    // Otherwise a GitHub user could impersonate a Google user whose `sub`
    // happens to be the same string as a GitHub numeric id.
    const gh = await deriveUid("github", "12345");
    const goog = await deriveUid("google", "12345");
    check("github and google with the same providerId give different uids", gh !== goog, { gh, goog });

    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(await deriveUid("github", `user-${i}`));
    }
    check("200 distinct provider ids give 200 distinct uids", seen.size === 200, seen.size);

    for (const uid of [a1, gh, goog]) {
      check(`derived uid ${uid} matches UID_RE`, UID_RE.test(uid), uid);
    }

    const weird = await deriveUid("google", "some/id with spaces and ünicode \u{1F680}");
    check("a providerId with slashes, spaces, and unicode still yields a UID_RE-valid uid", UID_RE.test(weird), weird);
  }

  console.log("\nauthorize urls");
  {
    const state = "abc.def";
    const gh = authorizeUrl("github", "gh-client-id", "https://example.com/callback?x=1", state);
    check("github url contains the client id", gh.includes("client_id=gh-client-id"), gh);
    check(
      "github url contains the encoded redirect_uri",
      gh.includes(`redirect_uri=${encodeURIComponent("https://example.com/callback?x=1")}`),
      gh,
    );
    check("github url contains the state", gh.includes(`state=${encodeURIComponent(state)}`), gh);
    check("github url requests scope=read%3Auser", gh.includes("scope=read%3Auser"), gh);

    const goog = authorizeUrl("google", "goog-client-id", "https://example.com/callback", state);
    check("google url contains response_type=code", goog.includes("response_type=code"), goog);
    check("google url contains prompt=select_account", goog.includes("prompt=select_account"), goog);
    check("google url's scope contains openid", /scope=[^&]*openid/.test(goog), goog);

    const withQuery = authorizeUrl("github", "id", "https://example.com/cb?a=1&b=2", "s");
    check(
      "a redirect_uri with a query string is encoded, not concatenated raw",
      !withQuery.includes("redirect_uri=https://example.com/cb?a=1&b=2") &&
        withQuery.includes(`redirect_uri=${encodeURIComponent("https://example.com/cb?a=1&b=2")}`),
      withQuery,
    );

    const SECRET_MARKER = "super-secret-value-should-never-appear";
    check(
      "neither URL contains a client secret",
      !authorizeUrl("github", "id", "https://example.com/cb", "s").includes(SECRET_MARKER) &&
        !authorizeUrl("google", "id", "https://example.com/cb", "s").includes(SECRET_MARKER),
      undefined,
    );
  }

  console.log("\ncode exchange");
  {
    const cfg = { clientId: "id", clientSecret: "secret" };

    const ghOk = makeStub(() => new Response(JSON.stringify({ access_token: "gho_abc" }), { status: 200 }));
    const ghOkRes = await exchangeCode("github", cfg, "code1", "https://example.com/cb", ghOk.fetchImpl);
    check("github 200 with access_token yields ok:true", ghOkRes.ok === true && ghOkRes.accessToken === "gho_abc", ghOkRes);
    check(
      "github request carried Accept: application/json",
      (ghOk.state.requests[0]?.init?.headers as Record<string, string> | undefined)?.Accept === "application/json",
      ghOk.state.requests[0]?.init?.headers,
    );

    // A 200 is not success for GitHub — a reused/expired code comes back as
    // HTTP 200 with an `error` field in the body.
    const ghBodyError = makeStub(
      () => new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200 }),
    );
    const ghBodyErrorRes = await exchangeCode("github", cfg, "code2", "https://example.com/cb", ghBodyError.fetchImpl);
    check(
      "github 200 with {error: bad_verification_code} yields ok:false",
      ghBodyErrorRes.ok === false,
      ghBodyErrorRes,
    );

    const googOk = makeStub(() => new Response(JSON.stringify({ access_token: "ya29.abc" }), { status: 200 }));
    const googOkRes = await exchangeCode("google", cfg, "code3", "https://example.com/cb", googOk.fetchImpl);
    check("google 200 with access_token yields ok:true", googOkRes.ok === true && googOkRes.accessToken === "ya29.abc", googOkRes);

    const unauthorized = makeStub(
      () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "code expired" }), { status: 401 }),
    );
    const unauthorizedRes = await exchangeCode("google", cfg, "code4", "https://example.com/cb", unauthorized.fetchImpl);
    check(
      "401 with error_description yields ok:false containing that text",
      unauthorizedRes.ok === false && unauthorizedRes.error.includes("code expired"),
      unauthorizedRes,
    );

    const nonJson = makeStub(() => new Response("<html>not json</html>", { status: 500 }));
    let threw = false;
    let nonJsonRes: Awaited<ReturnType<typeof exchangeCode>> | undefined;
    try {
      nonJsonRes = await exchangeCode("github", cfg, "code5", "https://example.com/cb", nonJson.fetchImpl);
    } catch {
      threw = true;
    }
    check("a non-JSON body does not throw", !threw);
    check("a non-JSON body yields ok:false", nonJsonRes !== undefined && nonJsonRes.ok === false, nonJsonRes);
  }

  console.log("\nprofiles");
  {
    const ghStub = makeStub(
      () =>
        new Response(
          JSON.stringify({ id: 42, name: "Ada Lovelace", login: "ada", avatar_url: "https://example.com/a.png" }),
          { status: 200 },
        ),
    );
    const ghRes = await fetchProfile("github", "token", ghStub.fetchImpl);
    check(
      "github profile maps id/name/avatar_url correctly, id becomes a string",
      ghRes.ok === true &&
        ghRes.profile.providerId === "42" &&
        typeof ghRes.profile.providerId === "string" &&
        ghRes.profile.name === "Ada Lovelace" &&
        ghRes.profile.avatar === "https://example.com/a.png",
      ghRes,
    );

    const ghNoName = makeStub(
      () => new Response(JSON.stringify({ id: 7, name: null, login: "ghost", avatar_url: "" }), { status: 200 }),
    );
    const ghNoNameRes = await fetchProfile("github", "token", ghNoName.fetchImpl);
    check(
      "github with name: null falls back to login",
      ghNoNameRes.ok === true && ghNoNameRes.profile.name === "ghost",
      ghNoNameRes,
    );

    const googStub = makeStub(
      () => new Response(JSON.stringify({ sub: "sub-123", name: "Grace Hopper", picture: "https://example.com/g.png" }), { status: 200 }),
    );
    const googRes = await fetchProfile("google", "token", googStub.fetchImpl);
    check(
      "google maps sub/name/picture correctly",
      googRes.ok === true &&
        googRes.profile.providerId === "sub-123" &&
        googRes.profile.name === "Grace Hopper" &&
        googRes.profile.avatar === "https://example.com/g.png",
      googRes,
    );

    const ghNoId = makeStub(() => new Response(JSON.stringify({ name: "No Id" }), { status: 200 }));
    const ghNoIdRes = await fetchProfile("github", "token", ghNoId.fetchImpl);
    check("github response with no id yields ok:false", ghNoIdRes.ok === false, ghNoIdRes);

    const googNoSub = makeStub(() => new Response(JSON.stringify({ name: "No Sub" }), { status: 200 }));
    const googNoSubRes = await fetchProfile("google", "token", googNoSub.fetchImpl);
    check("google response with no sub yields ok:false", googNoSubRes.ok === false, googNoSubRes);

    const throwingStub = (async () => {
      throw new Error("network exploded");
    }) as typeof fetch;
    let threw = false;
    let throwRes: Awaited<ReturnType<typeof fetchProfile>> | undefined;
    try {
      throwRes = await fetchProfile("github", "token", throwingStub);
    } catch {
      threw = true;
    }
    check("a stub that throws does not propagate", !threw);
    check("a stub that throws yields ok:false", throwRes !== undefined && throwRes.ok === false, throwRes);
  }

  console.log("\nstate");
  {
    const SECRET = "state-secret";
    const OTHER_SECRET = "a-different-secret";

    const state = await signState(SECRET, "github", "/r/abc123", 1000);
    const verified = await verifyState(SECRET, state, 1000);
    check(
      "signState -> verifyState round-trips provider and returnTo",
      verified !== null && verified.provider === "github" && verified.returnTo === "/r/abc123",
      verified,
    );

    const wrongSecret = await verifyState(OTHER_SECRET, state, 1000);
    check("a state signed with a different secret returns null", wrongSecret === null, wrongSecret);

    const expired = await verifyState(SECRET, state, 1000 + 601);
    check("an expired state returns null", expired === null, expired);

    // This is the check that keeps the two token namespaces apart: a
    // genuine room token (rid = a real room id) must never verify as OAuth
    // state, even though both are minted by the same underlying function.
    const roomToken = await mintToken(SECRET, { rid: "someroom", uid: "user1", role: "owner", exp: 999999999999 });
    const asState = await verifyState(SECRET, roomToken, 1000);
    check("a genuine room token passed to verifyState returns null", asState === null, asState);

    for (const bad of ["https://evil.example", "//evil.example", "/path//x"]) {
      const badState = await signState(SECRET, "google", bad, 1000);
      const result = await verifyState(SECRET, badState, 1000);
      check(`returnTo of ${JSON.stringify(bad)} is rejected`, result === null, result);
    }

    for (const good of ["/", "/#/r/abc"]) {
      const goodState = await signState(SECRET, "google", good, 1000);
      const result = await verifyState(SECRET, goodState, 1000);
      check(`returnTo of ${JSON.stringify(good)} is accepted`, result !== null && result.returnTo === good, result);
    }
  }

  console.log("\nconfiguration");
  {
    check("isConfigured with both values true", isConfigured({ clientId: "id", clientSecret: "secret" }) === true);
    check("isConfigured with clientId missing is false", isConfigured({ clientSecret: "secret" }) === false);
    check("isConfigured with clientSecret missing is false", isConfigured({ clientId: "id" }) === false);
    check("isConfigured with clientId empty is false", isConfigured({ clientId: "", clientSecret: "secret" }) === false);
    check("isConfigured with clientSecret empty is false", isConfigured({ clientId: "id", clientSecret: "" }) === false);
    check("isConfigured with undefined config is false", isConfigured(undefined) === false);
    check(
      "isConfigured with example placeholders is false",
      isConfigured({
        clientId: "replace-with-github-oauth-client-id",
        clientSecret: "replace-with-github-oauth-client-secret",
      }) === false,
    );
  }

  console.log("\nrepository authorisation");
  {
    const url = new URL(repoAuthorizeUrl("client-123", "https://app.example/api/auth/github/callback", "state-abc"));
    check(
      "repoAuthorizeUrl points at GitHub's authorize endpoint",
      `${url.origin}${url.pathname}` === "https://github.com/login/oauth/authorize",
      url.href,
    );
    check("repoAuthorizeUrl carries the repo scope", url.searchParams.get("scope") === GITHUB_REPO_SCOPE, url.href);
    check("repoAuthorizeUrl carries the client id", url.searchParams.get("client_id") === "client-123");
    check("repoAuthorizeUrl carries the state", url.searchParams.get("state") === "state-abc");
    check(
      "repoAuthorizeUrl carries the redirect uri",
      url.searchParams.get("redirect_uri") === "https://app.example/api/auth/github/callback",
    );
    check("repoAuthorizeUrl leaks no client secret", !url.href.includes("client_secret"), url.href);

    const appUrl = new URL(
      githubAppAuthorizeUrl("app-client", "https://app.example/api/auth/github/callback", "app-state"),
    );
    check("githubAppAuthorizeUrl carries the GitHub App client id", appUrl.searchParams.get("client_id") === "app-client");
    check("githubAppAuthorizeUrl carries no OAuth App repository scope", appUrl.searchParams.get("scope") === null, appUrl.href);

    // The whole reason the two builders are kept apart. If this ever fails,
    // merely signing in would hand this app read and write access to every
    // repository the person can reach, which is not what sign-in is for.
    const signIn = new URL(authorizeUrl("github", "client-123", "https://app.example/cb", "s"));
    check("sign-in never asks for the repo scope", signIn.searchParams.get("scope") === "read:user", signIn.href);
  }

  console.log("\nrepository credential routing");
  {
    const split = githubRepositoryAuthorization({
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      GITHUB_APP_CLIENT_ID: "github-app-client",
      GITHUB_APP_CLIENT_SECRET: "github-app-secret",
      GITHUB_OAUTH_CLIENT_ID: "oauth-app-client",
      GITHUB_OAUTH_CLIENT_SECRET: "oauth-app-secret",
    });
    check(
      "a GitHub App deployment uses the GitHub App client pair",
      split?.kind === "app" &&
        split.config.clientId === "github-app-client" &&
        split.config.clientSecret === "github-app-secret",
      split,
    );

    const missingAppPair = githubRepositoryAuthorization({
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      GITHUB_OAUTH_CLIENT_ID: "oauth-app-client",
      GITHUB_OAUTH_CLIENT_SECRET: "oauth-app-secret",
    });
    check(
      "a GitHub App deployment never falls back to an OAuth App token",
      missingAppPair === null,
      missingAppPair,
    );

    const oauthOnly = githubRepositoryAuthorization({
      GITHUB_OAUTH_CLIENT_ID: "oauth-app-client",
      GITHUB_OAUTH_CLIENT_SECRET: "oauth-app-secret",
    });
    check(
      "an OAuth-only deployment keeps the repository fallback",
      oauthOnly?.kind === "oauth" && oauthOnly.config.clientId === "oauth-app-client",
      oauthOnly,
    );
  }

  console.log("\nrepository-connect state is its own namespace");
  {
    const REPO_STATE_SECRET = "state-secret";
    const ROOM = "a".repeat(22);

    check(
      "a repo-connect state is recognised",
      isRepoConnectState({ rid: ROOM, uid: "member-1", role: GITHUB_REPO_STATE_ROLE }) === true,
    );

    // A room token is signed with the same key and carries a real room id in
    // `rid`. If any room role were ever mistaken for repository-connect state,
    // a member could replay their own room credential as the OAuth callback's
    // state parameter and have a token filed against the room in their name.
    for (const role of ["owner", "admin", "editor", "viewer"]) {
      check(
        `a room token with role ${role} is not repo-connect state`,
        isRepoConnectState({ rid: ROOM, uid: "member-1", role }) === false,
      );
    }

    for (const role of ["github", "google"]) {
      check(
        `sign-in state for ${role} is not repo-connect state`,
        isRepoConnectState({ rid: "oauth", uid: "/", role }) === false,
      );
    }

    // ...and the reverse direction: the sign-in verifier must refuse a
    // repository-connect state outright, because its rid is a room id and
    // never the oauth marker.
    const repoState = await mintToken(REPO_STATE_SECRET, {
      rid: "b".repeat(22),
      uid: "member-1",
      role: GITHUB_REPO_STATE_ROLE,
      exp: 2000,
    });
    const asSignIn = await verifyState(REPO_STATE_SECRET, repoState, 1000);
    check("a repo-connect state passed to verifyState returns null", asSignIn === null, asSignIn);
  }

  console.log("\nGITHUB_REPO_AUTH overrides the routing");
  {
    const bothConfigured = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      GITHUB_APP_CLIENT_ID: "github-app-client",
      GITHUB_APP_CLIENT_SECRET: "github-app-secret",
      GITHUB_OAUTH_CLIENT_ID: "oauth-app-client",
      GITHUB_OAUTH_CLIENT_SECRET: "oauth-app-secret",
    };

    // Why the override exists: a GitHub App cannot reach a private repository
    // on an account where it is not installed, so a deployment needing that
    // reach has to ask for a classic OAuth App token instead.
    const forcedOauth = githubRepositoryAuthorization({ ...bothConfigured, GITHUB_REPO_AUTH: "oauth" });
    check(
      "oauth wins over a fully configured App",
      forcedOauth?.kind === "oauth" && forcedOauth.config.clientId === "oauth-app-client",
      forcedOauth,
    );

    const forcedApp = githubRepositoryAuthorization({ ...bothConfigured, GITHUB_REPO_AUTH: "app" });
    check(
      "app keeps the App credentials",
      forcedApp?.kind === "app" && forcedApp.config.clientId === "github-app-client",
      forcedApp,
    );

    // A typo must not silently reroute a deployment's credentials.
    const nonsense = githubRepositoryAuthorization({ ...bothConfigured, GITHUB_REPO_AUTH: "OAuth App please" });
    check("an unrecognised value falls back to the default, not to oauth", nonsense?.kind === "app", nonsense);

    const unset = githubRepositoryAuthorization(bothConfigured);
    check("absent leaves the historical app-when-configured behaviour", unset?.kind === "app", unset);

    // Forcing oauth without OAuth credentials must refuse rather than quietly
    // hand back the App's.
    const forcedWithoutCreds = githubRepositoryAuthorization({
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      GITHUB_APP_CLIENT_ID: "github-app-client",
      GITHUB_APP_CLIENT_SECRET: "github-app-secret",
      GITHUB_REPO_AUTH: "oauth",
    });
    check(
      "forcing oauth with no OAuth credentials yields null, never the App's",
      forcedWithoutCreds === null,
      forcedWithoutCreds,
    );
  }

  console.log("\nthe exchange reports what GitHub actually granted");
  {
    const cfg = { clientId: "id", clientSecret: "secret" };

    const scoped = makeStub(() =>
      new Response(JSON.stringify({ access_token: "gho_abc", scope: "repo" }), { status: 200 }),
    );
    const scopedRes = await exchangeCode("github", cfg, "code", "https://example.com/cb", scoped.fetchImpl);
    check("a classic OAuth App token reports its scope", scopedRes.ok === true && scopedRes.scope === "repo", scopedRes);

    // A GitHub App's OAuth client ignores the requested scope and says so by
    // returning none. That empty string is what the callback refuses on, and
    // it is the whole reason the check is worth having: without it the
    // misconfiguration is silent.
    const appUserToken = makeStub(() =>
      new Response(JSON.stringify({ access_token: "ghu_abc" }), { status: 200 }),
    );
    const appUserRes = await exchangeCode("github", cfg, "code", "https://example.com/cb", appUserToken.fetchImpl);
    check(
      "an App user-to-server token reports no scope at all",
      appUserRes.ok === true && appUserRes.scope === "",
      appUserRes,
    );
  }

  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
