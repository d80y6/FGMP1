import type { Role } from "./types";

/**
 * The six roles exposed by the role-preview switcher. Keep this module free of
 * server-only imports: AppShell is a Client Component and only needs this list,
 * not the token-signing code in role-preview.ts.
 */
export const PREVIEW_ROLES: Role[] = [
  "ADMIN",
  "NOC_OPERATOR",
  "REGIONAL_MANAGER",
  "FIELD_ENGINEER",
  "EXECUTIVE",
  "READONLY",
];
