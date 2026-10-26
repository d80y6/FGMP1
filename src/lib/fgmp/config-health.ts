/**
 * Startup configuration health — collected once, reported on the wire.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS: A MODULE-SCOPE THROW IS THE WRONG FAILURE MODE HERE
 *
 * Two configuration checks used to run at MODULE SCOPE, i.e. while the first
 * route module was being evaluated rather than while a request was being
 * served:
 *
 *   src/lib/db.ts     assertRlsEnforced()      → throws when `FGMP_REQUIRE_RLS=1`
 *                                                and `DATABASE_URL` is not the
 *                                                non-owner `fgmp_app` role
 *   src/lib/auth.ts   resolveSessionConfig()   → throws on a nonsensical
 *                                                `FGMP_SESSION_MAX_AGE_MS` /
 *                                                `FGMP_SESSION_UPDATE_AGE_MS`
 *
 * On a long-lived Node container that is a legitimate *deployment* failure: the
 * process dies at boot and the reason is printed once. The production target is
 * **Cloudflare Workers**, where the same throw behaves very differently:
 *
 *   1. There is no process to kill. `src/instrumentation.ts` documents the
 *      measured behaviour: throwing out of `register()` does not stop the
 *      runtime from serving, so "the process refuses to start" is not a control
 *      this platform has.
 *   2. The throw happens inside a *route module*. workerd answers EVERY request
 *      to EVERY `/api/fgmp/*` route with a bare `500 Internal Server Error` —
 *      unrelated screens included — because every one of them imports the auth
 *      helper that transits the same module.
 *   3. A thrown error is not a response. Nothing on the wire says *which*
 *      variable is wrong, and `observability.logs` is off in `wrangler.jsonc`
 *      (a deliberate free-tier decision), so there is no server-side line to
 *      read either. The operator sees "the whole API is down, reason unknown".
 *   4. An isolate caches the failed module evaluation, so the deployment stays
 *      broken until the isolate is replaced — a redeploy, not a config fix.
 *
 * A wrong database ROLE therefore presented as a total, unexplained outage.
 * That is the failure this module makes impossible.
 *
 * ── WHAT IT DOES INSTEAD ────────────────────────────────────────────────────
 * The same checks run here, once, memoized per isolate, and the request path
 * (`requireAuth`) turns a failure into
 *
 *     503 { code: "RLS_NOT_ENFORCED" | "SESSION_CONFIG_INVALID" | "ENV_INVALID" }
 *
 * Fail-closed is preserved: the request is still refused, and it is refused
 * *before* any route handler runs. It is simply refused by the layer that can
 * express a reason, with a stable code a support engineer can act on.
 *
 * ── WHAT MAY APPEAR IN `detail` ─────────────────────────────────────────────
 * Variable NAMES and verdicts, never a value. `src/lib/env.ts` already holds
 * that line for its own output ("A validation error that echoes a secret into
 * the logs is a new incident"); the RLS message is the one already written to
 * be safe to print (host + role name, never the URL). The UNAUTHENTICATED
 * readiness route publishes the `code` only — never `detail` — so an anonymous
 * caller learns "the server is misconfigured", not how.
 */

import { collectEnvIssues, envErrors } from "@/lib/env";
import { rlsViolation } from "@/lib/db-rls";

/**
 * The variables whose absence makes serving either impossible or UNSAFE.
 *
 * `src/lib/env.ts` lists more errors than this, and that is correct for its
 * purpose: it validates a *process at startup*, where refusing to boot costs
 * nothing and a half-configured deployment should never come up. The request
 * path is a different question. Refusing every read because `APINATOR_*` is
 * partially configured, or because the MFA key is short, would be an outage this
 * code causes itself — realtime degrades to polling and only enrolment breaks,
 * while tenant data is served correctly and safely.
 *
 * So this set is deliberately short, and each member is here for a reason:
 *
 *   DATABASE_URL        no connection → no request can be answered
 *   NEXTAUTH_SECRET     no session can be verified → every caller is a stranger
 *   FGMP_REQUIRE_RLS=0  in production → the tenant backstop is switched off, and
 *                       every query the app serves would be unscoped-by-policy.
 *                       Refusing is the whole point of the flag.
 *
 * `FGMP_OPS_DATABASE_URL` is NOT here: without it sign-in cannot read `User`
 * through the RLS-enforced role, so LOGIN is broken (401s, see
 * docs/DEPLOYMENT.md §4) — but an already-issued session still serves correctly
 * scoped data, and taking away that access would make the outage worse.
 */
const BLOCKING_ENV_VARIABLES = new Set([
  "DATABASE_URL",
  "NEXTAUTH_SECRET",
  "FGMP_REQUIRE_RLS",
]);

/** Stable, machine-readable, and safe to return to a client. */
export type ConfigProblemCode =
  | "ENV_INVALID"
  | "RLS_NOT_ENFORCED"
  | "SESSION_CONFIG_INVALID";

export interface ConfigProblem {
  code: ConfigProblemCode;
  /** Names and verdicts only — see the note above. Never a secret. */
  detail: string;
}

/**
 * Problems discovered while a module was being evaluated (a caught throw).
 * `auth.ts` reports a bad session lifetime here instead of throwing; the record
 * survives for the life of the isolate, exactly like the throw would have —
 * except that it can be answered with a status code.
 */
const recorded: ConfigProblem[] = [];

let evaluated: ConfigProblem[] | null = null;

function evaluate(): ConfigProblem[] {
  const problems: ConfigProblem[] = [...recorded];

  // Missing/invalid required variables — ERROR severity AND blocking, see the
  // note on BLOCKING_ENV_VARIABLES. Warnings describe degraded features (no
  // Apinator credentials, no MFA key) and must never refuse traffic.
  const blocking = envErrors(collectEnvIssues()).filter((issue) =>
    BLOCKING_ENV_VARIABLES.has(issue.name),
  );
  if (blocking.length > 0) {
    problems.push({
      code: "ENV_INVALID",
      detail: blocking.map((issue) => issue.name).join(", "),
    });
  }

  // RLS posture. `rlsViolation` returns null unless the operator opted in with
  // FGMP_REQUIRE_RLS, so local development and CI keep booting.
  const violation = rlsViolation(process.env.DATABASE_URL, process.env.FGMP_REQUIRE_RLS);
  if (violation) {
    problems.push({ code: "RLS_NOT_ENFORCED", detail: violation });
  }

  return problems;
}

/**
 * Every configuration problem, evaluated once per isolate.
 *
 * Memoized on purpose: this runs on the request path, and re-parsing the
 * environment on every request would trade one problem for another. The
 * environment of a Worker cannot change under a live isolate anyway.
 */
export function configProblems(): ConfigProblem[] {
  if (!evaluated) evaluated = evaluate();
  return evaluated;
}

/** The first problem, or null when the configuration is sound. */
export function firstConfigProblem(): ConfigProblem | null {
  return configProblems()[0] ?? null;
}

/**
 * Record a problem discovered by a module's own validation instead of throwing.
 *
 * Deduplicated by code: `auth.ts` runs its check once at load, so this is
 * belt-and-braces against a double evaluation (a test harness, a hot reload).
 */
export function noteConfigProblem(problem: ConfigProblem): void {
  if (recorded.some((existing) => existing.code === problem.code)) return;
  recorded.push(problem);
  evaluated = null;
}

/** Test seam: forget everything, so a new environment can be evaluated. */
export function resetConfigProblemsForTests(): void {
  recorded.length = 0;
  evaluated = null;
}
