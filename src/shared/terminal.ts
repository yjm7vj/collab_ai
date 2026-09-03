export type TerminalSharing = "private" | "room";

export type TerminalController = {
  uid: string;
  name: string;
};

export type TerminalSession = {
  id: string;
  hostUid: string;
  hostName: string;
  label: string;
  shell: string;
  sharing: TerminalSharing;
  controllers: TerminalController[];
  startedAt: number;
};

export type TerminalControlRequest = {
  sessionId: string;
  uid: string;
  name: string;
};

export type TerminalOutput = {
  sessionId: string;
  data: string;
  seq: number;
};

export type TerminalCommandRequest = {
  id: string;
  sessionId: string;
  command: string;
};

export type TerminalRemoteInput = {
  sessionId: string;
  data: string;
  fromUid: string;
  fromName: string;
};

export type TerminalRisk = "low" | "approval_required";

/**
 * Deliberately narrow. This is only used to skip a room vote, so uncertainty
 * always becomes approval_required. Chaining, redirects, substitutions and
 * multiline commands are never classified as low risk.
 */
export function classifyTerminalCommand(value: unknown): TerminalRisk {
  if (typeof value !== "string") return "approval_required";
  const command = value.trim();
  if (!command || command.length > 500 || /[\r\n;&|><`]/.test(command) || command.includes("$(")) {
    return "approval_required";
  }

  const normalized = command.replace(/\s+/g, " ").toLowerCase();
  if (/^(ls|dir)(\s+[-/a-z0-9_.]+)*$/i.test(command)) return "low";
  if (/^git (status|diff)(\s+[-a-z0-9_./:=]+)*$/i.test(command)) return "low";
  if (/^npm (test|run test(?::[a-z0-9_-]+)?)(\s+--(\s+[-a-z0-9_./:=]+)*)?$/i.test(command)) return "low";
  if (/^grep(\s+-[a-z]+)*(\s+[^\s]+){1,3}$/i.test(command)) return "low";
  if (/^(pwd|git branch --show-current)$/i.test(normalized)) return "low";
  return "approval_required";
}

export function sanitizeTerminalLabel(value: unknown): string {
  const label = typeof value === "string" ? value.replace(/[\r\n\t]/g, " ").trim() : "";
  return label.slice(0, 80) || "Local terminal";
}

export function sanitizeTerminalShell(value: unknown): string {
  const shell = typeof value === "string" ? value.replace(/[\r\n\t]/g, " ").trim() : "";
  return shell.slice(0, 40) || "Local shell";
}

export const TERMINAL_LIMITS = {
  frameBytes: 32_768,
  inputBytes: 8_192,
  commandBytes: 2_000,
  resultBytes: 128_000,
  commandTimeoutMs: 120_000,
} as const;
