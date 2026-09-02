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
import type {
  SidebarSyncRequest,
  SidebarSyncResponse,
  SyncProject,
  SyncRoom,
} from "../shared/sidebar";
import { Landing, JoinGate, ProjectInvitePanel, SidePane, SignInGate } from "./components";
import { LandingPage } from "./landing";
import { isAppGated, WAITLIST_URL } from "./host";
import { IDENTITY_KEY, readIdentity, storedIdentity } from "./identity";
import { useTheme } from "./theme";
import { RoomView } from "./RoomView";
import type { WorkspaceInfo } from "../shared/workspace";
import {
  PROJECT_INVITE_CODE_RE,
  type ProjectInviteRequest,
  type ProjectInviteRedeemResponse,
  type ProjectInviteResponse,
  type ProjectInviteRole,
  type ProjectInviteRoom,
} from "../shared/project-invites";

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

const PROJECTS_KEY = "collab_ai:projects";
const ROOMS_KEY = "collab_ai:rooms";
/**
 * Which account the cached sidebar above belongs to.
 *
 * The cache is one browser's, but /api/sidebar files whatever it is handed
 * under whoever is signed in, and it files it as a bookmark — a row there is
 * not membership, and the room re-checks membership on every join. So a
 * sidebar carried across a sign-in lands rooms in an account that cannot open
 * them, which reads as "this is my room" and refuses to let you in.
 *
 * Same marker, and the same reasoning, as OWNER_KEY in ./presets.
 */
const SIDEBAR_OWNER_KEY = "collab_ai:sidebar:owner";

/**
 * `updatedAt` is what makes two browsers able to disagree and settle.
 *
 * Every edit to a synced field stamps it, and the server keeps whichever side
 * stamped later (see ../shared/sidebar). Fields the server never sees —
 * `workspace` above all — do not stamp it: a folder handle belongs to the
 * machine holding it, so touching one must not win an argument about a name.
 */
type SidebarProject = {
  id: string;
  name: string;
  archived: boolean;
  rooms: SidebarRoom[];
  workspace: WorkspaceInfo;
  updatedAt: number;
};

type SidebarRoom = {
  roomId: string;
  label: string;
  projectId?: string;
  archived: boolean;
  workspace: WorkspaceInfo;
  updatedAt: number;
};

const EMPTY_WORKSPACE: WorkspaceInfo = {
  kind: "none", online: false, hostUid: null, label: "", canWrite: false,
};

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
  return {
    kind: workspace.kind,
    label: workspace.label,
    online: false,
    hostUid: null,
    canWrite: workspace.canWrite,
  };
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
    // Three states, and the absent one is not false: a sidebar written
    // before this field existed knows nothing about write access and must
    // not be read as having found none.
    canWrite: rec.canWrite === true ? true : rec.canWrite === false ? false : null,
  };
}

/**
 * Sidebars written before rooms synced have no `updatedAt` at all. They are
 * stamped as of now rather than with 0, because this browser's copy is the
 * only copy there is: reading it as ancient would let a server row created a
 * moment ago by the same person's other tab overwrite the names they have been
 * using here for weeks. The stamp is frozen on the first persist after load.
 */
function safeStamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : Date.now();
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
    updatedAt: safeStamp(rec.updatedAt),
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
      return [{
        id,
        name: rec.name,
        archived: rec.archived === true,
        rooms,
        workspace: safeWorkspace(rec.workspace),
        updatedAt: safeStamp(rec.updatedAt),
      }];
    });
  } catch {
    return [];
  }
}

function persistSidebar(projects: SidebarProject[], rooms: SidebarRoom[]) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));
}

/** How long the sidebar settles before a change is pushed to the account. */
const SYNC_DEBOUNCE_MS = 600;

/**
 * The sidebar flattened into the shape the account stores.
 *
 * A room's project comes from the list it is sitting in rather than from its
 * own `projectId`: the nesting is what the UI actually renders, so it is the
 * only version of the answer that can be wrong in a way anyone would notice.
 */
