import type { Prisma, SystemSettingCategory } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * System Settings (Task 35-E) — global platform configuration key-value store.
 * ────────────────────────────────────────────────────────────────────────────
 * Stores global config (alarm thresholds, escalation timers, branding colors,
 * platform toggles) in the SystemSetting model. Each row is one setting; the
 * UI groups them by category.
 *
 * Categories:
 *   - ALARM        : fuelLowPct, fuelCriticalPct, genTempMax, battVoltageMin, commLossMin
 *   - ESCALATION   : l1ToL2Min, l2ToL3Min, autoResolveMin
 *   - BRANDING     : platformName, primaryColor, logoUrl
 *   - PLATFORM     : maxSitesPerTenant, sessionTimeoutMin, enableRealtime, enableOta
 *
 * GET  ?category=ALARM           → returns {key: value} map for the category
 * PATCH {key, value}              → upsert a single setting (ADMIN only)
 * PATCH {settings: [{key, value}]} → batch upsert (ADMIN only)
 *
 * On GET, if a category is requested and has zero rows, the API auto-upserts
 * the defaults (idempotent seeding) so the UI always has a complete payload.
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
 * Ensure every default for the given category exists in the DB. Cheap no-op
 * after first call. Returns the upserted count (0 if everything was already
 * present) so callers can log/audit the seeding event.
 */
async function seedCategoryDefaults(tenantId: string, category: string): Promise<number> {
  const defs = DEFAULT_SETTINGS.filter((d) => d.category === category);
  if (defs.length === 0) return 0;
  let seeded = 0;
  // Phase 3: scoped. These writes used the bare `db` client, which under FORCE
  // RLS is rejected by WITH CHECK — so auto-seeding defaults failed on a fresh
  // database. (SystemSetting is one of three tables deliberately EXCLUDED from
  // the tenant_isolation policy because it carries no tenantId, but the write
  // still needs an ambient transaction for the SET LOCAL to be valid.)
  await withTenant(tenantId, async (tx) => {
    for (const def of defs) {
      const existing = await tx.systemSetting.findUnique({ where: { key: def.key } });
      if (!existing) {
        await tx.systemSetting.create({
          data: { key: def.key, category: def.category, value: def.value, type: def.type },
        });
        seeded += 1;
      }
    }
  });
  return seeded;
}

/**
 * GET /api/fgmp/settings?category=ALARM
 * Returns a {key: value} map (with `type` metadata) for the given category.
 * If `category` is omitted, returns every setting grouped by category.
 *
 * On first load for a category, the API auto-upserts the defaults so the UI
 * never sees an empty payload.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const rl = rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
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

    // Auto-seed defaults for the requested category (or all of them).
    if (category) {
      await seedCategoryDefaults(me.tenantId, category);
    } else {
      for (const cat of VALID_CATEGORIES) await seedCategoryDefaults(me.tenantId, cat);
    }

    const where: Prisma.SystemSettingWhereInput = category ? { category } : {};
    const rows = await withTenant(me.tenantId, (tx) =>
      tx.systemSetting.findMany({
        where,
        orderBy: { key: "asc" },
      }),
    );

    // Build a {key: value} map with type coercion + metadata for the UI.
    const out: Record<string, { value: unknown; type: string; category: string; updatedAt: string }> = {};
    for (const r of rows) {
      out[r.key] = {
        value: coerceValue(r.value, r.type as DefaultSetting["type"]),
        type: r.type,
        category: r.category,
        updatedAt: r.updatedAt.toISOString(),
      };
    }

    // `void user` was a leftover from when this handler destructured
    // `const { user } = await bootstrap()`. Phase 1 removed seeding from the
    // request path and bootstrap() from routes, so no `user` binding exists
    // here any more — and nothing needs one: the reads above already run scoped
    // to `me.tenantId`, and this response carries no per-actor data.
    const res = NextResponse.json(out);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/fgmp/settings
 * ADMIN-only. Body is either:
 *   { key: "fuelLowPct", value: 30 }
 *   { settings: [{key: "fuelLowPct", value: 30}, {key: "fuelCriticalPct", value: 12}] }
 *
 * The value is coerced to string before persistence (the DB column is TEXT).
 * The `type` field for the row is taken from the defaults catalog so callers
 * can't lie about the storage type. Unknown keys are rejected with 400.
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
    const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
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

      await withTenant(me.tenantId, (tx) =>
        tx.systemSetting.upsert({
          where: { key: op.key },
          update: { value: stored, category: def.category, type: def.type },
          create: { key: op.key, category: def.category, value: stored, type: def.type },
        }),
      );
      updatedKeys.push(op.key);
      results.push({ key: op.key, ok: true });
    }

    if (updatedKeys.length > 0) {
      await audit({
        userId: me.id,
        tenantId: me.tenantId,
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
