/**
 * Regenerate `scripts/supabase/02-schema.sql` from `prisma/migrations`.
 *
 * Run after adding or editing a migration:
 *     bun run scripts/supabase/build-schema-sql.ts
 *
 * The test `src/lib/fgmp/__tests__/supabase-schema-sql.test.ts` fails when the
 * committed file no longer matches the migrations, so a forgotten regeneration
 * is caught in CI rather than in a failed deploy.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSchemaSql, type MigrationFile } from "../../src/lib/fgmp/supabase-schema-sql";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDir = join(root, "prisma", "migrations");
const outFile = join(root, "scripts", "supabase", "02-schema.sql");

const migrations: MigrationFile[] = readdirSync(migrationsDir)
  .filter((name) => existsSync(join(migrationsDir, name, "migration.sql")))
  .sort() // directory names are timestamp-prefixed, so lexical order is apply order
  .map((name) => ({
    name,
    sql: readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"),
  }));

writeFileSync(outFile, buildSchemaSql(migrations), "utf8");
console.log(`[schema-sql] wrote ${outFile} from ${migrations.length} migrations`);
