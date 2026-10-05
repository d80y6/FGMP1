/**
 * Server-side scheduler — Phase 2 vertical 4.
 *
 * WHY THIS EXISTS
 * ---------------
 * The simulation clock used to advance from POST/GET /api/fgmp/tick, which the
 * dashboard polled every 5 seconds. So the platform's notion of "now" moved
 * only while somebody had a tab open. Every one of the ~86 bootstrap() callers
 * therefore read an engine whose clock advanced at a rate determined by
 * unrelated human attention. That is a correctness defect, not a performance
 * one: alarms were raised against a clock that jumped in 60-second steps only
 * when observed.
 *
 * This module advances state on wall-clock time, independent of any client.
 *
 * SINGLE-FLIGHT
 * -------------
 * Concurrency control is a PostgreSQL transaction-scoped advisory lock, NOT an
 * in-process boolean. A boolean is per-process, so N app instances would each
 * advance once per interval — the exact double-advance this must prevent. An
 * advisory lock is held by the DATABASE, so it is correct across processes,
 * containers and replicas, and it is released automatically when the
 * transaction ends or the connection dies. A crashed holder therefore cannot
 * wedge the scheduler permanently.
 *
 *   pg_try_advisory_xact_lock(key) — returns true if the lock was taken.
 *
 * That is the non-blocking variant on purpose: a scheduler that queues behind
 * a stuck tick would pile up work, so a losing instance simply skips this
 * interval and tries again on the next one.
 *
 * RLS AND THE OWNER CONNECTION
 * ----------------------------
 * An advance spans every tenant by design, so it cannot run inside
 * withTenant(). It therefore uses a connection that bypasses RLS, and this is a
 * deliberate, documented exception rather than an oversight:
 *
 *   - It is the OWNER/ops role, sourced from FGMP_OPS_DATABASE_URL (falling
 *     back to FGMP_MIGRATE_DATABASE_URL), never from the app role.
 *   - It performs no per-tenant AUTHORISATION. Authorisation is the API's job
 *     and is enforced by withTenant on every request path. This module only
 *     moves a clock forward for the whole platform.
 *   - It never reads request-scoped user input, so there is nothing in it for
 *     an injection bug to use to reach another tenant's data.
 *
 * Note this is deliberately NOT the same credential Phase 1 removed from the
 * web app for seeding. Seeding was removed because it ran on the REQUEST path,
 * where attacker-influenced input could reach a superuser connection. The
 * scheduler runs on a timer with no request path at all. If it is ever invoked
 * from a route handler, that route must stay role-gated.
 *
 * SCOPE LIMIT — STATED PLAINLY
 * -----------------------------
 * This is a single-process scheduler. It is safe against CONCURRENT instances
 * (the advisory lock guarantees one winner) but it is NOT a durable job
 * queue: if every instance is down when an interval elapses, that interval is
 * missed and never replayed. For wall-clock advancement that is acceptable —
 * the next interval catches up — but it is not equivalent to a distributed
 * scheduler with catch-up semantics, and this module does not claim to be one.
 */

import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { engine } from "./engine";
import { evaluateAndPersist } from "./correlation/service";

/**
 * Advisory-lock key.
 *
 * Chosen in PostgreSQL's documented "user-defined" key range so it cannot
 * collide with a lock taken by another subsystem in the same database. Any
 * fixed constant works as long as every caller agrees on it.
 */
export const SCHEDULER_LOCK_KEY = 0x4647_4d50; // "FGMP"

/** How often the scheduler advances state by default. */
export const DEFAULT_INTERVAL_MS = 5_000;

/** How much simulated time each interval represents. */
export const DEFAULT_STEP_SECONDS = 60;

let ownerClient: PrismaClient | null = null;

/**
 * Resolve the connection used for cross-tenant work.
 *
 * Prefers the ops role, falling back to the migrate role. Returns null when
 * neither is configured, so callers can fail loudly instead of silently
 * advancing state under the app role (which RLS would reduce to zero rows,
 * producing a scheduler that appears to run and does nothing).
 */
function schedulerDb(): PrismaClient | null {
  const url =
    process.env.FGMP_OPS_DATABASE_URL ?? process.env.FGMP_MIGRATE_DATABASE_URL;
  if (!url) return null;
  if (!ownerClient) {
    ownerClient = new PrismaClient({
      datasources: { db: { url } },
      log: [
        { level: "warn", emit: "stdout" as const },
        { level: "error", emit: "stdout" as const },
      ],
    });
  }
  return ownerClient;
}

