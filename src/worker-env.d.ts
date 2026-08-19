/**
 * Bindings that `wrangler types` cannot see.
 *
 * Secrets are deliberately absent from wrangler.jsonc, so they never appear in
 * the generated worker-configuration.d.ts. Declaring them here merges them into
 * the same `Env` without touching the generated file, which is overwritten on
 * every `wrangler types` run.
 */
interface SecretBindings {
  /** Set via `.dev.vars` locally, `wrangler secret put` when deployed. */
  ANTHROPIC_API_KEY: string;
  /** Set via `.dev.vars` locally, `wrangler secret put` when deployed. */
  ROOM_SECRET: string;
  /**
   * Optional. GitHub App id, used to mint the App JWT for installation tokens.
   * Without this (and GITHUB_APP_PRIVATE_KEY), GitHub workspaces are simply
   * unavailable — everything else in the app still works.
   */
  GITHUB_APP_ID: string;
  /**
   * Optional. PKCS#8 PEM private key for the GitHub App. See pemToPkcs8 in
   * src/server/github.ts for the openssl conversion GitHub's PKCS#1 key needs.
   */
  GITHUB_APP_PRIVATE_KEY: string;
  /**
   * Optional. The GitHub App's URL slug (public — it appears in the app's own
   * URL), used only to send a room owner straight to the install page instead
   * of a generic settings page.
   */
  GITHUB_APP_SLUG?: string;
}

// wrangler emits `Cloudflare.Env` and a global `Env` as siblings — the global
// one extends the generated base, not `Cloudflare.Env` — so both need merging.
declare namespace Cloudflare {
  interface Env extends SecretBindings {}
}
interface Env extends SecretBindings {}
