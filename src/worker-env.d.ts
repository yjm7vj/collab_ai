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
}

// wrangler emits `Cloudflare.Env` and a global `Env` as siblings — the global
// one extends the generated base, not `Cloudflare.Env` — so both need merging.
declare namespace Cloudflare {
  interface Env extends SecretBindings {}
}
interface Env extends SecretBindings {}
