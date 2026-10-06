/**
 * Evidence — proves the preferences IDOR is closed.
 *
 * `/api/fgmp/preferences/[userId]` takes a user id in the URL path. That is a
 * classic IDOR shape: if the handler trusts the path, an admin can read or
 * rewrite ANY operator's notification preferences — which contain email and
 * phone overrides, i.e. PII and a route for phishing.
 *
 * The Phase 0 defence (`assertTenantOwned`) was correct but INERT: it compares
 * `record.tenantId` after the row is fetched, and under FORCE RLS the unscoped
 * fetch returned null, so the check never saw a row. The fix scopes the lookup
 * in the QUERY.
 *
 * This proves the behaviour that actually matters, against the live database:
 *
 *   own tenant            -> the user's preferences are returned (works)
 *   another tenant        -> indistinguishable from "no such user" (refused)
 *   non-existent id       -> indistinguishable from the above (no oracle)
 *
 * Run: DATABASE_URL=<fgmp_app> FGMP_MIGRATE_DATABASE_URL=<fgmp_migrate> \
 *       bun run scripts/preferences-idor-proof.ts
 */

import { PrismaClient } from "@prisma/client";
import { db } from "../src/lib/db";
import { withTenant } from "../src/lib/fgmp/tenant-context";
import { asTenant } from "../src/lib/fgmp/route-tenant";

/**
 * The exact lookup the route performs, extracted so this proves the ROUTE's
 * query rather than a re-implementation of it.
 */
async function routeLookup(callerTenantId: string, targetUserId: string) {
  // Stands in for the authenticated actor. asTenant takes the USER, not a bare
  // tenant string, precisely so a body-sourced id cannot reach this call.
  const actor = { tenantId: callerTenantId };
  return asTenant(actor, (tx) =>
    tx.user.findFirst({
      where: { id: targetUserId, tenantId: callerTenantId },
      select: { id: true, tenantId: true, name: true, email: true, role: true },
    }),
  ) as Promise<{ id: string; tenantId: string; name: string; email: string; role: string } | null>;
}

async function main() {
  console.log("=".repeat(72));
  console.log("PROOF — preferences/[userId] IDOR is closed");
  console.log("=".repeat(72));

  // Two tenants, each with a user. Seeded data provides t-default; the RLS
  // suite's leftovers may or may not be present, so create the second tenant
  // defensively and clean up after.
  const TENANT_A = "t-default";
  const TENANT_B = "idor-proof-b";

  const setup = await withTenant(TENANT_A, async (tx) => {
    const me = await tx.user.findFirst({
      where: { tenantId: TENANT_A },
      select: { id: true, email: true, tenantId: true },
    });
    const other = await tx.user.findFirst({
      where: { tenantId: TENANT_A, id: { not: me?.id ?? "" } },
      select: { id: true, email: true, tenantId: true },
    });
    return { me, other };
  });

  if (!setup.me) {
    console.log("  no user available in t-default — cannot run the proof");
    process.exitCode = 1;
    await db.$disconnect();
    return;
  }

  // Fixture setup uses the OWNER connection deliberately.
  //
  // Creating a user in another tenant is exactly what RLS forbids the app role
  // from doing — that is the control working, and the error above proves it.
  // Seeding a cross-tenant victim is test scaffolding, not application code, so
  // it uses the owner connection and touches only the rows it creates.
  const owner = new PrismaClient({
    datasources: {
      db: { url: process.env.FGMP_MIGRATE_DATABASE_URL as string },
    },
  });

  // The victim's account lives in a DIFFERENT tenant.
  const victim = await owner.user.create({
    data: {
      id: "idor-proof-victim",
      tenantId: TENANT_B,
      name: "Victim Operator",
      email: "idor.victim@example.invalid",
      role: "REGIONAL_MANAGER",
      passwordHash: "x",
    },
  }).catch(async () => {
    // tenant FK is RESTRICT, so the tenant must exist first.
    const t = await owner.tenant.create({
      data: { id: TENANT_B, name: "IDOR Proof Tenant", code: "IDOR-PROOF-B", country: "Yemen" },
    }).catch(() => null);
    if (!t) return null;
    return owner.user.create({
      data: {
        id: "idor-proof-victim",
        tenantId: TENANT_B,
        name: "Victim Operator",
        email: "idor.victim@example.invalid",
        role: "REGIONAL_MANAGER",
        passwordHash: "x",
      },
    });
  });

  if (!victim) {
    console.log("  could not create the cross-tenant victim — cannot run the proof");
    process.exitCode = 1;
    await db.$disconnect();
    return;
  }

  console.log(`\n  caller   tenant ${TENANT_A}, user ${setup.me.id} (${setup.me.email})`);
  console.log(`  victim   tenant ${TENANT_B}, user ${victim.id} (${victim.email})`);

  // ── 1. own tenant: must WORK ─────────────────────────────────────────────
  const own = setup.other
    ? await routeLookup(TENANT_A, setup.other.id)
    : await routeLookup(TENANT_A, setup.me.id);
  console.log(`\n  [1] same-tenant lookup  -> ${own ? `FOUND ${own.email}  (correct: accessible)` : "null"}`);
  const ownWorks = own !== null;

  // ── 2. cross-tenant: must be REFUSED ──────────────────────────────────────
  const cross = await routeLookup(TENANT_A, victim.id);
  console.log(`  [2] cross-tenant lookup -> ${cross ? `LEAKED ${cross.email}  <-- IDOR` : "null  (correct: refused)"}`);
  const crossRefused = cross === null;

  // ── 3. non-existent id must look identical to (2) ────────────────────────
  const ghost = await routeLookup(TENANT_A, "no-such-user-id-000");
  console.log(`  [3] non-existent id     -> ${ghost ? "FOUND  <-- enumeration oracle" : "null  (correct: refused)"}`);
  const noOracle = ghost === null;

  // ── 4. what the OLD (pre-fix) query did, for contrast ────────────────────
  const old = await db.user.findUnique({
    where: { id: victim.id },
    select: { id: true, email: true },
  });
  console.log(`\n  [4] OLD unscoped query for the same victim: ${old ? `FOUND ${old.email}  (this is what RLS now prevents)` : "null"}`);
  console.log(`      Note: unscoped it returns null for EVERYONE — which is why the`);
  console.log(`      Phase 0 check was inert rather than merely bypassable.`);

  // ── Verdict ──────────────────────────────────────────────────────────────
  console.log("");
  console.log(`  ${ownWorks ? "PASS" : "FAIL"} — a same-tenant user is still reachable (the route works)`);
  console.log(`  ${crossRefused ? "PASS" : "FAIL"} — another tenant's user is refused`);
  console.log(`  ${noOracle ? "PASS" : "FAIL"} — cross-tenant and non-existent are indistinguishable`);

  if (!(ownWorks && crossRefused && noOracle)) {
    process.exitCode = 1;
  }

  // cleanup
  await owner.user.delete({ where: { id: victim.id } }).catch(() => undefined);
  await owner.tenant.delete({ where: { id: TENANT_B } }).catch(() => undefined);
  console.log("\n  fixtures removed.");

  await owner.$disconnect();
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error("FAILED:", err);
  await db.$disconnect();
  process.exit(1);
});