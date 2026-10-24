import type { Prisma, SystemSettingCategory } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, can, isSuperAdminUser } from "@/lib/fgmp/auth-helpers";
import { getOpsDb } from "@/lib/fgmp/owner-db";
import { invalidateSettingsCache } from "@/lib/fgmp/metrics-settings";
import { resetFuelPriceCache } from "@/lib/fgmp/metrics-fuel";
import { resetBattThresholdCache } from "@/lib/fgmp/thresholds-battery";

export const dynamic = "force-dynamic";

/**
 * System Settings (Task 35-E) — tenant-scoped configuration key-value store.
 * ────────────────────────────────────────────────────────────────────────────
 * Each row is one setting; the UI groups them by category.
 *
 * Categories:
 *   - ALARM        : fuelLowPct, fuelCriticalPct, genTempMax, battVoltageMin, commLossMin
 *   - ESCALATION   : l1ToL2Min, l2ToL3Min, autoResolveMin
 *   - BRANDING     : platformName, primaryColor, logoUrl
 *   - PLATFORM     : maxSitesPerTenant, sessionTimeoutMin, enableRealtime, enableOta
 *
 * ── TENANCY (security fix, 2026-10) ───────────────────────────────────────────
 * This table was GLOBAL (`key` unique platform-wide, no tenant column) while the
 * routes are tenant-scoped. Verified exploit: an ADMIN of tenant A patched
 * `platformName` and tenant B read the new value back — one tenant rewriting
 * every other tenant's configuration.
 *
 * Settings are now per-tenant rows with a nullable `tenantId`:
 *   * a tenant row (tenantId = caller's tenant) overrides the inherited value;
 *   * a platform default (tenantId = NULL) is inherited by every tenant and is
 *     READ-ONLY through this API — the RLS WITH CHECK requires a tenant match,
 *     so the application role cannot create or edit a platform-wide row.
 *
 * Effective value = in-code catalog default ← platform default row ← tenant row.
 *
 * ── AUTHORITY ────────────────────────────────────────────────────────────────
 *   ALARM / ESCALATION / FORECAST : ADMIN (+SUPERADMIN) writes its OWN tenant.
 *   BRANDING / PLATFORM           : platform policy. Writes require SUPERADMIN;
 *                                   a tenant administrator gets 403. (Before the
 *                                   fix these were writable by any tenant admin
 *                                   and applied to the whole platform.)
 *
 * GET   ?category=ALARM            → {key: {value, type, category, updatedAt}}
 * PATCH {key, value}               → upsert one setting
 * PATCH {settings: [{key, value}]} → batch upsert
 *
 * GET no longer writes. It used to auto-seed every default with one
 * `findUnique` + one `create` PER KEY PER CATEGORY on every single read, so a
 * dashboard poll produced dozens of statements, and a GET mutated the database.
 * Defaults now come from the catalog below, which needs no rows at all.
 */

// ── Default settings catalog ────────────────────────────────────────────────
// One entry per known setting. `type` controls how the UI renders + how the
// value is coerced when read back. Defaults are written on first GET.
interface DefaultSetting {
  key: string;
  category: "ALARM" | "ESCALATION" | "BRANDING" | "PLATFORM";
  value: string;
  type: "string" | "number" | "boolean" | "json";
}

const DEFAULT_SETTINGS: DefaultSetting[] = [
  // ── ALARM ────────────────────────────────────────────────────────────────
  { key: "fuelLowPct",      category: "ALARM",      value: "25",  type: "number" },
  { key: "fuelCriticalPct", category: "ALARM",      value: "10",  type: "number" },
  { key: "genTempMax",      category: "ALARM",      value: "95",  type: "number" },
  { key: "battVoltageMin",  category: "ALARM",      value: "46",  type: "number" },
  { key: "commLossMin",     category: "ALARM",      value: "10",  type: "number" },

  // ── ESCALATION ───────────────────────────────────────────────────────────
  { key: "l1ToL2Min",       category: "ESCALATION", value: "15",  type: "number" },
  { key: "l2ToL3Min",       category: "ESCALATION", value: "60",  type: "number" },
  { key: "autoResolveMin",  category: "ESCALATION", value: "1440", type: "number" },

  // ── BRANDING ─────────────────────────────────────────────────────────────
  { key: "platformName",    category: "BRANDING",   value: "FGMP — Fuel & Generator Monitoring Platform", type: "string" },
  { key: "primaryColor",    category: "BRANDING",   value: "#10b981", type: "string" },
  { key: "logoUrl",         category: "BRANDING",   value: "/logo.svg", type: "string" },

  // ── PLATFORM ─────────────────────────────────────────────────────────────
  { key: "maxSitesPerTenant", category: "PLATFORM", value: "200",  type: "number" },
  { key: "sessionTimeoutMin", category: "PLATFORM", value: "60",   type: "number" },
  { key: "enableRealtime",    category: "PLATFORM", value: "true", type: "boolean" },
  { key: "enableOta",         category: "PLATFORM", value: "true", type: "boolean" },
];

