/**
 * Just-in-time platform support access.
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────
 * `SUPERADMIN` is a platform role, but the tenant-scoped data path is built
 * around ONE tenant per request: `withTenant(tenantId, …)` sets
 * `app.tenant_id` and every FORCE-RLS policy compares against it. A super-admin
 * session therefore carries a tenant like any other session — `t-platform`, the
 * tenant that owns the platform accounts — and every list route that runs
 * inside `asTenant(me, …)` silently returns that tenant's data and nothing
 * else. Measured in this repository: `GET /api/fgmp/audit` as SUPERADMIN
 * returned 0 rows while other tenants had thousands, and the route's own
 * comment claimed it "widens the tenant scope".
 *
 * There are only three ways to make a super-admin see customer data:
 *
 *   A. Run the whole request as a role that bypasses RLS (`fgmp_ops`).
 *      Rejected: that is a permanent, ambient capability on the request path,
 *      and one missing check turns every query into a cross-tenant read.
 *
 *   B. Let the super-admin's own session carry an arbitrary tenant id.
 *      Rejected: nothing in the request distinguishes "the operator chose this
 *      tenant" from "this id came from a request body". Two tenants in one
 *      session is exactly the state we must be able to prove is impossible.
 *
 *   C. A time-boxed, single-tenant grant, recorded before it is used, that the
 *      operator must explicitly obtain and explicitly end. CHOSEN.
 *
 * This module implements C. A support session is a row that says
 * "operator X may act as tenant T, for reason R, until time E" — and the data
 * path reads that row, not a client-supplied tenant id. The grant is the
 * authorisation; the `SET LOCAL app.tenant_id` still happens per request, so
 * RLS keeps working exactly as designed and the request path still runs as
 * `fgmp_app` with no BYPASSRLS anywhere.
 *
 * ── THE INVARIANTS, AND WHY EACH ONE IS ENFORCED WHERE IT IS ────────────────
 *  1. ONE OPEN SESSION PER OPERATOR. Enforced by a partial unique index in the
 *     database (`SupportSession_one_open_per_actor`), not just by a check in
 *     this file. "A super-admin cannot hold two tenants at once" is then a
 *     property of the schema; an application bug cannot produce the state.
 *  2. ONE TENANT PER SESSION. `tenantId` is a single column with no wildcard
 *     value. There is no "all tenants" mode to mis-set.
 *  3. READ BY DEFAULT. `mode` defaults to READ; WRITE must be asked for AND
 *     carries a mandatory ticket reference, because the interesting audit
 *     question about a support session is "why did you change something".
 *  4. EVERYTHING IS RECORDED, IN TWO PLACES. The platform audit log (global,
 *     outside the tenant's write path) records start, use and end; the target
 *     tenant's own `AuditLog` records that support access happened, so the
 *     customer can see it. Neither record is written by the code path that
 *     the operator is using on the tenant's data — see `recordTenantNotice`.
 *  5. EXPIRY IS WALL-CLOCK, NOT SESSION-LENGTH. A session ends at `expiresAt`
 *     whether or not anybody calls DELETE, and a new session is refused while
 *     any other is still open.
 *  6. THE COOKIE IS SIGNED AND BOUND. The session id alone is not a capability:
 *     `fgmp_support` is an HMAC over {session id, operator id, tenant, mode,
 *     expiry} and is only accepted while the row agrees with all five.
 *
 * ── WHY THE TOKEN AND THE ROW BOTH EXIST ───────────────────────────────────
 * The row is the authority (it can be revoked centrally, and it is what the
 * audit trail points at). The token exists so that a *different* operator who
 * learns a session id from the audit log cannot paste it into a cookie: the
 * token's `sub` must equal the authenticated user, and it is signed with the
 * deployment secret, so it cannot be minted for someone else.
 *
 * ── WHAT THIS MODULE DOES NOT DO ───────────────────────────────────────────
 * It does not grant access to the ordinary tenant routes. Those keep running
 * inside the caller's own tenant context (`asTenant`). Support access is a
 * separate, narrow surface under /api/fgmp/platform/support/ that resolves the
 * session on every request. Making the ordinary routes switch tenants based on
 * a cookie would put the support capability behind every one of ~80 handlers,
 * which is precisely the wrong place for it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Cookie carrying the signed support-session token. */
export const SUPPORT_COOKIE = "fgmp_support_session";

