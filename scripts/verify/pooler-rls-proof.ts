/**
 * Pooler RLS proof — the evidence the Hyperdrive decision was missing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The app's tenant isolation rests on one mechanism: every tenant-scoped query
 * runs inside an explicit transaction that begins with
 *
 *     SET LOCAL app.tenant_id = '<uuid>'
 *
 * `SET LOCAL` is scoped to the transaction, so COMMIT/ROLLBACK resets it and a
 * pooled connection cannot leak one tenant's context into the next request.
 * That property is what makes a connection pooler — Supabase's pgbouncer, or
 * Cloudflare Hyperdrive in front of it — safe.
 *
 * The deployment decision is blocked on exactly this question: does the pooler
 * the operator will actually use preserve it? A pooler in **session** mode does;
 * a pooler in **transaction** mode also does, because a transaction is pinned to
 * one backend for its whole duration. What breaks is different: `SET` (without
 * LOCAL), or a pooler configured to reset session state *between statements*.
 *
 * The existing `rls-regression.ts` proves the semantics on a **direct**
 * connection. It cannot say anything about a pooler, because it never uses one.
 * This script does: point it at the pooler URL and it either proves the
 * property there or says which property failed and why that is fatal.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT ASSERTS (against whatever URL it is given)
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. `SET LOCAL` is visible inside its own transaction.
 *   2. It is GONE in the next transaction on the same pooled connection —
 *      i.e. the pooler does not carry session state forward.
 *   3. Two concurrent transactions with different tenants, interleaved, each
 *      see only their own value. This is the cross-tenant bleed that a broken
 *      pooler produces, and it is deliberate here: the two transactions are
 *      held open simultaneously rather than run in sequence.
 *   4. A row from the `Site` table (the table the RLS suite uses as its
 *      sentinel) is not readable across tenants.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *   # against the pooler the Worker will use (what the decision needs)
 *   DATABASE_URL='postgresql://fgmp_app:…@…pooler…:6543/fgmp?pgbouncer=true' \
 *     bun run scripts/verify/pooler-rls-proof.ts
 *
 *   # against the direct endpoint, as a control: this MUST also pass, and if
 *   # it does not, the failure is in the database, not in the pooler.
 *   DATABASE_URL='postgresql://fgmp_app:…@…direct…:5432/fgmp' \
 *     bun run scripts/verify/pooler-rls-proof.ts
 *
 * Exit code 0 only if every assertion passes. Any skip is a failure: a proof
 * that silently skips is a proof that certifies nothing.
 *
 * It writes nothing. All four assertions are reads of `current_setting`; the
 * Site check runs inside a transaction that is rolled back.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE IT CANNOT BE RUN
 * ─────────────────────────────────────────────────────────────────────────────
 * This sandbox has no route to the operator's pooler, and CI has no credentials
 * for it. The script is therefore *not* evidence by itself — it is the
 * instrument that produces the evidence when an operator runs it. Until one
 * does, the Hyperdrive question stays open, and the ledger says so.
 */

import pg from 'pg'

// ── Result plumbing (same shape as rls-regression.ts) ───────────────────────

type Status = 'PASS' | 'FAIL'
interface Assertion {
  name: string
  status: Status
  detail: string
}

const assertions: Assertion[] = []

function record(name: string, status: Status, detail: string): void {
  assertions.push({ name, status, detail })
  const icon = status === 'PASS' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
  console.log(`  ${icon} ${name}\n       ${detail}`)
}

const pass = (n: string, d: string) => record(n, 'PASS', d)
const fail = (n: string, d: string) => record(n, 'FAIL', d)

/** Read the GUC inside an open transaction. `missing_ok` keeps it from raising. */
const TENANT_GUC = `current_setting('app.tenant_id', true)`

