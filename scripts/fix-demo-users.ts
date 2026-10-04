/**
 * FGMP Demo-User Healer (one-shot patch)
 * ─────────────────────────────────────────────────────────────────────────
 * Backfills passwordHash + correct role for the 5 RBAC demo users that
 * were created by an older version of seedIfNeeded() (which set
 * passwordHash=null and never wrote the role into the `update` branch of
 * the upsert). Running this once makes every demo account loggable with
 * the shared `Fgmp@2026` password.
 *
 * Idempotent: safe to run repeatedly. Only touches the 5 seeded demo
 * emails; never modifies the production admin (admin@fgmp.ye) or any
 * user created via the User Management UI.
 *
 * Usage:  bun run scripts/fix-demo-users.ts
 */
import bcrypt from "bcryptjs";
import { db } from "../src/lib/db";
import { PrismaClient } from "@prisma/client";

const DEMO_PASSWORD = "Fgmp@2026";

const DEMO_USERS: Array<{ id: string; name: string; email: string; role: string }> = [
  { id: "u-admin-1", name: "L. Al-Hadhrami", email: "admin@fgmp.telecom", role: "ADMIN" },
  { id: "u-noc-1", name: "A. Al-Rashid", email: "noc.operator@fgmp.telecom", role: "NOC_OPERATOR" },
  { id: "u-rm-1", name: "M. Al-Mikhlafi", email: "regional.manager@fgmp.telecom", role: "REGIONAL_MANAGER" },
  { id: "u-fe-1", name: "S. Al-Subeihi", email: "field.engineer@fgmp.telecom", role: "FIELD_ENGINEER" },
  { id: "u-exec-1", name: "Dr. K. Al-Mutawakel", email: "cto@fgmp.telecom", role: "EXECUTIVE" },
];

async function main() {
  const tenant = await db.tenant.findFirst({
    where: { code: "NATIONAL-TELCO" },
  });
  const tenantId = tenant?.id ?? "t-default";
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  console.log("──────────────────────────────────────────────────────────");
  console.log(" FGMP demo-user healer");
  console.log("──────────────────────────────────────────────────────────");

  let healed = 0;
  let created = 0;
  for (const u of DEMO_USERS) {
    const existing = await db.user.findUnique({ where: { email: u.email } });
    if (!existing) {
      await db.user.create({
        data: {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role as never,
          passwordHash,
          tenantId,
          active: true,
        },
      });
      created++;
      console.log(`  + created  ${u.email}  (${u.role})`);
    } else {
      await db.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          role: u.role as never,
          active: true,
          failedLoginAttempts: 0,
          lockedUntil: null,
          // Backfill name + tenantId for rows that may have been
          // partially seeded in older runs.
          name: existing.name ?? u.name,
          tenantId: existing.tenantId ?? tenantId,
        },
      });
      healed++;
      const roleChanged = existing.role !== u.role;
      const pwdWasMissing = !existing.passwordHash;
      const flags: string[] = [];
      if (roleChanged) flags.push(`role:${existing.role}→${u.role}`);
      if (pwdWasMissing) flags.push("pwd:null→set");
      console.log(`  ~ healed   ${u.email}  (${u.role})${flags.length ? "  [" + flags.join(", ") + "]" : ""}`);
    }
  }

  console.log("──────────────────────────────────────────────────────────");
  console.log(`  created: ${created}`);
  console.log(`  healed:  ${healed}`);
  console.log(`  password (all demo accounts): ${DEMO_PASSWORD}`);
  console.log("──────────────────────────────────────────────────────────");
}

main()
  .then(async () => {
    await (db as unknown as PrismaClient).$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[fix-demo-users] failed:", err);
    await (db as unknown as PrismaClient).$disconnect();
    process.exit(1);
  });
