export type ContextUsage = {
  used: number;
  limit: number;
  available: number | null;
  percent: number;
};

/** Normalize persisted token data before presenting it in the settings menu. */
export function contextUsage(tokens: number, limit: number): ContextUsage {
  const used = Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0;
  const normalizedLimit = Number.isFinite(limit) ? Math.max(0, Math.round(limit)) : 0;
  if (normalizedLimit === 0) {
    return { used, limit: 0, available: null, percent: 0 };
  }

  return {
    used,
    limit: normalizedLimit,
    available: Math.max(0, normalizedLimit - used),
    percent: Math.min(100, (used / normalizedLimit) * 100),
  };
}