function syncSnapshot(projects: SidebarProject[], rooms: SidebarRoom[]): SidebarSyncResponse {
  const flatten = (room: SidebarRoom, projectId: string | null): SyncRoom => ({
    roomId: room.roomId,
    label: room.label,
    projectId,
    archived: room.archived,
    updatedAt: room.updatedAt,
  });
  return {
    rooms: [
      ...rooms.map((room) => flatten(room, null)),
      ...projects.flatMap((project) => project.rooms.map((room) => flatten(room, project.id))),
    ],
    projects: projects.map((project): SyncProject => ({
      id: project.id,
      name: project.name,
      archived: project.archived,
      updatedAt: project.updatedAt,
    })),
  };
}

/** The ids this browser has already told the account about. */
type SentIds = { rooms: Set<string>; projects: Set<string> };

/**
 * Rebuild the sidebar from what the account holds, keeping what only this
 * browser can know.
 *
 * The account is authoritative about which rooms exist, what they are called
 * and how they are grouped — but only about what it has actually been told,
 * and only where this browser does not hold a later edit. The two exceptions
 * are spelled out inline below; between them they are what keeps a rename made
 * mid-sync, or a room created a second ago, from being swallowed by the reply
 * to a request that predates it.
 */
function applySnapshot(
  snapshot: SidebarSyncResponse,
  prevProjects: SidebarProject[],
  prevRooms: SidebarRoom[],
  sent: SentIds,
): { projects: SidebarProject[]; rooms: SidebarRoom[] } {
  // Rooms as this browser has them, each with the list it is actually sitting
  // in — the nesting, not the room's own `projectId`, is what the UI renders.
  const localRooms = new Map<string, { room: SidebarRoom; projectId: string | null }>();
  for (const room of prevRooms) localRooms.set(room.roomId, { room, projectId: null });
  for (const project of prevProjects) {
    for (const room of project.rooms) localRooms.set(room.roomId, { room, projectId: project.id });
  }
  const localProjects = new Map(prevProjects.map((project) => [project.id, project] as const));

  /**
   * The account's rows, except where this browser holds a newer edit.
   *
   * Someone renaming a room while a sync is in flight would otherwise watch
   * the response put the old name back — the request had already left, so it
   * could not have carried the rename. Preferring the newer stamp here is the
   * same rule the server merges by, and the watcher pushes the survivor on the
   * next tick, so the two ends agree either way.
   */
  const rooms: SyncRoom[] = snapshot.rooms.map((room) => {
    const local = localRooms.get(room.roomId);
    if (!local || local.room.updatedAt <= room.updatedAt) return room;
    return {
      roomId: room.roomId,
      label: local.room.label,
      projectId: local.projectId,
      archived: local.room.archived,
      updatedAt: local.room.updatedAt,
    };
  });
  const projects: SyncProject[] = snapshot.projects.map((project) => {
    const local = localProjects.get(project.id);
    if (!local || local.updatedAt <= project.updatedAt) return project;
    return { id: project.id, name: local.name, archived: local.archived, updatedAt: local.updatedAt };
  });

  /**
   * Plus whatever this browser has that the account has not been told about.
   *
   * A row that was sent and did not come back was deleted somewhere else and
   * has to go. A row that was never sent has simply not made the trip yet —
   * a room created seconds ago, a project made while the response was in the
   * air — and dropping it would delete something nobody asked to delete.
   */
  const returnedRooms = new Set(snapshot.rooms.map((room) => room.roomId));
  for (const [roomId, local] of localRooms) {
    if (returnedRooms.has(roomId) || sent.rooms.has(roomId)) continue;
    rooms.push({
      roomId,
      label: local.room.label,
      projectId: local.projectId,
      archived: local.room.archived,
      updatedAt: local.room.updatedAt,
    });
  }
  const returnedProjects = new Set(snapshot.projects.map((project) => project.id));
  for (const [id, local] of localProjects) {
    if (returnedProjects.has(id) || sent.projects.has(id)) continue;
    projects.push({ id, name: local.name, archived: local.archived, updatedAt: local.updatedAt });
  }

  // Back into the shape the sidebar renders. Workspaces are never carried over
  // the wire — a folder handle belongs to the machine holding it — so they
  // come from the copy already on screen, and a room arriving from another
  // device starts with none.
  const restore = (room: SyncRoom, projectId?: string): SidebarRoom => ({
    roomId: room.roomId,
    label: room.label,
    projectId,
    archived: room.archived,
    workspace: localRooms.get(room.roomId)?.room.workspace ?? EMPTY_WORKSPACE,
    updatedAt: room.updatedAt,
  });

  const nextProjects = projects.map((project): SidebarProject => ({
    id: project.id,
    name: project.name,
    archived: project.archived,
    workspace: localProjects.get(project.id)?.workspace ?? EMPTY_WORKSPACE,
    updatedAt: project.updatedAt,
    rooms: rooms.filter((room) => room.projectId === project.id).map((room) => restore(room, project.id)),
  }));

  const known = new Set(nextProjects.map((project) => project.id));
  // A room whose project is gone becomes a loose room rather than disappearing
  // with it — deleting a project deletes its rooms explicitly, so a dangling
  // reference here means the two rows are out of step, not that the room was
  // meant to go.
  const nextRooms = rooms
    .filter((room) => !room.projectId || !known.has(room.projectId))
    .map((room) => restore(room));

  return { projects: nextProjects, rooms: nextRooms };
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
  | { kind: "invite"; roomId: string; code: string }
  | { kind: "projectInvite"; code: string };

function parseRoute(): Route {
  const raw = location.hash.replace(/^#/, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] === "r" && parts[1] && ROOM_ID_RE.test(parts[1])) {
    return { kind: "room", roomId: parts[1] };
  }
  if (parts[0] === "j" && parts[1] && parts[2] && ROOM_ID_RE.test(parts[1])) {
    return { kind: "invite", roomId: parts[1], code: parts[2] };
  }
  if (parts[0] === "p" && parts[1] && PROJECT_INVITE_CODE_RE.test(parts[1])) {
    return { kind: "projectInvite", code: parts[1] };
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
  // Only a phone reads this: the side pane is a column at any width that can
  // spare 276px, and the drawer styles that consult it stop at 760px.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[] | null>(null);
  const [identity, setIdentity] = useState(() => {
    const t = storedIdentity();
    return t ? readIdentity(t) : null;
  });
  const [projects, setProjects] = useState<SidebarProject[]>(storedProjects);
  const [rooms, setRooms] = useState<SidebarRoom[]>(storedRooms);
  const [inviteProject, setInviteProject] = useState<SidebarProject | null>(null);
  const { theme, toggleTheme } = useTheme();
  const landingPreview = useMemo(
    () =>
      (location.hostname === "localhost" || location.hostname === "127.0.0.1") &&
      new URLSearchParams(location.search).get("landing") === "1",
    [],
  );

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

  // Escape closes the drawer, the same way it closes every other layer here.
  useEffect(() => {
    if (!sidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [sidebarOpen]);

  /**
   * The last snapshot this browser sent, so a change that is not a change
   * costs nothing. Cleared on a failed send, which is what makes the next
   * edit — or the next sign-in — a retry.
   */
  const pushed = useRef<string | null>(null);
  /**
   * Syncs run one at a time. Two in flight could return in either order and
   * the loser would paint a sidebar that is one edit stale, so they queue
   * instead. Each reads `sidebar.current` when it actually runs, never when it
   * was scheduled.
   */
  const queue = useRef<Promise<void>>(Promise.resolve());
  /**
   * What the last request carried, which is how a reply that omits a row is
   * read: sent and not returned means deleted elsewhere, never sent means the
   * account has simply not heard of it yet.
   */
  const sent = useRef<SentIds>({ rooms: new Set(), projects: new Set() });

  /**
   * Forget a sidebar cached for somebody else.
   *
   * A sidebar built while signed out has no owner recorded and belongs to
   * whoever signs in next — carrying it up is the point of syncing at all. A
   * sidebar last synced as another account is a different matter, and is
   * dropped before anything can be pushed under the new one's name. Without
   * this, signing in with a second provider quietly republished the first
   * account's rooms into the second's sidebar, where they showed up looking
   * like the person's own and then refused them at the door.
   *
   * The ref is cleared as well as the state because the push below reads the
   * ref, and a setState is not visible there until the next render.
   */
  const claimSidebarCache = useCallback((accountUid: string | null) => {
    let owner: string | null = null;
    try {
      owner = localStorage.getItem(SIDEBAR_OWNER_KEY);
    } catch {
      // Unreadable storage: treat the cache as unowned rather than refusing
      // to sync. The merge on the way back is safe either way.
    }
    if (owner && owner !== accountUid) {
      sidebar.current = { projects: [], rooms: [] };
      pushed.current = null;
      sent.current = { rooms: new Set(), projects: new Set() };
      setProjects([]);
      setRooms([]);
    }
    try {
      if (accountUid) localStorage.setItem(SIDEBAR_OWNER_KEY, accountUid);
    } catch {
      // Same reasoning as persistSidebar: losing the marker costs a merge,
      // not data.
    }
  }, []);

  /**
   * Push this browser's sidebar to the account and adopt what comes back.
   *
   * Rooms and projects used to live only in localStorage, which is why signing
   * in somewhere else showed an empty sidebar: the rooms were still there and
   * the account was still a member of them, but only this browser had ever
   * known their names. The exchange is one request — see /api/sidebar.
   *
   * Deletions have to be said out loud. A snapshot that simply lacks a room is
   * a browser that never heard of it, not a removal, so `deletedRooms` and
   * `deletedProjects` carry the intent that absence cannot.
   */
  const syncSidebar = useCallback(
    (options?: { deletedRooms?: string[]; deletedProjects?: string[]; force?: boolean }) => {
      const deletedRooms = options?.deletedRooms ?? [];
      const deletedProjects = options?.deletedProjects ?? [];
      const removing = deletedRooms.length > 0 || deletedProjects.length > 0;
      const run = async () => {
        const identityToken = storedIdentity();
        // No identity, no account to sync with: a deployment with sign-in off
        // keeps exactly the browser-local sidebar it has always had.
        if (!identityToken) return;
        // Before the snapshot is read, so a cache belonging to another
        // account is gone rather than pushed under this one's name.
        claimSidebarCache(readIdentity(identityToken)?.uid ?? null);
        const snapshot = syncSnapshot(sidebar.current.projects, sidebar.current.rooms);
        const body = JSON.stringify(snapshot);
        if (!options?.force && !removing && body === pushed.current) return;
        pushed.current = body;
        sent.current = {
          rooms: new Set(snapshot.rooms.map((room) => room.roomId)),
          projects: new Set(snapshot.projects.map((project) => project.id)),
        };
        try {
          const res = await fetch("/api/sidebar", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              identity: identityToken,
              ...snapshot,
              deletedRooms,
              deletedProjects,
            } satisfies SidebarSyncRequest),
          });
          // Nothing is surfaced on failure and nothing local is thrown away.
          // The sidebar someone is looking at still works offline, and a
          // banner about a background sync would be noise about a problem
          // they cannot act on.
          if (!res.ok) {
            pushed.current = null;
            return;
          }
          const merged = (await res.json()) as SidebarSyncResponse;
          const next = applySnapshot(merged, sidebar.current.projects, sidebar.current.rooms, sent.current);
          setProjects(next.projects);
          setRooms(next.rooms);
          // Recorded against what we just adopted, not against what we sent,
          // so the watcher below does not read the merge itself as a fresh
          // edit and bounce it straight back.
          pushed.current = JSON.stringify(syncSnapshot(next.projects, next.rooms));
        } catch {
          pushed.current = null;
        }
      };
      queue.current = queue.current.then(run, run);
      return queue.current;
    },
    [claimSidebarCache],
  );

  const identityUid = identity?.uid ?? null;

  // Signing in is the moment to go and get the account's rooms — including on
  // a browser that has never seen them, which is the whole point.
  useEffect(() => {
    if (identityUid) void syncSidebar({ force: true });
  }, [identityUid, syncSidebar]);

  /**
   * Every change to a synced field, sent once the sidebar stops moving.
   *
   * Watching the state rather than calling from each rename and archive means
   * a sidebar action added later cannot forget to sync. Changes the account
   * does not store — a workspace connecting, a folder going offline — leave
   * the snapshot identical and are dropped here without a request.
   */
  useEffect(() => {
    if (!identityUid) return;
    if (JSON.stringify(syncSnapshot(projects, rooms)) === pushed.current) return;
    const timer = setTimeout(() => void syncSidebar(), SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [identityUid, projects, rooms, syncSidebar]);

  /**
   * The app is not open yet: a signed-out visitor to the app host's root goes
   * to the waitlist rather than to a sign-in they have no way through. Deep
   * links are the exception — an invite or a room link still reaches its own
   * gate, which is the whole point of having been sent one.
   *
   * This has to happen here and not as a redirect in the Worker: rooms and
   * invites are hash routes, and a fragment never reaches the server, so a 302
   * on `/` would swallow every deep link it cannot see.
   *
   * `everIdentified` narrows this to arrival, which is the only moment the
   * gate is about. Losing an identity mid-session is a different situation:
   * createRoom and joinRoom clear it on `sign_in_required` and set a message
   * asking the person to sign in again, and without the latch that clearing
   * would flip `gated` true and navigate the browser to the waitlist before
   * the message ever rendered — throwing somebody who is already inside the
   * app out of it with no explanation, on an expiry they can simply fix. A
   * ref rather than state on purpose: it must be readable in the same render
   * that clears the identity, so a re-render would already be too late.
   */
  const everIdentified = useRef(false);
  if (identity) everIdentified.current = true;

  const gated = !identity && !everIdentified.current && route.kind === "landing" && isAppGated();
  useEffect(() => {
    if (gated) location.replace(WAITLIST_URL);
  }, [gated]);

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

  /**
   * Establish the session cookie before the room's socket opens.
   *
   * Once per room open, never per reconnect: the browser then attaches the
   * cookie to every upgrade on its own, including the reconnect storms after
   * a deploy. `null` means the attempt is still in flight — RoomView is held
   * back until it settles, because the socket's credential depends on the
   * answer and switching it afterwards would mean reconnecting.
   *
   * `false` is not a failure the person needs to see. It means this tab falls
   * back to the room token in the URL, exactly as it did before the cookie
   * existed, and the Worker still accepts that.
   */
  const [sessionReady, setSessionReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (!token) {
      setSessionReady(null);
      return;
    }
    let cancelled = false;
    setSessionReady(null);
    void (async () => {
      let ok = false;
      try {
        const res = await fetch("/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // RoomView is held back until this settles, so a request that never
          // does would leave the room blank rather than merely un-cookied.
          // Giving up falls back to the room token, which still works.
          signal: AbortSignal.timeout(5000),
          // Either credential establishes the same session. The identity is
          // preferred server-side; the room token is what a tab has on a
          // deployment with sign-in switched off.
          body: JSON.stringify({ identity: storedIdentity() ?? undefined, token }),
        });
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (!cancelled) setSessionReady(ok);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

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
          updatedAt: Date.now(),
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
            // The uid this browser had before it had an account. Rooms made
            // back then are owned by it, so it is the only thing that can
            // prove a room predating sign-in belongs to whoever is signing
            // in now. The room ignores it unless it is already a member.
            claim: uid,
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
        // The Worker has just recorded this room in the account's sidebar;
        // this is what fetches it back, so following an invite link finally
        // leaves the room somewhere other than the link itself.
        void syncSidebar({ force: true });
      } catch {
        setProblem(refusalMessage("network"));
      } finally {
        setBusy(false);
      }
    },
    [route, uid, syncSidebar],
  );

  const projectInviteRequest = useCallback(async (body: Omit<ProjectInviteRequest, "identity" | "uid">) => {
    const res = await fetch("/api/project-invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, identity: storedIdentity() ?? undefined, uid }),
    });
    const data = (await res.json()) as ProjectInviteResponse | { error?: string };
    if (!res.ok) throw new Error("error" in data ? data.error ?? "request_failed" : "request_failed");
    return data as ProjectInviteResponse;
  }, [uid]);

  const projectRooms = useCallback((project: SidebarProject): ProjectInviteRoom[] =>
    project.rooms.filter((room) => !room.archived).map((room) => ({ roomId: room.roomId, label: room.label })), []);

  const createProjectInvite = useCallback(async (roomIds: string[], role: ProjectInviteRole) => {
    if (!inviteProject) return null;
    try {
      const roomMap = new Map(projectRooms(inviteProject).map((room) => [room.roomId, room]));
      const result = await projectInviteRequest({
        action: "create", projectId: inviteProject.id, projectName: inviteProject.name,
        role, rooms: roomIds.map((roomId) => roomMap.get(roomId)).filter((room): room is ProjectInviteRoom => Boolean(room)),
      });
      return "invite" in result ? result.invite : null;
    } catch { return null; }
  }, [inviteProject, projectInviteRequest, projectRooms]);

  const listProjectInvites = useCallback(async () => {
    if (!inviteProject) return [];
    const result = await projectInviteRequest({ action: "list", projectId: inviteProject.id, rooms: projectRooms(inviteProject) });
    return "invites" in result ? result.invites : [];
  }, [inviteProject, projectInviteRequest, projectRooms]);

  const updateProjectInvite = useCallback(async (code: string, roomIds: string[], role: ProjectInviteRole) => {
    if (!inviteProject) return null;
    try {
      const roomMap = new Map(projectRooms(inviteProject).map((room) => [room.roomId, room]));
      const result = await projectInviteRequest({
        action: "update", code, projectId: inviteProject.id, projectName: inviteProject.name,
        role, rooms: roomIds.map((roomId) => roomMap.get(roomId)).filter((room): room is ProjectInviteRoom => Boolean(room)),
      });
      return "invite" in result ? result.invite : null;
    } catch { return null; }
  }, [inviteProject, projectInviteRequest, projectRooms]);

  const revokeProjectInvite = useCallback(async (code: string) => {
    if (!inviteProject) return false;
    try {
      await projectInviteRequest({ action: "revoke", code, projectId: inviteProject.id, rooms: projectRooms(inviteProject) });
      return true;
    } catch { return false; }
  }, [inviteProject, projectInviteRequest, projectRooms]);

  const joinProject = useCallback(async (displayName: string) => {
    if (route.kind !== "projectInvite") return;
    setBusy(true);
    try {
      const res = await fetch("/api/project-invites/redeem", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: route.code, uid, name: displayName, identity: storedIdentity() ?? undefined }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: JoinRefusal };
        setProblem(data.error === "sign_in_required" ? "You need to sign in before joining this project." : data.error === "bad_code" ? "That project invite is no longer valid." : refusalMessage("network"));
        return;
      }
      const data = (await res.json()) as ProjectInviteRedeemResponse;
      if (data.rooms.length === 0) { setProblem("This project invite has no available rooms."); return; }
      data.rooms.forEach((room) => writeToken(room.roomId, room.token));
      const existing = projects.find((project) => project.id === data.project.id);
      const joinedProject: SidebarProject = {
        id: data.project.id, name: data.project.name, archived: false,
        workspace: existing?.workspace ?? EMPTY_WORKSPACE, updatedAt: Date.now(),
        rooms: data.rooms.map((room) => ({ roomId: room.roomId, label: room.label, projectId: data.project.id, archived: false, workspace: existing?.rooms.find((old) => old.roomId === room.roomId)?.workspace ?? EMPTY_WORKSPACE, updatedAt: Date.now() })),
      };
      setProjects((current) => current.some((project) => project.id === joinedProject.id) ? current.map((project) => project.id === joinedProject.id ? joinedProject : project) : [...current, joinedProject]);
      localStorage.setItem("collab_ai:name", displayName); setName(displayName); setTokenEpoch((epoch) => epoch + 1);
      await syncSidebar({ force: true });
      location.hash = `#/r/${data.rooms.at(0)!.roomId}`;
    } catch { setProblem(refusalMessage("network")); }
    finally { setBusy(false); }
  }, [projects, route, syncSidebar, uid]);

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
    // The cookie is HttpOnly, so only the server can clear it. Signing out
    // without this would leave a credential behind that still opens sockets.
    void fetch("/api/session", { method: "DELETE" }).catch(() => {});
    setSessionReady(null);
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
          updatedAt: Date.now(),
        },
      ];
      return next;
    });
  }, []);

  const renameProject = useCallback((projectId: string, name: string) => {
    const nextName = name.trim().slice(0, 42);
    if (!nextName) return;
    setProjects((prev) =>
      prev.map((project) =>
        project.id === projectId ? { ...project, name: nextName, updatedAt: Date.now() } : project),
    );
  }, []);

  const openRoom = useCallback((roomId: string) => {
    location.hash = `#/r/${roomId}`;
  }, []);

  const renameRoom = useCallback((roomId: string, label: string) => {
    const nextLabel = label.trim().slice(0, 42);
    if (!nextLabel) return;
    const stamped = { label: nextLabel, updatedAt: Date.now() };
    setRooms((prevRooms) => prevRooms.map((room) => room.roomId === roomId ? { ...room, ...stamped } : room));
    setProjects((prevProjects) => prevProjects.map((project) => ({
      ...project,
      rooms: project.rooms.map((room) => room.roomId === roomId ? { ...room, ...stamped } : room),
    })));
  }, []);

  const copyRoomLink = useCallback((roomId: string) => {
    void navigator.clipboard.writeText(`${location.origin}/#/r/${roomId}`);
  }, []);

  const archiveRoom = useCallback((roomId: string) => {
    const room = [...rooms, ...projects.flatMap((project) => project.rooms)]
      .find((candidate) => candidate.roomId === roomId);
    if (!room || room.archived || !window.confirm(`Archive ${room.label}?`)) return;
    const stamped = { archived: true, updatedAt: Date.now() };
    setRooms((prevRooms) => prevRooms.map((candidate) =>
      candidate.roomId === roomId ? { ...candidate, ...stamped } : candidate,
    ));
    setProjects((prevProjects) => prevProjects.map((project) => ({
      ...project,
      rooms: project.rooms.map((candidate) =>
        candidate.roomId === roomId ? { ...candidate, ...stamped } : candidate,
      ),
    })));
  }, [projects, rooms]);

  const restoreRoom = useCallback((roomId: string) => {
    const stamped = { archived: false, updatedAt: Date.now() };
    setRooms((prevRooms) => prevRooms.map((candidate) =>
      candidate.roomId === roomId ? { ...candidate, ...stamped } : candidate,
    ));
    setProjects((prevProjects) => prevProjects.map((project) => ({
      ...project,
      rooms: project.rooms.map((candidate) =>
        candidate.roomId === roomId ? { ...candidate, ...stamped } : candidate,
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
    // Said explicitly, because a snapshot missing this room would read as a
    // browser that had never heard of it and the room would come straight
    // back on the next sync — here and on every other device.
    sidebar.current = { projects: nextProjects, rooms: nextRooms };
    void syncSidebar({ deletedRooms: [roomId] });
    if ((route.kind === "room" || route.kind === "invite") && route.roomId === roomId) {
      location.hash = "";
    }
  }, [projects, rooms, route, syncSidebar]);

  const archiveProject = useCallback((projectId: string) => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project || project.archived || !window.confirm(`Archive ${project.name} and its rooms?`)) return;
    const now = Date.now();
    setProjects((prevProjects) => prevProjects.map((candidate) => candidate.id === projectId
      ? {
          ...candidate,
          archived: true,
          updatedAt: now,
          rooms: candidate.rooms.map((room) => ({ ...room, archived: true, updatedAt: now })),
        }
      : candidate,
    ));
  }, [projects]);

  const restoreProject = useCallback((projectId: string) => {
    const now = Date.now();
    setProjects((prevProjects) => prevProjects.map((candidate) => candidate.id === projectId
      ? {
          ...candidate,
          archived: false,
          updatedAt: now,
          rooms: candidate.rooms.map((room) => ({ ...room, archived: false, updatedAt: now })),
        }
      : candidate,
    ));
  }, []);

  const deleteProject = useCallback((projectId: string) => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project || !window.confirm(`Delete ${project.name} and its room records?`)) return;
    project.rooms.forEach((room) => clearToken(room.roomId));
    const nextProjects = projects.filter((candidate) => candidate.id !== projectId);
    setProjects(nextProjects);
    // The rooms go with it: they only existed in the sidebar as part of this
    // project, and leaving them behind on the account would have them
    // reappear as loose rooms on every device.
    sidebar.current = { projects: nextProjects, rooms: sidebar.current.rooms };
    void syncSidebar({
      deletedRooms: project.rooms.map((room) => room.roomId),
      deletedProjects: [projectId],
    });
  }, [projects, syncSidebar]);

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
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((wasOpen) => !wasOpen)}
        projects={projects}
        rooms={rooms}
        // Going somewhere closes the drawer: on a phone it covers the room it
        // just navigated to, and leaving it up would hide the arrival.
        onCreateRoom={(projectId) => {
          setSidebarOpen(false);
          createRoomFromPane(projectId);
        }}
        onCreateProject={createProject}
        onRenameProject={renameProject}
        onOpenRoom={(roomId) => {
          setSidebarOpen(false);
          openRoom(roomId);
        }}
        onRenameRoom={renameRoom}
        onCopyRoomLink={copyRoomLink}
        onArchiveRoom={archiveRoom}
        onRestoreRoom={restoreRoom}
        onDeleteRoom={deleteArchivedRoom}
        onArchiveProject={archiveProject}
        onRestoreProject={restoreProject}
        onDeleteProject={deleteProject}
        onInviteProject={(project) => {
          const current = projects.find((candidate) => candidate.id === project.id);
          if (current) setInviteProject(current);
          else setInviteProject({
            ...project,
            rooms: project.rooms.map((room) => ({ ...room, updatedAt: Date.now() })),
            updatedAt: Date.now(),
          });
        }}
      />
      {sidebarOpen && (
        <button
          type="button"
          className="side-scrim"
          aria-label="Hide rooms and projects"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <main className="side-main">{content}</main>
      {inviteProject && (
        <ProjectInvitePanel
          project={inviteProject}
          onCreate={createProjectInvite}
          onList={listProjectInvites}
          onUpdate={updateProjectInvite}
          onRevoke={revokeProjectInvite}
          onClose={() => setInviteProject(null)}
        />
      )}
    </div>
  );

  // `providers` is only `null` for the beat before /api/auth/config answers —
  // render nothing rather than flash the wrong gate (name entry vs. sign-in).
  if (providers === null) return null;

  // A signed-out visitor at the root gets the landing surface, whichever way
  // this deployment admits people. Deep links (an invite, a room) keep going
  // straight to the gate that guards them — a marketing page between someone
  // and the room they were sent to would be a worse product, not a better one.
  // Mid-redirect. Rendering the landing here would flash a create-a-room page
  // at someone on their way to the waitlist.
  if (gated) return null;

  if ((landingPreview || !identity) && route.kind === "landing") {
    return (
      <LandingPage
        cta={{
          kind: "app",
          providers,
          onSignIn: signIn,
          onCreate: createRoom,
          initialName: name,
          busy,
          problem,
        }}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
  }

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

  if (route.kind === "projectInvite") {
    const join = (
      <JoinGate
        roomId="project"
        projectInvite
        initialName={name}
        busy={busy}
        problem={problem}
        onJoin={joinProject}
        identityName={identity?.name}
        onSignOut={identity ? signOut : undefined}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
    return identity ? withSidePane(join) : join;
  }

  if (token) {
    // Still settling which credential the socket will use. One paint, and
    // opening the socket twice is worse than waiting for it.
    if (sessionReady === null) return null;

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
        sessionCookie={sessionReady}
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
