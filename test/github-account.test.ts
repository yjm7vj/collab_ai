/**
 * GitHub authorisation as an account-level thing, not a room-level one.
 *
 * The bug these guard: the access token lived in the Room, so it was scoped to
 * whichever room the person happened to authorise in, and disconnecting a
 * workspace deleted it. Connecting a different repository in the same room, or
 * opening a second room, meant authorising again — while GitHub still had the
 * app authorised the whole time. The fix moves the token to `UserIndex`, keyed
 * by uid, and leaves the room holding a pointer to whose authorisation it runs
 * on.
 *
 * So the contract this file pins down is: the authorisation is written once,
 * survives everything except an explicit sign-out, and belongs to exactly one
 * account. Rooms reading it is covered by the room's own reconciliation
 * (#syncGithubAccount); what is asserted here is the store beneath that.
 *
 * These call the Durable Object directly rather than through a Worker route,
 * because it has none — the methods exist for Rooms to call over the internal
 * RPC channel, and a browser cannot address them at all.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

let counter = 0;
function account() {
  counter += 1;
  return env.UserIndex.get(env.UserIndex.idFromName(`github-tester-${counter}`));
}

describe("an account's GitHub authorisation", () => {
  it("reads as null before anyone has authorised", async () => {
    expect(await account().githubAccount()).toBeNull();
  });

  it("reads back what was stored", async () => {
    const stub = account();
    await stub.rememberGithub({ token: "gho_first", login: "octocat", githubId: "583231" });

    expect(await stub.githubAccount()).toEqual({
      token: "gho_first",
      login: "octocat",
      githubId: "583231",
      installationId: "",
    });
  });

  /**
   * The whole point of the change. Nothing a room does — disconnecting a
   * workspace, connecting a different repository, being left and reopened —
   * calls anything here, so the only way to observe the authorisation ending
   * is to end it. A second read returning the same token is what "stays
   * signed in" means.
   */
  it("survives being read over and over", async () => {
    const stub = account();
    await stub.rememberGithub({ token: "gho_keep", login: "octocat", githubId: "583231" });

    for (let i = 0; i < 5; i += 1) {
      expect((await stub.githubAccount())?.token).toBe("gho_keep");
    }
  });

  it("ends only on an explicit sign-out", async () => {
    const stub = account();
    await stub.rememberGithub({ token: "gho_bye", login: "octocat", githubId: "583231" });
    expect(await stub.githubAccount()).not.toBeNull();

    await stub.forgetGithub();
    expect(await stub.githubAccount()).toBeNull();
  });

  /** Changing accounts is a sign-out followed by a sign-in, and lands as one. */
  it("replaces the account when a different one authorises", async () => {
    const stub = account();
    await stub.rememberGithub({ token: "gho_one", login: "octocat", githubId: "583231" });
    await stub.forgetGithub();
    await stub.rememberGithub({ token: "gho_two", login: "hubot", githubId: "111111" });

    expect(await stub.githubAccount()).toEqual({
      token: "gho_two",
      login: "hubot",
      githubId: "111111",
      installationId: "",
    });
  });

  /**
   * Re-authorising is not a reason to forget a proved installation — a token
   * expiring and being renewed would otherwise send the person round the
   * install round trip again for an App they never uninstalled.
   */
  it("keeps a proved installation across a re-authorisation", async () => {
    const stub = account();
    await stub.rememberGithub({ token: "gho_first", login: "octocat", githubId: "583231" });
    await stub.rememberGithubInstallation("42");
    await stub.rememberGithub({ token: "gho_renewed", login: "octocat", githubId: "583231" });

    expect(await stub.githubAccount()).toEqual({
      token: "gho_renewed",
      login: "octocat",
      githubId: "583231",
      installationId: "42",
    });
  });

  /** A sign-out takes the installation with it, or the next sign-in inherits it. */
  it("drops the installation on sign-out", async () => {
    const stub = account();
    await stub.rememberGithub({ token: "gho_first", login: "octocat", githubId: "583231" });
    await stub.rememberGithubInstallation("42");
    await stub.forgetGithub();
    await stub.rememberGithub({ token: "gho_second", login: "hubot", githubId: "111111" });

    expect((await stub.githubAccount())?.installationId).toBe("");
  });

  /**
   * An installation is claimed by proving it against a stored token. With no
   * token there was nothing to prove it with, so recording one would be
   * inventing an authorisation that never happened.
   */
  it("will not record an installation for an account that never authorised", async () => {
    const stub = account();
    await stub.rememberGithubInstallation("42");

    expect(await stub.githubAccount()).toBeNull();
  });

  /** An empty token is not an authorisation, and must never read back as one. */
  it("refuses to store an empty token", async () => {
    const stub = account();
    await stub.rememberGithub({ token: "", login: "octocat", githubId: "583231" });

    expect(await stub.githubAccount()).toBeNull();
  });

  /**
   * One object per account is the only thing keeping one person's token out of
   * another person's rooms, so it is worth asserting rather than assuming.
   */
  it("keeps two accounts apart", async () => {
    const first = account();
    const second = account();
    await first.rememberGithub({ token: "gho_first", login: "octocat", githubId: "583231" });

    expect(await second.githubAccount()).toBeNull();
    expect((await first.githubAccount())?.token).toBe("gho_first");
  });
});
