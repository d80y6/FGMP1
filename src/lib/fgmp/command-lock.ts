/**
 * Per-generator command serialisation.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The control route evaluated the safety interlocks and then dispatched the
 * command, as two separate awaits with nothing in between. Telemetry arriving
 * during that window could invalidate the verdict, and the command would then be
 * authorised against a reading that no longer held.
 *
 * With an in-process dispatch that is latent. The moment dispatch becomes a
 * Modbus write, it is a real race: the interlock would have said "safe at 84 °C"
 * while the engine receives START and the sensor reads 97 °C.
 *
 * ── WHAT IT ACTUALLY GUARANTEES, PRECISELY ───────────────────────────────────
 * Commands for the SAME generator are serialised against each other, and the
 * caller re-evaluates its preconditions inside the critical section. That
 * combination is what closes the window between "checked" and "dispatched" for
 * anything happening in THIS process.
 *
 * It does NOT order a write arriving from another replica, and it does not
 * hold a database lock. That limitation is real and is documented here rather
 * than left to be discovered as an unexplained unsafe start:
 *
 *   When dispatch targets real hardware, replace this with a PostgreSQL
 *   advisory lock (`pg_try_advisory_xact_lock`) keyed on the generator id and
 *   held across the read-and-dispatch. The in-process mutex is correct for the
 *   current in-memory engine and insufficient for a shared one.
 *
 * ── WHY A PROMISE CHAIN AND NOT A MUTEX SET ─────────────────────────────────
 * A `Set<string>` of held keys with manual release is easy to leak: any thrown
 * error between acquire and release strands the key and that generator can
 * never be commanded again. A promise chain releases in a `finally`, so an
 * exception cannot strand a lock.
 */

/** In-flight chain per generator id. Presence means "a command is in the section". */
const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive access to one generator's command path.
 *
 * Calls for DIFFERENT generators do not block each other — a slow command on
 * site A must not delay site B, and a fleet-wide lock would serialise the whole
 * estate behind one generator.
 */
export async function withGeneratorCommandLock<T>(
  generatorId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(generatorId) ?? Promise.resolve();

  // Swallow the predecessor's rejection so one failed command does not poison
  // the chain for every subsequent command on this generator. The rejection is
  // still delivered to whoever is awaiting the original promise.
  const run = previous.then(
    () => fn(),
    () => fn(),
  );

  // The stored chain must never reject, or every subsequent `.then` would take
  // the rejection path.
  const stored = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(generatorId, stored);

  try {
    return await run;
  } finally {
    // Only clear if we are still the tail. Otherwise a later command has already
    // chained onto us and clearing would orphan its mutual exclusion.
    if (chains.get(generatorId) === stored) {
      chains.delete(generatorId);
    }
  }
}

/** True when a command is currently inside the critical section. */
export function isGeneratorCommandLocked(generatorId: string): boolean {
  return chains.has(generatorId);
}

/** Test seam: drop all state. */
export function resetCommandLocks(): void {
  chains.clear();
}
