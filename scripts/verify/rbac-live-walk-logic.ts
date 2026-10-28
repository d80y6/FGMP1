/** Pure verdict helpers for the live RBAC walk. Rate limits are not decisions. */

export type WalkControlVerdict = "ok" | "wrong" | "unknown";

export function isWalkProbeInconclusive(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export function classifyWalkControl(holdsCapability: boolean, status: number): WalkControlVerdict {
  if (isWalkProbeInconclusive(status)) return "unknown";

  const denied = status === 401 || status === 403;
  if (holdsCapability) return denied ? "wrong" : "ok";
  return denied ? "ok" : "wrong";
}

/** Mismatches fail; incomplete authorization evidence is a distinct nonzero result. */
export function walkExitCode(hasMismatch: boolean, hasInconclusiveProbe: boolean): 0 | 1 | 2 {
  if (hasMismatch) return 1;
  if (hasInconclusiveProbe) return 2;
  return 0;
}
