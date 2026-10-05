/**
 * Deploy-time seed entry point.
 *
 * Phase 1 step 6: seeding used to run inside bootstrap(), which meant every
 * authenticated request attempted it — and, because seeding spans tenants and
 * creates the tenants themselves, it needed the OWNER role. That forced the web
 * app container to hold a superuser connection purely to serve a request.
 *
 * It is now an explicit operator step:
 *
 *   bun run db:seed
 *
 * Run this ONCE per environment after `prisma migrate deploy`. It is
 * idempotent — seedIfNeeded() returns {seeded:false} when the topology is
 * already present.
 *
 * Requires FGMP_MIGRATE_DATABASE_URL (the owner role). This script is the ONLY
 * place that needs it; the web app must never be given that credential.
 */

import { PrismaClient } from "@prisma/client";
import { seedIfNeeded } from "@/lib/fgmp/seed";

function ownerUrl(): string {
  const url = process.env.FGMP_MIGRATE_DATABASE_URL;
  if (!url) {
    console.error(
      "\nFAIL: FGMP_MIGRATE_DATABASE_URL is not set.\n" +
        "  Seeding writes tenant rows, and RLS is FORCE-enabled on every\n" +
        "  tenant-carrying table, so it must run on the owner/migration role:\n\n" +
        "    export FGMP_MIGRATE_DATABASE_URL='postgresql://fgmp_migrate:…@…/fgmp?schema=public'\n" +
        "    bun run db:seed\n",
    );
    process.exit(1);
  }
  return url;
}

async function main() {
  // A visible warning beats a silent wrong-role failure. seed.ts already
  // falls back to the app client when this is absent, which RLS then rejects.
  const client = new PrismaClient({
    datasources: { db: { url: ownerUrl() } },
    log: [
      { level: "warn", emit: "stdout" as const },
      { level: "error", emit: "stdout" as const },
    ],
  });

  try {
    const result = await seedIfNeeded();
    console.log(`\ndb:seed -> ${JSON.stringify(result)}`);
    if (result.siteCount === 0) {
      console.error(
        "\nFAIL: seeding produced no sites. The platform would serve an empty\n" +
          "  fleet. Check the owner connection and the migrations above this.\n",
      );
      process.exitCode = 1;
    } else if (result.seeded) {
      console.log(`  seeded ${result.siteCount} sites`);
    } else {
      console.log(`  already seeded (${result.siteCount} sites) — nothing to do`);
    }
  } finally {
    await client.$disconnect();
  }
}

main().catch((err) => {
  console.error("\ndb:seed FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});