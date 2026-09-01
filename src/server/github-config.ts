import { isConfigured, type OAuthConfig } from "./oauth";

type GitHubCredentialEnv = {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /**
   * Force which credential authorises repository access: "oauth" or "app".
   * Absent means the historical behaviour, which is app-when-configured.
   */
  GITHUB_REPO_AUTH?: string;
};

export type GitHubRepositoryAuthorization = {
  kind: "app" | "oauth";
  config: OAuthConfig;
};

/** Whether installation-token repository access is enabled. */
export function githubConfigured(env: GitHubCredentialEnv): boolean {
  return Boolean(env.GITHUB_APP_ID) && Boolean(env.GITHUB_APP_PRIVATE_KEY);
}

/**
 * Credentials for the repository authorization round trip.
 *
 * A configured GitHub App uses its own client credentials by default. A token
 * minted by a standalone OAuth App cannot call /user/installations, so falling
 * back to the sign-in credentials silently would turn a configuration mistake
 * into a production 403 after the user has already authorized successfully.
 *
 * GITHUB_REPO_AUTH overrides that default, and exists for one reason: a
 * GitHub App can only reach repositories on accounts where it is installed,
 * so a private repository shared with someone by its owner is invisible until
 * that owner installs the app. Setting this to "oauth" asks instead for a
 * classic OAuth App token carrying the `repo` scope, which acts as the person
 * themselves and therefore reaches everything they can reach, with no
 * installation anywhere.
 *
 * The cost of that is real and deliberate: `repo` is not narrowable. It is
 * read and write over every repository the account can touch, so a deployment
 * choosing it trades per-repository scoping for reach. Whoever sets this is
 * making that trade knowingly.
 */
export function githubRepositoryAuthorization(
  env: GitHubCredentialEnv,
): GitHubRepositoryAuthorization | null {
  const forced = env.GITHUB_REPO_AUTH === "oauth" || env.GITHUB_REPO_AUTH === "app"
    ? env.GITHUB_REPO_AUTH
    : null;
  const kind = forced ?? (githubConfigured(env) ? "app" : "oauth");
  const candidate = kind === "app"
    ? { clientId: env.GITHUB_APP_CLIENT_ID, clientSecret: env.GITHUB_APP_CLIENT_SECRET }
    : { clientId: env.GITHUB_OAUTH_CLIENT_ID, clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET };

  if (!isConfigured(candidate)) return null;
  return {
    kind,
    config: {
      clientId: candidate.clientId!,
      clientSecret: candidate.clientSecret!,
    },
  };
}
