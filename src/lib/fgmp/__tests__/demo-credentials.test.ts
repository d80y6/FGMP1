import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEMO_PASSWORDS,
  evaluateDemoCredential,
  isDemoPassword,
} from "../demo-credentials";

describe("demo credentials — what counts as published", () => {
  it("recognises every published password, including the legacy healer's", () => {
    expect(isDemoPassword("Admin@2026")).toBe(true);
    expect(isDemoPassword("Super@2026")).toBe(true);
    expect(isDemoPassword("Fgmp@2026")).toBe(true);
  });

  it("does not treat a rotated password as demo", () => {
    expect(isDemoPassword("Adm1n@2026!")).toBe(false);
    expect(isDemoPassword("")).toBe(false);
    // Case and whitespace matter: this is an exact comparison, not a pattern.
    expect(isDemoPassword("admin@2026")).toBe(false);
    expect(isDemoPassword(" Admin@2026")).toBe(false);
  });

  it("keeps this list in sync with both seeders", () => {
    // If somebody changes the seed password without updating this file, the
    // published password would go unenforced. This is the test that fails.
    const seed = readFileSync(join(process.cwd(), "src/lib/fgmp/seed.ts"), "utf8");
    const sql = readFileSync(join(process.cwd(), "scripts/supabase/03-seed.sql"), "utf8");
    const seedPasswords = [...seed.matchAll(/const (?:SEED_PASSWORD|SUPERADMIN_PASSWORD) = "([^"]+)"/g)].map(
      (m) => m[1],
    );
    const healer = readFileSync(join(process.cwd(), "scripts/db/fix-demo-users.ts"), "utf8");
    const healerPassword = /const DEMO_PASSWORD = "([^"]+)"/.exec(healer)?.[1];
    expect(seedPasswords.sort()).toEqual(["Admin@2026", "Super@2026"]);
    expect([...new Set([...seedPasswords, healerPassword])].sort()).toEqual([...DEMO_PASSWORDS].sort());
    for (const p of seedPasswords) {
      expect(sql).toContain(p);
    }
  });
});

describe("demo credentials — the policy", () => {
  it("lets a rotated password through everywhere", () => {
    expect(evaluateDemoCredential("a-strong-new-password", { NODE_ENV: "production" })).toBe("allow");
    expect(evaluateDemoCredential("a-strong-new-password", {})).toBe("allow");
  });

  it("allows demo passwords in development so the documented accounts work", () => {
    expect(evaluateDemoCredential("Admin@2026", { NODE_ENV: "development" })).toBe("allow");
    expect(evaluateDemoCredential("Admin@2026", {})).toBe("allow");
  });

  it("REFUSES a demo password in production by default", () => {
    expect(evaluateDemoCredential("Super@2026", { NODE_ENV: "production" })).toBe("refuse");
    expect(
      evaluateDemoCredential("Super@2026", { NODE_ENV: "production", FGMP_ALLOW_DEMO_CREDENTIALS: "0" }),
    ).toBe("refuse");
  });

  it("allows it only when the operator explicitly opts in, and then warns", () => {
    expect(
      evaluateDemoCredential("Super@2026", { NODE_ENV: "production", FGMP_ALLOW_DEMO_CREDENTIALS: "1" }),
    ).toBe("allow-with-warning");
  });

  it("does not accept a truthy-looking but non-exact opt-in", () => {
    // "true", "yes" and "TRUE" are easy to write and easy to assume; the
    // escape hatch is deliberately one exact value.
    for (const v of ["true", "yes", "TRUE", " 1", "1 "]) {
      expect(
        evaluateDemoCredential("Admin@2026", { NODE_ENV: "production", FGMP_ALLOW_DEMO_CREDENTIALS: v }),
      ).toBe("refuse");
    }
  });
});
