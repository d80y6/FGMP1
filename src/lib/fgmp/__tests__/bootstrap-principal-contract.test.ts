import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = join(process.cwd(), "src", "app", "api", "fgmp");

function routeFiles(dir = API_ROOT, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) routeFiles(path, files);
    else if (name === "route.ts") files.push(path);
  }
  return files;
}

describe("API handlers reuse the principal that passed server authorization", () => {
  test("every domain bootstrap receives the requireAuth result, never a second JWT lookup", () => {
    const calls = routeFiles().flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(/^\s*(?:const\s+\{\s*user\s*\}\s*=\s*)?await\s+bootstrap\(([^)]*)\);/gm)].map((match) => ({
        file,
        argument: match[1].trim(),
      }));
    });

    expect(calls.length).toBeGreaterThan(70);
    expect(calls.filter((call) => call.argument !== "auth.user")).toEqual([]);
  });
});
