import type { Role } from "./access";

export const PROJECT_INVITE_CODE_RE = /^[A-Za-z0-9]{32}$/;
export const PROJECT_INVITE_MAX_ROOMS = 50;

export type ProjectInviteRole = Extract<Role, "viewer" | "editor">;

export type ProjectInviteRoom = {
  roomId: string;
  label: string;
};

export type ProjectInviteSummary = {
  code: string;
  projectId: string;
  projectName: string;
  role: ProjectInviteRole;
  rooms: ProjectInviteRoom[];
  createdAt: number;
  revoked: boolean;
};

export type ProjectInviteRequest = {
  action: "create" | "list" | "update" | "revoke";
  identity?: string;
  uid?: string;
  projectId: string;
  projectName?: string;
  rooms?: ProjectInviteRoom[];
  role?: ProjectInviteRole;
  code?: string;
};

export type ProjectInviteResponse =
  | { ok: true; invite: ProjectInviteSummary }
  | { ok: true; invites: ProjectInviteSummary[] }
  | { ok: true };

export type ProjectInviteRedeemRequest = {
  code: string;
  identity?: string;
  uid?: string;
  name?: string;
};

export type ProjectInviteRedeemResponse = {
  project: { id: string; name: string };
  rooms: Array<ProjectInviteRoom & { token: string; role: Role }>;
};
