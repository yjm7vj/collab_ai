/**
 * App owns routing and admission — nothing else.
 *
 * The URL hash is the router (there is no router library here): `#/r/<id>`
 * opens a room, `#/j/<id>/<code>` is an invite link into one. Neither is
 * enough to get in on its own. A room now has an unguessable 22-character id
 * and a socket to it cannot be opened without a signed token, and a token can
 * only be obtained over plain HTTP, before the socket exists, by creating a
 * room or by being admitted through `/api/join`. App's whole job is to make
 * sure that token exists before `RoomView` — which owns the live socket and
 * everything downstream of it — is ever allowed to mount.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  ROOM_ID_RE,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type JoinRefusal,
  type JoinRoomRequest,
  type JoinRoomResponse,
} from "../shared/protocol";
import { Landing, JoinGate, SidePane, SignInGate } from "./components";
import { RoomView } from "./RoomView";

/**
 * A durable id for this browser, so a reload or a second tab is the same person.
 * Not a credential — the server treats it as a claim, not proof.
 */
function myUid(): string {
  const key = "collab_ai:uid";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const fresh = crypto.randomUUID().replace(/-/g, "");
  localStorage.setItem(key, fresh);
  return fresh;
}

const IDENTITY_KEY = "collab_ai:identity";
const PROJECTS_KEY = "collab_ai:projects";
const THEME_KEY = "collab_ai:theme";
function storedIdentity(): string | null {
  return localStorage.getItem(IDENTITY_KEY);
}

type Theme = "light" | "dark";
function storedTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
}

type SidebarProject = {
  name: string;
  channels: { label: string; detail: string }[];
};

function storedProjects(): SidebarProject[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((p) => {
        if (!p || typeof p !== "object") return null;
        const rec = p as Record<string, unknown>;
        if (typeof rec.name !== "string") return null;
        return {
          name: rec.name,
          channels: Array.isArray(rec.channels)
            ? rec.channels.flatMap((c) => {
                if (!c || typeof c !== "object") return [];
                const channel = c as Record<string, unknown>;
                return typeof channel.label === "string" && typeof channel.detail === "string"
                  ? [{ label: channel.label, detail: channel.detail }]
                  : [];
              })
            : [],
        };
      })
      .filter((p): p is SidebarProject => Boolean(p));
  } catch {
    return [];
  }
}

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return atob(padded + pad);
}

/**
 * Decode the display fields from an identity token.
 *
 * The token is signed, not encrypted, so reading it for display is safe.
 * This is NOT an authorisation check — the server verifies the signature on
 * every request, and nothing decoded here may decide what a user can do.
 */
function readIdentity(token: string): { uid: string; name: string } | null {
  try {
    const payload = token.split(".")[0];
    if (!payload) return null;
    const parsed = JSON.parse(base64UrlDecode(payload)) as { uid?: unknown; role?: unknown };
    if (typeof parsed.uid !== "string" || typeof parsed.role !== "string") return null;
    return { uid: parsed.uid, name: parsed.role };
  } catch {
    return null;
  }
}

/**
 * Pull a `#auth=<token>` fragment out of the URL on mount and store it.
 *
 * This app routes on the hash (`#/r/<id>`), and the sign-in redirect returns
 * to `<returnTo>#auth=<token>`, where `returnTo` was
 * `location.pathname + location.hash` when sign-in began. So when the
 * original route was itself a hash route, the token lands concatenated onto
 * it: only the FIRST `#` in a URL actually starts the fragment, so
 * `location.hash` here is the single string `"#/r/<id>#auth=<token>"`, not
 * two separate fragments — the second `#` is just a literal character
 * inside it. We split on the literal `auth=` marker to recover both pieces:
 * everything before the `#` that immediately precedes the marker is the
 * route the person was heading to, and everything after the marker is the
 * token. If there was no route prefix (sign-in started from the landing
 * page, where `returnTo` had no hash at all) the recovered route is empty,
 * which correctly falls through to the landing page.
 *
 * We then use `history.replaceState` to put the recovered route back as the
 * real hash and drop the token from the address bar entirely — a signed
 * credential has no business sitting in a URL that could get copied into a
 * shared link or logged somewhere.
 */