// Typed against the Prisma enum so the membership test below also narrows the
// query param to a valid `SystemSettingCategory` instead of a bare string.
const VALID_CATEGORIES: ReadonlySet<SystemSettingCategory> = new Set<SystemSettingCategory>([
  "ALARM",
  "ESCALATION",
  "BRANDING",
  "PLATFORM",
]);

/** Coerce a stringified setting value into the type stored in the row. */
export function coerceValue(value: string, type: DefaultSetting["type"]): unknown {
  switch (type) {
    case "number":
      return Number(value);
    case "boolean":
      return value === "true" || value === "1";
    case "json":
      try { return JSON.parse(value); } catch { return value; }
    case "string":
    default:
      return value;
  }
}

/** Find the default for a key (used by PATCH to know the type for new rows). */
function findDefault(key: string): DefaultSetting | undefined {
  return DEFAULT_SETTINGS.find((d) => d.key === key);
}

/**
 * The catalog defaults for one category (or all), keyed by setting key.
 *
 * Read-only on purpose. The previous implementation inserted the defaults into
 * the database on first read; defaults are a property of the code, so the
 * database only needs a row when an operator CHANGES one.
 */
function catalogDefaults(category?: string): Map<string, DefaultSetting> {
  const out = new Map<string, DefaultSetting>();
  for (const d of DEFAULT_SETTINGS) {
    if (category && d.category !== category) continue;
    out.set(d.key, d);
  }
  return out;
}