/** Default lifetime of a read-only support session: one hour. */
export const SUPPORT_READ_TTL_SEC = 60 * 60;

/** Default lifetime of a write-capable session: thirty minutes. */
export const SUPPORT_WRITE_TTL_SEC = 30 * 60;

/**
 * Hard ceiling on any support session, whatever the caller asks for.
 *
 * Four hours is long enough for a real incident and short enough that a
 * forgotten session cannot survive a working day. A caller passing `ttlSec`
 * gets min(requested, ceiling); there is no way to ask for "no expiry".
 */
export const SUPPORT_MAX_TTL_SEC = 4 * 60 * 60;

/** Minimum length of `reason`. Short enough not to be an obstacle, long
 *  enough that "test" is not a valid justification for reading a customer. */
export const SUPPORT_REASON_MIN = 10;

export type SupportMode = "READ" | "WRITE";

export class SupportSessionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SupportSessionError";
    this.status = status;
    this.code = code;
  }
}

/** The subset of a `SupportSession` row this module reasons about. */
export interface SupportSessionRow {
  id: string;
  actorUserId: string;
  actorEmail: string;
  tenantId: string;
  reason: string;
  ticketRef: string | null;
  mode: string;
  createdAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endReason: string | null;
}

export interface NewSupportSession {
  actorUserId: string;
  actorEmail: string;
  tenantId: string;
  reason: string;
  ticketRef: string | null;
  mode: SupportMode;
  createdAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Storage the module needs. Injectable so the invariants above can be tested
 * without a database — the tests in `__tests__/support-session.test.ts` use an
 * in-memory implementation and assert the refusals, which is the part that
 * must not regress.
 *
 * Production wiring is `prismaSupportStore()` at the bottom of this file,
 * imported lazily so this module stays importable in a test process with no
 * generated Prisma client.
 */
export interface SupportStore {
  /** Close sessions whose `expiresAt` has passed and that were never ended. */
  expireStale(actorUserId: string, now: Date): Promise<number>;
  /** The single open session for an operator, if any. */
  findOpenForActor(actorUserId: string, now: Date): Promise<SupportSessionRow | null>;
  findById(id: string): Promise<SupportSessionRow | null>;
  create(row: NewSupportSession): Promise<SupportSessionRow>;
  end(id: string, at: Date, reason: string): Promise<SupportSessionRow | null>;
  tenantExists(tenantId: string): Promise<boolean>;
}

/** Where platform-level (cross-tenant, no customer rows) events are recorded. */
export interface PlatformAuditSink {
  record(entry: {
    actorUserId: string;
    actorEmail: string;
    action: string;
    targetTenantId?: string | null;
    supportSessionId?: string | null;
    detail: Record<string, unknown>;
    ip?: string | null;
    at: Date;
  }): Promise<void>;
}

/** Where tenant-visible notices are recorded (inside the target tenant). */
export interface TenantNoticeSink {
  record(entry: {
    tenantId: string;
    actorUserId: string;
    action: string;
    supportSessionId: string;
    detail: Record<string, unknown>;
    ip?: string | null;
  }): Promise<void>;
}

export interface SupportDeps {
  store?: SupportStore;
  platformAudit?: PlatformAuditSink;
  tenantNotice?: TenantNoticeSink;
  now?: () => Date;
  /** Secret used to sign the cookie. Defaults to NEXTAUTH_SECRET. */
  secret?: string | null;
}

export interface ActiveSupportSession {
  id: string;
  tenantId: string;
  actorUserId: string;
  actorEmail: string;
  mode: SupportMode;
  reason: string;
  ticketRef: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface StartedSupportSession {
  session: ActiveSupportSession;
  /** Signed cookie value. The caller sets it; this module never touches HTTP. */
  token: string;
}

// ── Validation ───────────────────────────────────────────────────────────────

function normaliseMode(mode: string | undefined): SupportMode {
  const value = (mode ?? "READ").toUpperCase();
  if (value !== "READ" && value !== "WRITE") {
    throw new SupportSessionError(
      400,
      "SUPPORT_MODE_INVALID",
      `mode must be READ or WRITE, received ${JSON.stringify(mode)}. There is no third mode: a session is read-only unless write access was explicitly requested.`,
    );
  }
  return value;
}

function requireReason(reason: string | undefined): string {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length < SUPPORT_REASON_MIN) {
    throw new SupportSessionError(
      400,
      "SUPPORT_REASON_REQUIRED",
      `A support session needs a reason of at least ${SUPPORT_REASON_MIN} characters. This text is shown to the tenant in its own audit log, so it must say what the operator is doing.`,
    );
  }
  if (trimmed.length > 500) {
    throw new SupportSessionError(400, "SUPPORT_REASON_TOO_LONG", "reason must be 500 characters or fewer.");
  }
  return trimmed;
}

function ttlFor(mode: SupportMode, requested: number | undefined): number {
  const ceiling = SUPPORT_MAX_TTL_SEC;
  const fallback = mode === "WRITE" ? SUPPORT_WRITE_TTL_SEC : SUPPORT_READ_TTL_SEC;
  if (requested === undefined || requested === null) return fallback;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new SupportSessionError(400, "SUPPORT_TTL_INVALID", "ttlSec must be a positive number of seconds.");
  }
  // Short sessions are fine (a 5-minute look during a call); long ones are not.
  return Math.min(Math.floor(requested), ceiling);
}

