import { routeAgentRequest } from "agents";

export { Room } from "./room";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.ANTHROPIC_API_KEY) {
      return new Response(
        "ANTHROPIC_API_KEY is not set. Put it in .dev.vars for local dev, or run " +
          "`npx wrangler secret put ANTHROPIC_API_KEY` for a deployed Worker.",
        { status: 500 },
      );
    }

    // /agents/room/:name -> the Room Durable Object for that name.
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    // Everything else is the single-page app.
    return env.ASSETS.fetch(request);
  },
};