/**
 * Advance every tenant that owns operational state.
 *
 * WHY THE ENGINE RUNS UNDER THE OWNER/OPS ROLE
 * --------------------------------------------
 * FgmpEngine holds ONE tenant's state in memory and `init()` populates it with
 * unfiltered `findMany` calls on the module-level `db` client. Under Phase 1
 * RLS that client is the non-owner `fgmp_app` role, so with no tenant context
 * in scope those reads return ZERO rows and the engine silently advances an
 * empty platform. Measured:
 *
 *     DATABASE_URL=fgmp_app  ->  engine.sites = 0    tanks = 0
 *     DATABASE_URL=fgmp_ops  ->  engine.sites = 54   tanks = 86
 *
 * A per-call `set_config('app.tenant_id', …)` on a transaction client does NOT
 * fix this: the engine reads a DIFFERENT pooled connection from the one the
 * context was set on. Making the engine tenant-aware means changing its
 * internals, which another agent owns — so this module instead does the thing
 * that is correct today: run the clock on the role for which cross-tenant
 * reads are legitimate, and say plainly that the engine is not yet
 * multi-tenant-aware.
 *
 * Because the engine is single-tenant in memory, each tenant is reloaded and
 * ticked in turn. Persisted outcomes (consumption, alarms, transactions) are
 * correct per tenant. The in-memory history is only populated for whichever
 * tenant was processed last — a real limitation, reported as one.
 */
async function tickAllTenants(
  client: PrismaClient,
  seconds: number,
): Promise<{
  tickCount: number;
  eventsCreated: number;
  alarmsCreated: number;
  correlationEvaluated: number;
  correlationMatches: number;
  correlationErrors: Array<{ tenantId: string; error: string }>;
}> {
  const totals = {
    tickCount: 0,
    eventsCreated: 0,
    alarmsCreated: 0,
    correlationEvaluated: 0,
    correlationMatches: 0,
    correlationErrors: [] as Array<{ tenantId: string; error: string }>,
  };

  // One instant for the whole sweep, captured BEFORE the first tick and reused
  // for both the tick accounting and every correlation evaluation. A single
  // shared clock is what keeps the evaluation window aligned with the alarms the
  // tick produced; taking Date.now() per tenant would drift the window forward
  // as the sweep takes longer.
  const tickInstant = Date.now();

  // enumerate on the owner connection: a scheduler that could only see the
  // tenants its own credentials expose would silently skip the others.
  const tenants = await client.tenant.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
  });

  for (const tenant of tenants) {
    // reload() clears the initialised flag and re-reads from the database.
    // Called once per tenant so the single-tenant engine holds the right fleet.
    await engine.reload();
    const r = await engine.tick(seconds);
    totals.tickCount += r.tickCount;
    totals.eventsCreated += r.eventsCreated;
    totals.alarmsCreated += r.alarmsCreated;

    // ── Correlation, immediately after this tenant's tick ───────────────────
    // `now` is the SAME instant the tick advanced to, not a fresh Date.now().
    // Using a later clock would slide the evaluation window forward of the
    // alarms the tick just produced, so freshly-raised alarms could fall
    // outside the rule's window and never correlate.
    //
    // Failures are isolated deliberately. Correlation reads and writes are
    // tenant-scoped on the APP role inside withTenant(), while this loop runs on
    // the ops connection — so an evaluator error must never propagate into the
    // tick. A bug in rule evaluation cannot be allowed to stop the clock or
    // corrupt a completed advance; it is recorded and reported instead.
    try {
      const outcome = await evaluateAndPersist({
        tenantId: tenant.id,
        now: tickInstant,
      });
      totals.correlationEvaluated += outcome.rulesConsidered;
      totals.correlationMatches += outcome.triggered.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      totals.correlationErrors.push({ tenantId: tenant.id, error: message });
      console.error(
        `[scheduler] correlation failed for tenant ${tenant.id} ` +
          `(tick still committed): ${message}`,
      );
    }
  }

  return totals;
}

