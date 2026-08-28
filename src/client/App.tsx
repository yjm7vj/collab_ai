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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
import type { WorkspaceInfo } from "../shared/workspace";

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
const ROOMS_KEY = "collab_ai:rooms";
const THEME_KEY = "collab_ai:theme";
function storedIdentity(): string | null {
  return localStorage.getItem(IDENTITY_KEY);
}

type Theme = "light" | "dark";
function storedTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
}

type SidebarProject = {
  id: string;
  name: string;
  archived: boolean;
  rooms: SidebarRoom[];
  workspace: WorkspaceInfo;
};

type SidebarRoom = {
  roomId: string;
  label: string;
  projectId?: string;
  archived: boolean;
  workspace: WorkspaceInfo;
};

const EMPTY_WORKSPACE: WorkspaceInfo = { kind: "none", online: false, hostUid: null, label: "" };

/**
 * The part of a workspace that belongs to the project rather than to the one
 * room it was connected in.
 *
 * `online` and `hostUid` describe a live host socket in a single room, so they
 * never travel: a sibling room is not hosting anything until someone opens it.
 * The kind and label do travel, because they are what the sibling reconnects
 * for itself — see RoomView's inherit effect.
 */
function inheritedWorkspace(workspace: WorkspaceInfo): WorkspaceInfo {
  if (workspace.kind === "none") return EMPTY_WORKSPACE;
  return { kind: workspace.kind, label: workspace.label, online: false, hostUid: null };
}

function safeWorkspace(value: unknown): WorkspaceInfo {
  if (!value || typeof value !== "object") return EMPTY_WORKSPACE;
  const rec = value as Record<string, unknown>;
  const kind = rec.kind === "local" || rec.kind === "github" ? rec.kind : "none";
  return {
    kind,
    online: kind !== "none" && rec.online === true,
    hostUid: typeof rec.hostUid === "string" ? rec.hostUid : null,
    label: typeof rec.label === "string" ? rec.label : "",
  };
}

function safeRoom(value: unknown): SidebarRoom | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.roomId !== "string" || typeof rec.label !== "string") return null;
  return {
    roomId: rec.roomId,
    label: rec.label,
    projectId: typeof rec.projectId === "string" ? rec.projectId : undefined,
    archived: rec.archived === true,
    workspace: safeWorkspace(rec.workspace),
  };
}

function storedRooms(): SidebarRoom[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ROOMS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(safeRoom).filter((room): room is SidebarRoom => Boolean(room));
  } catch {
    return [];
  }
}

function storedProjects(): SidebarProject[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value, index) => {
      if (!value || typeof value !== "object") return [];
      const rec = value as Record<string, unknown>;
      if (typeof rec.name !== "string") return [];
      const id = typeof rec.id === "string" ? rec.id : `project-${index}-${rec.name}`;
      const rooms = Array.isArray(rec.rooms)
        ? rec.rooms.map(safeRoom).filter((room): room is SidebarRoom => Boolean(room))
        : [];
      return [{ id, name: rec.name, archived: rec.archived === true, rooms, workspace: safeWorkspace(rec.workspace) }];
    });
  } catch {
    return [];
  }
}

function persistSidebar(projects: SidebarProject[], rooms: SidebarRoom[]) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));
}

const UNTITLED_RE = /^Untitled (\d+)$/;

/**
 * The next name in the Untitled 1, Untitled 2, ... sequence.
 *
 * Counts from the highest number taken anywhere in the sidebar — loose rooms,
 * project rooms, archived ones — rather than filling the gaps a deleted room
 * leaves, so no two rooms wear the same default name in one sitting.
 */
