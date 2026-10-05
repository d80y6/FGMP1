/**
 * FGMP Admin Seed Script
 * ─────────────────────────────────────────────────────────────────────────
 * Creates (or refreshes) the default ADMIN user used for first-time login
 * on a freshly deployed FGMP instance.
 *
 * Default credentials:
 *   Email:    admin@fgmp.ye
 *   Password: Admin@2026
 *
 * Usage:
 *   bun run scripts/seed-admin.ts                       # uses defaults
 *   ADMIN_EMAIL=ops@fgmp.ye ADMIN_PASSWORD='...' bun run scripts/seed-admin.ts
 *
 * The script is idempotent: if the admin already exists, it only refreshes
 * the password hash + ensures role=ADMIN + active=true. It never deletes
 * data.
 */
import bcrypt from "bcryptjs";
/**
 * Owner-role client for system-level work (Phase 1 step 6).
 *
 * RLS is FORCE-enabled on every tenant-carrying table, so a write with no
 * `app.tenant_id` in scope fails its WITH CHECK:
 *
 *   ERROR: new row violates row-level security policy for table "User"
 *
 * This script creates the tenants themselves, so it cannot wrap itself in
 * withTenant() — there is no tenant to scope to yet. It runs on the owner role,
 * the same pattern as src/lib/fgmp/seed.ts.
 */
function systemDb(): PrismaClient {
  const url = process.env.FGMP_MIGRATE_DATABASE_URL;
  if (!url) {
    throw new Error(
      "FGMP_MIGRATE_DATABASE_URL is required: RLS blocks writes on the app role.",
    );
  }
  return new PrismaClient({
    datasources: { db: { url } },
    log: [
      { level: "warn", emit: "stdout" as const },
      { level: "error", emit: "stdout" as const },
    ],
  });
}

const db = systemDb();
import { PrismaClient } from "@prisma/client";

const DEFAULT_EMAIL = "admin@fgmp.ye";
const DEFAULT_PASSWORD = "Admin@2026";
const DEFAULT_NAME = "Platform Administrator";
const DEFAULT_TENANT_ID = "t-default";
const DEFAULT_TENANT_NAME = "National Telecom Operator";
const DEFAULT_TENANT_CODE = "NATIONAL-TELCO";

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? DEFAULT_EMAIL).trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? DEFAULT_PASSWORD;
  const name = process.env.ADMIN_NAME ?? DEFAULT_NAME;

  if (password.length < 8) {
    console.error("[seed-admin] Password must be at least 8 characters.");
    process.exit(1);
  }

  // Make sure the default tenant exists.
  const tenant = await db.tenant.upsert({
    where: { code: DEFAULT_TENANT_CODE },
    update: {},
    create: {
      id: DEFAULT_TENANT_ID,
      name: DEFAULT_TENANT_NAME,
      code: DEFAULT_TENANT_CODE,
      country: "Yemen",
    },
  });

  const passwordHash = await bcrypt.hash(password, 10);

  const admin = await db.user.upsert({
    where: { email },
    update: {
      passwordHash,
      role: "ADMIN",
      active: true,
      // Reset any brute-force lock that may have been triggered by earlier
      // testing — fresh admin should be able to log in immediately.
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
    create: {
      email,
      name,
      role: "ADMIN",
      passwordHash,
      tenantId: tenant.id,
      active: true,
    },
    select: { id: true, email: true, name: true, role: true, tenantId: true },
  });

  console.log("──────────────────────────────────────────────────────────");
  console.log(" FGMP admin seeded");
  console.log("──────────────────────────────────────────────────────────");
  console.log(`  id        : ${admin.id}`);
  console.log(`  email     : ${admin.email}`);
  console.log(`  name      : ${admin.name}`);
  console.log(`  role      : ${admin.role}`);
  console.log(`  tenantId  : ${admin.tenantId}`);
  console.log(`  password  : ${password === DEFAULT_PASSWORD ? "(default — change immediately)" : "(from env)"}`);
  console.log("──────────────────────────────────────────────────────────");
}

main()
  .then(async () => {
    await (db as unknown as PrismaClient).$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[seed-admin] failed:", err);
    await (db as unknown as PrismaClient).$disconnect();
    process.exit(1);
  });
