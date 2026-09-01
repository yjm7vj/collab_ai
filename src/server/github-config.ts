import { isConfigured, type OAuthConfig } from "./oauth";

type GitHubCredentialEnv = {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
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
 * A configured GitHub App must use its own client credentials here. A token
 * minted by a standalone OAuth App cannot call /user/installations, so falling
 * back to the sign-in credentials would turn a configuration mistake into a
 * production 403 after the user has already authorized successfully.
 */
export function githubRepositoryAuthorization(
  env: GitHubCredentialEnv,
): GitHubRepositoryAuthorization | null {
  const kind = githubConfigured(env) ? "app" : "oauth";
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