async function readGuc(c: pg.PoolClient): Promise<string | null> {
  const r = await c.query<{ v: string | null }>(`SELECT ${TENANT_GUC} AS v`)
  return r.rows[0]?.v ?? null
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. This script proves the pooler the app will use;')
    console.error('point it at that URL (see the header of this file for both invocations).')
    process.exit(2)
  }

  // A pool of TWO, so the concurrency assertion has a second backend to run on
  // while the first transaction is still open. With max: 1 the two transactions
  // would serialise and the bleed test would prove nothing.
  const pool = new pg.Pool({ connectionString: url, max: 2 })

  // Describe the target without printing credentials.
  const parsed = new URL(url)
  console.log(`\nTarget: ${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`)
  console.log(`Role:   ${decodeURIComponent(parsed.username || '(none)')}`)
  const isPooler = /pooler|pgbouncer/i.test(url)
  // Heuristic and labelled as one: the marker is in the hostname for Supabase
  // and Neon. A URL without it may still reach a pooler, which is why the
  // verdict below tells the operator to record the host.
  console.log(`Mode:   ${isPooler ? 'pooler endpoint (what the decision needs)' : 'direct endpoint (control run)'}\n`)

  const client = await pool.connect()
  try {
    const who = await client.query<{ u: string; s: string }>(
      `SELECT current_user AS u, current_setting('server_version') AS s`,
    )
    console.log(`Connected as ${who.rows[0].u} on PostgreSQL ${who.rows[0].s}\n`)
  } finally {
    client.release()
  }

  // ── 1 + 2. SET LOCAL is transaction-scoped, as the app requires ──────────
  {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SET LOCAL app.tenant_id = 'tenant-a-uuid'`)
      const inside = await readGuc(c)
      await c.query('COMMIT')

      await c.query('BEGIN')
      const after = await readGuc(c)
      await c.query('COMMIT')

      // PostgreSQL keeps a placeholder for a custom GUC once it has been SET, so
      // after COMMIT the value typically reverts to '' rather than NULL. Both
      // are safe — neither carries the tenant — and asserting "must be NULL"
      // is a bug in the instrument, not a finding about the pooler. The control
      // run in CI failed on exactly that, which is what the control is for.
      const cleared = after === null || after === ''
      if (inside === 'tenant-a-uuid') {
        pass('set-local-visible-in-its-transaction', `read back ${inside}`)
      } else {
        fail(
          'set-local-visible-in-its-transaction',
          `SET LOCAL did not take effect inside the transaction (got ${inside ?? 'NULL'}). ` +
            'A pooler that strips or defers session commands cannot run this app.',
        )
      }

      if (cleared) {
        pass(
          'set-local-reset-by-commit',
          `next transaction sees ${after === null ? 'NULL' : "''"} — the tenant is gone, ` +
            'so context cannot leak forward on a reused backend',
        )
      } else {
        fail(
          'set-local-reset-by-commit',
          `app.tenant_id survived COMMIT as "${after}". ` +
            'That is a cross-tenant leak on a shared backend: the next request inherits this tenant.',
        )
      }
    } finally {
      c.release()
    }
  }

  // ── 3. Two overlapping transactions do not see each other's context ──────
  {
    const a = await pool.connect()
    const b = await pool.connect()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      await a.query(`SET LOCAL app.tenant_id = 'tenant-a-uuid'`)
      await b.query(`SET LOCAL app.tenant_id = 'tenant-b-uuid'`)

      // Deliberately interleaved: read A, then B, then A again, with both
      // transactions still open. A pooler that multiplexes transactions onto
      // one backend shows a's value in b, or vice versa.
      const a1 = await readGuc(a)
      const b1 = await readGuc(b)
      const a2 = await readGuc(a)

      await a.query('ROLLBACK')
      await b.query('ROLLBACK')

      if (a1 === 'tenant-a-uuid' && b1 === 'tenant-b-uuid' && a2 === 'tenant-a-uuid') {
        pass(
          'concurrent-transactions-are-isolated',
          'two transactions held open at once each saw only their own tenant context',
        )
      } else {
        fail(
          'concurrent-transactions-are-isolated',
          `contexts bled between open transactions: a=${a1 ?? 'NULL'} b=${b1 ?? 'NULL'} a-again=${a2 ?? 'NULL'}. ` +
            'This is the exact failure that makes a session-mode pooler unsafe for this app.',
        )
      }
    } finally {
      a.release()
      b.release()
    }
  }

  // ── 4. RLS actually enforces on this connection ───────────────────────────
  {
    const c = await pool.connect()
    try {
      const rls = await c.query<{ table: string; rls: boolean; force: boolean }>(
        `SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'Site'`,
      )
      const row = rls.rows[0]
      if (!row) {
        fail('rls-installed-on-site', 'the Site table was not found in schema public')
      } else if (!row.rls || !row.force) {
        fail(
          'rls-installed-on-site',
          `Site has rowsecurity=${row.rls} force=${row.force}. Both must be true, or the owner ` +
            'and any BYPASSRLS role read every tenant.',
        )
      } else {
        pass('rls-installed-on-site', 'Site has ENABLE + FORCE ROW LEVEL SECURITY')
      }

      // With no tenant context set, a plain SELECT must return zero rows.
      // The policy predicate is `tenant_id = NULL`, which is NULL, not TRUE.
      await c.query('BEGIN')
      const unscoped = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM "Site"')
      await c.query('ROLLBACK')
      const n = unscoped.rows[0]?.n ?? '?'
      if (n === '0') {
        pass('unset-context-fails-closed', 'SELECT with no tenant context returned 0 rows')
      } else {
        fail(
          'unset-context-fails-closed',
          `SELECT with no tenant context returned ${n} rows. An unset context must return NOTHING; ` +
            'returning rows means the policy is not applied to this role.',
        )
      }
    } finally {
      c.release()
    }
  }

  await pool.end()

  const failed = assertions.filter((a) => a.status === 'FAIL')
  console.log(`\n${assertions.length - failed.length}/${assertions.length} assertions passed`)
  if (failed.length > 0) {
    console.log('\nVerdict: this endpoint MUST NOT be used with this application.')
    console.log('Tenant isolation is enforced by transaction-scoped context; a backend that')
    console.log('does not preserve those semantics converts every request into a coin toss')
    console.log('over which tenant’s data it can read.\n')
    process.exit(1)
  }
  console.log('\nVerdict: the transaction-scoped tenant context holds on this endpoint.')
  console.log('Record the URL host + mode (pooler or direct) with this result; a proof')
  console.log('without its target is not a proof.\n')
}

main().catch((err: unknown) => {
  console.error('\nPooler RLS proof could not complete:')
  console.error(err instanceof Error ? err.message : String(err))
  console.error('\nA proof that cannot run is not a pass. Fix the connection and re-run.\n')
  process.exit(2)
})