/**
 * Refuse to start a session for a tenant named by the caller when the caller is
 * not a platform super-admin.
 *
 * The role is passed in rather than read from a session inside this module so
 * the check happens on the SAME value the route authorised with — not on a
 * second, possibly-stale read.
 */
function assertSuperAdmin(role: string | undefined): void {
  if (role !== "SUPERADMIN") {
    // 403, not 404: the endpoint's existence is not a secret (it is in the
    // admin UI), and a clear refusal is what an audit of a failed attempt needs.
    throw new SupportSessionError(
      403,
      "SUPPORT_REQUIRES_SUPERADMIN",
      "Support sessions can only be opened by a platform super-admin. Tenant administrators must use their own tenant scope.",
    );
  }
}

// ── Token ────────────────────────────────────────────────────────────────────

interface SupportTokenPayload {
  sid: string;
  sub: string;
  tid: string;
  mode: SupportMode;
  exp: number;
}

function sign(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * The signing secret, or a hard failure.
 *
 * Same rule as session signing (src/lib/auth.ts): at least 32 characters. A
 * short or absent secret must DISABLE the feature rather than sign with a
 * guessable key — a forged support token is a cross-tenant read.
 */
export function supportSecret(explicit?: string | null): string {
  const secret = explicit ?? process.env.NEXTAUTH_SECRET ?? "";
  if (secret.trim().length < 32) {
    throw new SupportSessionError(
      503,
      "SUPPORT_TOKEN_SECRET_MISSING",
      "NEXTAUTH_SECRET is missing or shorter than 32 characters, so support-session tokens cannot be signed. The feature is disabled rather than falling back to an unsigned token.",
    );
  }
  return secret;
}

export function signSupportToken(
  payload: SupportTokenPayload,
  secret = supportSecret(),
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

/**
 * Verify a support token. Returns null on ANY inconsistency — bad shape, bad
 * signature, expired, or bound to a different operator. Never throws for a
 * malformed cookie: a garbage cookie must look like "no support session".
 */
export function verifySupportToken(
  token: string | null | undefined,
  actorUserId: string,
  now: Date = new Date(),
  secret?: string | null,
): SupportTokenPayload | null {
  if (!token) return null;
  let key: string;
  try {
    key = supportSecret(secret);
  } catch {
    return null;
  }
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = sign(key, body);
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.sid !== "string" || typeof p.sub !== "string" || typeof p.tid !== "string") return null;
  if (p.mode !== "READ" && p.mode !== "WRITE") return null;
  if (typeof p.exp !== "number") return null;
  // Bound to the authenticated user: a token lifted from another operator's
  // browser (or from the audit log) authorises nothing.
  if (p.sub !== actorUserId) return null;
  if (p.exp * 1000 <= now.getTime()) return null;
  return { sid: p.sid, sub: p.sub, tid: p.tid, mode: p.mode, exp: p.exp };
}

/**
 * True for a unique-constraint violation, across the two shapes it arrives in:
 * Prisma's `P2002` (production) and the raw PostgreSQL message (tests, and any
 * driver that does not map codes). Deliberately narrow — a generic "create
 * failed" must not be reported as "a session is already open".
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "P2002") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /unique constraint/i.test(message);
}

// ── Start / end ──────────────────────────────────────────────────────────────

export interface StartSupportInput {
  actor: { id: string; email?: string | null; role?: string };
  tenantId: string;
  reason: string;
  ticketRef?: string | null;
  mode?: string;
  ttlSec?: number;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Open a support session.
 *
 * Ordering matters and is deliberate: authorise, validate, refuse a second
 * session, THEN write. A refused attempt writes nothing to the tenant, so a
 * failed authorisation cannot itself become a cross-tenant write.
 */
export async function startSupportSession(
  input: StartSupportInput,
  deps: SupportDeps = {},
): Promise<StartedSupportSession> {
  assertSuperAdmin(input.actor.role);

  const tenantId = (input.tenantId ?? "").trim();
  if (!tenantId) {
    throw new SupportSessionError(
      400,
      "SUPPORT_TENANT_REQUIRED",
      "A support session must name exactly one tenant. There is no \"all tenants\" mode.",
    );
  }
  const mode = normaliseMode(input.mode);
  const reason = requireReason(input.reason);
  const ticketRef = (input.ticketRef ?? "").trim() || null;
  if (mode === "WRITE" && !ticketRef) {
    throw new SupportSessionError(
      400,
      "SUPPORT_TICKET_REQUIRED",
      "Write-capable support access requires a ticket or case reference. Read-only access does not.",
    );
  }

  const now = (deps.now ?? (() => new Date()))();
  const ttlSec = ttlFor(mode, input.ttlSec);
  const expiresAt = new Date(now.getTime() + ttlSec * 1000);
  const store = await resolveStore(deps);

  if (!(await store.tenantExists(tenantId))) {
    throw new SupportSessionError(404, "SUPPORT_TENANT_UNKNOWN", "No such tenant.");
  }

  // Expired-but-unended rows would otherwise block the unique index below
  // forever. Closing them is also the honest record: a session that ran out is
  // "expired", not "still open".
  await store.expireStale(input.actor.id, now);

  const open = await store.findOpenForActor(input.actor.id, now);
  if (open) {
    throw new SupportSessionError(
      409,
      "SUPPORT_SESSION_ALREADY_OPEN",
      `A support session for tenant ${open.tenantId} is already open and expires at ${open.expiresAt.toISOString()}. End it before opening another: one operator session may hold one tenant at a time.`,
    );
  }

  let row: SupportSessionRow;
  try {
    row = await store.create({
      actorUserId: input.actor.id,
      actorEmail: input.actor.email ?? "",
      tenantId,
      reason,
      ticketRef,
      mode,
      createdAt: now,
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  } catch (err) {
    // The check above and this insert are not atomic: two concurrent requests
    // can both pass it. The partial unique index is what actually stops that,
    // and it surfaces here as a constraint violation. Translate it into the
    // same 409 the sequential path returns, so the invariant holds under
    // concurrency and the caller sees one predictable answer.
    if (isUniqueViolation(err)) {
      throw new SupportSessionError(
        409,
        "SUPPORT_SESSION_ALREADY_OPEN",
        "Another support session was opened for this operator at the same moment. One operator may hold one tenant at a time; re-read the open session and end it first.",
      );
    }
    throw err;
  }

  const session: ActiveSupportSession = {
    id: row.id,
    tenantId: row.tenantId,
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    mode: row.mode === "WRITE" ? "WRITE" : "READ",
    reason: row.reason,
    ticketRef: row.ticketRef,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };

  const platformAudit = await resolvePlatformAudit(deps);
  await platformAudit.record({
    actorUserId: input.actor.id,
    actorEmail: input.actor.email ?? "",
    action: "SUPPORT_SESSION_START",
    targetTenantId: tenantId,
    supportSessionId: row.id,
    detail: { mode, reason, ticketRef, expiresAt: expiresAt.toISOString(), ttlSec },
    ip: input.ip ?? null,
    at: now,
  });

  // The tenant-visible half. Written through ITS OWN tenant-scoped connection,
  // so the notice lands inside the tenant's RLS boundary and the tenant sees it
  // in its own audit view. A failure here must not abort a legitimate support
  // session, but it must not be silent either: the platform record already
  // exists, and `supportSessionFailures` counts the gap.
  const notice = await resolveTenantNotice(deps);
  try {
    await notice.record({
      tenantId,
      actorUserId: input.actor.id,
      action: "SUPPORT_ACCESS_STARTED",
      supportSessionId: row.id,
      detail: { mode, reason, ticketRef, expiresAt: expiresAt.toISOString() },
      ip: input.ip ?? null,
    });
  } catch {
    recordFailure("tenant-notice", row.id);
  }

  const token = signSupportToken(
    {
      sid: row.id,
      sub: input.actor.id,
      tid: tenantId,
      mode: session.mode,
      exp: Math.floor(expiresAt.getTime() / 1000),
    },
    deps.secret ?? undefined,
  );

  return { session, token };
}

/**
 * End a session. Idempotent: ending an already-ended session returns the
 * existing row rather than raising, so a retried click is not an error.
 */
export async function endSupportSession(
  actor: { id: string; email?: string | null; role?: string },
  sessionId: string,
  options: { reason?: string; ip?: string | null } = {},
  deps: SupportDeps = {},
): Promise<SupportSessionRow> {
  assertSuperAdmin(actor.role);
  const now = (deps.now ?? (() => new Date()))();
  const store = await resolveStore(deps);

  const row = await store.findById(sessionId);
  // A super-admin may only end their OWN session. Another operator's session is
  // terminated by expiry, or by an operator with database access — not by a
  // peer who happens to know the id.
  if (!row || row.actorUserId !== actor.id) {
    throw new SupportSessionError(404, "SUPPORT_SESSION_NOT_FOUND", "No such support session.");
  }
  if (row.endedAt) return row;

  const ended = await store.end(sessionId, now, (options.reason ?? "ENDED_BY_OPERATOR").slice(0, 200));
  const finalRow = ended ?? { ...row, endedAt: now, endReason: options.reason ?? "ENDED_BY_OPERATOR" };

  const platformAudit = await resolvePlatformAudit(deps);
  await platformAudit.record({
    actorUserId: actor.id,
    actorEmail: actor.email ?? "",
    action: "SUPPORT_SESSION_END",
    targetTenantId: finalRow.tenantId,
    supportSessionId: finalRow.id,
    detail: {
      reason: finalRow.endReason,
      startedAt: finalRow.createdAt.toISOString(),
      endedAt: now.toISOString(),
      durationSec: Math.max(0, Math.round((now.getTime() - finalRow.createdAt.getTime()) / 1000)),
    },
    ip: options.ip ?? null,
    at: now,
  });

  const notice = await resolveTenantNotice(deps);
  try {
    await notice.record({
      tenantId: finalRow.tenantId,
      actorUserId: actor.id,
      action: "SUPPORT_ACCESS_ENDED",
      supportSessionId: finalRow.id,
      detail: { reason: finalRow.endReason, endedAt: now.toISOString() },
      ip: options.ip ?? null,
    });
  } catch {
    recordFailure("tenant-notice", finalRow.id);
  }

  return finalRow;
}

// ── Resolve the active session on a request ──────────────────────────────────

/**
 * The session a request may act under, or null.
 *
 * Checks the token, then the row. A row that has been ended, that has expired,
 * or whose tenant/mode disagrees with the token yields null — the token is a
 * summary, the row is the authority. Callers pass the authenticated user; a
 * token belonging to somebody else is rejected in `verifySupportToken`.
 */
export async function resolveActiveSupport(
  actor: { id: string; role?: string },
  token: string | null | undefined,
  deps: SupportDeps = {},
): Promise<ActiveSupportSession | null> {
  if (actor.role !== "SUPERADMIN") return null;
  const now = (deps.now ?? (() => new Date()))();
  const payload = verifySupportToken(token, actor.id, now, deps.secret);
  if (!payload) return null;

  const store = await resolveStore(deps);
  const row = await store.findById(payload.sid);
  if (!row) return null;
  if (row.actorUserId !== actor.id) return null;
  if (row.endedAt) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  // The row wins on tenant and mode. If the token was minted before the row was
  // amended, the amended values apply; a mismatch in the tenant is a refusal,
  // because acting on a tenant the operator never chose is the one outcome that
  // must be impossible.
  if (row.tenantId !== payload.tid) return null;

  return {
    id: row.id,
    tenantId: row.tenantId,
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    mode: row.mode === "WRITE" ? "WRITE" : "READ",
    reason: row.reason,
    ticketRef: row.ticketRef,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/** Refuse access to a tenant other than the one the session grants. */
export function assertSupportTenant(session: ActiveSupportSession, tenantId: string): void {
  if (tenantId !== session.tenantId) {
    throw new SupportSessionError(
      403,
      "SUPPORT_TENANT_MISMATCH",
      `This support session is scoped to tenant ${session.tenantId}. It cannot be used for tenant ${tenantId}; open a separate session for that tenant.`,
    );
  }
}

/** Refuse a write under a read-only session. */
export function assertSupportWritable(session: ActiveSupportSession): void {
  if (session.mode !== "WRITE") {
    throw new SupportSessionError(
      403,
      "SUPPORT_READ_ONLY",
      "This support session is read-only. Write access must be granted separately and requires a ticket reference.",
    );
  }
}

/**
 * Highest number of distinct tenants one operator can be acting as at once.
 *
 * Exported as a constant rather than left implicit in the code because a test
 * asserts it, and because it is the answer to a question a reviewer will ask:
 * one. The partial unique index enforces the same number in the database.
 */
export const MAX_CONCURRENT_TENANTS_PER_OPERATOR = 1;

// ── Failure accounting ───────────────────────────────────────────────────────

const failures = new Map<string, number>();

function recordFailure(kind: string, sessionId: string): void {
  const key = kind;
  failures.set(key, (failures.get(key) ?? 0) + 1);
  // Session id, not tenant id: this line goes to the application log, and the
  // log is not the place to spread customer identifiers around.
  console.error(`[support-session] failed to write ${kind} for session ${sessionId}`);
}

/**
 * Count of support-session side-writes that failed. A monitoring check should
 * assert this stays zero; it exists so "the tenant was told" is checkable
 * rather than assumed (the same reasoning as `auditFailures` in audit.ts).
 */
export function supportSessionFailures(): number {
  return [...failures.values()].reduce((a, b) => a + b, 0);
}

/** Test hook. Not exported through the package index. */
export function __resetSupportSessionFailures(): void {
  failures.clear();
}

// ── Default (Prisma) wiring ──────────────────────────────────────────────────

/**
 * Resolve the store, lazily.
 *
 * The Prisma import is dynamic on purpose: `bun test` runs without a generated
 * client in this repository's CI-less environment, and a static import of
 * `@/lib/db` would make the pure invariant tests above unrunnable. Production
 * paths always take the default branch.
 */
async function resolveStore(deps: SupportDeps): Promise<SupportStore> {
  if (deps.store) return deps.store;
  const defaults = await prismaSupportWiring();
  return defaults.store;
}

async function resolvePlatformAudit(deps: SupportDeps): Promise<PlatformAuditSink> {
  if (deps.platformAudit) return deps.platformAudit;
  const { platformAudit } = await import("./platform-audit");
  return platformAudit;
}

async function resolveTenantNotice(deps: SupportDeps): Promise<TenantNoticeSink> {
  if (deps.tenantNotice) return deps.tenantNotice;
  const { tenantNotice } = await import("./platform-audit");
  return tenantNotice;
}

let wiring: Promise<{ store: SupportStore }> | null = null;

function prismaSupportWiring(): Promise<{ store: SupportStore }> {
  if (!wiring) {
    wiring = (async () => {
      const { db } = await import("@/lib/db");
      const store: SupportStore = {
        async expireStale(actorUserId, now) {
          const res = await db.supportSession.updateMany({
            where: { actorUserId, endedAt: null, expiresAt: { lte: now } },
            data: { endedAt: now, endReason: "EXPIRED" },
          });
          return res.count;
        },
        async findOpenForActor(actorUserId, now) {
          return db.supportSession.findFirst({
            where: { actorUserId, endedAt: null, expiresAt: { gt: now } },
            orderBy: { createdAt: "desc" },
          });
        },
        async findById(id) {
          return db.supportSession.findUnique({ where: { id } });
        },
        async create(row) {
          return db.supportSession.create({ data: row });
        },
        async end(id, at, reason) {
          // updateMany with `endedAt: null` in the WHERE makes this a
          // compare-and-set: two operators ending the same session at once
          // cannot both succeed. The second gets `count: 0` and reads back the
          // row, which already carries the first end's timestamp.
          const res = await db.supportSession.updateMany({
            where: { id, endedAt: null },
            data: { endedAt: at, endReason: reason },
          });
          if (res.count === 0) return db.supportSession.findUnique({ where: { id } });
          return db.supportSession.findUnique({ where: { id } });
        },
        async tenantExists(tenantId) {
          const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
          return Boolean(t);
        },
      };
      return { store };
    })();
  }
  return wiring;
}
