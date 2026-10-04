/**
 * Per-request tenant context for PostgreSQL Row Level Security.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE IS THE MOST DANGEROUS ONE IN THE REPOSITORY
 * ─────────────────────────────────────────────────────────────────────────────
 * RLS policies read the tenant from a session GUC:
 *
 *     tenant_id = current_setting('app.tenant_id', true)
 *
 * The whole multi-tenant isolation guarantee rests on that GUC being correct
 * for the connection doing the query. Two failure modes, one catastrophic:
 *
 *   1. FORGETTING to set it  → current_setting() is NULL → `NULL = x` is NULL
 *                              → predicate is not TRUE → **0 rows**. Safe.
 *   2. Setting it GLOBALLY    → `SET app.tenant_id = 'A'` (NOT `SET LOCAL`) is
 *                              session-scoped and PERMANENT for that
 *                              connection. PgBouncer / Prisma connection
 *                              pools HAND THAT CONNECTION TO THE NEXT
 *                              REQUEST. Tenant B's query then runs with
 *                              `app.tenant_id = 'A'` still set and RLS happily
 *                              returns TENANT A'S ROWS TO TENANT B.
 *
 * Failure mode 2 is silent, passes every test written against a single
 * connection, and is a complete cross-tenant data breach in production.
 *
 * Therefore, in this codebase:
 *
 *   - ALWAYS `SET LOCAL` (transaction-scoped, auto-reset on COMMIT/ROLLBACK).
 *   - ALWAYS inside an explicit transaction.
 *   - NEVER call `SET` (no LOCAL) on any pooled connection.
 *   - The ONLY supported way to run tenant-scoped work is `withTenant()`
 *     below, or `withTenantTx()` if you need the transaction yourself.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY AN UNSET CONTEXT FAILS CLOSED (do not "fix" this)
 * ─────────────────────────────────────────────────────────────────────────────
 * `current_setting('app.tenant_id', true)` — note the `true` — returns NULL
 * when the GUC has never been set (missing_ok). The policy predicate becomes
 *
 *     tenant_id = NULL        →   NULL
 *
 * and SQL `WHERE` keeps a row only when its predicate evaluates to TRUE.
 * NULL is not TRUE, so the row is dropped. An unset context therefore yields
 * an EMPTY result, not "all rows". This is the property that makes RLS safe
 * by default: a code path that forgets to establish context fails closed and
 * is immediately visible as "no data", rather than silently exposing the
 * whole table.
 *
 * Do not "improve" this by defaulting to a sentinel tenant id, and do not
 * change the policy to `coalesce(current_setting(...), 'default')`. That
 * turns a safe failure into a data leak.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TENANT ID TYPING — TEXT, no cast
 * ─────────────────────────────────────────────────────────────────────────────
 * `Tenant.id` is `String @default(cuid())`, which PostgreSQL stores as TEXT.
 * Real tenant ids are cuid-style strings ("t-default", "t-platform"), NOT
 * uuids.
 *
 * The policy predicate is therefore a plain TEXT comparison, with NO cast:
 *
 *     tenant_id = current_setting('app.tenant_id', true)
 *
 * The original architecture note specified
 * `current_setting('app.tenant_id', true)::uuid`. That predicate cannot work
 * in this schema — it throws on every row access:
 *
 *     ERROR:  invalid input syntax for type uuid: "t-default"
 *
 * Verified against the running database. The cast was removed; see
 * docs/phase1-tenant-isolation.md §"The predicate is TEXT, not uuid".
 *
 * Consequence for this module: `app.tenant_id` is always set as TEXT and a
 * tenant id is treated as an OPAQUE IDENTIFIER. `assertTenantId()` therefore
 * accepts cuid-style ids, never requires uuid-ness, and rejects anything
 * outside a conservative identifier character set. RLS compares values, not
 * types, so text equality is exact and already indexable.
 */

import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'

/** Thrown when tenant context is requested with an unusable tenant id. */
export class TenantContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenantContextError'
  }
}

/**
 * The session GUC name the RLS policies read.
 * Kept as a constant so a typo cannot silently disable isolation.
 */
export const TENANT_SETTING = 'app.tenant_id'

