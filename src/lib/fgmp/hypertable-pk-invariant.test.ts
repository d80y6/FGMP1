/**
 * The SensorReading hypertable primary-key invariant.
 *
 * WHY THIS IS A TEST AND NOT A LINT RULE
 * --------------------------------------
 * `schema.prisma` declares `id String @id` for SensorReading. That is the HONEST
 * declaration for a PostgreSQL server without the TimescaleDB extension — but
 * Prisma cannot express a partition key in a composite primary key, so the model
 * will never record what migration 20261012000000 actually does:
 *
 *     ALTER TABLE "SensorReading"
 *       ADD CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("id", "ts");
 *
 * The gap between what the schema says and what the database does is the trap.
 * `prisma migrate dev --create-only` diffs the schema against the migration
 * history, concludes the primary key should be ("id") alone, and emits:
 *
 *     DROP INDEX "SensorReading_ts_idx";
 *     ALTER TABLE "SensorReading" DROP CONSTRAINT "SensorReading_pkey",
 *       ADD COLUMN ...,
 *       ADD CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("id");
 *
 * On a TimescaleDB server that REVERTS the hypertable conversion. It does not
 * error — it succeeds, the table stops being a hypertable, and dedup silently
 * changes shape, on whichever agent next touches this model. It fired once
 * already while writing the `tsSource` migration; that was caught only because
 * the generated SQL was read before applying it.
 *
 * A lint rule cannot catch this, because the schema is not wrong — it is
 * incomplete in a way Prisma has no syntax for. So the check below reads the
 * migration set and asserts the model cannot be regenerated into a revert.
 *
 * Run: bun test src/lib/fgmp/hypertable-pk-invariant.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = "prisma/migrations";
const HYPERTABLE_MIGRATION = "20261012000000_sensor_reading_hypertable";
const MODEL = "SensorReading";

function readSchema(): string {
  return readFileSync(join("prisma", "schema.prisma"), "utf8");
}

/**
 * The comment block IMMEDIATELY PRECEDING a model, plus its body.
 *
 * The warning has to live above `model SensorReading {` so Prisma does not
 * reformat it, which means it is outside the braces. Reading only the body
 * would miss exactly the comment this test exists to verify.
 */
function modelRegion(schema: string, model: string): string {
  const start = schema.indexOf(`model ${model} {`);
  if (start === -1) throw new Error(`model ${model} not found in schema.prisma`);
  // Walk back over the CONTIGUOUS comment block directly above the model. A
  // single lastIndexOf("// ─") is not enough: the warning is bounded by rule
  // lines on BOTH sides, so the first line of the block is what must be found.
  const before = schema.slice(0, start);
  const lines = before.split("\n");
  let first = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("//")) { first = i; continue; }
    break;
  }
  const leading = lines.slice(first).join("\n");
  const bodyEnd = schema.indexOf("\n}", start);
  return `${leading}${schema.slice(start, bodyEnd)}`;
}

function modelBody(schema: string, model: string): string {
  const m = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m").exec(schema);
  if (!m) throw new Error(`model ${model} not found in schema.prisma`);
  return m[1];
}

function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

describe("SensorReading hypertable primary key", () => {
  test("the hypertable migration exists and does require PRIMARY KEY (id, ts)", () => {
    // The premise of every check below. If this stops being true the model may
    // legitimately change, and these assertions should be revisited with it.
    const sql = migrationSql(HYPERTABLE_MIGRATION);
    expect(sql).toMatch(/PRIMARY KEY\s*\(\s*"id"\s*,\s*"ts"\s*\)/);
    expect(sql).toContain("create_hypertable");
  });

  test("no migration regresses the primary key to a single column", () => {
    // The actual trap. Any migration that re-asserts PRIMARY KEY ("id") alone on
    // this table would silently un-hypertable it.
    const offenders: string[] = [];
    for (const dir of readdirSync(MIGRATIONS_DIR)) {
      if (dir === "migration_lock.toml") continue;
      let sql: string;
      try {
        sql = migrationSql(dir);
      } catch {
        continue;
      }
      if (!sql.includes(MODEL)) continue;
      // Strip line comments before matching. The tsSource migration QUOTES the
      // destructive SQL verbatim in a comment explaining why it must not be
      // used — so a naive match flags its own documentation and the test fails
      // on the very file it is protecting.
      const executable = sql.replace(/--[^\n]*/g, "");
      // The hypertable migration legitimately ADDS the composite key; what is
      // forbidden is a LATER migration dropping it back to one column.
      if (dir === HYPERTABLE_MIGRATION) continue;
      // Match the PRIMARY KEY column list itself. Anchoring on the constraint
      // name missed Prisma's real output, where the clause sits at the END of
      // the statement after ADD COLUMN — so the test passed against exactly the
      // destructive SQL it exists to forbid.
      const single = /ADD\s+CONSTRAINT\s+"SensorReading_pkey"\s+PRIMARY\s+KEY\s*\(\s*"id"\s*\)/i;
      const multiLine = /ADD\s+CONSTRAINT\s+"SensorReading_pkey"\s+PRIMARY\s+KEY\s*\(\s*"id"\s*,\s*"ts"\s*\)/i;
      if (single.test(executable) && !multiLine.test(executable)) {
        offenders.push(dir);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the model documents why `id @id` is incomplete", () => {
    // The other half of the fix: the next agent to read this model must learn
    // the danger from the model itself, not from a test failure years later.
    const region = modelRegion(readSchema(), MODEL);
    expect(region).toContain("tsSource"); // sanity: we are reading the right model
    const comment = region.toLowerCase();
    expect(comment).toContain("primary key");
    expect(comment).toContain("timescaledb");
    // The specific instruction that prevents the accident.
    expect(comment).toMatch(/prisma migrate|regenerat/);
  });

  test("the model still declares a partition-key-unrepresentable id", () => {
    // Documents WHY the drift exists rather than asserting it should not: `id @id`
    // is correct for a server without the extension, and changing it would be
    // wrong. What must not happen is silently regenerating from it.
    const body = modelBody(readSchema(), MODEL);
    expect(body).toMatch(/^\s*id\s+String\s+@id/m);
  });
});