/**
 * GET /api/fgmp/settings?category=ALARM
 * Returns a {key: {value, type, category, updatedAt}} map.
 *
 * Effective value resolution (lowest to highest precedence):
 *   1. the in-code catalog default for the key (no row needed);
 *   2. a PLATFORM default row (tenantId IS NULL) — inherited by every tenant;
 *   3. this tenant's own row.
 *
 * Read-only: it issues ONE query and writes nothing. The previous version
 * auto-inserted every default on every read (two statements per key, six
 * categories when no category was named), so a dashboard poll produced dozens of
 * writes and a GET mutated the database.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { searchParams } = new URL(req.url);
    const rawCategory = searchParams.get("category")?.toUpperCase();
    // Type predicate so the validated value narrows to SystemSettingCategory —
    // the membership test IS the runtime validation, this just lets TypeScript
    // see it, rather than casting an unvalidated string into the enum.
    const isValidCategory = (v: string): v is SystemSettingCategory =>
      (VALID_CATEGORIES as ReadonlySet<string>).has(v);
    const category = rawCategory && isValidCategory(rawCategory) ? rawCategory : undefined;
    if (rawCategory && !isValidCategory(rawCategory)) {
      const res = NextResponse.json(
        { error: "Invalid category", allowed: Array.from(VALID_CATEGORIES) },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const tenantId = tenantIdOrThrow(me.tenantId);

    // ONE query. RLS returns platform defaults (tenantId IS NULL) plus this
    // tenant's rows, and nothing belonging to any other tenant.
    const where: Prisma.SystemSettingWhereInput = category ? { category } : {};
    const rows = await withTenant(tenantId, (tx) =>
      tx.systemSetting.findMany({
        where,
        orderBy: { key: "asc" },
      }),
    );

    const defaults = catalogDefaults(category);
    const out: Record<string, { value: unknown; type: string; category: string; updatedAt: string }> = {};

    // 1 + 2. Catalog defaults, overridden by platform rows.
    for (const [key, def] of defaults) {
      out[key] = {
        value: coerceValue(def.value, def.type),
        type: def.type,
        category: def.category,
        updatedAt: new Date(0).toISOString(),
      };
    }
    // Platform rows first, then tenant rows, so the tenant always wins.
    const ordered = [...rows].sort((a, b) => {
      const rank = (r: typeof a) => (r.tenantId === null ? 0 : 1);
      return rank(a) - rank(b);
    });
    for (const r of ordered) {
      out[r.key] = {
        value: coerceValue(r.value, r.type as DefaultSetting["type"]),
        type: r.type,
        category: r.category,
        updatedAt: r.updatedAt.toISOString(),
      };
    }

    const res = NextResponse.json(out);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/fgmp/settings
 * Body is either:
 *   { key: "fuelLowPct", value: 30 }
 *   { settings: [{key: "fuelLowPct", value: 30}, {key: "fuelCriticalPct", value: 12}] }
 *
 * AUTHORITY — checked per requested key, not once for the request:
 *   * ALARM / ESCALATION / FORECAST → tenant configuration. Requires the
 *     `settings:manage` capability (ADMIN) and is written into the caller's OWN
 *     tenant. A request that names a key from another authority class is refused
 *     as a whole (403) rather than partially applied.
 *   * BRANDING / PLATFORM → platform policy (session timeout, tenant caps, OTA
 *     switches, platform identity). SUPERADMIN only; a tenant administrator gets
 *     403. Before the fix any tenant admin could change these for everyone.
 *     These values are stored as PLATFORM defaults (`tenantId IS NULL`), which
 *     the application role must not write — the RLS WITH CHECK forbids it — so
 *     they are written on the narrow ops connection, which only a super-admin
 *     request can reach. Without an ops credential the request fails closed
 *     (503) instead of silently writing the value into one tenant.
 *
 * The value is coerced to string before persistence (the DB column is TEXT).
 * The `type` field for the row is taken from the defaults catalog so callers
 * can't lie about the storage type. Unknown keys are rejected individually.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  // The ACTING user, from the session. This is what the audit row below must
  // attribute the change to.
  //
  // `const me = await bootstrap()` was wrong on two counts: bootstrap() no
  // longer exists in the route layer (Phase 1 moved seeding off the request
  // path), and even when it did it returned the ENGINE's context rather than
  // this request's actor. Authorship of a configuration change is an audit
  // fact, so it has to come from the session and nowhere else.
  const me = auth.user;
  try {
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const ops: Array<{ key: string; value: unknown }> = [];
    if (Array.isArray((body as { settings?: unknown }).settings)) {
      for (const item of (body as { settings: Array<{ key?: string; value?: unknown }> }).settings) {
        if (item && typeof item.key === "string") ops.push({ key: item.key, value: item.value });
      }
    } else if (typeof (body as { key?: string }).key === "string") {
      ops.push({ key: (body as { key: string }).key, value: (body as { value?: unknown }).value });
    } else {
      const res = NextResponse.json(
        { error: "Body must be {key, value} or {settings: [{key, value}]}" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    if (ops.length === 0) {
      const res = NextResponse.json({ error: "No settings to update" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // ── Authority gate (before any write) ────────────────────────────────
    // Computed for the WHOLE request so a batch cannot half-apply: if one key in
    // the payload needs an authority the caller does not hold, nothing is
    // written. "Apply what you are allowed to and silently skip the rest" is how
    // a partial configuration change becomes a mystery later.
    const known: Array<{ op: { key: string; value: unknown }; def: DefaultSetting }> = [];
    for (const op of ops) {
      const def = findDefault(op.key);
      if (def) known.push({ op, def });
    }
    const platformKeys = known.filter(
      ({ def }) => def.category === "BRANDING" || def.category === "PLATFORM",
    );
    if (platformKeys.length > 0 && !isSuperAdminUser(me)) {
      const res = NextResponse.json(
        {
          error:
            "Platform-level settings (branding, session/tenant limits, OTA switches) can only be changed by a super-admin.",
          code: "PLATFORM_SETTING_REQUIRES_SUPERADMIN",
          keys: platformKeys.map(({ op }) => op.key),
        },
        { status: 403 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (known.length > 0 && !can(me, "settings:manage")) {
      const res = NextResponse.json(
        { error: "Forbidden", code: "INSUFFICIENT_CAPABILITY" },
        { status: 403 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const tenantId = tenantIdOrThrow(me.tenantId);

    // Platform defaults (branding / platform policy) live as `tenantId IS NULL`
    // rows, which the application role is forbidden to write. A super-admin's
    // request is the only path to them, and it needs the narrow ops connection.
    // Fail CLOSED when that credential is absent: writing the value into the
    // super-admin's own tenant would leave the other tenants on the old value
    // while the UI reported success.
    const opsDb = platformKeys.length > 0 ? getOpsDb() : null;
    if (platformKeys.length > 0 && !opsDb) {
      const res = NextResponse.json(
        {
          error: "Platform settings cannot be written on this deployment",
          code: "PLATFORM_SETTINGS_REQUIRE_OPS_CREDENTIAL",
          detail:
            "Platform-wide settings are stored as shared defaults (tenantId IS NULL). " +
            "Writing them requires the ops database role (FGMP_OPS_DATABASE_URL). " +
            "Set a platform default with the seed/ops path instead.",
        },
        { status: 503 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const results: Array<{ key: string; ok: boolean; error?: string }> = [];
    const updatedKeys: string[] = [];
    for (const op of ops) {
      const def = findDefault(op.key);
      if (!def) {
        results.push({ key: op.key, ok: false, error: "Unknown setting key" });
        continue;
      }
      // Coerce incoming value to the storage form (string). Booleans and
      // numbers are stringified; objects are JSON-stringified.
      let stored: string;
      if (typeof op.value === "string") stored = op.value;
      else if (typeof op.value === "number") stored = String(op.value);
      else if (typeof op.value === "boolean") stored = op.value ? "true" : "false";
      else stored = JSON.stringify(op.value);

      const isPlatformKey = def.category === "BRANDING" || def.category === "PLATFORM";
      if (isPlatformKey) {
        // Platform default: one shared row, written on the ops connection by a
        // super-admin request (see the authority gate above). `tenantId IS NULL`
        // is what makes it inherited by every tenant.
        //
        // The authority gate above already returned 503 when a platform key was
        // requested without an ops credential, so this cannot be null — but it
        // is checked rather than asserted, so a future edit that moves the gate
        // fails closed with a clear error instead of a TypeError.
        const ops = opsDb;
        if (!ops) {
          results.push({
            key: op.key,
            ok: false,
            error: "PLATFORM_SETTINGS_REQUIRE_OPS_CREDENTIAL",
          });
          continue;
        }
        const existing = await ops.systemSetting.findFirst({
          where: { tenantId: null, key: op.key },
          select: { id: true },
        });
        if (existing) {
          await ops.systemSetting.update({
            where: { id: existing.id },
            data: { value: stored, category: def.category, type: def.type },
          });
        } else {
          await ops.systemSetting.create({
            data: { tenantId: null, key: op.key, category: def.category, value: stored, type: def.type },
          });
        }
      } else {
        // Tenant-scoped upsert on the (tenantId, key) unique key. The row is
        // written into the CALLER'S tenant — never another tenant's, and never as
        // a platform-wide default (the RLS WITH CHECK rejects tenantId NULL for
        // the application role, so that mistake fails loudly instead of silently
        // re-creating the cross-tenant bug this change fixes).
        await withTenant(tenantId, (tx) =>
          tx.systemSetting.upsert({
            where: { tenantId_key: { tenantId, key: op.key } },
            update: { value: stored, category: def.category, type: def.type },
            create: { tenantId, key: op.key, category: def.category, value: stored, type: def.type },
          }),
        );
      }
      updatedKeys.push(op.key);
      results.push({ key: op.key, ok: true });
    }

    if (updatedKeys.length > 0) {
      // ── Invalidate the live read caches ─────────────────────────────────
      // Settings are read by the metrics/threshold helpers through a 60 s
      // cache, and `metrics-fuel.ts` used to memoise ONE process-wide Promise
      // with no TTL at all — so a saved fuel price or battery threshold did not
      // reach `/api/fgmp/analytics` until the process restarted. A settings
      // write that reports success and changes nothing is worse than a slow
      // one, so the write path now drops exactly what it invalidated:
      //   * a platform default (tenantId IS NULL) is inherited by EVERY tenant,
      //     so every tenant's cache goes;
      //   * a tenant row only affects that tenant's cache.
      if (platformKeys.length > 0) {
        invalidateSettingsCache();
        resetFuelPriceCache();
        resetBattThresholdCache();
      } else {
        invalidateSettingsCache(tenantId);
        resetFuelPriceCache(tenantId);
        resetBattThresholdCache(tenantId);
      }

      await audit({
        userId: me.id,
        tenantId,
        action: "CONFIG",
        entity: "SystemSetting",
        entityId: updatedKeys[0],
        details: { updated: updatedKeys, count: updatedKeys.length },
      });
    }

    const res = NextResponse.json({ ok: true, results });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
