/**
 * Set a user's password, so a seeded account can be rotated.
 *
 * ── WHY THIS SCRIPT EXISTS ─────────────────────────────────────────────────
 * The seed files publish their passwords. `src/lib/fgmp/auth.ts` now REFUSES a
 * production login that still uses one of them (unless the operator opts in
 * with FGMP_ALLOW_DEMO_CREDENTIALS=1), which is only a useful control if there
 * is a supported way to rotate. The reset-password endpoint needs a logged-in
 * administrator, and the account that most needs rotating is the super-admin
 * who cannot log in yet.
 *
 * ── WHY IT RUNS AS THE OWNER ROLE ──────────────────────────────────────────
 * `User` is FORCE-RLS protected. This script looks a user up by email without
 * knowing the tenant — the same chicken-and-egg as login — and it must not
 * depend on the app role or on an ambient tenant context. It therefore uses
 * FGMP_MIGRATE_DATABASE_URL, exactly like the seed, and refuses to run without
 * it rather than silently falling back to the RLS-enforced app role.
 *
 * ── WHAT IT CHECKS BEFORE WRITING ──────────────────────────────────────────
 *   1. the email exists;
 *   2. the new password is not one of the published demo values (rotating from
 *      one published password to another is not a rotation);
 *   3. the new password meets the same length floor the user routes enforce.
 * It also clears failed-login counters and any lock, so a locked-out operator
 * is not left locked out after the rotation.
 *
 * Usage:
 *   FGMP_MIGRATE_DATABASE_URL=postgresql://fgmp_migrate:…/fgmp \
 *     bun run scripts/set-password.ts admin@fgmp.telecom 'a-new-long-password'
 *
 * The password is read from argv for scriptability and MAY be omitted, in
 * which case it is read from stdin — prefer that on a shared machine, because
 * argv is visible in `ps` and in shell history.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { isDemoPassword, DEMO_PASSWORDS } from "../src/lib/fgmp/demo-credentials";

/** Same floor the reset-password endpoint applies. */
const MIN_LENGTH = 12;

function fail(message: string): never {
  console.error(`[set-password] ${message}`);
  process.exit(1);
}

async function main() {
  const email = (process.argv[2] ?? "").trim().toLowerCase();
  if (!email) {
    fail("usage: bun run scripts/set-password.ts <email> [new-password]");
  }

  let password = process.argv[3] ?? "";
  if (!password) {
    if (!stdin.isTTY) {
      // Piped input: read one line, so `echo … | bun run …` works in CI.
      const rl = createInterface({ input: stdin, output: stdout });
      password = (await rl.question("New password: ")).trim();
      rl.close();
    } else {
      const rl = createInterface({ input: stdin, output: stdout });
      password = (await rl.question(`New password for ${email}: `)).trim();
      rl.close();
    }
  }

  if (password.length < MIN_LENGTH) {
    fail(`the new password must be at least ${MIN_LENGTH} characters.`);
  }
  if (isDemoPassword(password)) {
    fail(
      `that is one of the published demo passwords (${DEMO_PASSWORDS.join(", ")}). Rotating to another published value does not rotate anything.`,
    );
  }

  const url = process.env.FGMP_MIGRATE_DATABASE_URL;
  if (!url) {
    fail("FGMP_MIGRATE_DATABASE_URL is required: `User` is FORCE-RLS protected and this lookup is cross-tenant by necessity.");
  }

  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, email: true, tenantId: true, role: true },
    });
    if (!user) fail(`no user with email ${email}.`);

    const passwordHash = await bcrypt.hash(password, 12);

    // ONE TRANSACTION, WITH THE TENANT CONTEXT SET EXPLICITLY.
    // `User` and `AuditLog` are both FORCE-RLS protected, and the migration role
    // is a non-superuser on a hosted database, so being the OWNER is not enough:
    // the WITH CHECK still requires app.tenant_id to match. Setting it here is
    // the same transaction-local mechanism the app uses, applied to the one
    // tenant this user belongs to.
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${user.tenantId}, true)`;

      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          // An operator rotating a password is the recovery path for a locked
          // account, so the lock and the counter go with it. Leaving them would
          // mean "I reset the password and still cannot log in".
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });

      // A password change that is invisible in the audit trail is a change
      // nobody can review. The actor is the operator running the script, which
      // the database cannot attest to, so the detail says so rather than
      // inventing a user id.
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: null,
          action: "USER_PASSWORD_SET_BY_OPERATOR",
          entity: "User",
          entityId: user.id,
          details: JSON.stringify({
            email: user.email,
            role: user.role,
            via: "scripts/set-password.ts",
            actorKind: "operator-cli",
          }),
        },
      });
    });

    console.log(`[set-password] password updated for ${user.email} (${user.role}, tenant ${user.tenantId}).`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
