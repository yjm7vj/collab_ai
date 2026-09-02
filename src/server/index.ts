/**
 * This Worker is the trust boundary for the whole app: it decides who may open
 * a socket to a room, before the socket ever reaches the Durable Object. The
 * Durable Object in turn trusts the `x-room-uid` header this Worker sets on
 * the upgrade request, because nothing else can reach it — Durable Objects are
 * not independently addressable from outside the Worker.
 *
 * That header says who, and nothing more. What they may do is read from the
 * room's member table at connect time, so a role change takes effect on the
 * next socket rather than whenever the credential that asserted it expires.
 */

import { routeAgentRequest, getAgentByName } from "agents";

import { mintToken, newId, verifyToken } from "./auth";
import {
  clearedSessionCookie,
  mintSession,
  sameOrigin,
  sessionCookie,
  sessionUid,
} from "./session";
import {
  authorizeUrl,
  deriveUid,
  exchangeCode,
  fetchProfile,
  isConfigured,
  GITHUB_REPO_SCOPE,
  isRepoConnectState,
  signState,
  verifyState,
  safeAvatarUrl,
  type OAuthProvider,
} from "./oauth";
import { appSlug, listUserInstallations } from "./github";
import { githubConfigured, githubRepositoryAuthorization } from "./github-config";
import { sanitizePush, type SidebarSyncResponse } from "../shared/sidebar";
import { sanitizeLibraryPush, type LibrarySyncResponse } from "../shared/library";
import { sanitizeSkillsPush, type SkillsSyncResponse } from "../shared/skills";
import {
  PROJECT_INVITE_CODE_RE,
  PROJECT_INVITE_MAX_ROOMS,
  type ProjectInviteRequest,
  type ProjectInviteRoom,
  type ProjectInviteResponse,
  type ProjectInviteRedeemRequest,
  type ProjectInviteRedeemResponse,
} from "../shared/project-invites";
import { isProjectInviteCode } from "./projectIndex";
import {
  ROOM_ID_RE,
  UID_RE,
  IDENTITY_MARKER,
  type AuthConfigResponse,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type JoinRoomRequest,
  type JoinRoomResponse,
} from "../shared/protocol";

export { Room } from "./room";
export { UserIndex } from "./userIndex";
export { ProjectIndex } from "./projectIndex";

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
 * The Durable Object holding one account's sidebar, addressed by the uid that
 * `deriveUid` produces — the same on every device the person signs in on,
 * which is the whole point of it.
 */
function userIndex(env: Env, uid: string) {
  return env.UserIndex.get(env.UserIndex.idFromName(uid));
}

function projectIndex(env: Env) {
  // Invite codes are the only lookup key available when a recipient opens a
  // link, so all project invite records share one small coordination object.
  // The room Durable Objects remain the authority for access checks.
  return env.ProjectIndex.getByName("project-invites");
}

function projectRooms(value: unknown): ProjectInviteRoom[] {
  if (!Array.isArray(value)) return [];
  const rooms: ProjectInviteRoom[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const roomId = typeof rec.roomId === "string" ? rec.roomId : "";
    const label = typeof rec.label === "string" ? rec.label.trim().slice(0, 42) : "";
    if (!ROOM_ID_RE.test(roomId) || !label || seen.has(roomId)) continue;
    seen.add(roomId);
    rooms.push({ roomId, label });
    if (rooms.length === PROJECT_INVITE_MAX_ROOMS) break;
  }
  return rooms;
}

async function authorizeProjectRooms(env: Env, uid: string, rooms: ProjectInviteRoom[]): Promise<boolean> {
  if (rooms.length === 0) return false;
  const checks = await Promise.all(rooms.map(async ({ roomId }) => {
    try {
      const res = await roomStub(env, roomId).then((stub) => stub.fetch("https://room/project-authorize", {
        method: "POST",
        body: JSON.stringify({ uid }),
        headers: { "content-type": "application/json", "x-internal-auth": env.ROOM_SECRET },
      }));
      return res.ok;
    } catch {
      return false;
    }
  }));
  return checks.every(Boolean);
}

/**
 * Note a room in its member's sidebar, and never fail the request over it.
 *
 * A room the person is already inside is worth more than a bookmark to it: if
 * this write fails they still have the room, the token and the link, and their
 * next sidebar sync will carry the room up anyway. So a failure here is
 * swallowed rather than turned into a create or join that did not happen.
 */
async function rememberRoom(env: Env, uid: string, roomId: string, title: string): Promise<void> {
  try {
    await userIndex(env, uid).remember(roomId, title);
  } catch {
    // Deliberately ignored — see above.
  }
}

