/**
 * A small MCP client, so the room can hold a tool call before it happens.
 *
 * WHY THIS FILE EXISTS AT ALL
 * Anthropic's MCP connector is less code than this: hand it a server URL and
 * the model calls that server's tools inside the same API request. But the call
 * happens on Anthropic's side, before this Worker sees anything, and a call we
 * never see is a call the room cannot vote on. Every other action this agent
 * takes goes to a vote; MCP was the one exception, and the exception was
 * winning. So we talk to MCP servers ourselves: discover their tools, offer
 * them to the model as ordinary tools of ours, and run one only once the room
 * has said yes.
 *
 * The MCP specification asks for exactly this, incidentally — clients SHOULD
 * keep "a human in the loop with the ability to deny tool invocations" and
 * SHOULD "show tool inputs to the user before calling the server".
 *
 * WHAT IT SPEAKS
 * Streamable HTTP, per the 2025-06-18 spec: every message is a POST carrying
 * one JSON-RPC message, and the reply is either a JSON object or an SSE stream
 * that eventually contains one. Both are handled. A server that hands back a
 * session id gets it echoed on later requests, as do the protocol version
 * header and the bearer token.
 *
 * HOUSE RULES
 *  - Nothing here throws. Every export returns a result object, because these
 *    are network calls against somebody else's server in the middle of a turn.
 *  - Every request has a timeout. A hung MCP server must not hang a room.
 *  - The token is written to exactly one place — the Authorization header —
 *    and never to a log, a result, or an error message.
 */

/** What we send as, and the newest protocol version we understand. */
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "huddleai", version: "1.0.0" } as const;

/** Ceilings, so one bad server cannot spend a turn's worth of time. */
export const MCP_LIMITS = {
  /** Per HTTP request. */
  timeoutMs: 20_000,
  /** Tools taken from one server, however many it offers. */
  toolsPerServer: 40,
  /** Pages of tools/list to walk before giving up on a paginating server. */
  toolPages: 5,
  /** Characters of tool result handed back to the model. */
  resultChars: 20_000,
} as const;

export type McpTarget = {
  /** The name this server is known by in the room, used to prefix its tools. */
  name: string;
  url: string;
  authorizationToken?: string;
};

/** One tool as the server describes it. `inputSchema` is passed to the model as-is. */
export type McpTool = {
  name: string;
  description: string;
  inputSchema: unknown;
};

export type McpListResult =
  | { ok: true; tools: McpTool[] }
  | { ok: false; error: string };

export type McpCallResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/* ------------------------------------------------------------------ wire */

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/**
 * A live session with one server: the negotiated version and, when the server
 * uses them, its session id. Held only for the duration of one operation.
 */
type Session = { sessionId: string; protocolVersion: string };

function headers(target: McpTarget, session: Session | null): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    // Both are required: the server picks which one it answers with, and the
    // spec obliges the client to cope with either.
    accept: "application/json, text/event-stream",
  };
  if (target.authorizationToken) h.authorization = `Bearer ${target.authorizationToken}`;
  if (session) {
    h["mcp-protocol-version"] = session.protocolVersion;
    if (session.sessionId) h["mcp-session-id"] = session.sessionId;
  }
  return h;
}

/**
 * Pull the JSON-RPC response out of a body that may be either a JSON object or
 * an SSE stream. For SSE we take the first `data:` payload that parses and
 * carries a result or an error — servers may send notifications first, and
 * those are not what the caller is waiting for.
 */
async function readRpc(res: Response): Promise<JsonRpcResponse | null> {
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();

  if (type.includes("text/event-stream")) {
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(trimmed.slice(5).trim()) as JsonRpcResponse;
        if ("result" in parsed || "error" in parsed) return parsed;
      } catch {
        /* a partial or non-JSON event; keep looking */
      }
    }
    return null;
  }

  try {
    return JSON.parse(body) as JsonRpcResponse;
  } catch {
    return null;
  }
}

