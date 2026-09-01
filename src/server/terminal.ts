import type { TokenClaims } from "./auth";
import { ROOM_ID_RE, UID_RE } from "../shared/protocol";

export const TERMINAL_TICKET_TTL_SECONDS = 60 * 60 * 8;

/** The server derives this from the verified room claim, never client input. */
export function terminalSandboxId(roomId: string): string {
  return `room-${roomId}`;
}

export function terminalTicketRole(terminalId: string): string {
  return `terminal:${terminalId}`;
}

export function terminalTicketMatches(claims: TokenClaims | null, terminalId: string): claims is TokenClaims {
  return Boolean(
    terminalId &&
    claims &&
    ROOM_ID_RE.test(claims.rid) &&
    UID_RE.test(claims.uid) &&
    claims.role === terminalTicketRole(terminalId),
  );
}
