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
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ROOM_ID_RE,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type JoinRefusal,
  type JoinRoomRequest,
  type JoinRoomResponse,
} from "../shared/protocol";
import { Landing, JoinGate } from "./components";
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

function refusalMessage(reason: JoinRefusal | "network"): string {
  switch (reason) {
    case "not_found":
      return "There's no room at that link. Check you copied all of it.";
    case "invite_required":
      return "This room is invite-only. Ask someone inside for an invite link.";
    case "locked":
      return "This room isn't accepting new members.";
    case "bad_request":
      return "That link doesn't look right.";
    case "network":
      return "Couldn't reach the server. Check your connection and try again.";
  }
}

export function App() {
  const uid = useMemo(myUid, []);
  const [route, setRoute] = useState<Route>(parseRoute);
  const [name, setName] = useState(() => localStorage.getItem("collab_ai:name") ?? "");
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

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
          } satisfies CreateRoomRequest),
        });
        if (!res.ok) {
          const { error } = (await res.json()) as { error: JoinRefusal };
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
          } satisfies JoinRoomRequest),
        });
        if (!res.ok) {
          const { error } = (await res.json()) as { error: JoinRefusal };
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

  const onAccessLost = useCallback(
    (reason: string) => {
      if (route.kind === "room" || route.kind === "invite") clearToken(route.roomId);
      setToken(null);
      setProblem(reason);
    },
    [route],
  );

  if (route.kind === "landing") {
    return (
      <Landing initialName={name} busy={busy} problem={problem} onCreate={createRoom} />
    );
  }

  if (token) {
    return (
      <RoomView
        roomId={route.roomId}
        token={token}
        displayName={name}
        onAccessLost={onAccessLost}
      />
    );
  }

  return (
    <JoinGate
      roomId={route.roomId}
      initialName={name}
      busy={busy}
      problem={problem}
      onJoin={joinRoom}
    />
  );
}
