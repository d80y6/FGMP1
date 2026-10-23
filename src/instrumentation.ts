/**
 * Server startup hook (Phase 2, vertical 5).
 *
 * Next.js calls `register()` once per server process, after the runtime is
 * ready and before the first request is served. That is the correct place to
 * start the telemetry scheduler: the clock must belong to the server, not to
 * whichever browser happens to have a dashboard open.
 *
 * ── WHY THIS REPLACES THE REQUEST-DRIVEN TICK ───────────────────────────────
 * `app-shell.tsx` used to POST /api/fgmp/tick every 5s when the realtime socket
 * was down. That made the BROWSER drive platform state:
 *
 *   - two operators with the dashboard open advanced the same tanks twice as
 *     fast, and the outcome depended on who was watching;
 *   - an unattended platform generated no data at all, because the only thing
 *     that advanced it was a user request.
 *
 * The scheduler uses a PostgreSQL advisory lock, so N replicas start safely and
 * exactly one of them advances the clock — the correctness property a
 * request-driven design could not offer regardless of how it was rate-limited.
 *
 * ── WHY IT IS OPT-IN BY ENVIRONMENT, NOT UNCONDITIONAL ─────────────────────
 * A scheduler that silently starts in every environment is a scheduler that
 * fabricates telemetry in production. `p2-telemetry` already added
 * `assertSimulationAllowed()` for exactly this reason, and this hook honours the
 * same signal rather than inventing a second, contradictory one: if simulation
 * is not permitted here, the scheduler does not start and says so once, at boot,
 * instead of failing later inside a tick.
 */

let started = false;

export async function register(): Promise<void> {
  // Next re-evaluates instrumentation on hot reload in development.
  if (started) return;
  started = true;

  const guard = globalThis as unknown as { __fgmpInstrumentation?: boolean };
  if (guard.__fgmpInstrumentation) return;
  guard.__fgmpInstrumentation = true;

  if (process.env.NEXT_RUNTIME !== "nodejs") {
    // Edge runtime has no timers worth scheduling against and no advisory-lock
    // connection; the Node server owns the clock.
    return;
  }

  // ── Environment validation, once, before anything else ────────────────────
  // Only the Node server owns the database credential, the scheduler and the
  // session secret, so only it refuses to start on a broken environment.
  // Warnings (no Apinator credentials, no MFA key) are reported and the server
  // continues: each degrades one feature and none makes the app unsafe to serve.
  const { assertEnv, formatEnvIssues } = await import("@/lib/env");
  const envIssues = ((): Awaited<ReturnType<typeof assertEnv>> => {
    try {
      return assertEnv();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      // Throwing out of register() is NOT fail-closed: Next logs
      // "Failed to prepare server", marks the hook failed and keeps the port
      // open, so an orchestrator sees a healthy socket on a process that will
      // 500 every request. Exiting is the only honest signal.
      process.exit(1);
    }
  })();
  const warnings = envIssues.filter((i) => i.severity === "warn");
  if (warnings.length > 0) {
    console.warn(
      `[env] ${warnings.length} configuration warning${warnings.length === 1 ? "" : "s"} — ` +
        "the app runs, but these features are degraded:\n" +
        formatEnvIssues(warnings),
    );
  }

  // ── RLS posture, before the first query ───────────────────────────────────
  // `db.ts` runs this check at module load too, but in a deployed process
  // nothing imports the database layer during boot — the scheduler is the only
  // boot-time consumer and it is disabled in production — so a bypassing
  // DATABASE_URL produced a healthy socket, a working sign-in screen and a 500
  // on every data route, discovered only by making a request. Checking here is
  // what makes `FGMP_REQUIRE_RLS=1` mean what .env.example and compose claim:
  // the process refuses to start.
  //
  // The import is inside the try because the module itself can throw this
  // error while being evaluated.
  try {
    const { assertRlsEnforced } = await import("@/lib/db");
    assertRlsEnforced();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { simulationDecision } = await import("@/lib/fgmp/simulation");
  const decision = simulationDecision();

  if (!decision.allowed) {
    // Fail loudly ONCE, at boot. A scheduler that never starts but gives no
    // explanation is indistinguishable from one that is running and advancing
    // nothing.
    console.warn(
      `[scheduler] not started: ${decision.reason ?? "simulation is not permitted in this environment"}. ` +
        `Set the simulation flag documented in src/lib/fgmp/simulation.ts to enable it.`,
    );
    return;
  }

  try {
    const { ensureScheduler, stopScheduler, closeSchedulerConnection } = await import(
      "@/lib/fgmp/scheduler"
    );

    const handle = ensureScheduler({
      onAdvance: (r) => {
        if (!r.ok) {
          // Correlation failing must not be silent — but it must also not be
          // noisy every 5s if it is persistently broken, so the scheduler
          // reports per-iteration and the caller decides.
          console.warn("[scheduler] advance reported errors", r);
          return;
        }
        if (r.tickCount > 0) {
          console.log(
            `[scheduler] advanced ${r.seconds}s: ${r.tickCount} ticks, ` +
              `${r.eventsCreated} events, ${r.alarmsCreated} alarms, ` +
              `${r.correlationEvaluated} rules evaluated, ${r.correlationMatches} matched`,
          );
        }
      },
    });

    console.log("[scheduler] started — server-side telemetry clock is running");

    // ── Graceful shutdown ────────────────────────────────────────────────
    // Await an in-flight advance before letting the process exit, so a SIGTERM
    // mid-step cannot abandon a half-written transaction. `stop()` already
    // awaits the in-flight promise; closing the connection afterwards releases
    // the advisory lock.
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[scheduler] ${signal} received — draining in-flight advance`);
      try {
        await handle.stop();
        await stopScheduler();
        await closeSchedulerConnection();
        console.log("[scheduler] stopped cleanly");
      } catch (err) {
        console.error("[scheduler] shutdown error", err);
      }
    };

    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
  } catch (err) {
    // Never take the server down because the scheduler failed to start. The
    // platform still serves every read; it simply is not advancing.
    console.error("[scheduler] failed to start:", err);
  }
}