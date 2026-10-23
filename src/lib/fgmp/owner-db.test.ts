/**
 * Owner-credential selection tests.
 *
 * Run: bun test src/lib/fgmp/owner-db.test.ts
 *
 * The regression this pins is specific: `systemDb()` in `src/lib/fgmp/seed.ts`
 * had its owner-variable read commented out and used DATABASE_URL instead. The
 * app URL is the RLS-enforced role, so every seed died on the first insert with
 *
 *   ERROR: new row violates row-level security policy for table "User"
 *
 * which looks like broken policies rather than a one-line edit. These tests
 * exist so that edit fails here, in a second, instead of in the first
 * deployment that runs `bun run db:seed`.
 */

import { describe, expect, test } from "bun:test";
import { hasOwnerDbUrl, resolveOwnerDbUrl } from "./owner-db";

const OWNER = "postgresql://fgmp_migrate:owner@db:5432/fgmp";
const APP = "postgresql://fgmp_app:app@db:5432/fgmp";

describe("resolveOwnerDbUrl", () => {
  test("prefers the owner credential over the app one", () => {
    // THE regression. If this returns APP, seeding runs as fgmp_app and RLS
    // rejects every insert.
    expect(
      resolveOwnerDbUrl({
        FGMP_MIGRATE_DATABASE_URL: OWNER,
        DATABASE_URL: APP,
      }),
    ).toBe(OWNER);
  });

  test("uses the owner credential when there is no app URL at all", () => {
    expect(resolveOwnerDbUrl({ FGMP_MIGRATE_DATABASE_URL: OWNER })).toBe(OWNER);
  });

  test("falls back to DATABASE_URL for local development without RLS", () => {
    expect(resolveOwnerDbUrl({ DATABASE_URL: APP })).toBe(APP);
  });

  test("returns undefined when neither is configured", () => {
    expect(resolveOwnerDbUrl({})).toBeUndefined();
  });

  test("treats empty strings as absent", () => {
    // `FGMP_MIGRATE_DATABASE_URL=` in a .env is an easy mistake, and Prisma
    // would accept the empty string as a URL. Falling through to undefined
    // makes the seed's own guard fire with a readable message.
    expect(
      resolveOwnerDbUrl({ FGMP_MIGRATE_DATABASE_URL: "", DATABASE_URL: APP }),
    ).toBe(APP);
    expect(resolveOwnerDbUrl({ FGMP_MIGRATE_DATABASE_URL: "" })).toBeUndefined();
  });

  test("does not leak a credential into a boolean", () => {
    // Cheap, but the point of hasOwnerDbUrl is that it can be called on a
    // value that must not be printed.
    expect(hasOwnerDbUrl({ FGMP_MIGRATE_DATABASE_URL: OWNER })).toBe(true);
    expect(hasOwnerDbUrl({ DATABASE_URL: APP })).toBe(false);
    expect(hasOwnerDbUrl({})).toBe(false);
  });
});
