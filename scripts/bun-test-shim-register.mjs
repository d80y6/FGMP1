// Node loader that remaps "bun:test" → the shim and "@/..." → the repo src,
// so `node --experimental-strip-types --import ./scripts/bun-test-shim-register.mjs <file.test.ts>` works.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

register("./bun-test-resolve.mjs", pathToFileURL(repo + "/scripts/"));