function nextUntitledLabel(projects: SidebarProject[], rooms: SidebarRoom[]): string {
  let highest = 0;
  for (const room of [...rooms, ...projects.flatMap((project) => project.rooms)]) {
    const match = UNTITLED_RE.exec(room.label);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `Untitled ${highest + 1}`;
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
  // Bumped whenever a room token is written or cleared, so the read below
  // re-runs. The tokens themselves live in localStorage, never in state.
  const [tokenEpoch, setTokenEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[] | null>(null);
  const [identity, setIdentity] = useState(() => {
    const t = storedIdentity();
    return t ? readIdentity(t) : null;
  });
  const [projects, setProjects] = useState<SidebarProject[]>(storedProjects);
  const [rooms, setRooms] = useState<SidebarRoom[]>(storedRooms);
  const [theme, setTheme] = useState<Theme>(storedTheme);

  /**
   * A mirror of the sidebar for createRoom to name against. It picks the name
   * after an await, by which point the lists its closure captured may be a
   * room behind; the ref is always the current pair.
   */
  const sidebar = useRef({ projects, rooms });

  useEffect(() => {
    persistSidebar(projects, rooms);
    sidebar.current = { projects, rooms };
  }, [projects, rooms]);

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

  const routeRoomId = route.kind === "room" || route.kind === "invite" ? route.roomId : null;

  /**
   * The token for the room the route points at, read straight from storage
   * rather than mirrored into state by an effect.
   *
   * A mirror is always one render stale after a route change: the route says
   * the new room while the mirror still holds the previous room's token, and
   * RoomView opens its socket in exactly that render. The Worker rejects a
   * token minted for another room, so the room never finishes connecting.
   * Reading here keeps the pair consistent in every render there is.
   */
  const token = useMemo(
    () => (routeRoomId ? readToken(routeRoomId) : null),
    [routeRoomId, tokenEpoch],
  );

  useEffect(() => {
    setProblem(null);
  }, [route]);

  const createRoom = useCallback(
    async (displayName: string, projectId?: string) => {
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
        const room = {
          roomId,
          label: nextUntitledLabel(sidebar.current.projects, sidebar.current.rooms),
          projectId,
          archived: false,
          workspace: EMPTY_WORKSPACE,
        };
        setRooms((prevRooms) => (projectId ? prevRooms : [...prevRooms, room]));
        if (projectId) {
          // A room born into a project starts with the project's workspace
          // already on it, so it never shows as folder-less for the beat
          // before it opens and connects the shared folder itself.
          setProjects((prevProjects) => prevProjects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  rooms: [...project.rooms, { ...room, workspace: inheritedWorkspace(project.workspace) }],
                }
              : project,
          ));
        }
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
        setTokenEpoch((epoch) => epoch + 1);
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

  const updateDisplayName = useCallback((displayName: string) => {
    localStorage.setItem("collab_ai:name", displayName);
    setName(displayName);
  }, []);

  const onAccessLost = useCallback(
    (reason: string) => {
      if (route.kind === "room" || route.kind === "invite") clearToken(route.roomId);
      setTokenEpoch((epoch) => epoch + 1);
      setProblem(reason);
    },
    [route],
  );

  const sideName = identity?.name ?? name;
  const createRoomFromPane = useCallback((projectId?: string) => {
    const displayName = sideName.trim() || "Guest";
    createRoom(displayName, projectId);
  }, [createRoom, sideName]);

  const createProject = useCallback((projectName: string) => {
    const trimmed = projectName.trim().slice(0, 42);
    if (!trimmed) return;
    setProjects((prev) => {
      if (prev.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) return prev;
      const next = [
        ...prev,
        {
          id: crypto.randomUUID(),
          name: trimmed,
          archived: false,
          rooms: [],
          workspace: EMPTY_WORKSPACE,
        },
      ];
      return next;
    });
  }, []);

  const openRoom = useCallback((roomId: string) => {
    location.hash = `#/r/${roomId}`;
  }, []);

  const renameRoom = useCallback((roomId: string, label: string) => {
    const nextLabel = label.trim().slice(0, 42);
    if (!nextLabel) return;
    setRooms((prevRooms) => prevRooms.map((room) => room.roomId === roomId ? { ...room, label: nextLabel } : room));
    setProjects((prevProjects) => prevProjects.map((project) => ({
      ...project,
      rooms: project.rooms.map((room) => room.roomId === roomId ? { ...room, label: nextLabel } : room),
    })));
  }, []);

  const copyRoomLink = useCallback((roomId: string) => {
    void navigator.clipboard.writeText(`${location.origin}/#/r/${roomId}`);
  }, []);

  const archiveRoom = useCallback((roomId: string) => {
    const room = [...rooms, ...projects.flatMap((project) => project.rooms)]
      .find((candidate) => candidate.roomId === roomId);
    if (!room || room.archived || !window.confirm(`Archive ${room.label}?`)) return;
    setRooms((prevRooms) => prevRooms.map((candidate) =>
      candidate.roomId === roomId ? { ...candidate, archived: true } : candidate,
    ));
    setProjects((prevProjects) => prevProjects.map((project) => ({
      ...project,
      rooms: project.rooms.map((candidate) =>
        candidate.roomId === roomId ? { ...candidate, archived: true } : candidate,
      ),
    })));
  }, [projects, rooms]);

  const restoreRoom = useCallback((roomId: string) => {
    setRooms((prevRooms) => prevRooms.map((candidate) =>
      candidate.roomId === roomId ? { ...candidate, archived: false } : candidate,
    ));
    setProjects((prevProjects) => prevProjects.map((project) => ({
      ...project,
      rooms: project.rooms.map((candidate) =>
        candidate.roomId === roomId ? { ...candidate, archived: false } : candidate,
      ),
    })));
  }, []);

  const deleteArchivedRoom = useCallback((roomId: string) => {
    const room = [...rooms, ...projects.flatMap((project) => project.rooms)]
      .find((candidate) => candidate.roomId === roomId);
    if (!room || !room.archived || !window.confirm(`Delete ${room.label} permanently?`)) return;
    clearToken(roomId);
    const nextRooms = rooms.filter((candidate) => candidate.roomId !== roomId);
    const nextProjects = projects.map((project) => ({
      ...project,
      rooms: project.rooms.filter((candidate) => candidate.roomId !== roomId),
    }));
    setRooms(nextRooms);
    setProjects(nextProjects);
    persistSidebar(nextProjects, nextRooms);
    if ((route.kind === "room" || route.kind === "invite") && route.roomId === roomId) {
      location.hash = "";
    }
  }, [projects, rooms, route]);

  const archiveProject = useCallback((projectId: string) => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project || project.archived || !window.confirm(`Archive ${project.name} and its rooms?`)) return;
    setProjects((prevProjects) => prevProjects.map((candidate) => candidate.id === projectId
      ? { ...candidate, archived: true, rooms: candidate.rooms.map((room) => ({ ...room, archived: true })) }
      : candidate,
    ));
  }, [projects]);

  const restoreProject = useCallback((projectId: string) => {
    setProjects((prevProjects) => prevProjects.map((candidate) => candidate.id === projectId
      ? { ...candidate, archived: false, rooms: candidate.rooms.map((room) => ({ ...room, archived: false })) }
      : candidate,
    ));
  }, []);

  const deleteProject = useCallback((projectId: string) => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project || !window.confirm(`Delete ${project.name} and its room records?`)) return;
    project.rooms.forEach((room) => clearToken(room.roomId));
    setProjects((prevProjects) => prevProjects.filter((candidate) => candidate.id !== projectId));
  }, [projects]);

  /**
   * Record what a room reports about its workspace, and spread it across the
   * project the room belongs to.
   *
   * A "none" report never clears the project. Rooms in a project connect the
   * shared folder when they open, so every one of them reports "none" for the
   * moment between its socket opening and that attach landing; treating that
   * as a disconnect would let simply visiting a room wipe the project's
   * workspace. Disconnecting is an explicit act — see `detachWorkspace`.
   */
  const updateWorkspace = useCallback((roomId: string, workspace: WorkspaceInfo) => {
    setRooms((prevRooms) => prevRooms.map((room) => (room.roomId === roomId ? { ...room, workspace } : room)));
    setProjects((prevProjects) => prevProjects.map((project) => {
      if (!project.rooms.some((room) => room.roomId === roomId)) return project;
      const shared = workspace.kind === "none" ? project.workspace : inheritedWorkspace(workspace);
      return {
        ...project,
        workspace: shared,
        rooms: project.rooms.map((room) =>
          room.roomId === roomId
            ? { ...room, workspace: workspace.kind === "none" ? shared : workspace }
            : { ...room, workspace: shared }),
      };
    }));
  }, []);

  /**
   * Disconnect the workspace from the room, and from its project with it.
   *
   * The folder is the project's, so leaving it on the project would have the
   * next room to open silently reconnect the folder the person just removed.
   */
  const detachWorkspace = useCallback((roomId: string) => {
    setRooms((prevRooms) =>
      prevRooms.map((room) => (room.roomId === roomId ? { ...room, workspace: EMPTY_WORKSPACE } : room)));
    setProjects((prevProjects) => prevProjects.map((project) => {
      if (!project.rooms.some((room) => room.roomId === roomId)) return project;
      return {
        ...project,
        workspace: EMPTY_WORKSPACE,
        rooms: project.rooms.map((room) => ({ ...room, workspace: EMPTY_WORKSPACE })),
      };
    }));
  }, []);

  const withSidePane = (content: ReactNode) => (
    <div className="side-shell">
      <SidePane
        activeRoomId={route.kind === "room" || route.kind === "invite" ? route.roomId : undefined}
        busy={busy}
        projects={projects}
        rooms={rooms}
        onCreateRoom={createRoomFromPane}
        onCreateProject={createProject}
        onOpenRoom={openRoom}
        onRenameRoom={renameRoom}
        onCopyRoomLink={copyRoomLink}
        onArchiveRoom={archiveRoom}
        onRestoreRoom={restoreRoom}
        onDeleteRoom={deleteArchivedRoom}
        onArchiveProject={archiveProject}
        onRestoreProject={restoreProject}
        onDeleteProject={deleteProject}
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
    const project = projects.find((candidate) =>
      candidate.rooms.some((room) => room.roomId === route.roomId));
    const room = (
      // Keyed by room: RoomView holds a socket, a transcript, a role and a
      // workspace handle, all of which belong to one room. Reusing the
      // instance across a switch would show the previous room's transcript
      // while the new one connects.
      <RoomView
        key={route.roomId}
        roomId={route.roomId}
        token={token}
        displayName={name}
        onDisplayNameChange={updateDisplayName}
        onSignOut={identity ? signOut : undefined}
        onAccessLost={onAccessLost}
        onWorkspaceChange={updateWorkspace}
        onWorkspaceDetach={detachWorkspace}
        // A room in a project shares that project's folder: one saved handle
        // under the project's id, rather than a copy per room that would have
        // to be kept in step and would leave rooms created later with none.
        workspaceKey={project?.id ?? route.roomId}
        projectWorkspace={project?.workspace ?? EMPTY_WORKSPACE}
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
