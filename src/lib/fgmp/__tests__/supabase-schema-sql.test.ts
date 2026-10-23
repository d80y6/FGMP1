/**
 * The generated provisioning SQL must track `prisma/migrations`.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * `scripts/supabase/02-schema.sql` is what an operator runs against a hosted
 * database that this repository's tooling cannot reach. It is generated, and a
 * generated file that nobody regenerates is worse than no file at all: someone
 * adds a migration with a new column, deploys with the stale script, and the
 * application queries a column that does not exist — on the one database that
 * has no other way to be verified.
 *
 * The test rebuilds the script from the migrations on disk and compares it byte
 * for byte, so `bun test` answers "is the SQL an operator will run still the
 * schema in this commit?" without needing a database.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  buildSchemaSql,
  migrationChecksum,
  type MigrationFile,
} from "@/lib/fgmp/supabase-schema-sql";

const root = process.cwd();
const migrationsDir = join(root, "prisma", "migrations");
const generatedFile = join(root, "scripts", "supabase", "02-schema.sql");

function readMigrations(): MigrationFile[] {
  return readdirSync(migrationsDir)
    .filter((name) => existsSync(join(migrationsDir, name, "migration.sql")))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"),
    }));
}

describe("supabase schema script", () => {
  test("the committed 02-schema.sql matches the migrations", () => {
    assert.ok(
      statSync(generatedFile).size > 1000,
      "02-schema.sql is missing or empty — run `bun run scripts/supabase/build-schema-sql.ts`",
    );
    const expected = buildSchemaSql(readMigrations());
    const actual = readFileSync(generatedFile, "utf8");
    assert.equal(
      actual === expected,
      true,
      "scripts/supabase/02-schema.sql is out of date — regenerate it with " +
        "`bun run scripts/supabase/build-schema-sql.ts`",
    );
  });

  test("every migration is applied exactly once, in directory order", () => {
    const migrations = readMigrations();
    const sql = readFileSync(generatedFile, "utf8");

    let cursor = -1;
    for (const migration of migrations) {
      const at = sql.indexOf(`-- ${migration.name}\n`, cursor + 1);
      assert.ok(at > cursor, `${migration.name} is missing, duplicated, or out of order`);
      cursor = at;
    }
    assert.equal(sql.split("set role fgmp_migrate;").length, 2, "expected exactly one SET ROLE");
  });

  test("the bookkeeping rows carry Prisma's checksum", () => {
    const migrations = readMigrations();
    const sql = readFileSync(generatedFile, "utf8");

    for (const migration of migrations) {
      const checksum = migrationChecksum(migration.sql);
      assert.match(checksum, /^[0-9a-f]{64}$/);
      assert.ok(
        sql.includes(`'${checksum}', now(), '${migration.name}'`),
        `${migration.name} has no _prisma_migrations row with the right checksum`,
      );
    }

    // One INSERT per migration: a deploy that already ran must be a no-op.
    assert.equal(
      (sql.match(/insert into "_prisma_migrations"/g) ?? []).length,
      migrations.length,
    );
  });

  test("the script refuses to run over an existing schema", () => {
    const sql = readFileSync(generatedFile, "utf8");
    assert.match(sql, /tablename = 'Tenant'/);
    assert.match(sql, /raise exception[\s\S]{0,200}already exists/);
  });

  test("the application role cannot read the migration history", () => {
    const sql = readFileSync(generatedFile, "utf8");
    assert.match(sql, /revoke all on "_prisma_migrations" from fgmp_app/);
  });
});
