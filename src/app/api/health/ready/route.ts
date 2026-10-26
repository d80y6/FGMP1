import { NextResponse } from "next/server";
import { checkReadiness } from "@/lib/health/readiness";
import { firstConfigProblem } from "@/lib/fgmp/config-health";

/**
 * Readiness probe — unauthenticated, but says almost nothing.
 *
 * Ready means: the process can reach PostgreSQL AND the schema is present. A
 * container that answered "ready" before migrations were applied would receive
 * traffic it can only answer with 500s, which is exactly the failure the
 * boot-time preflight exists to prevent.
 *
 * The body is intentionally limited to a status and a coarse reason code. An
 * unauthenticated route must not disclose the driver, the host, the schema, or
 * the exception — an attacker learns the stack from error text.
 *
 * The check itself lives in `src/lib/health/readiness.ts`: route handlers are
 * not allowed to import the Prisma client directly (see eslint.config.mjs).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await checkReadiness();
  const ready = result === "ok";
  // `code` is the machine-readable configuration verdict, present only when the
  // deployment itself is wrong. It is a stable enum member — never the detail
  // string, which names variables and is therefore not published anonymously.
  const problem = firstConfigProblem();
  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      reason: result,
      ...(problem ? { code: problem.code } : {}),
    },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