/** Longest plausible cuid/uuid — a cheap guard against passing a blob. */
const MAX_TENANT_ID_LENGTH = 128

/**
 * Validate a tenant id before it is used as a security context.
 *
 * Fails FAST rather than letting an empty string reach the database. An empty
 * context is *safe* (it fails closed) but it breaks every query in the
 * request, which surfaces as a confusing "no data anywhere" bug instead of a
 * clear error at the call site.
 *
 * Tenant ids are opaque TEXT: this accepts cuid-style ids ("t-default") and
 * would accept uuids alike. It deliberately does NOT assert uuid-ness, because
 * this schema uses cuids and the policy is a plain TEXT comparison — see the
 * TYPING note above.
 */
export function assertTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string') {
    throw new TenantContextError(
      `tenantId must be a string, received ${tenantId === null ? 'null' : typeof tenantId}.`,
    )
  }
  const trimmed = tenantId.trim()
  if (trimmed.length === 0) {
    throw new TenantContextError(
      'tenantId is empty. Refusing to open a transaction with an empty tenant ' +
        'context — it would fail closed and return zero rows for every query.',
    )
  }
  if (trimmed.length > MAX_TENANT_ID_LENGTH) {
    throw new TenantContextError(
      `tenantId exceeds ${MAX_TENANT_ID_LENGTH} characters (received ${trimmed.length}).`,
    )
  }
  // A tenant id is an identifier, never an SQL fragment. Anything outside this
  // set is either a programming error or an injection attempt. cuid ("t-…",
  // "c…") and uuid ("…-…") both satisfy it.
  if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) {
    throw new TenantContextError(
      'tenantId contains characters outside [A-Za-z0-9_.:-]; refusing to use it as a tenant context.',
    )
  }
}

/**
 * Normalise and validate a tenant id, returning the trimmed value.
 * Use this when you want the canonical string rather than an assertion.
 */
export function normalizeTenantId(tenantId: unknown): string {
  assertTenantId(tenantId)
  return (tenantId as string).trim()
}

/**
 * Read the tenant context currently in effect on this connection.
 *
 * Returns null when there is no usable context — either because the GUC was
 * never set on this connection, or because a previous `SET LOCAL` was reset
 * by COMMIT/ROLLBACK.
 *
 * SUBTLETY, verified against PostgreSQL 17, and the reason for the empty-string
 * check: after `SET LOCAL app.tenant_id = 'x'` followed by COMMIT or ROLLBACK,
 * `current_setting('app.tenant_id', true)` returns the EMPTY STRING, not NULL.
 * So:
 *
 *     current_setting('app.tenant_id', true) IS NULL   →  false   (post-rollback)
 *     current_setting('app.tenant_id', true) IS NULL   →  true    (never set)
 *
 * Both states are equally safe — the RLS predicate is `tenant_id = <value>`,
 * and `tenant_id` is never `''` (it is NOT NULL and references Tenant.id), so
 * `'…' = ''` is FALSE and the row is filtered out either way. The backstop
 * holds in both states.
 *
 * But a caller asking "which tenant am I acting as?" must not be handed `''`
 * and treat it as a tenant id, so empty and NULL are both normalised to null
 * here. Anything that relied on distinguishing "never set" from "reset" must
 * query the setting itself rather than use this helper.
 */
export async function currentTenantId(
  client: Pick<Prisma.TransactionClient, '$queryRaw'> = db,
): Promise<string | null> {
  const rows = await client.$queryRaw<Array<{ tenant_id: string | null }>>`
    SELECT current_setting(${TENANT_SETTING}, true) AS tenant_id
  `
  const value = rows[0]?.tenant_id
  // Normalise both "never set" (NULL) and "reset by rollback" ('') to null.
  return value === null || value === undefined || value === '' ? null : value
}

/**
 * Raw view of the session setting, for diagnostics and tests.
 *
 * IMPORTANT — pass the TRANSACTION client to read the context of an open
 * `withTenant()` transaction:
 *
 *     await withTenant(id, (tx) => rawTenantSetting(tx))
 *
 * Calling it with the default global client borrows a DIFFERENT pooled
 * connection, which by definition has no tenant context, so it will report
 * null even while the surrounding transaction is correctly scoped.
 *
 * Unlike `currentTenantId()` this preserves the distinction between NULL
 * (never set on this connection) and '' (set locally then rolled back), so a
 * test can assert the true state of the GUC rather than the normalised view.
 */
