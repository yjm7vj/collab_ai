/**
 * This Worker is the trust boundary for the whole app: it decides who may open
 * a socket to a room, before the socket ever reaches the Durable Object. The
 * Durable Object in turn trusts the `x-room-uid` / `x-room-role` headers this
 * Worker sets on the upgrade request, because nothing else can reach it —
 * Durable Objects are not independently addressable from outside the Worker.
 */

import { routeAgentRequest, getAgentByName } from "agents";

import { mintToken, newId, verifyToken } from "./auth";
import {
  ROOM_ID_RE,
  UID_RE,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type JoinRoomRequest,
  type JoinRoomResponse,
} from "../shared/protocol";

export { Room } from "./room";

// A token is a session, not a membership — membership outlives it and is
// re-checked against the room's own member table on every connect.
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function roomStub(env: Env, roomId: string) {
  return await getAgentByName(env.Room, roomId);
}

/**
 * Whether this Worker has both GitHub App secrets configured. GitHub
 * workspaces are an optional feature: absent these, everything else in the
 * app still works, so callers use this to degrade cleanly rather than error.
 */
function githubConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_APP_ID) && Boolean(env.GITHUB_APP_PRIVATE_KEY);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.ANTHROPIC_API_KEY) {
      return new Response(
        "ANTHROPIC_API_KEY is not set. Put it in .dev.vars for local dev, or run " +
          "`npx wrangler secret put ANTHROPIC_API_KEY` for a deployed Worker.",
        { status: 500 },
      );
    }

    if (!env.ROOM_SECRET) {
      return new Response(
        "ROOM_SECRET is not set. Put it in .dev.vars for local dev, or run " +
          "`npx wrangler secret put ROOM_SECRET` for a deployed Worker. Without " +
          "it, nothing can verify who is allowed into a room.",
        { status: 500 },
      );
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/rooms") {
      if (request.method !== "POST") return json({ error: "bad_request" }, 405);

      let body: CreateRoomRequest;
      try {
        body = (await request.json()) as CreateRoomRequest;
      } catch {
        return json({ error: "bad_request" }, 400);
      }

      const uid = String(body.uid ?? "");
      if (!UID_RE.test(uid)) return json({ error: "bad_request" }, 400);

      const roomId = newId(22);
      const stub = await roomStub(env, roomId);
      const initRes = await stub.fetch("https://room/init", {
        method: "POST",
        body: JSON.stringify({ uid, name: body.name, title: body.title }),
        headers: {
          "content-type": "application/json",
          // Proves to the room that this call came from the Worker. Without it
          // the room refuses, so /init cannot be reached from outside.
          "x-internal-auth": env.ROOM_SECRET,
        },
      });

      if (!initRes.ok) {
        return new Response(initRes.body, {
          status: initRes.status,
          headers: initRes.headers,
        });
      }

      const { role } = (await initRes.json()) as { role: string };
      const token = await mintToken(env.ROOM_SECRET, {
        rid: roomId,
        uid,
        role,
        exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
      });

      return json({ roomId, token, role } satisfies CreateRoomResponse);
    }

    if (url.pathname === "/api/join") {
      if (request.method !== "POST") return json({ error: "bad_request" }, 405);

      let body: JoinRoomRequest;
      try {
        body = (await request.json()) as JoinRoomRequest;
      } catch {
        return json({ error: "bad_request" }, 400);
      }

      const roomId = String(body.roomId ?? "");
      const uid = String(body.uid ?? "");
      if (!ROOM_ID_RE.test(roomId) || !UID_RE.test(uid)) {
        return json({ error: "bad_request" }, 400);
      }

      const stub = await roomStub(env, roomId);
      const admitRes = await stub.fetch("https://room/admit", {
        method: "POST",
        body: JSON.stringify({ uid, name: body.name, code: body.code }),
        headers: {
          "content-type": "application/json",
          "x-internal-auth": env.ROOM_SECRET,
        },
      });

      if (!admitRes.ok) {
        return new Response(admitRes.body, {
          status: admitRes.status,
          headers: admitRes.headers,
        });
      }

      const { role } = (await admitRes.json()) as { role: string };
      const token = await mintToken(env.ROOM_SECRET, {
        rid: roomId,
        uid,
        role,
        exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
      });

      return json({ token, role } satisfies JoinRoomResponse);
    }

    if (url.pathname === "/api/github/callback") {
      if (!githubConfigured(env)) return json({ error: "not_found" }, 404);

      const state = url.searchParams.get("state") ?? "";
      const claims = await verifyToken(env.ROOM_SECRET, state);
      if (!claims) {
        return new Response(
          "That installation link is invalid or has expired. Start again from the room.",
          { status: 400 },
        );
      }

      const installationId = url.searchParams.get("installation_id") ?? "";
      if (!/^[0-9]+$/.test(installationId)) {
        return new Response("GitHub didn't return an installation id.", { status: 400 });
      }

      const stub = await roomStub(env, claims.rid);
      const installedRes = await stub.fetch("https://room/github-installed", {
        method: "POST",
        body: JSON.stringify({ installationId, uid: claims.uid }),
        headers: {
          "content-type": "application/json",
          "x-internal-auth": env.ROOM_SECRET,
        },
      });

      if (!installedRes.ok) {
        return new Response(installedRes.body, {
          status: installedRes.status,
          headers: installedRes.headers,
        });
      }

      return new Response(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Repository connected</title></head>" +
          "<body><p>The repository is connected. You can close this tab.</p></body></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }

    /**
     * Verify the connecting socket's token before it ever reaches the Durable
     * Object. This runs for every `/agents/room/:roomId` upgrade.
     */
    async function onBeforeConnect(req: Request): Promise<Request | Response> {
      const reqUrl = new URL(req.url);
      const segments = reqUrl.pathname.split("/").filter(Boolean);
      const roomId = segments.at(-1) ?? "";

      const token = reqUrl.searchParams.get("tk");
      if (!token) return new Response("unauthorized", { status: 401 });

      const claims = await verifyToken(env.ROOM_SECRET, token);
      if (!claims) return new Response("unauthorized", { status: 401 });

      // A token minted for one room must never open a socket to another.
      if (claims.rid !== roomId) return new Response("unauthorized", { status: 401 });

      const headers = new Headers(req.headers);
      // `set` overwrites any value already on the request, which is what stops
      // a client from supplying its own x-room-uid on the upgrade request.
      headers.set("x-room-uid", claims.uid);
      // Same reasoning as x-room-uid: `set` overwrites, so a forged role header
      // on the incoming request can't survive to reach the Durable Object.
      headers.set("x-room-role", claims.role);
      return new Request(req, { headers });
    }

    // /agents/room/:name -> the Room Durable Object for that name.
    const routed = await routeAgentRequest(request, env, { onBeforeConnect });
    if (routed) return routed;

    // Everything else is the single-page app.
    return env.ASSETS.fetch(request);
  },
};