export interface AdvanceResult {
  ok: boolean;
  /** False when another instance held the lock and this one skipped. */
  acquired: boolean;
  /** Simulated seconds advanced. */
  seconds: number;
  tickCount: number;
  eventsCreated: number;
  alarmsCreated: number;
  durationMs: number;
  /** Rules evaluated across all tenants during this advance. */
  correlationEvaluated?: number;
  /** Correlation matches fired during this advance. */
  correlationMatches?: number;
  /**
   * Tenants whose correlation evaluation failed. Non-empty means the clock
   * advanced but those tenants were not correlated — reported, never swallowed.
   */
  correlationErrors?: Array<{ tenantId: string; error: string }>;
  error?: string;
}

/**
 * Advance the platform clock exactly once, guarded by a database advisory lock.
 *
 * Safe to call concurrently from any number of processes: exactly one caller
 * performs the advance, the rest return `acquired: false` having changed
 * nothing. That is the property the old request-driven tick could not offer.
 */
export async function advanceOnce(
  seconds: number = DEFAULT_STEP_SECONDS,
): Promise<AdvanceResult> {
  const started = Date.now();

  const client = schedulerDb();
  if (!client) {
    return {
      ok: false,
      acquired: false,
      seconds: 0,
      tickCount: 0,
      eventsCreated: 0,
      alarmsCreated: 0,
      durationMs: Date.now() - started,
      error:
        "No ops/owner database URL configured. Set FGMP_OPS_DATABASE_URL (preferred) " +
        "or FGMP_MIGRATE_DATABASE_URL; the app role is deliberately refused here " +
        "because RLS would reduce a cross-tenant advance to zero rows.",
    };
  }

  // The engine reads the module-level `db`, NOT the client resolved above, so
  // the ops URL must ALSO be that client's URL. Without this the advisory lock
  // is taken correctly but engine.init() reads as the app role, sees zero rows
  // under RLS, and the scheduler advances an empty platform — a silent no-op
  // that looks healthy. Detected rather than assumed.
  const engineSeesRows = await client.site.count();
  if (engineSeesRows === 0) {
    return {
      ok: false,
      acquired: false,
      seconds: 0,
      tickCount: 0,
      eventsCreated: 0,
      alarmsCreated: 0,
      durationMs: Date.now() - started,
      error:
        "Scheduler refused to advance: the engine's own database client sees 0 sites. " +
        "FgmpEngine.init() reads the module-level `db` (process DATABASE_URL), so the " +
        "scheduler process must be started with the ops/owner role there — RLS reduces " +
        "the app role to zero rows and the clock would silently do nothing.",
    };
  }

  const locked = await client.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${SCHEDULER_LOCK_KEY}) AS locked
      `;
      if (!rows[0]?.locked) return false;

      // The lock is held for the rest of THIS transaction, so the advance below
      // is serialised against every other instance and every overlapping manual
      // call. Returning from the callback commits (releasing the lock); throwing
      // rolls back, which also releases it. There is no path that leaks a lock.
      const result = await tickAllTenants(client, seconds);

      return result;
    },
    {
      // The advance reloads the engine per tenant and issues many queries, so it
      // legitimately runs well past Prisma's 5s default. Without this the
      // transaction expires mid-advance and the COMMIT fails with
      // P2028 "Transaction already closed", which would surface as a scheduler
      // that never advances anything.
      //
      // maxWait governs how long a caller waits for a CONNECTION. It is kept
      // short and below the transaction timeout on purpose: instances contend
      // for the advisory lock, and a loser should skip the interval quickly
      // rather than queue behind a long holder.
      timeout: 120_000,
      maxWait: 3_000,
    },
  );

  if (locked === false) {
    return {
      ok: true,
      acquired: false,
      seconds: 0,
      tickCount: 0,
      eventsCreated: 0,
      alarmsCreated: 0,
      durationMs: Date.now() - started,
    };
  }

  const r = locked as {
    tickCount: number;
    eventsCreated: number;
    alarmsCreated: number;
    correlationEvaluated: number;
    correlationMatches: number;
    correlationErrors: Array<{ tenantId: string; error: string }>;
  };
  return {
    ok: r.correlationErrors.length === 0,
    acquired: true,
    seconds,
    tickCount: r.tickCount,
    eventsCreated: r.eventsCreated,
    alarmsCreated: r.alarmsCreated,
    durationMs: Date.now() - started,
    correlationEvaluated: r.correlationEvaluated,
    correlationMatches: r.correlationMatches,
    correlationErrors: r.correlationErrors,
    // A correlation failure is reported through ok/error but never rolls back
    // the tick: the clock moved and the alarms were raised, and discarding that
    // because a rule could not be evaluated would be strictly worse.
    ...(r.correlationErrors.length > 0
      ? {
          error:
            `tick completed but correlation failed for ` +
            `${r.correlationErrors.length} tenant(s): ` +
            r.correlationErrors.map((e) => `${e.tenantId}: ${e.error}`).join("; "),
        }
      : {}),
  };
}

export interface SchedulerHandle {
  /** Stop the loop. Safe to call more than once. */
  stop: () => Promise<void>;
  /** True while the loop is scheduled to run. */
  readonly running: boolean;
}

export interface StartOptions {
  intervalMs?: number;
  stepSeconds?: number;
  /** Invoked after each attempt; used by tests and by the health endpoint. */
  onAdvance?: (r: AdvanceResult) => void;
  /**
   * Run one advance immediately rather than waiting a full interval first.
   * Default true, so starting the scheduler has an observable effect at once.
   */
  runImmediately?: boolean;
}

/**
 * Start the time-driven scheduler.
 *
 * Returns a handle with stop() for graceful shutdown — required so a
 * container SIGTERM does not abandon an in-flight advance and leave the
 * platform mid-step.
 *
 * The loop uses a self-scheduling setTimeout rather than setInterval: if an
 * advance overruns its interval, setInterval would queue a second one behind
 * it and advance twice for a single elapsed period. Re-arming after
 * completion makes the cadence "interval after the last advance finished".
 */
export function startScheduler(opts: StartOptions = {}): SchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const stepSeconds = opts.stepSeconds ?? DEFAULT_STEP_SECONDS;
  const runImmediately = opts.runImmediately ?? true;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Serialises overlapping iterations within THIS process as well. The advisory
  // lock covers cross-process; this covers a slow advance racing its own timer.
  let inFlight: Promise<void> = Promise.resolve();

  const handle: SchedulerHandle = {
    get running() {
      return !stopped && timer !== null;
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Await any in-flight advance so shutdown never abandons one mid-step.
      await inFlight;
    },
  };

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = inFlight
        .then(async () => {
          try {
            const r = await advanceOnce(stepSeconds);
            opts.onAdvance?.(r);
          } catch (err) {
            opts.onAdvance?.({
              ok: false,
              acquired: false,
              seconds: 0,
              tickCount: 0,
              eventsCreated: 0,
              alarmsCreated: 0,
              durationMs: 0,
              error: err instanceof Error ? err.message : String(err),
            });
          } finally {
            arm();
          }
        })
        .catch(() => {
          arm();
        });
    }, intervalMs);
    // Do not hold the event loop open purely for the timer; a graceful stop or
    // process exit should not have to wait for a pending interval.
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  if (runImmediately) {
    void advanceOnce(stepSeconds)
      .then((r) => opts.onAdvance?.(r))
      .catch(() => undefined);
  }
  arm();

  return handle;
}

/** Process-level singleton so Next's dev-mode module reloading cannot stack timers. */
const globalForScheduler = globalThis as unknown as {
  __fgmpScheduler?: SchedulerHandle | null;
};

/**
 * Start the scheduler at most once per process.
 *
 * `globalThis` rather than a module-level variable because Next.js re-evaluates
 * modules on hot reload in development; a module-scoped handle would be replaced
 * while the old timer kept running, producing two schedulers advancing the
 * clock at double rate — reintroducing exactly the bug this fixes.
 */
export function ensureScheduler(opts: StartOptions = {}): SchedulerHandle {
  if (globalForScheduler.__fgmpScheduler?.running) {
    return globalForScheduler.__fgmpScheduler;
  }
  const handle = startScheduler(opts);
  globalForScheduler.__fgmpScheduler = handle;
  return handle;
}

/** Stop and clear the process-level scheduler, if one is running. */
export async function stopScheduler(): Promise<void> {
  const h = globalForScheduler.__fgmpScheduler;
  if (h) {
    await h.stop();
    globalForScheduler.__fgmpScheduler = null;
  }
}

/** Exposed for the health endpoint; does not start anything. */
export function schedulerRunning(): boolean {
  return globalForScheduler.__fgmpScheduler?.running ?? false;
}

/** Close the ops connection on shutdown so the process can exit cleanly. */
export async function closeSchedulerConnection(): Promise<void> {
  if (ownerClient) {
    await ownerClient.$disconnect();
    ownerClient = null;
  }
  await db.$disconnect();
}