// Deliberately loose. The only thing a stricter pattern would buy is rejecting
// addresses that are unusual rather than wrong, and a waitlist that silently
// drops a real address is worse than one holding a few undeliverable ones.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
// RFC 5321's ceiling on a whole address.
const EMAIL_MAX = 254;
const WAITLIST_NAME_MAX = 64;

/** Pull the client id/secret pair for an OAuth sign-in provider off env. */
function providerConfig(env: Env, provider: "github" | "google"): { clientId?: string; clientSecret?: string } {
  if (provider === "github") {
    return { clientId: env.GITHUB_OAUTH_CLIENT_ID, clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET };
  }
  return { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET };
}

/**
 * The sign-in providers this deployment has both secrets for. Each one
 * becomes a button on the sign-in screen, so configuring two offers a
 * choice rather than a single mandatory account type.
 *
 * GitHub sign-in uses a standalone OAuth App and remains independent from the
 * GitHub App user authorization used for repository installations. Signing in
 * asks only for `read:user`; it never grants repository access.
 */
function configuredProviders(env: Env): ("github" | "google")[] {
  return (["github", "google"] as const).filter((provider) => isConfigured(providerConfig(env, provider)));
}

/**
 * Whether this deployment requires sign-in before a caller may create or join
 * a room. A deployment with no provider configured keeps the old open
 * behaviour on purpose, so local development and the mock model still work
 * with no setup.
 */
function signInRequired(env: Env): boolean {
  return configuredProviders(env).length > 0;
}

/**
 * Resolve an identity token into the uid/name it was minted for.
 *
 * Returns null for anything that isn't a valid, current identity token —
 * including a well-formed room token, which is rejected by the rid check
 * below.
 */
