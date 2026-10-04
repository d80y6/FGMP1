import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
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

async function buildReport(): Promise<TenantIsolationReport> {
  const startedAt = new Date();
  const tenants = await db.tenant.findMany({
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
    ] = await Promise.all([
      db.user.count({ where: { tenantId: t.id } }),
      db.site.count({ where: { tenantId: t.id } }),
      db.alarm.count({ where: { tenantId: t.id } }),
      db.generator.count({ where: { site: { tenantId: t.id } } }),
      db.fuelTank.count({ where: { site: { tenantId: t.id } } }),
      db.batteryBank.count({ where: { site: { tenantId: t.id } } }),
      db.fuelDispenser.count({ where: { site: { tenantId: t.id } } }),
      db.fuelDelivery.count({ where: { site: { tenantId: t.id } } }),
      db.maintenanceTicket.count({ where: { site: { tenantId: t.id } } }),
      db.iotDevice.count({ where: { site: { tenantId: t.id } } }),
      db.alarmSuppression.count({ where: { tenantId: t.id } }),
      db.auditLog.count({ where: { tenantId: t.id } }),
      db.notification.count({ where: { tenantId: t.id } }),
      db.region.count({ where: { tenantId: t.id } }),
      db.apiKey.count({ where: { tenantId: t.id } }),
      db.shiftHandover.count({ where: { tenantId: t.id } }),
      db.siteGateway.count({ where: { site: { tenantId: t.id } } }),
    ]);
    census.push({
      tenantId: t.id, tenantName: t.name, tenantCode: t.code, country: t.country,
      counts: {
        users, sites, alarms, generators, tanks, batteries, dispensers,
        deliveries, tickets, iotDevices, suppressions, auditLogs, notifications,
        regions, apiKeys, shiftHandovers, gateways,
      },
      listScoped: {
        // Verify tenantWhereOrAll returns the same count for a tenant admin
        alarmsList: await db.alarm.count({ where: { ...tenantWhereOrAll(mockUser) } as never }),
        sitesList: await db.site.count({ where: { ...tenantWhereOrAll(mockUser) } as never }),
        auditList: await db.auditLog.count({ where: { ...tenantWhereOrAll(mockUser) } as never }),
        generatorsList: await db.generator.count({ where: { ...siteTenantWhereOrAll(mockUser) } as never }),
        tanksList: await db.fuelTank.count({ where: { ...siteTenantWhereOrAll(mockUser) } as never }),
      },
    });
  }

  // 2. Cross-tenant access simulation
  const crossTenantTests: CrossTenantTest[] = [];
  if (tenants.length >= 2) {
    // Pick the first tenant with sites as "source" and any other as "target"
    for (const sourceTenant of tenants) {
      // Find a sample site + child resources in the source tenant
      const sampleSite = await db.site.findFirst({
        where: { tenantId: sourceTenant.id },
        select: { id: true, code: true, tenantId: true },
      });
      const sampleAlarm = await db.alarm.findFirst({
        where: { tenantId: sourceTenant.id },
        select: { id: true, tenantId: true },
      });
      const sampleGen = await db.generator.findFirst({
        where: { site: { tenantId: sourceTenant.id } },
        select: { id: true, site: { select: { tenantId: true } } },
      });
      const sampleTank = await db.fuelTank.findFirst({
        where: { site: { tenantId: sourceTenant.id } },
        select: { id: true, site: { select: { tenantId: true } } },
      });
      const sampleUser = await db.user.findFirst({
        where: { tenantId: sourceTenant.id },
        select: { id: true, tenantId: true, email: true },
      });
      const sampleSuppression = await db.alarmSuppression.findFirst({
        where: { tenantId: sourceTenant.id },
        select: { id: true, tenantId: true },
      });
      const sampleApiKey = await db.apiKey.findFirst({
        where: { tenantId: sourceTenant.id },
        select: { id: true, tenantId: true, name: true },
      });

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
            crossTenantDenied: denied !== null,
            superAdminBypass: saAccess === null,
            pass: denied !== null && saAccess === null,
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
            crossTenantDenied: denied !== null,
            superAdminBypass: saAccess === null,
            pass: denied !== null && saAccess === null,
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
            crossTenantDenied: denied !== null,
            superAdminBypass: saAccess === null,
            pass: denied !== null && saAccess === null,
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
            crossTenantDenied: denied !== null,
            superAdminBypass: saAccess === null,
            pass: denied !== null && saAccess === null,
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
            crossTenantDenied: denied !== null,
            superAdminBypass: saAccess === null,
            pass: denied !== null && saAccess === null,
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
            crossTenantDenied: denied !== null,
            superAdminBypass: saAccess === null,
            pass: denied !== null && saAccess === null,
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
            crossTenantDenied: denied !== null,
            superAdminBypass: saAccess === null,
            pass: denied !== null && saAccess === null,
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
      isolationIntact: failed === 0,
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
  resourceId: string;
  resourceLabel: string;
  sourceTenant: string;
  targetTenant: string;
  crossTenantDenied: boolean;
  superAdminBypass: boolean;
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
    isolationIntact: boolean;
  };
}

// Re-export for type-checking only — avoids unused import warnings.
void (null as unknown as AuthResult);
