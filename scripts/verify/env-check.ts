/**
 * Environment pre-flight.
 *
 * Run this BEFORE deploying, especially before the first deploy:
 *
 *   bun run check:env
 *
 * It applies exactly the checks the server applies at boot
 * (`src/lib/env.ts`), so a misconfiguration is found on the operator's
 * terminal instead of in the container logs after a rollover. `[error]`
 * entries would stop the server; `[warn]` entries mean the app runs with that
 * feature degraded.
 *
 * Values are never printed — only names and verdicts.
 *
 * Exit codes: 0 = no errors (warnings allowed), 1 = at least one error.
 */

import { collectEnvIssues, envErrors, formatEnvIssues } from "@/lib/env";

const issues = collectEnvIssues();
const errors = envErrors(issues);
const warnings = issues.filter((i) => i.severity === "warn");

console.log(`FGMP environment check — ${process.env.NODE_ENV ?? "development"}\n`);

if (errors.length === 0 && warnings.length === 0) {
  console.log("  No problems found.");
} else {
  console.log(formatEnvIssues(issues));
}

console.log(
  `\n${errors.length} error(s), ${warnings.length} warning(s).` +
    (errors.length > 0
      ? "\nThe server refuses to start while any [error] is present."
      : "\nThe server will start; degraded features are listed above."),
);

// `process.exitCode` rather than `process.exit()`: let stdout flush.
process.exitCode = errors.length > 0 ? 1 : 0;