async function identityFrom(env: Env, token: unknown): Promise<{ uid: string; name: string; avatar: string } | null> {
  if (typeof token !== "string") return null;
  const claims = await verifyToken(env.ROOM_SECRET, token);
  if (!claims) return null;
  // Without this check a room token — which always carries a real room id in
  // rid — would authenticate as an identity, since both are minted by the
  // same mintToken/verifyToken machinery.
  if (claims.rid !== IDENTITY_MARKER) return null;
  if (!UID_RE.test(claims.uid)) return null;
  return { uid: claims.uid, name: claims.role, avatar: typeof claims.avatar === "string" ? claims.avatar : "" };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Waitlist signups from the apex landing page. This is the one route that
    // belongs to huddleai.org rather than to the app, and it stays open to
    // anyone: there is no identity yet for someone who has never been let in.
    // It sits above the secret guards below on purpose — collecting an address
    // needs neither the model key nor the room secret, and the page that posts
    // here is the one page that should still work on a Worker missing them.
    if (url.pathname === "/api/waitlist") {
      if (request.method !== "POST") return json({ error: "bad_request" }, 405);
      if (!env.WAITLIST_DB) return json({ error: "waitlist_unavailable" }, 503);

      let body: { email?: unknown; name?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: "bad_request" }, 400);
      }

      const email = String(body.email ?? "").trim().toLowerCase();
      if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
        return json({ error: "bad_email" }, 400);
      }
      const name = String(body.name ?? "").trim().slice(0, WAITLIST_NAME_MAX);

      try {
        // An address already on the list is a success, not a conflict: the
        // person asked to be on the waitlist and they are. Answering anything
        // else would also turn the form into a way to test whether a given
        // address has signed up.
        await env.WAITLIST_DB.prepare(
          "INSERT INTO waitlist (email, name, source, created_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT (email) DO NOTHING",
        )
          .bind(email, name, url.hostname, Date.now())
          .run();
      } catch {
        return json({ error: "waitlist_failed" }, 500);
      }

      return json({ ok: true });
    }

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

    /**
     * Establish or end the session cookie.
     *
     * Called once when a room is opened, not once per connect: the cookie is
     * then attached to every upgrade and every reconnect for free. That is the
     * whole reason for preferring it to a per-connect ticket — reconnects
     * arrive in storms, and this path is not on them.
     */
    if (url.pathname === "/api/session") {
      if (request.method === "DELETE") {
        return new Response(null, {
          status: 204,
          headers: { "set-cookie": clearedSessionCookie() },
        });
      }
      if (request.method !== "POST") return json({ error: "bad_request" }, 405);

      let body: { identity?: unknown; token?: unknown };
      try {
        body = (await request.json()) as { identity?: unknown; token?: unknown };
      } catch {
        return json({ error: "bad_request" }, 400);
      }

      // A signed identity is the stronger of the two and is tried first.
      const identity = await identityFrom(env, body.identity);
      if (identity) {
        const session = await mintSession(env.ROOM_SECRET, identity);
        return new Response(JSON.stringify({ uid: identity.uid }), {
          headers: { "content-type": "application/json", "set-cookie": sessionCookie(session) },
        });
      }

      // Otherwise a room token, which is what a tab has on a deployment with
      // sign-in switched off. It proves the same uid, so exchanging it grants
      // nothing new — but the session is capped at the token's own expiry so
      // the exchange cannot extend it.
      if (typeof body.token === "string") {
        const claims = await verifyToken(env.ROOM_SECRET, body.token);
        if (claims && ROOM_ID_RE.test(claims.rid) && UID_RE.test(claims.uid)) {
          const session = await mintSession(
            env.ROOM_SECRET,
            { uid: claims.uid, name: "", avatar: "" },
            claims.exp,
          );
          return new Response(JSON.stringify({ uid: claims.uid }), {
            headers: { "content-type": "application/json", "set-cookie": sessionCookie(session) },
          });
        }
      }

      return json({ error: "unauthorized" }, 401);
    }

    if (url.pathname === "/api/rooms") {
      if (request.method !== "POST") return json({ error: "bad_request" }, 405);

      let body: CreateRoomRequest;
      try {
        body = (await request.json()) as CreateRoomRequest;
      } catch {
        return json({ error: "bad_request" }, 400);
      }

      let uid: string;
      let name: string;
      let avatar = "";
      if (body.identity !== undefined) {
        const identity = await identityFrom(env, body.identity);
        if (!identity) return json({ error: "sign_in_required" }, 401);
        // The body's uid/name are ignored once a signed identity exists —
        // trusting them anyway would make the whole thing decorative.
        uid = identity.uid;
        name = identity.name;
        avatar = identity.avatar;
      } else if (signInRequired(env)) {
        // Closes unauthenticated room creation on a deployment that has
        // sign-in switched on: no identity and no fallback allowed.
        return json({ error: "sign_in_required" }, 401);
      } else {
        // Sign-in is off on this deployment — fall back to the body fields
        // exactly as before.
        uid = String(body.uid ?? "");
        name = body.name;
      }
      if (!UID_RE.test(uid)) return json({ error: "bad_request" }, 400);

      const roomId = newId(22);
      const stub = await roomStub(env, roomId);
      const initRes = await stub.fetch("https://room/init", {
        method: "POST",
        body: JSON.stringify({ uid, name, avatar, title: body.title }),
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

      const { role, title } = (await initRes.json()) as { role: string; title: string };
      const token = await mintToken(env.ROOM_SECRET, {
        rid: roomId,
        uid,
        role,
        exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
      });
      await rememberRoom(env, uid, roomId, title);

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

      let uid: string;
      let name: string;
      let avatar = "";
      let identityUsed = false;
      if (body.identity !== undefined) {
        const identity = await identityFrom(env, body.identity);
        if (!identity) return json({ error: "sign_in_required" }, 401);
        // The body's uid/name are ignored once a signed identity exists —
        // trusting them anyway would make the whole thing decorative.
        uid = identity.uid;
        name = identity.name;
        avatar = identity.avatar;
        identityUsed = true;
      } else if (signInRequired(env)) {
        // Closes unauthenticated room joining on a deployment that has
        // sign-in switched on: no identity and no fallback allowed.
        return json({ error: "sign_in_required" }, 401);
      } else {
        // Sign-in is off on this deployment — fall back to the body fields
        // exactly as before.
        uid = String(body.uid ?? "");
        name = body.name;
      }
      if (!ROOM_ID_RE.test(roomId) || !UID_RE.test(uid)) {
        return json({ error: "bad_request" }, 400);
      }

      // Only meaningful when a signed identity chose the uid above. With
      // sign-in off the browser-local uid IS the uid, so there is nothing to
      // link and forwarding it would just be the same value twice.
      const claim = identityUsed ? String(body.claim ?? "") : "";

      const stub = await roomStub(env, roomId);
      const admitRes = await stub.fetch("https://room/admit", {
        method: "POST",
        body: JSON.stringify({ uid, name, avatar, code: body.code, claim }),
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

      const { role, title } = (await admitRes.json()) as { role: string; title: string };
      const token = await mintToken(env.ROOM_SECRET, {
        rid: roomId,
        uid,
        role,
        exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
      });
      // An invite link is how most people meet a room, and until now following
      // one left no trace in the sidebar at all — the room was reachable only
      // from the link itself. Recording it here puts it in the sidebar on
      // every device the account is signed in on.
      await rememberRoom(env, uid, roomId, title);

      return json({ token, role } satisfies JoinRoomResponse);
    }

    const roomExitMatch = url.pathname.match(/^\/api\/rooms\/([0-9A-Za-z]{22})\/exit$/);
    if (roomExitMatch) {
      if (request.method !== "POST") return json({ error: "bad_request" }, 405);

      let body: { token?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: "bad_request" }, 400);
      }

      const roomId = roomExitMatch[1]!;
      const token = typeof body.token === "string" ? body.token : "";
      const claims = token ? await verifyToken(env.ROOM_SECRET, token) : null;
      if (!claims || claims.rid !== roomId || !UID_RE.test(claims.uid)) {
        return json({ error: "unauthorized" }, 401);
      }

      const exitRes = await (await roomStub(env, roomId)).fetch("https://room/presence-exit", {
        method: "POST",
        body: JSON.stringify({ uid: claims.uid }),
        headers: {
          "content-type": "application/json",
          "x-internal-auth": env.ROOM_SECRET,
        },
      });
      if (!exitRes.ok) {
        return new Response(exitRes.body, {
          status: exitRes.status,
          headers: exitRes.headers,
        });
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/api/project-invites") {
      if (request.method !== "POST") return json({ error: "bad_request" }, 405);
      let body: ProjectInviteRequest;
      try { body = (await request.json()) as ProjectInviteRequest; } catch { return json({ error: "bad_request" }, 400); }

      const identity = await identityFrom(env, body.identity);
      const actorUid = identity?.uid ?? (signInRequired(env) ? "" : String(body.uid ?? ""));
      if (!UID_RE.test(actorUid)) return json({ error: "sign_in_required" }, 401);
      if (typeof body.projectId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.projectId)) return json({ error: "bad_request" }, 400);
      const rooms = projectRooms(body.rooms);
      const index = projectIndex(env);
      const existing = body.code && PROJECT_INVITE_CODE_RE.test(body.code) ? await index.get(body.code) : null;

      if (body.action === "list") {
        if (!(await authorizeProjectRooms(env, actorUid, rooms))) return json({ error: "forbidden" }, 403);
        const invites = (await index.list()).filter((invite) => invite.projectId === body.projectId);
        return json({ ok: true, invites } satisfies ProjectInviteResponse);
      }

      if (body.action === "create") {
        const projectName = typeof body.projectName === "string" ? body.projectName.trim().slice(0, 42) : "";
        const role = body.role === "editor" ? "editor" : body.role === "viewer" ? "viewer" : "";
        if (!projectName || !role || rooms.length === 0 || !(await authorizeProjectRooms(env, actorUid, rooms))) return json({ error: "forbidden" }, 403);
        const invite = await index.create({ code: newId(32), projectId: body.projectId, projectName, role, rooms });
        return json({ ok: true, invite } satisfies ProjectInviteResponse);
      }

      if (!existing || existing.projectId !== body.projectId || existing.revoked) return json({ error: "not_found" }, 404);
      const allRooms = projectRooms([...existing.rooms, ...rooms]);
      if (!(await authorizeProjectRooms(env, actorUid, allRooms))) return json({ error: "forbidden" }, 403);

      if (body.action === "revoke") {
        await index.revoke(existing.code);
        return json({ ok: true } satisfies ProjectInviteResponse);
      }
      if (body.action === "update") {
        const projectName = typeof body.projectName === "string" ? body.projectName.trim().slice(0, 42) : existing.projectName;
        const role = body.role === "editor" ? "editor" : body.role === "viewer" ? "viewer" : existing.role;
        if (!projectName || rooms.length === 0) return json({ error: "bad_request" }, 400);
        const invite = await index.update({ code: existing.code, projectName, role, rooms });
        if (!invite) return json({ error: "not_found" }, 404);
        return json({ ok: true, invite } satisfies ProjectInviteResponse);
      }
      return json({ error: "bad_request" }, 400);
    }

    if (url.pathname === "/api/project-invites/redeem") {
      if (request.method !== "POST") return json({ error: "bad_request" }, 405);
      let body: ProjectInviteRedeemRequest;
      try { body = (await request.json()) as ProjectInviteRedeemRequest; } catch { return json({ error: "bad_request" }, 400); }
      if (!isProjectInviteCode(body.code)) return json({ error: "bad_code" }, 403);

      let uid: string;
      let name: string;
      let avatar = "";
      const identity = await identityFrom(env, body.identity);
      if (identity) {
        uid = identity.uid;
        name = identity.name;
        avatar = identity.avatar;
      } else if (signInRequired(env)) {
        return json({ error: "sign_in_required" }, 401);
      } else {
        uid = String(body.uid ?? "");
        name = String(body.name ?? "").trim().slice(0, 32) || "anon";
        if (!UID_RE.test(uid)) return json({ error: "bad_request" }, 400);
      }

      const record = await projectIndex(env).get(body.code);
      if (!record || record.revoked) return json({ error: "bad_code" }, 403);
      const joined: ProjectInviteRedeemResponse["rooms"] = [];
      for (const room of record.rooms) {
        try {
          const admitted = await roomStub(env, room.roomId).then((stub) => stub.fetch("https://room/project-admit", {
            method: "POST",
            body: JSON.stringify({ uid, name, avatar, role: record.role }),
            headers: { "content-type": "application/json", "x-internal-auth": env.ROOM_SECRET },
          }));
          if (!admitted.ok) continue;
          const result = (await admitted.json()) as { role: string };
          const role = result.role === "owner" || result.role === "admin" || result.role === "editor" || result.role === "viewer" ? result.role : record.role;
          joined.push({ ...room, token: await mintToken(env.ROOM_SECRET, { rid: room.roomId, uid, role, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }), role });
        } catch {
          // A deleted or unavailable room does not prevent the remaining
          // rooms in a project invitation from being admitted.
        }
      }
      if (joined.length === 0) return json({ error: "not_found" }, 404);
      return json({ project: { id: record.projectId, name: record.projectName }, rooms: joined } satisfies ProjectInviteRedeemResponse);
    }

    /**
     * The account's sidebar: rooms and projects that follow the person rather
     * than the browser.
     *
     * One route does both directions. The body is what this browser knows and
     * the response is what the account knows, because a browser that has been
     * away has nothing useful to say about ordering and a request each way
     * would only widen the window in which the two disagree.
     *
     * Identity is required and there is no unauthenticated fallback: without a
     * signed identity there is no stable uid to key a sidebar by, and a uid
     * taken from the body would let anyone read anyone's room list. A
     * deployment with sign-in switched off simply never calls this — the
     * client keeps the browser-local sidebar it has always had.
     */
    if (url.pathname === "/api/sidebar") {
      if (request.method !== "POST") return json({ error: "bad_request" }, 405);

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad_request" }, 400);
      }

      const identity = await identityFrom(env, (body as { identity?: unknown }).identity);
      if (!identity) return json({ error: "sign_in_required" }, 401);

      const push = sanitizePush(body, Date.now(), (id) => ROOM_ID_RE.test(id));
      const snapshot = await userIndex(env, identity.uid).sync(push);
      return json(snapshot satisfies SidebarSyncResponse);
    }

    /**
     * The account's workflow library: the agent graphs this person saved, which
     * follow them rather than the browser they drew them in.
     *
     * Same shape and same rules as /api/sidebar — a signed identity is the only
     * way in, because the uid it carries is the address of the Durable Object
     * holding the library, and a caller that could name its own uid could read
     * anybody's. A deployment with sign-in off has no account to sync with, and
     * the client keeps the browser-local library it has always had.
     *
     * Nothing here is a room credential. A saved workflow is a drawing of a
     * team; applying one to a room still goes over that room's socket and is
     * still re-checked against the `workflow` capability there.
     */
    if (url.pathname === "/api/workflows") {
      if (request.method !== "POST") return json({ error: "bad_request" }, 405);

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad_request" }, 400);
      }

      const identity = await identityFrom(env, (body as { identity?: unknown }).identity);
      if (!identity) return json({ error: "sign_in_required" }, 401);

      const push = sanitizeLibraryPush(body, Date.now());
      const snapshot = await userIndex(env, identity.uid).syncWorkflows(push);
      return json(snapshot satisfies LibrarySyncResponse);
    }

    /**
     * The account's skills library: the Agent Skills this person installed,
     * which follow them rather than the browser they pasted a repo URL into.
     *
     * Same shape and same rules as the two routes above, and a signed identity
     * is again the only way in — the uid is the address of the Durable Object
     * holding the library, so a caller that could name its own uid could read
     * and rewrite anybody's.
     *
     * Nothing here is a room credential, and the `enabledIn` field this route
     * happily accepts is not one either. It records which rooms a person has
     * *asked* to enable a skill in; whether the shared agent actually loads it
     * is decided in the room, against that room's vote and its own capability
     * check, exactly as applying a saved workflow is. A push that claims a room
     * id nobody approved buys nothing but a row in its own library.
     */
    if (url.pathname === "/api/skills") {
      if (request.method !== "POST") return json({ error: "bad_request" }, 405);

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad_request" }, 400);
      }

      const identity = await identityFrom(env, (body as { identity?: unknown }).identity);
      if (!identity) return json({ error: "sign_in_required" }, 401);

      const push = sanitizeSkillsPush(body, Date.now());
      const snapshot = await userIndex(env, identity.uid).syncSkills(push);
      return json(snapshot satisfies SkillsSyncResponse);
    }

    if (url.pathname === "/api/auth/config") {
      // Never include secrets — this is how the client decides whether to
      // render sign-in buttons at all.
      return json({ providers: configuredProviders(env) } satisfies AuthConfigResponse);
    }

    const authStartMatch = url.pathname.match(/^\/api\/auth\/(github|google)\/start$/);
    if (authStartMatch) {
      const provider = authStartMatch[1] as OAuthProvider;
      const cfg = providerConfig(env, provider);
      if (!isConfigured(cfg)) return json({ error: "not_found" }, 404);

      const returnTo = url.searchParams.get("returnTo") ?? "/";
      const state = await signState(env.ROOM_SECRET, provider, returnTo);
      // The redirect URI is derived from the request origin rather than
      // configured, so the same deployment works on localhost and in
      // production without a second setting. It must match what is
      // registered with the provider.
      const redirectUri = `${url.origin}/api/auth/${provider}/callback`;
      return Response.redirect(authorizeUrl(provider, cfg.clientId!, redirectUri, state), 302);
    }

    const authCallbackMatch = url.pathname.match(/^\/api\/auth\/(github|google)\/callback$/);
    if (authCallbackMatch) {
      const provider = authCallbackMatch[1] as OAuthProvider;
      const cfg = providerConfig(env, provider);

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        return new Response("That sign-in link is invalid or has expired. Start again.", { status: 400 });
      }

      // The GitHub OAuth App permits exactly one registered callback URL, so
      // repository connection cannot have a route of its own — it shares
      // this same sign-in callback and is told apart from an ordinary
      // sign-in purely by the signed state token (isRepoConnectState is the
      // only thing that distinguishes them). The access token GitHub hands
      // back is passed straight to the room's Durable Object over the
      // internal channel below; it is never placed in a URL, a cookie, a
      // log line, or room state.
      if (provider === "github") {
        const claims = await verifyToken(env.ROOM_SECRET, state);
        if (claims && isRepoConnectState(claims)) {
          if (!/^[A-Za-z0-9]{22}$/.test(claims.rid)) {
            return new Response(
              "That link is invalid or has expired. Start again from the room.",
              { status: 400 },
            );
          }
          const repositoryAuth = githubRepositoryAuthorization(env);
          if (!repositoryAuth) return json({ error: "not_found" }, 404);

          const redirectUri = `${url.origin}/api/auth/github/callback`;
          const exchanged = await exchangeCode(
            "github",
            repositoryAuth.config,
            code,
            redirectUri,
          );
          if (!exchanged.ok) return new Response(exchanged.error, { status: 502 });

          // A deployment that asked for the OAuth route must actually have
          // got an OAuth App token. If GITHUB_OAUTH_CLIENT_ID in fact names a
          // GitHub App's OAuth client, the `repo` scope requested at the
          // authorize step is ignored without complaint and what comes back
          // is another user-to-server token — same installation limits, no
          // error, nothing on screen. Refusing here is the difference between
          // a misconfiguration that is reported and one that is only noticed
          // weeks later as "some repositories are missing".
          if (repositoryAuth.kind === "oauth") {
            const granted = exchanged.scope.split(",").map((entry) => entry.trim());
            if (!granted.includes(GITHUB_REPO_SCOPE)) {
              return new Response(
                `GitHub granted "${exchanged.scope || "no scopes"}" rather than the "${GITHUB_REPO_SCOPE}" scope this ` +
                  `deployment asked for. GITHUB_OAUTH_CLIENT_ID must name a classic OAuth App: a GitHub App's OAuth ` +
                  `client silently ignores scopes and cannot reach repositories outside its installations.`,
                { status: 502 },
              );
            }
          }

          // OAuth-only deployments can proceed without a display label. A
          // GitHub App deployment requires the immutable provider id below to
          // match a personal installation to the person who authorized it.
          const fetched = await fetchProfile("github", exchanged.accessToken);
          const login = fetched.ok ? fetched.profile.name : "";
          // Carried alongside the label because it is the durable half: a
          // display name changes and is not unique, while this id is
          // GitHub's own and is what later proves an App installation
          // belongs to this person. See github_oauth.github_id in room.ts.
          const githubId = fetched.ok ? fetched.profile.providerId : "";

          const stub = await roomStub(env, claims.rid);
          const stored = await stub.fetch("https://room/github-oauth", {
            method: "POST",
            body: JSON.stringify({ uid: claims.uid, token: exchanged.accessToken, login, githubId }),
            headers: {
              "content-type": "application/json",
              "x-internal-auth": env.ROOM_SECRET,
            },
          });
          if (!stored.ok) {
            return new Response(stored.body, { status: stored.status, headers: stored.headers });
          }

          if (githubConfigured(env)) {
            if (!fetched.ok) return new Response(fetched.error, { status: 502 });

            // Recovering an existing App installation is opportunistic. The
            // token was stored above and the room is connected either way;
            // all this can do is save someone an install round trip.
            //
            // It cannot always be attempted. /user/installations answers only
            // to a GitHub App user-to-server token, so a deployment whose
            // OAuth credentials belong to a classic OAuth App is refused here
            // every time, for every account — and failing the connect on that
            // made the OAuth path unusable on any deployment that also has an
            // App configured. So a listing that cannot be read now means
            // "nothing to recover" rather than an error. The cost is that a
            // transient GitHub failure quietly skips the shortcut instead of
            // reporting itself, which is the right way round for a step that
            // is only ever a shortcut.
            const found = await listUserInstallations(exchanged.accessToken);
            if (found.ok) {
              const ownInstallation = found.installations.find(
                (installation) => installation.targetType === "User" && installation.accountId === fetched.profile.providerId,
              );
              const installation = ownInstallation ?? (found.installations.length === 1 ? found.installations[0] : undefined);

              if (installation) {
                const installed = await stub.fetch("https://room/github-installed", {
                  method: "POST",
                  body: JSON.stringify({ installationId: installation.id, uid: claims.uid }),
                  headers: {
                    "content-type": "application/json",
                    "x-internal-auth": env.ROOM_SECRET,
                  },
                });
                if (!installed.ok) {
                  return new Response(installed.body, { status: installed.status, headers: installed.headers });
                }
                return Response.redirect(`${url.origin}/?app=1&gh=installed#/r/${claims.rid}`, 302);
              }

              if (found.installations.length > 1) {
                return new Response(
                  "More than one organization installation is available. Install the app on your personal account or select one organization and try again.",
                  { status: 409 },
                );
              }

              const slug = await appSlug({
                appId: env.GITHUB_APP_ID,
                privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
              });
              if (!slug.ok) return new Response(slug.error, { status: 502 });
              return Response.redirect(
                `https://github.com/apps/${encodeURIComponent(slug.slug)}/installations/new?state=${encodeURIComponent(state)}`,
                302,
              );
            }
          }

          return Response.redirect(`${url.origin}/?gh=connected#/r/${claims.rid}`, 302);
        }
        // Not a repository-connect state (or not a valid token at all) —
        // fall through to the ordinary sign-in verification below, which
        // rejects it on its own terms if it isn't valid sign-in state either.
      }

      if (!isConfigured(cfg)) return json({ error: "not_found" }, 404);

      // This is what stops a forged callback: verifyState only accepts a
      // token this server minted via signState. It also rejects a room
      // token outright (a room token's rid is never the oauth-state marker),
      // so a room credential can never be replayed here as sign-in state.
      const verified = await verifyState(env.ROOM_SECRET, state);
      if (!verified || verified.provider !== provider) {
        return new Response("That sign-in link is invalid or has expired. Start again.", { status: 400 });
      }
      const { returnTo } = verified;

      const redirectUri = `${url.origin}/api/auth/${provider}/callback`;
      const exchanged = await exchangeCode(provider, cfg as { clientId: string; clientSecret: string }, code, redirectUri);
      if (!exchanged.ok) return new Response(exchanged.error, { status: 502 });

      const fetched = await fetchProfile(provider, exchanged.accessToken);
      if (!fetched.ok) return new Response(fetched.error, { status: 502 });

      const uid = await deriveUid(provider, fetched.profile.providerId);
      // rid is the identity marker rather than a room id, so an identity
      // token can never be mistaken for admission to a room. The display
      // name rides in `role` because the token shape is fixed.
      const token = await mintToken(env.ROOM_SECRET, {
        rid: IDENTITY_MARKER,
        uid,
        role: fetched.profile.name.slice(0, 32) || provider,
        avatar: safeAvatarUrl(provider, fetched.profile.avatar),
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
      });

      // The token rides in the URL fragment, not a query parameter: a
      // fragment is never sent to a server, so it does not land in the
      // Worker's logs or any intermediary's. It stays in localStorage and
      // drives the signed-in UI; the cookie set alongside it is what actually
      // opens sockets, and unlike the token it is not readable by script.
      const session = await mintSession(env.ROOM_SECRET, {
        uid,
        name: fetched.profile.name,
        avatar: safeAvatarUrl(provider, fetched.profile.avatar),
      });
      // Response.redirect cannot carry extra headers, so the redirect is built
      // by hand to make room for Set-Cookie.
      return new Response(null, {
        status: 302,
        headers: {
          location: `${url.origin}${returnTo}#auth=${token}`,
          "set-cookie": sessionCookie(session),
        },
      });
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

      return Response.redirect(`${url.origin}/?app=1&gh=installed#/r/${claims.rid}`, 302);
    }

    /**
     * Verify the connecting socket's token before it ever reaches the Durable
     * Object. This runs for every `/agents/room/:roomId` upgrade.
     */
    async function onBeforeConnect(req: Request): Promise<Request | Response> {
      const reqUrl = new URL(req.url);
      const segments = reqUrl.pathname.split("/").filter(Boolean);
      const roomId = segments.at(-1) ?? "";

      // The session cookie is the credential. It identifies the person, not
      // the room: which rooms they may open is decided by the room's own
      // member table, which the Durable Object consults on every connect and
      // which is the only thing that is current.
      let uid = await sessionUid(req, env.ROOM_SECRET);

      // Checked here rather than at the top of this function, because it is
      // the cookie that needs it. A browser attaches the cookie to any upgrade
      // aimed at this origin, including one opened by a page on another site,
      // and a WebSocket handshake is not covered by CORS — so without this a
      // hostile page could open an authenticated socket to any room its
      // visitor belongs to. A `tk` request cannot be forged that way (the page
      // would need the token itself), so the fallback below keeps its old
      // behaviour and does not require an Origin. See session.ts.
      if (uid && !sameOrigin(req, reqUrl.origin)) {
        return new Response("forbidden", { status: 403 });
      }

      if (!uid) {
        // ROLLOUT FALLBACK. A tab loaded before the cookie existed still has a
        // room token in localStorage and no session. Remove this once those
        // have aged out — while it stands, the credential is still in the URL
        // and still in the request logs, which is the thing the cookie fixes.
        const token = reqUrl.searchParams.get("tk");
        if (!token) return new Response("unauthorized", { status: 401 });

        const claims = await verifyToken(env.ROOM_SECRET, token);
        if (!claims) return new Response("unauthorized", { status: 401 });

        // A token minted for one room must never open a socket to another.
        // The cookie path needs no equivalent: it grants nothing by itself.
        if (claims.rid !== roomId) return new Response("unauthorized", { status: 401 });
        uid = claims.uid;
      }

      const headers = new Headers(req.headers);
      // `set` overwrites any value already on the request, which is what stops
      // a client from supplying its own x-room-uid on the upgrade request.
      headers.set("x-room-uid", uid);
      // No role header. Role is read from the member record inside the room —
      // a credential that carried one would still be asserting the role held
      // when it was minted, days after a demotion.
      headers.delete("x-room-role");
      // The Durable Object needs the deployment's own origin to build an
      // OAuth redirect URI for repository connection. It must come from the
      // server, like the other bound headers above — `headers.set`
      // overwrites, so a client cannot forge it.
      headers.set("x-room-origin", reqUrl.origin);
      return new Request(req, { headers });
    }

    // An unrecognised /api/ path is a mistake, not a page. Without this it
    // falls through to the asset server, which answers every unknown path with
    // the single-page app — so a typo'd endpoint would return 200 and a body of
    // HTML, and the caller would fail at .json() somewhere far from the cause.
    if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);

    // /agents/room/:name -> the Room Durable Object for that name.
    const routed = await routeAgentRequest(request, env, { onBeforeConnect });
    if (routed) return routed;

    // Everything else is the single-page app.
    return env.ASSETS.fetch(request);
  },
};
