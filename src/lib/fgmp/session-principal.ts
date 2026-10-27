import type { SessionUser } from "@/lib/auth";
import { tenantIdOrThrow } from "./tenant-id";
import { ALL_ROLES } from "./rbac-core";
import type { Role } from "./types";

/** The authenticated principal shape consumed by the FGMP domain/engine. */
export interface FgmpUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  tenantId: string;
}

/** State re-read from the authoritative user record for a session. */
export interface CurrentSessionState {
  role: string;
  tenantId: string;
  active: boolean;
  sessionEpoch: number;
}

/**
 * Narrow a server-authorized session to the engine principal.
 *
 * `requireAuth` returns the database-revalidated user (including an active role
 * preview, when one is in force). This function intentionally accepts that
 * principal instead of fetching NextAuth's JWT a second time: the JWT may carry
 * an older role or tenant after revocation, and is not the authorization result.
 * Missing role/tenant or an unknown persisted role fails closed.
 */
export function toFgmpUser(user: SessionUser): FgmpUser {
  if (!user.id || !user.role || !ALL_ROLES.includes(user.role as Role)) {
    throw new Error("An authenticated FGMP principal must have a recognized role.");
  }

  return {
    id: user.id,
    name: user.name ?? "",
    email: user.email ?? "",
    role: user.role as Role,
    tenantId: tenantIdOrThrow(user.tenantId),
  };
}

/**
 * Resolve a JWT identity against current account state for non-route callers.
 * Missing, disabled, pending-MFA, or revoked sessions fail closed. The current
 * database role and tenant replace token claims; the token only supplies the
 * identity and the epoch against which revocation is checked.
 */
export function toCurrentFgmpUser(
  user: SessionUser,
  state: CurrentSessionState | null,
): FgmpUser {
  if (
    !state ||
    !state.active ||
    (user.sessionEpoch ?? 0) !== state.sessionEpoch ||
    user.mfaPending
  ) {
    throw new Error("Session is not active, fully authenticated, and current.");
  }

  return toFgmpUser({ ...user, role: state.role, tenantId: state.tenantId });
}
