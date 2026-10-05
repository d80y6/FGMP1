import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { bootstrap } from "@/lib/fgmp";
import { withTenant } from "@/lib/fgmp/tenant-context";
import {
  requireAuth,
  isSuperAdminUser,
  assertTenantOwned,
  assertSiteTenantOwned,
  tenantWhereOrAll,
  siteTenantWhereOrAll,
  type AuthResult,
} from "@/lib/fgmp/auth-helpers";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import type { SessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/admin/tenant-isolation-test
 *
 * SUPERADMIN-only endpoint that runs a comprehensive tenant-isolation
 * verification suite and returns a structured report. The report covers:
 *
 *   1. **Per-tenant resource census** — counts of users, sites, alarms,
 *      generators, tanks, batteries, dispensers, deliveries, maintenance
 *      tickets, IoT devices, suppressions, audit logs, notifications,
 *      regions, and api-keys for every tenant in the platform.
 *
 *   2. **Cross-tenant access simulation** — for every pair of distinct
 *      tenants (A, B), picks a sample resource from tenant A and verifies
 *      that `assertTenantOwned` / `assertSiteTenantOwned` would REJECT a
 *      mock user from tenant B (returns 404). This is the unit test of the
 *      isolation helpers against real DB rows.
 *
 *   3. **SUPERADMIN bypass verification** — confirms the same helpers
 *      return `null` (allow) when called with a mock super-admin user.
 *
 *   4. **List-view scoping audit** — for every tenant, runs the
 *      `tenantWhereOrAll` / `siteTenantWhereOrAll` filter against each model
 *      and reports the row count, so the super-admin can confirm that a
 *      tenant admin's query returns only their own rows.
 *
 * The endpoint is read-only (no mutations) and safe to run in production.
 *
 * ── WHY THIS ROUTE WAS WRONG, AND WHAT NOW MAKES IT TRUSTWORTHY ───────────
 * This endpoint exists to ASSERT tenant isolation. Under Phase 1's FORCE RLS it
 * asserted nothing at all while reporting success:
 *
 *   - All eight sample queries and all census counts used the module-level
 *     `db` client with no tenant context, so every one returned NULL / 0.
 *   - Each assertion was guarded by `if (sampleX) { ... }`, so a null sample
 *     silently SKIPPED the test instead of failing it.
 *   - The summary computed `isolationIntact: failed === 0`, and `0 === 0` is
 *     true — so with every assertion skipped, the route reported
 *     `isolationIntact: true` having executed ZERO tests. Verified against the
 *     live database: totalTests 0, passed 0, failed 0, isolationIntact true.
 *
 * That is worse than a route returning empty data: it looks authoritative.
 *
 * Three properties now make a verdict mean something:
 *
 *   1. SAMPLES ARE READ INSIDE `withTenant(sourceTenant.id, …)`. The sample
 *      step is the precondition — the rightful tenant must be able to READ its
 *      own row. If it cannot, the policy is over-restrictive and no
 *      cross-tenant conclusion drawn from it is worth anything.
 *   2. `recordFound` is asserted BEFORE the access assertion, and a sample
 *      that cannot be located is recorded as a FAILURE with a reason, never
 *      skipped and never passed. `assertTenantOwned(null, …)` returns the same
 *      404 as "belongs to another tenant", so without this precondition a
 *      completely invisible dataset scores identically to correct isolation.
 *   3. `isolationIntact` requires `failed === 0 && measured > 0 &&
 *      measured === allTests.length`. A suite that measured nothing, or
 *      measured only part of what it claimed, reports false. `verdictBasis`
 *      states which of those happened in plain words.
 *
 * The tenant LIST is read on the ops/owner connection, which is deliberate:
 * this route compares tenants against each other and no single tenant context
 * can serve that. Only the enumeration is exempt — see `ops()`.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  if (!isSuperAdminUser(auth.user)) {
    return NextResponse.json(
      {
        error: "Forbidden",
        code: "SUPERADMIN_ONLY",
        message: "Tenant isolation testing is restricted to platform super-admins.",
      },
      { status: 403 },
    );
  }
  try {
    await bootstrap();
    const rl = rateLimitByUser(req, auth.user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const report = await buildReport();
    const res = NextResponse.json(report);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Report builder ─────────────────────────────────────────────────────────

/**
 * OPS connection for the parts of this report that are inherently cross-tenant.
 *
 * This route enumerates EVERY tenant and compares them against each other, so
 * no single tenant context can serve it — `withTenant("t-a", …)` would hide
 * t-b entirely, which is the opposite of what this diagnostic needs. Reading
 * the tenant list is therefore a deliberate, documented BY-DESIGN-OPS access
 * on the owner/ops role, NOT an oversight.
 *
 * Everything that reads a TENANT'S OWN ROWS (the census counts and the
 * per-tenant samples below) is NOT exempt: those run inside
 * `withTenant(t.id, …)` on the normal app connection, which is what proves the
 * policies actually admit the rightful tenant.
 *
 * The previous version used the module-level `db` for all of it. Under Phase
 * 1's FORCE RLS that returned zero rows for everything, and the route still
 * reported success — see the summary note below.
 */
let opsClient: PrismaClient | null = null;

function ops(): PrismaClient {
  const url =
    process.env.FGMP_OPS_DATABASE_URL ?? process.env.FGMP_MIGRATE_DATABASE_URL;
  if (!url) {
    throw new Error(
      "No ops/owner database URL configured. Set FGMP_OPS_DATABASE_URL " +
        "(preferred) or FGMP_MIGRATE_DATABASE_URL. Tenant enumeration is " +
        "inherently cross-tenant and cannot be served by a tenant-scoped " +
        "connection.",
    );
  }
  if (!opsClient) {
    opsClient = new PrismaClient({ datasources: { db: { url } } });
  }
  return opsClient;
}

async function buildReport(): Promise<TenantIsolationReport> {
  const startedAt = new Date();
  const tenants = await ops().tenant.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, code: true, country: true },
  });

  // 1. Per-tenant census
  const census: TenantCensus[] = [];
  for (const t of tenants) {
    const mockUser = makeMockUser(t.id, "ADMIN");
    const [
      users, sites, alarms, generators, tanks, batteries, dispensers,
      deliveries, tickets, iotDevices, suppressions, auditLogs, notifications,
      regions, apiKeys, shiftHandovers, gateways,
    ] = await withTenant(t.id, (tx) => Promise.all([
      tx.user.count({ where: { tenantId: t.id } }),
      tx.site.count({ where: { tenantId: t.id } }),
      tx.alarm.count({ where: { tenantId: t.id } }),
      tx.generator.count({ where: { site: { tenantId: t.id } } }),
      tx.fuelTank.count({ where: { site: { tenantId: t.id } } }),
      tx.batteryBank.count({ where: { site: { tenantId: t.id } } }),
      tx.fuelDispenser.count({ where: { site: { tenantId: t.id } } }),
      tx.fuelDelivery.count({ where: { site: { tenantId: t.id } } }),
      tx.maintenanceTicket.count({ where: { site: { tenantId: t.id } } }),
      tx.iotDevice.count({ where: { site: { tenantId: t.id } } }),
      tx.alarmSuppression.count({ where: { tenantId: t.id } }),
      tx.auditLog.count({ where: { tenantId: t.id } }),
      tx.notification.count({ where: { tenantId: t.id } }),
      tx.region.count({ where: { tenantId: t.id } }),
      tx.apiKey.count({ where: { tenantId: t.id } }),
      tx.shiftHandover.count({ where: { tenantId: t.id } }),
      tx.siteGateway.count({ where: { site: { tenantId: t.id } } }),
    ]));
    census.push({
      tenantId: t.id, tenantName: t.name, tenantCode: t.code, country: t.country,
      counts: {
        users, sites, alarms, generators, tanks, batteries, dispensers,
        deliveries, tickets, iotDevices, suppressions, auditLogs, notifications,
        regions, apiKeys, shiftHandovers, gateways,
      },
      listScoped: {
        // Verify tenantWhereOrAll returns the same count for a tenant admin
        alarmsList: await withTenant(t.id, (tx) =>
          tx.alarm.count({ where: { ...tenantWhereOrAll(mockUser) } as never })),
        sitesList: await withTenant(t.id, (tx) =>
          tx.site.count({ where: { ...tenantWhereOrAll(mockUser) } as never })),
        auditList: await withTenant(t.id, (tx) =>
          tx.auditLog.count({ where: { ...tenantWhereOrAll(mockUser) } as never })),
        generatorsList: await withTenant(t.id, (tx) =>
          tx.generator.count({ where: { ...siteTenantWhereOrAll(mockUser) } as never })),
        tanksList: await withTenant(t.id, (tx) =>
          tx.fuelTank.count({ where: { ...siteTenantWhereOrAll(mockUser) } as never })),
      },
    });
  }

  // 2. Cross-tenant access simulation
  const crossTenantTests: CrossTenantTest[] = [];
  if (tenants.length >= 2) {
    // Pick the first tenant with sites as "source" and any other as "target"
    for (const sourceTenant of tenants) {
      // Find a sample site + child resources in the source tenant
      // ── Samples are read INSIDE the source tenant's context ────────────
      // This is the assertion that makes the whole route meaningful: the
      // rightful tenant MUST be able to read its own row. If this returns
      // null, the policy is over-restrictive and every cross-tenant verdict
      // below is vacuous — which is exactly what the unscoped version did.
      const [
        sampleSite, sampleAlarm, sampleGen, sampleTank,
        sampleUser, sampleSuppression, sampleApiKey,
      ] = await withTenant(sourceTenant.id, (tx) => Promise.all([
        tx.site.findFirst({ where: { tenantId: sourceTenant.id }, select: { id: true, code: true, tenantId: true } }),
        tx.alarm.findFirst({ where: { tenantId: sourceTenant.id }, select: { id: true, tenantId: true } }),
        tx.generator.findFirst({ where: { site: { tenantId: sourceTenant.id } }, select: { id: true, site: { select: { tenantId: true } } } }),
        tx.fuelTank.findFirst({ where: { site: { tenantId: sourceTenant.id } }, select: { id: true, site: { select: { tenantId: true } } } }),
        tx.user.findFirst({ where: { tenantId: sourceTenant.id }, select: { id: true, tenantId: true, email: true } }),
        tx.alarmSuppression.findFirst({ where: { tenantId: sourceTenant.id }, select: { id: true, tenantId: true } }),
        tx.apiKey.findFirst({ where: { tenantId: sourceTenant.id }, select: { id: true, tenantId: true, name: true } }),
      ]));

      for (const targetTenant of tenants) {
        if (targetTenant.id === sourceTenant.id) continue;
        const mockTargetUser = makeMockUser(targetTenant.id, "ADMIN");
        const mockSuperAdmin = makeMockUser("t-platform", "SUPERADMIN");

        // Test each resource type
        const tests: ResourceTest[] = [];

        // Site (direct tenantId)
        if (sampleSite) {
          const denied = assertTenantOwned(sampleSite, mockTargetUser);
          const saAccess = assertTenantOwned(sampleSite, mockSuperAdmin);
          tests.push({
            resource: "site",
            resourceId: sampleSite.id,
            resourceLabel: sampleSite.code,
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            recordFound: true,
            crossTenantDenied: denied !== null,
            superAdminBypass: saAccess === null,
            // A pass requires the record to have been FOUND and readable by
            // the source tenant AND access to be denied for the target. A
            // null sample cannot score a pass: "denied because it is another
            // tenant's" and "denied because nobody can see it" are the same
            // value, and conflating them is what hid the original defect.
            pass: denied !== null && saAccess === null,
          });
        } else {
          // Flaw 2 fix: absence is a FAILURE, not a skip. An
          // assertion that could not be measured must never be
          // counted as a pass.
          tests.push({
            resource: "site",
            resourceId: null,
            resourceLabel: null,
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            recordFound: false,
            crossTenantDenied: null,
            superAdminBypass: null,
            reason: "sample not found for site in the source tenant — isolation cannot be measured",
            pass: false,
          });
        }

        // Alarm (direct tenantId)
        if (sampleAlarm) {
          const denied = assertTenantOwned(sampleAlarm, mockTargetUser);
          const saAccess = assertTenantOwned(sampleAlarm, mockSuperAdmin);
          tests.push({
            resource: "alarm",
            resourceId: sampleAlarm.id,
            resourceLabel: sampleAlarm.id.slice(-8),
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            recordFound: true,
            crossTenantDenied: denied !== null,
            superAdminBypass: saAccess === null,
            // A pass requires the record to have been FOUND and readable by
            // the source tenant AND access to be denied for the target. A
            // null sample cannot score a pass: "denied because it is another
            // tenant's" and "denied because nobody can see it" are the same
            // value, and conflating them is what hid the original defect.
            pass: denied !== null && saAccess === null,
          });
        } else {
          // Flaw 2 fix: absence is a FAILURE, not a skip. An
          // assertion that could not be measured must never be
          // counted as a pass.
          tests.push({
            resource: "alarm",
            resourceId: null,
            resourceLabel: null,
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            recordFound: false,
            crossTenantDenied: null,
            superAdminBypass: null,
            reason: "sample not found for alarm in the source tenant — isolation cannot be measured",
            pass: false,
          });
        }

        // Generator (child of Site)
        if (sampleGen) {
          const denied = assertSiteTenantOwned(sampleGen.site, mockTargetUser);
          const saAccess = assertSiteTenantOwned(sampleGen.site, mockSuperAdmin);
          tests.push({
            resource: "generator",
            resourceId: sampleGen.id,
            resourceLabel: sampleGen.id.slice(-8),
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            recordFound: true,
            crossTenantDenied: denied !== null,
            superAdminBypass: saAccess === null,
            // A pass requires the record to have been FOUND and readable by
            // the source tenant AND access to be denied for the target. A
            // null sample cannot score a pass: "denied because it is another
            // tenant's" and "denied because nobody can see it" are the same
            // value, and conflating them is what hid the original defect.
            pass: denied !== null && saAccess === null,
          });
        } else {
          // Flaw 2 fix: absence is a FAILURE, not a skip. An
          // assertion that could not be measured must never be
          // counted as a pass.
          tests.push({
            resource: "generator",
            resourceId: null,
            resourceLabel: null,
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            recordFound: false,
            crossTenantDenied: null,
            superAdminBypass: null,
            reason: "sample not found for generator in the source tenant — isolation cannot be measured",
            pass: false,
          });
        }

        // Tank (child of Site)
        if (sampleTank) {
          const denied = assertSiteTenantOwned(sampleTank.site, mockTargetUser);
          const saAccess = assertSiteTenantOwned(sampleTank.site, mockSuperAdmin);
          tests.push({
            resource: "tank",
            resourceId: sampleTank.id,
            resourceLabel: sampleTank.id.slice(-8),
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            recordFound: true,
            crossTenantDenied: denied !== null,
            superAdminBypass: saAccess === null,
            // A pass requires the record to have been FOUND and readable by
            // the source tenant AND access to be denied for the target. A
            // null sample cannot score a pass: "denied because it is another
            // tenant's" and "denied because nobody can see it" are the same
            // value, and conflating them is what hid the original defect.
            pass: denied !== null && saAccess === null,
          });
        } else {
          // Flaw 2 fix: absence is a FAILURE, not a skip. An
          // assertion that could not be measured must never be
          // counted as a pass.
          tests.push({
            resource: "tank",
            resourceId: null,
            resourceLabel: null,
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            recordFound: false,
            crossTenantDenied: null,
            superAdminBypass: null,
            reason: "sample not found for tank in the source tenant — isolation cannot be measured",
            pass: false,
          });
        }

        // User (direct tenantId)
        if (sampleUser) {
          const denied = assertTenantOwned(sampleUser, mockTargetUser);
          const saAccess = assertTenantOwned(sampleUser, mockSuperAdmin);
          tests.push({
            resource: "user",
            resourceId: sampleUser.id,
            resourceLabel: sampleUser.email ?? sampleUser.id,
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            recordFound: true,
            crossTenantDenied: denied !== null,
            superAdminBypass: saAccess === null,
            // A pass requires the record to have been FOUND and readable by
            // the source tenant AND access to be denied for the target. A
            // null sample cannot score a pass: "denied because it is another
            // tenant's" and "denied because nobody can see it" are the same
            // value, and conflating them is what hid the original defect.
            pass: denied !== null && saAccess === null,
          });
        } else {
          // Flaw 2 fix: absence is a FAILURE, not a skip. An
          // assertion that could not be measured must never be
          // counted as a pass.
          tests.push({
            resource: "user",
            resourceId: null,
            resourceLabel: null,
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            recordFound: false,
            crossTenantDenied: null,
            superAdminBypass: null,
            reason: "sample not found for user in the source tenant — isolation cannot be measured",
            pass: false,
          });
        }

        // Suppression (direct tenantId)
        if (sampleSuppression) {
          const denied = assertTenantOwned(sampleSuppression, mockTargetUser);
          const saAccess = assertTenantOwned(sampleSuppression, mockSuperAdmin);
          tests.push({
            resource: "suppression",
            resourceId: sampleSuppression.id,
            resourceLabel: sampleSuppression.id.slice(-8),
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            recordFound: true,
            crossTenantDenied: denied !== null,
            superAdminBypass: saAccess === null,
            // A pass requires the record to have been FOUND and readable by
            // the source tenant AND access to be denied for the target. A
            // null sample cannot score a pass: "denied because it is another
            // tenant's" and "denied because nobody can see it" are the same
            // value, and conflating them is what hid the original defect.
            pass: denied !== null && saAccess === null,
          });
        } else {
          // Flaw 2 fix: absence is a FAILURE, not a skip. An
          // assertion that could not be measured must never be
          // counted as a pass.
          tests.push({
            resource: "alarmSuppression",
            resourceId: null,
            resourceLabel: null,
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            recordFound: false,
            crossTenantDenied: null,
            superAdminBypass: null,
            reason: "sample not found for alarmSuppression in the source tenant — isolation cannot be measured",
            pass: false,
          });
        }

        // ApiKey (direct tenantId)
        if (sampleApiKey) {
          const denied = assertTenantOwned(sampleApiKey, mockTargetUser);
          const saAccess = assertTenantOwned(sampleApiKey, mockSuperAdmin);
          tests.push({
            resource: "apiKey",
            resourceId: sampleApiKey.id,
            resourceLabel: sampleApiKey.name ?? sampleApiKey.id.slice(-8),
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            recordFound: true,
            crossTenantDenied: denied !== null,
            superAdminBypass: saAccess === null,
            // A pass requires the record to have been FOUND and readable by
            // the source tenant AND access to be denied for the target. A
            // null sample cannot score a pass: "denied because it is another
            // tenant's" and "denied because nobody can see it" are the same
            // value, and conflating them is what hid the original defect.
            pass: denied !== null && saAccess === null,
          });
        } else {
          // Flaw 2 fix: absence is a FAILURE, not a skip. An
          // assertion that could not be measured must never be
          // counted as a pass.
          tests.push({
            resource: "apiKey",
            resourceId: null,
            resourceLabel: null,
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            recordFound: false,
            crossTenantDenied: null,
            superAdminBypass: null,
            reason: "sample not found for apiKey in the source tenant — isolation cannot be measured",
            pass: false,
          });
        }

        if (tests.length > 0) {
          crossTenantTests.push({
            sourceTenant: sourceTenant.code,
            targetTenant: targetTenant.code,
            tests,
          });
        }
      }
    }
  }

  // 3. Aggregate summary
  const allTests = crossTenantTests.flatMap((g) => g.tests);
  const passed = allTests.filter((t) => t.pass).length;
  const failed = allTests.filter((t) => !t.pass).length;
  // A suite that measured nothing must not report success. `failed === 0` on an
  // EMPTY array is true, which is how the previous version reported
  // isolationIntact:true having executed zero assertions.
  const measured = allTests.filter((t) => t.recordFound).length;
  const unmeasured = allTests.length - measured;
  const finishedAt = new Date();

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    tenantCount: tenants.length,
    tenants: census,
    crossTenantTests,
    summary: {
      totalTests: allTests.length,
      passed,
      failed,
      /** Assertions that actually located a real record to test against. */
      measured,
      /** Assertions that could not be measured (no sample row existed). */
      unmeasured,
      /**
       * True only when isolation was MEASURED and every measurement passed.
       *
       * Requires: at least one real measurement, no unmeasured assertions
       * masquerading as successes, and no failures. The previous
       * `failed === 0` was true on an empty suite, so an RLS policy that hid
       * every row produced a green verdict — the exact opposite of the truth.
       */
      isolationIntact: failed === 0 && measured > 0 && measured === allTests.length,
      /** Why the verdict is what it is, so a reader never has to guess. */
      verdictBasis:
        measured === 0
          ? "NO MEASUREMENT POSSIBLE: no sample rows were visible to the source tenant, so isolation was not tested."
          : unmeasured > 0
            ? `PARTIAL: ${measured}/${allTests.length} assertions measured; ${unmeasured} had no sample row and are counted as failures.`
            : `COMPLETE: ${measured} assertions measured against real rows, ${failed} failed.`,
    },
  };
}

