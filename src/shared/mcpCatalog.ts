/**
 * A short list of remote MCP servers we know exist, so wiring one up is a
 * choice from a menu rather than a URL somebody has to already know.
 *
 * EVERY ENTRY HERE WAS READ OFF THE VENDOR'S OWN DOCUMENTATION. A wrong address
 * produces a server that silently never answers, and the person who picked it
 * from our menu blames us rather than the URL — so this list grows only by
 * someone loading the vendor's docs and copying what is written there. Nothing
 * in it is inferred from a naming pattern.
 *
 * `auth` is the part people get wrong, and it is recorded honestly:
 *
 *   - "token"  the server takes a bearer token, which is what this app can
 *              actually send today. These work end to end.
 *   - "oauth"  the server only speaks OAuth, which we do not implement yet.
 *              Listed anyway, because knowing a server exists and is currently
 *              out of reach beats not knowing it exists — but the editor says
 *              so plainly rather than letting someone wire up a dead server.
 *   - "none"   no credential needed.
 *
 * Most of the interesting servers are OAuth-first. Until OAuth lands, this
 * catalogue is more a map of the territory than a set of working connections.
 */

export type McpAuthKind = "none" | "token" | "oauth";

export type McpCatalogEntry = {
  /** Stable, lowercase, no spaces. Never reused for a different service. */
  id: string;
  /** What a person reads in the picker. */
  label: string;
  /** Exactly as published by the vendor. */
  url: string;
  /** One sentence: what wiring this up gets you. */
  blurb: string;
  auth: McpAuthKind;
};

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "linear",
    label: "Linear",
    url: "https://mcp.linear.app/mcp",
    blurb: "Read and file Linear issues, projects and cycles.",
    // Linear's docs lead with OAuth but state you can also authenticate with a
    // bearer token or Linear API key, which is the path we can use.
    auth: "token",
  },
  {
    id: "stripe",
    label: "Stripe",
    url: "https://mcp.stripe.com",
    blurb: "Query customers, payments, invoices and subscriptions.",
    // Stripe's docs: use OAuth where the client supports it, otherwise a
    // restricted API key as a bearer token. Prefer a restricted key here.
    auth: "token",
  },
  {
    id: "sentry",
    label: "Sentry",
    url: "https://mcp.sentry.dev/mcp",
    blurb: "Look up issues, events and stack traces from Sentry.",
    auth: "oauth",
  },
  {
    id: "cloudflare-docs",
    label: "Cloudflare Docs",
    url: "https://docs.mcp.cloudflare.com/mcp",
    blurb: "Search Cloudflare's own reference documentation.",
    auth: "oauth",
  },
  {
    id: "cloudflare-radar",
    label: "Cloudflare Radar",
    url: "https://radar.mcp.cloudflare.com/mcp",
    blurb: "Internet traffic trends, and scanning a URL for what it serves.",
    auth: "oauth",
  },
];

export function catalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}

/** What to tell someone about a server's credential, in the editor. */
export function authNote(auth: McpAuthKind): string {
  switch (auth) {
    case "token":
      return "Needs a token — paste one below once the workflow is applied.";
    case "oauth":
      return "This server only supports OAuth, which this app can't do yet. It will not connect.";
    case "none":
      return "No credential needed.";
  }
}
