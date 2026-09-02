import { DurableObject } from "cloudflare:workers";

import {
  PROJECT_INVITE_CODE_RE,
  PROJECT_INVITE_MAX_ROOMS,
  type ProjectInviteRole,
  type ProjectInviteRoom,
  type ProjectInviteSummary,
} from "../shared/project-invites";

type InviteRow = {
  code: string;
  project_id: string;
  project_name: string;
  role: ProjectInviteRole;
  rooms: string;
  created_at: number;
  revoked_at: number;
};

function roomList(value: unknown): ProjectInviteRoom[] {
  if (!Array.isArray(value)) return [];
  const out: ProjectInviteRoom[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const roomId = typeof rec.roomId === "string" ? rec.roomId : "";
    const label = typeof rec.label === "string" ? rec.label.trim().slice(0, 42) : "";
    if (!/^[A-Za-z0-9]{22}$/.test(roomId) || !label || seen.has(roomId)) continue;
    seen.add(roomId);
    out.push({ roomId, label });
    if (out.length >= PROJECT_INVITE_MAX_ROOMS) break;
  }
  return out;
}

function summary(row: InviteRow): ProjectInviteSummary {
  let rooms: unknown;
  try { rooms = JSON.parse(row.rooms); } catch { rooms = []; }
  return {
    code: row.code,
    projectId: row.project_id,
    projectName: row.project_name,
    role: row.role === "editor" ? "editor" : "viewer",
    rooms: roomList(rooms),
    createdAt: row.created_at,
    revoked: row.revoked_at > 0,
  };
}

export class ProjectIndex extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS project_invites (
      code TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      role TEXT NOT NULL,
      rooms TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER NOT NULL DEFAULT 0
    )`);
  }

  create(input: { code: string; projectId: string; projectName: string; role: ProjectInviteRole; rooms: ProjectInviteRoom[] }): ProjectInviteSummary {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO project_invites (code, project_id, project_name, role, rooms, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.code,
      input.projectId,
      input.projectName,
      input.role,
      JSON.stringify(roomList(input.rooms)),
      now,
    );
    return {
      code: input.code,
      projectId: input.projectId,
      projectName: input.projectName,
      role: input.role,
      rooms: roomList(input.rooms),
      createdAt: now,
      revoked: false,
    };
  }

  list(): ProjectInviteSummary[] {
    return this.ctx.storage.sql.exec<InviteRow>(
      `SELECT * FROM project_invites ORDER BY created_at DESC`,
    ).toArray().map(summary);
  }

  get(code: string): ProjectInviteSummary | null {
    const row = this.ctx.storage.sql.exec<InviteRow>(
      `SELECT * FROM project_invites WHERE code = ?`, code,
    ).toArray()[0];
    return row ? summary(row) : null;
  }

  update(input: { code: string; projectName: string; role: ProjectInviteRole; rooms: ProjectInviteRoom[] }): ProjectInviteSummary | null {
    const rooms = roomList(input.rooms);
    const changed = this.ctx.storage.sql.exec(
      `UPDATE project_invites SET project_name = ?, role = ?, rooms = ? WHERE code = ? AND revoked_at = 0`,
      input.projectName,
      input.role,
      JSON.stringify(rooms),
      input.code,
    );
    if (changed.rowsWritten === 0) return null;
    return this.get(input.code);
  }

  revoke(code: string): boolean {
    const changed = this.ctx.storage.sql.exec(
      `UPDATE project_invites SET revoked_at = ? WHERE code = ? AND revoked_at = 0`,
      Date.now(), code,
    );
    return changed.rowsWritten > 0;
  }
}

export function isProjectInviteCode(value: unknown): value is string {
  return typeof value === "string" && PROJECT_INVITE_CODE_RE.test(value);
}