function makeMockUser(tenantId: string, role: string): SessionUser {
  return {
    id: `mock-${tenantId}`,
    name: "Mock User",
    email: `mock@${tenantId}.local`,
    role,
    tenantId,
  } as SessionUser;
}

// ── Types ──────────────────────────────────────────────────────────────────

interface TenantCensus {
  tenantId: string;
  tenantName: string;
  tenantCode: string;
  country: string;
  counts: {
    users: number;
    sites: number;
    alarms: number;
    generators: number;
    tanks: number;
    batteries: number;
    dispensers: number;
    deliveries: number;
    tickets: number;
    iotDevices: number;
    suppressions: number;
    auditLogs: number;
    notifications: number;
    regions: number;
    apiKeys: number;
    shiftHandovers: number;
    gateways: number;
  };
  listScoped: {
    alarmsList: number;
    sitesList: number;
    auditList: number;
    generatorsList: number;
    tanksList: number;
  };
}

interface ResourceTest {
  resource: string;
  /** null when no sample row existed — see `recordFound`. */
  resourceId: string | null;
  resourceLabel: string | null;
  sourceTenant: string;
  targetTenant: string;
  /**
   * Whether a real row was FOUND and readable by the source tenant.
   *
   * This is the precondition that makes the rest of the test meaningful.
   * Without it, "denied" is ambiguous between "belongs to another tenant" and
   * "invisible to everyone" — and the second case is indistinguishable from
   * correct isolation at the assertion level.
   */
  recordFound: boolean;
  /** null when unmeasured. */
  crossTenantDenied: boolean | null;
  /** null when unmeasured. */
  superAdminBypass: boolean | null;
  /** Present only on failures, so an operator is never left guessing. */
  reason?: string;
  pass: boolean;
}

interface CrossTenantTest {
  sourceTenant: string;
  targetTenant: string;
  tests: ResourceTest[];
}

interface TenantIsolationReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tenantCount: number;
  tenants: TenantCensus[];
  crossTenantTests: CrossTenantTest[];
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    measured: number;
    unmeasured: number;
    isolationIntact: boolean;
    verdictBasis: string;
  };
}

// Re-export for type-checking only — avoids unused import warnings.
void (null as unknown as AuthResult);