function resolveIncomingAuth(): void {
  const raw = location.hash;
  const markerIdx = raw.indexOf("auth=");
  if (markerIdx === -1) return;
  const token = raw.slice(markerIdx + "auth=".length);
  if (token) localStorage.setItem(IDENTITY_KEY, token);
  const restoredHash = raw.slice(0, markerIdx).replace(/#$/, "");
  history.replaceState(null, "", location.pathname + location.search + restoredHash);
}

type Route =
  | { kind: "landing" }
  | { kind: "room"; roomId: string }
  | { kind: "invite"; roomId: string; code: string };

function parseRoute(): Route {
  const raw = location.hash.replace(/^#/, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] === "r" && parts[1] && ROOM_ID_RE.test(parts[1])) {
    return { kind: "room", roomId: parts[1] };
  }
  if (parts[0] === "j" && parts[1] && parts[2] && ROOM_ID_RE.test(parts[1])) {
    return { kind: "invite", roomId: parts[1], code: parts[2] };
  }
  // Old-scheme room names (like `#lobby`) are deliberately not routable any
  // more — a guessable room name is exactly what this change removes.
  return { kind: "landing" };
}

const tokenKey = (roomId: string) => `collab_ai:token:${roomId}`;
function readToken(roomId: string): string | null {
  return localStorage.getItem(tokenKey(roomId));
}
function writeToken(roomId: string, token: string) {
  localStorage.setItem(tokenKey(roomId), token);
}
function clearToken(roomId: string) {
  localStorage.removeItem(tokenKey(roomId));
}

// A Record keyed by the full union, rather than a switch, so adding a new
// JoinRefusal member is a compile error here instead of a silent fallthrough.
const REFUSAL_MESSAGES: Record<JoinRefusal | "network", string> = {
  not_found: "There's no room at that link. Check you copied all of it.",
  invite_required: "This room is invite-only. Ask someone inside for an invite link.",
  locked: "This room isn't accepting new members.",
  bad_request: "That link doesn't look right.",
  sign_in_required: "You need to sign in before you can create or join a room.",
  bad_code: "That invite code isn't valid. Check the link, or ask for a new one.",
  code_expired: "That invite link has expired. Ask for a new one.",
  code_used_up: "That invite link has already been used as many times as it allows.",
  code_revoked: "That invite link was turned off. Ask for a new one.",
  network: "Couldn't reach the server. Check your connection and try again.",
};

function refusalMessage(reason: JoinRefusal | "network"): string {
  return REFUSAL_MESSAGES[reason];
}

export function App() {
  // Must run before `parseRoute` (and before the identity state below) reads
  // `location.hash`, so it happens first and unconditionally on mount only.
  useMemo(resolveIncomingAuth, []);
  const uid = useMemo(myUid, []);
  const [route, setRoute] = useState<Route>(parseRoute);
  const [name, setName] = useState(() => localStorage.getItem("collab_ai:name") ?? "");
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[] | null>(null);
  const [identity, setIdentity] = useState(() => {
    const t = storedIdentity();
    return t ? readIdentity(t) : null;
  });
  const [projects, setProjects] = useState<SidebarProject[]>(storedProjects);
  const [theme, setTheme] = useState<Theme>(storedTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "light" ? "dark" : "light"));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/config")
      .then((res) => (res.ok ? (res.json() as Promise<{ providers: string[] }>) : Promise.reject()))
      .then((data) => {
        if (!cancelled) setProviders(data.providers);
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // Whenever the route points at a room, pick up any token already stashed
  // for it; otherwise there is nothing to connect with.
  useEffect(() => {
    setProblem(null);
    if (route.kind === "room" || route.kind === "invite") {
      setToken(readToken(route.roomId));
    } else {
      setToken(null);
    }
  }, [route]);

  const createRoom = useCallback(
    async (displayName: string) => {
      setBusy(true);
      try {
        const res = await fetch("/api/rooms", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            uid,
            name: displayName,
            identity: storedIdentity() ?? undefined,
          } satisfies CreateRoomRequest),
        });
        if (!res.ok) {
          const { error } = (await res.json()) as { error: JoinRefusal };
          if (error === "sign_in_required") {
            localStorage.removeItem(IDENTITY_KEY);
            setIdentity(null);
            setProblem("Your sign-in expired. Sign in again to continue.");
            return;
          }
          setProblem(refusalMessage(error));
          return;
        }
        const { roomId, token: tok } = (await res.json()) as CreateRoomResponse;
        writeToken(roomId, tok);
        localStorage.setItem("collab_ai:name", displayName);
        setName(displayName);
        location.hash = "#/r/" + roomId;
      } catch {
        setProblem(refusalMessage("network"));
      } finally {
        setBusy(false);
      }
    },
    [uid],
  );

  const joinRoom = useCallback(
    async (displayName: string) => {
      if (route.kind !== "room" && route.kind !== "invite") return;
      const roomId = route.roomId;
      const code = route.kind === "invite" ? route.code : undefined;
      setBusy(true);
      try {
        const res = await fetch("/api/join", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            roomId,
            uid,
            name: displayName,
            code,
            identity: storedIdentity() ?? undefined,
          } satisfies JoinRoomRequest),
        });
        if (!res.ok) {
          const { error } = (await res.json()) as { error: JoinRefusal };
          if (error === "sign_in_required") {
            localStorage.removeItem(IDENTITY_KEY);
            setIdentity(null);
            setProblem("Your sign-in expired. Sign in again to continue.");
            return;
          }
          setProblem(refusalMessage(error));
          return;
        }
        const { token: tok } = (await res.json()) as JoinRoomResponse;
        writeToken(roomId, tok);
        localStorage.setItem("collab_ai:name", displayName);
        setName(displayName);
        setToken(tok);
      } catch {
        setProblem(refusalMessage("network"));
      } finally {
        setBusy(false);
      }
    },
    [route, uid],
  );

  // A full-page navigation, not a fetch — the provider's consent screen has
  // to actually be shown to the person, which only a real navigation can do.
  const signIn = useCallback((provider: string) => {
    location.href = `/api/auth/${provider}/start?returnTo=${encodeURIComponent(location.pathname + location.hash)}`;
  }, []);

  // Room tokens are a separate credential from the signed-in identity — a
  // signed-out browser silently losing access to rooms it already belongs to
  // would be surprising, so signing out only clears the identity.
  const signOut = useCallback(() => {
    localStorage.removeItem(IDENTITY_KEY);
    setIdentity(null);
  }, []);

  const onAccessLost = useCallback(
    (reason: string) => {
      if (route.kind === "room" || route.kind === "invite") clearToken(route.roomId);
      setToken(null);
      setProblem(reason);
    },
    [route],
  );

  const sideName = identity?.name ?? name;
  const createRoomFromPane = useCallback(() => {
    const displayName = sideName.trim() || "Guest";
    createRoom(displayName);
  }, [createRoom, sideName]);

  const createProject = useCallback((projectName: string) => {
    const trimmed = projectName.trim().slice(0, 42);
    if (!trimmed) return;
    setProjects((prev) => {
      if (prev.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) return prev;
      const next = [
        ...prev,
        {
          name: trimmed,
          channels: [
            { label: "Rooms", detail: "Shared agent sessions for this project" },
            { label: "Workspace", detail: "Files, GitHub repos, and project context" },
          ],
        },
      ];
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const withSidePane = (content: ReactNode) => (
    <div className="side-shell">
      <SidePane
        activeRoomId={route.kind === "room" || route.kind === "invite" ? route.roomId : undefined}
        busy={busy}
        projects={projects}
        onCreateRoom={createRoomFromPane}
        onCreateProject={createProject}
      />
      <main className="side-main">{content}</main>
    </div>
  );

  // `providers` is only `null` for the beat before /api/auth/config answers —
  // render nothing rather than flash the wrong gate (name entry vs. sign-in).
  if (providers === null) return null;

  if (providers.length > 0 && !identity) {
    return (
      <SignInGate
        providers={providers}
        onSignIn={signIn}
        problem={problem}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
  }

  if (route.kind === "landing") {
    const landing = (
      <Landing
        initialName={name}
        busy={busy}
        problem={problem}
        onCreate={createRoom}
        identityName={identity?.name}
        onSignOut={identity ? signOut : undefined}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
    return identity ? withSidePane(landing) : landing;
  }

  if (token) {
    const room = (
      <RoomView
        roomId={route.roomId}
        token={token}
        displayName={name}
        onAccessLost={onAccessLost}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
    return identity ? withSidePane(room) : room;
  }

  const join = (
    <JoinGate
      roomId={route.roomId}
      initialName={name}
      busy={busy}
      problem={problem}
      onJoin={joinRoom}
      identityName={identity?.name}
      onSignOut={identity ? signOut : undefined}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  );
  return identity ? withSidePane(join) : join;
}