export async function rawTenantSetting(
  client: Pick<Prisma.TransactionClient, '$queryRaw'> = db,
): Promise<string | null> {
  const rows = await client.$queryRaw<Array<{ tenant_id: string | null }>>`
    SELECT current_setting(${TENANT_SETTING}, true) AS tenant_id
  `
  return rows[0]?.tenant_id ?? null
}

/**
 * Run `fn` inside an interactive transaction with the tenant context set via
 * `SET LOCAL`.
 *
 * This is the ONLY supported entry point for tenant-scoped database work.
 * The GUC is set immediately after BEGIN and is discarded automatically when
 * the transaction ends, so the connection returns to the pool clean.
 *
 * `fn` receives a transaction client. ALL queries that must respect RLS have
 * to run on that client — a query issued on the global `db` client runs on a
 * DIFFERENT (pooled) connection that has no tenant context, and will
 * therefore see zero rows.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  assertTenantId(tenantId)
  const tid = (tenantId as string).trim()

  return db.$transaction(
    async (tx) => {
      // `set_config(name, value, is_local => true)` is the transaction-local
      // equivalent of `SET LOCAL`, and is used instead of it for one concrete
      // reason: PostgreSQL's SET grammar does NOT accept bind parameters —
      //
      //     SET LOCAL app.tenant_id = $1
      //     ERROR:  syntax error at or near "$1"
      //
      // So the only way to pass the tenant id as a real bind parameter (rather
      // than string-concatenated SQL) is set_config(). The third argument
      // `true` scopes it to the current transaction, which gives exactly the
      // `SET LOCAL` semantics required above: the value is discarded on
      // COMMIT or ROLLBACK and cannot leak to the next borrower of the
      // pooled connection.
      //
      // Verified against PostgreSQL 17: inside the transaction the setting
      // reads back and RLS filters correctly; after ROLLBACK it is empty and
      // reads return zero rows.
      await tx.$executeRaw`SELECT set_config(${TENANT_SETTING}, ${tid}, true)`
      return fn(tx)
    },
    {
      // Keep the transaction short: RLS checks and row locks are held for its
      // duration, and interactive transactions consume a pooled connection.
      timeout: 10_000,
      maxWait: 5_000,
    },
  )
}

/**
 * Open a tenant-scoped transaction and hand the raw client to `fn`.
 *
 * Same guarantee as `withTenant`, but the caller owns the transaction body —
 * required when several statements must share one snapshot, or when the
 * caller needs to COMMIT/ROLLBACK explicitly.
 *
 * IMPORTANT: `fn` MUST let the returned promise settle so Prisma closes the
 * transaction. Returning early without awaiting leaves the connection and its
 * GUC in limbo.
 */
export async function withTenantTx<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withTenant(tenantId, fn)
}

/**
 * The SQL used to establish tenant context inside an existing interactive
 * transaction.
 *
 * Exposed for code that must add tenant context to a transaction it already
 * owns. Note the tenant id is passed as a bind parameter — `SET LOCAL` cannot
 * be used here because PostgreSQL's SET grammar rejects bind parameters, so
 * `set_config(..., true)` provides the identical transaction-local semantics.
 *
 * @example
 * await db.$transaction(async (tx) => {
 *   await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`
 *   // …tenant-scoped statements…
 * })
 */
export function tenantContextSqlFragment(): string {
  return `SELECT set_config('${TENANT_SETTING}', $1, true)`
}

/**
 * True when `value` looks like a RFC 4122 uuid.
 *
 * NOT a requirement for tenant ids in this schema — they are cuid-style TEXT
 * and the RLS predicate is a TEXT comparison. Retained because the regression
 * suite uses it to PROVE the deployment's tenant ids are not uuids, which is
 * what justifies the cast-free policy. A uuid here would mean the policy could
 * safely use ::uuid, but it is not currently the case.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
}