/** One JSON-RPC request. Returns the response, or a reason it could not. */
async function rpc(
  target: McpTarget,
  session: Session | null,
  method: string,
  params: unknown,
  id: number,
): Promise<{ ok: true; res: Response; body: JsonRpcResponse } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_LIMITS.timeoutMs);
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: headers(target, session),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // The status is worth naming — a 401 means the token, a 404 after a
      // session id means the session went away — but the body is the server's
      // and may be anything, so it is not echoed into the room.
      return { ok: false, error: `${target.name} answered HTTP ${res.status}.` };
    }

    const body = await readRpc(res);
    if (!body) return { ok: false, error: `${target.name} sent a reply that wasn't valid MCP.` };
    if (body.error) {
      return { ok: false, error: `${target.name} refused: ${body.error.message ?? "no reason given"}` };
    }
    return { ok: true, res, body };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? `${target.name} did not answer within ${MCP_LIMITS.timeoutMs / 1000}s.`
        : `${target.name} could not be reached.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The handshake: initialize, then the initialized notification.
 *
 * A session is per-operation rather than kept alive between turns. That costs
 * one extra round trip per operation and buys not having to keep somebody
 * else's session alive across a Durable Object that sleeps — worth it until
 * there is evidence otherwise.
 */
async function open(target: McpTarget): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  const init = await rpc(target, null, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    // We implement none of the optional client features, and say so honestly
    // rather than claiming capabilities we would then fail to honour.
    capabilities: {},
    clientInfo: CLIENT_INFO,
  }, 1);
  if (!init.ok) return init;

  const result = (init.body.result ?? {}) as { protocolVersion?: string };
  const session: Session = {
    sessionId: init.res.headers.get("mcp-session-id") ?? "",
    // The server picks the version. Echoing our own back would be a lie the
    // server has to cope with.
    protocolVersion: result.protocolVersion ?? PROTOCOL_VERSION,
  };

  // Fire-and-forget by design: the spec wants the notification sent, and a
  // server that dislikes it will say so on the next real request.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MCP_LIMITS.timeoutMs);
    await fetch(target.url, {
      method: "POST",
      headers: headers(target, session),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  } catch {
    /* the next request will surface anything that actually matters */
  }

  return { ok: true, session };
}

/* --------------------------------------------------------------- exports */

/**
 * Everything this server offers, capped and flattened.
 *
 * Descriptions come from a third party and land in our prompt, so they are
 * length-limited here. They are still untrusted text — whatever reads them
 * downstream must treat them as data, exactly as it treats a fetched page.
 */
export async function listTools(target: McpTarget): Promise<McpListResult> {
  const opened = await open(target);
  if (!opened.ok) return { ok: false, error: opened.error };

  const tools: McpTool[] = [];
  let cursor: string | undefined;
  let id = 2;

  for (let page = 0; page < MCP_LIMITS.toolPages; page++) {
    const listed = await rpc(
      target,
      opened.session,
      "tools/list",
      cursor ? { cursor } : {},
      id++,
    );
    if (!listed.ok) return { ok: false, error: listed.error };

    const result = (listed.body.result ?? {}) as {
      tools?: { name?: unknown; description?: unknown; inputSchema?: unknown }[];
      nextCursor?: unknown;
    };

    for (const t of Array.isArray(result.tools) ? result.tools : []) {
      if (tools.length >= MCP_LIMITS.toolsPerServer) break;
      if (typeof t?.name !== "string" || t.name === "") continue;
      tools.push({
        name: t.name,
        description: typeof t.description === "string" ? t.description.slice(0, 1024) : "",
        // Passed through untouched: this is the contract the model must
        // generate arguments against, and rewriting it would break the call.
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object"
            ? t.inputSchema
            : { type: "object", properties: {} },
      });
    }

    cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    if (!cursor || tools.length >= MCP_LIMITS.toolsPerServer) break;
  }

  return { ok: true, tools };
}

/**
 * Run one tool. Called only after the room has approved it — see
 * room.ts#settleIfDecided.
 *
 * A tool that fails on the server's own terms (`isError`) comes back as
 * `ok: false` too: the model needs to know it did not work, and the distinction
 * between "the network broke" and "the tool refused" is not one it can act on
 * differently.
 */
export async function callTool(
  target: McpTarget,
  toolName: string,
  args: unknown,
): Promise<McpCallResult> {
  const opened = await open(target);
  if (!opened.ok) return { ok: false, error: opened.error };

  const called = await rpc(
    target,
    opened.session,
    "tools/call",
    { name: toolName, arguments: args ?? {} },
    99,
  );
  if (!called.ok) return { ok: false, error: called.error };

  const result = (called.body.result ?? {}) as {
    content?: unknown;
    isError?: unknown;
    structuredContent?: unknown;
  };

  const text = flatten(result.content, result.structuredContent);
  if (result.isError === true) {
    return { ok: false, error: text || `${target.name} reported the tool failed.` };
  }
  return { ok: true, text: text || "(the tool returned nothing)" };
}

/**
 * A tool result as one string.
 *
 * MCP results are an array that can carry text, images, audio and links to
 * resources. The model gets the text; everything else is named rather than
 * inlined, because a base64 image dropped into a tool result is a very
 * expensive way to say "there was a picture".
 */
function flatten(content: unknown, structured: unknown): string {
  const parts: string[] = [];

  for (const block of Array.isArray(content) ? content : []) {
    const b = (block ?? {}) as { type?: unknown; text?: unknown; uri?: unknown; mimeType?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "image" || b.type === "audio") {
      parts.push(`(${String(b.type)} returned, ${String(b.mimeType ?? "unknown type")})`);
    } else if (b.type === "resource_link" && typeof b.uri === "string") {
      parts.push(`(resource: ${b.uri})`);
    } else if (b.type === "resource") {
      parts.push("(an embedded resource was returned)");
    }
  }

  // Only when there was no text at all: the spec asks servers to repeat
  // structured content as text, so using both would usually duplicate it.
  if (parts.length === 0 && structured && typeof structured === "object") {
    try {
      parts.push(JSON.stringify(structured));
    } catch {
      /* not serialisable; nothing useful to say about it */
    }
  }

  const joined = parts.join("\n").trim();
  return joined.length > MCP_LIMITS.resultChars
    ? `${joined.slice(0, MCP_LIMITS.resultChars)}\n…(truncated)`
    : joined;
}

/* ---------------------------------------------------------- tool naming */

/**
 * How an MCP tool is named in the model's tool list.
 *
 * The prefix does two jobs: it stops a server's `read_file` colliding with
 * ours, and it is how a call coming back from the model is routed to the server
 * it belongs to. Anthropic's tool names allow letters, digits, underscores and
 * hyphens, so the server name is squeezed into that.
 */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${slug(serverName)}__${toolName}`.slice(0, 128);
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

/** The server slug and tool name inside a prefixed name, or null. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!isMcpToolName(name)) return null;
  const rest = name.slice("mcp__".length);
  const cut = rest.indexOf("__");
  if (cut <= 0) return null;
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
}

export function slug(serverName: string): string {
  return serverName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "server";
}
