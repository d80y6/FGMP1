/**
 * Generate the Mosquitto password file used by the dev/test broker.
 *
 * Run via `bun run broker:passwords`. Writes docker/mosquitto/config/passwd,
 * which mosquitto.conf points at. Credentials are deterministic FOR DEVELOPMENT
 * ONLY and are committed on purpose so the test suite and a developer's
 * docker-compose run agree without setup. They are worthless outside the local
 * loopback listener, and the broker refuses anonymous connections entirely.
 *
 * mosquitto_passwd hashes with PBKDF2-SHA512, which Go's x/crypto exposes as
 * `$7$`. Using the real algorithm matters: a hand-rolled hash would not be
 * readable by the broker, and a plaintext file would make this a list of live
 * passwords rather than a dev fixture.
 */
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Development credentials. Not secrets — see the file header. */
export const DEV_PASSWORDS: Record<string, string> = {
  "tenant-a": "dev-tenant-a-pw",
  "tenant-b": "dev-tenant-b-pw",
  platform: "dev-platform-pw",
};

const SALT_BYTES = 12;
const ITERATIONS = 10_000;

/**
 * Produce a mosquitto-compatible PBKDF2-SHA512 verifier.
 *
 * Format: `$7$<iterations>$<salt-b64>$<hash-b64>` (also base64url-safe in
 * mosquitto 2.x; the standard alphabet is used here).
 */
export function mosquittoHash(password: string, salt = randomBytes(SALT_BYTES)): string {
  const hash = pbkdf2Sync(password, salt, ITERATIONS, 64, "sha512");
  return `$7$${ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** One `username:verifier` line per credential. */
export function buildPasswdFile(pw: Record<string, string> = DEV_PASSWORDS): string {
  return (
    Object.entries(pw)
      .map(([user, password]) => `${user}:${mosquittoHash(password)}`)
      .join("\n") + "\n"
  );
}

/** Stable hash of the file content, for test assertions. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

if (import.meta.main) {
  const target = process.argv[2] ?? "docker/mosquitto/config/passwd";
  const content = buildPasswdFile();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { mode: 0o644 });
  console.log(`wrote ${target} (${Object.keys(DEV_PASSWORDS).length} users)`);
  console.log("these are DEVELOPMENT credentials and are committed on purpose");
}