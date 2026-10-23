/**
 * Demo-credential rotation policy.
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────
 * `seed.ts` and `03-seed.sql` create accounts with KNOWN passwords. That is
 * correct for a demo and for a seeded development database, and it is a
 * critical defect for anything reachable from the internet:
 *
 *   superadmin@fgmp.telecom / Super@2026   ← platform-wide, cross-tenant
 *   admin@fgmp.telecom      / Admin@2026   ← tenant administrator
 *   …four more with the same password
 *
 * The passwords are in this repository, in two seeders, and in the deployment
 * documentation. "Rotate them after first login" was the previous policy — a
 * policy that is invisible to the system and therefore unenforced. The
 * `docs/READINESS.md` entry said the same thing, which is how it survived: a
 * documented intention is not a control.
 *
 * ── WHAT IS ENFORCED, AND WHEN ─────────────────────────────────────────────
 * The check runs at the one moment the plaintext is available: inside
 * `authorize()`, after the password has been verified. If the verified password
 * IS one of the published demo values:
 *
 *   • NODE_ENV=production, and FGMP_ALLOW_DEMO_CREDENTIALS is not "1"
 *       → the login is REFUSED. An operator who deploys the seed and does not
 *         rotate gets a clear log line and cannot get in with a published
 *         password. This is fail-closed, and it is the point.
 *   • NODE_ENV=production with FGMP_ALLOW_DEMO_CREDENTIALS=1
 *       → allowed, with a warning on every such login. This is the explicit
 *         "I am running a demo" escape hatch, not a default.
 *   • anything else (development, CI, previews)
 *       → allowed, no warning. Forcing rotation in development would make the
 *         documented demo accounts unusable and would train people to set the
 *         escape hatch everywhere.
 *
 * ── WHY COMPARE THE PLAINTEXT INSTEAD OF A HASH ────────────────────────────
 * bcrypt hashes are salted, so a stored hash cannot be compared to a constant
 * hash to detect "this is still the demo password". The plaintext is available
 * at exactly this point and nowhere else, so this is the only place the check
 * can live. It is a string comparison against three constants; it costs
 * nothing, and it cannot be fooled by a re-salted hash of the same password.
 *
 * ── ROTATION ───────────────────────────────────────────────────────────────
 * `bun run scripts/set-password.ts <email> <new-password>` sets a bcrypt hash
 * directly. The reset-password endpoint does the same thing for a logged-in
 * administrator. Rotating the SEED FILES is not enough for an existing
 * database: the check is on the password that is used, not on the file.
 */

/**
 * Passwords published by the seeders. Keep in sync with `src/lib/fgmp/seed.ts`
 * (SEED_PASSWORD / SUPERADMIN_PASSWORD), `scripts/supabase/03-seed.sql` and the
 * legacy healer `scripts/db/fix-demo-users.ts`.
 *
 * The test suite asserts all three seeders agree, so this list cannot silently
 * fall behind and leave a published password unenforced.
 */
export const DEMO_PASSWORDS: readonly string[] = [
  "Admin@2026",
  "Super@2026",
  // Published by the one-shot healer scripts/db/fix-demo-users.ts. It is in the
  // repository and has been used on real databases, so it counts as published.
  "Fgmp@2026",
];

/** True when `password` is one of the published demo values. */
export function isDemoPassword(password: string): boolean {
  return DEMO_PASSWORDS.includes(password);
}

/** The environment this policy reads (injectable for tests). */
export interface DemoCredentialEnv {
  NODE_ENV?: string;
  FGMP_ALLOW_DEMO_CREDENTIALS?: string;
}

export type DemoCredentialDecision = "allow" | "allow-with-warning" | "refuse";

/**
 * Decide what to do about a successful login that used a demo password.
 *
 * Pure and total, so the policy can be tested without an auth round-trip.
 */
export function evaluateDemoCredential(
  password: string,
  env: DemoCredentialEnv = process.env as DemoCredentialEnv,
): DemoCredentialDecision {
  if (!isDemoPassword(password)) return "allow";
  const isProduction = env.NODE_ENV === "production";
  if (!isProduction) return "allow";
  return env.FGMP_ALLOW_DEMO_CREDENTIALS === "1" ? "allow-with-warning" : "refuse";
}

/** The message returned (and logged) when a demo credential is refused. */
export const DEMO_CREDENTIAL_REFUSAL =
  "This account still uses the password published in the seed data, and this deployment does not allow demo credentials. Ask an administrator to set a new password (bun run scripts/set-password.ts <email> <new-password>).";
