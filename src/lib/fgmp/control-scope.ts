/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTROL SCOPE ASSERTION — the tenant-ownership check at every control boundary
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THIS IS THE CLOSURE OF THE CROSS-TENANT CONTROL GAP.
 *
 * ── THE GAP, STATED PRECISELY ────────────────────────────────────────────────
 * Before this module, the denial of a cross-tenant control command was a SIDE
 * EFFECT of which tenants the process happened to have loaded. An engine
 * holding tenant A's state cannot find tenant B's generator in
 * `engine.generators`, so `find()` returns undefined and the command is
 * refused — correctly, but by accident.
 *
 * That is not a control. It is a consequence, and it reverses the moment any of
 * these become true:
 *   - the engine loads more than one tenant, or a tenant chosen per request
 *   - an asset is resolved from the DATABASE instead of memory, where an
 *     unscoped read behaves differently
 *   - `ensureInit()` is called with the requesting tenant BEFORE the asset is
 *     resolved, so the asset becomes resident and the `find()` succeeds
 *
 * In each of those cases a caller authenticated to tenant A would resolve tenant
 * B's asset and the command would be ALLOWED. A cross-tenant DENIAL being safe
 * does not make a cross-tenant ALLOW safe — only the absence of the ALLOW does.
 *
 * ── WHY AN EXPLICIT TENANT ARGUMENT, NOT AN INFERRED ONE ────────────────────
 * `assertControlScope` takes the tenant the command was AUTHORISED FOR — which
 * comes from the authenticated session, upstream of the engine — and compares it
 * against the tenant the asset actually belongs to. Deriving the expected tenant
 * from the asset itself would make the check tautological: it would always pass.
 *
 * ── WHY REFUSAL IS THE DEFAULT ──────────────────────────────────────────────
 * Every failure path returns denied, including "cannot determine". An
 * undeterminable owner is not an implicit owner. That is the same fail-closed
 * property the interlock layer relies on, applied to authorisation instead of
 * physical safety.
 */

import type { GenCommand } from "./types";

/** Commands that can move a physical asset. Used for messages, not for gating. */
export type ControlAction =
  | "START"
  | "STOP"
  | "EMERGENCY_STOP"
  | "RESET"
  | "AUTHORIZE"
  | "LOCK"
  | "UNLOCK"
  | "ESP_REBOOT"
  | "FIRMWARE_DEPLOY"
  | "GATEWAY_REBOOT";

export type ScopeVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** Stable machine-readable code for the route/audit record. */
      code:
        | "ASSET_TENANT_MISMATCH"
        | "ASSET_TENANT_UNKNOWN"
        | "TENANT_SCOPE_UNKNOWN"
        | "TENANT_ID_INVALID";
      /** Operator-facing explanation. Never leaks the other tenant's identity. */
      message: string;
    };

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function tenantIdIsWellFormed(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

/**
 * Assert that an asset may be commanded by a caller acting for `expectedTenantId`.
 *
 * `assetTenantId` is the tenant the asset was RESOLVED to. Pass `undefined` or
 * `null` when the asset could not be resolved to a tenant at all — that is a
 * refusal, not a pass.
 */
export function assertControlScope(params: {
  /** Tenant of the authenticated caller. From the session, never inferred. */
  expectedTenantId: unknown;
  /** Tenant the resolved asset belongs to. */
  assetTenantId: unknown;
  /** Human label for messages, e.g. "Generator cmuv...". */
  assetLabel: string;
  action: ControlAction;
}): ScopeVerdict {
  const { expectedTenantId, assetTenantId, assetLabel, action } = params;

  // 1. We do not know WHO is asking. Refuse — an unauthenticated caller must
  //    never reach a control boundary, and treating a missing tenant as a
  //    wildcard would make the whole assertion optional.
  if (!tenantIdIsWellFormed(expectedTenantId)) {
    return {
      allowed: false,
      code: "TENANT_SCOPE_UNKNOWN",
      message:
        `${action} refused for ${assetLabel}: the requesting tenant is not known. ` +
        `A control command must carry the tenant it was authorised for.`,
    };
  }

  // 2. The asset could not be attributed to a tenant. This is the ambiguous
  //    case the audit called out: "not found" and "wrong tenant" both surface as
  //    an absent in-memory record, and treating either as an approval is the
  //    silent-success defect. Refuse.
  if (!tenantIdIsWellFormed(assetTenantId)) {
    return {
      allowed: false,
      code: "ASSET_TENANT_UNKNOWN",
      message:
        `${action} refused for ${assetLabel}: the asset could not be resolved to an ` +
        `owning tenant, so ownership cannot be confirmed. This is not an approval.`,
    };
  }

  // 3. The actual comparison. Note the message deliberately does NOT name the
  //    other tenant: telling a caller that asset X belongs to tenant Y is an
  //    enumeration oracle across tenant boundaries.
  if (assetTenantId !== expectedTenantId) {
    return {
      allowed: false,
      code: "ASSET_TENANT_MISMATCH",
      message:
        `${action} refused for ${assetLabel}: the asset does not belong to the ` +
        `requesting tenant.`,
    };
  }

  return { allowed: true };
}

/**
 * Convenience wrapper returning the denial message, or null when allowed.
 * Used at entry points whose signature already returns `{ ok, message }`.
 */
export function controlScopeDenial(params: Parameters<typeof assertControlScope>[0]): string | null {
  const verdict = assertControlScope(params);
  return verdict.allowed ? null : verdict.message;
}

/**
 * Resolve a generator's tenant via its site, then assert.
 *
 * Generators reach a tenant two hops (Generator.siteId → Site.tenantId) because
 * Generator carries its own tenantId but the authoritative ownership for a
 * CONTROLLED asset is its site — the site is what the breaker and the load
 * belong to. When the two disagree the command is refused rather than resolved,
 * because a disagreement means the data is inconsistent and refusing is the
 * direction that cannot touch another operator's hardware.
 */
export function assertGeneratorControlScope(params: {
  expectedTenantId: unknown;
  generatorId: string;
  generatorTenantId: unknown;
  siteTenantId: unknown;
  action: ControlAction;
}): ScopeVerdict {
  const verdict = assertControlScope({
    expectedTenantId: params.expectedTenantId,
    assetTenantId: params.siteTenantId,
    assetLabel: `Generator ${params.generatorId}`,
    action: params.action,
  });
  if (!verdict.allowed) return verdict;

  // Generator.tenantId is denormalised from Site.tenantId. If they disagree the
  // record is internally inconsistent and we must not guess which is right.
  if (
    typeof params.generatorTenantId === "string" &&
    params.generatorTenantId !== params.siteTenantId
  ) {
    return {
      allowed: false,
      code: "ASSET_TENANT_MISMATCH",
      message:
        `CONTROL refused for Generator ${params.generatorId}: the generator and its ` +
        `site disagree on tenant ownership, so the asset cannot be safely commanded.`,
    };
  }

  return { allowed: true };
}

/** Narrow helper so callers cannot pass an arbitrary string as an action. */
export function isGenCommand(value: string): value is GenCommand {
  return ["START", "STOP", "EMERGENCY_STOP", "RESET"].includes(value);
}