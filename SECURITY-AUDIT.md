# FGMP Security & Multi-Tenancy Audit

**Scope:** `/home/ubuntu/FGMP1` — Next.js 16 (App Router) + Prisma/SQLite + Bun mini-services (`fgmp-realtime`, `fgmp-iot-bridge`), Caddy gateway, Docker Compose.
**Method:** full read of the auth/RBAC/rate-limit/backup/realtime libraries, all 98 API route handlers, both Compose services, the Caddyfile, `next.config.ts`, and a repo-wide sink sweep.

> **Context:** this codebase has clearly already been through prior remediation passes — most comments in `auth-helpers.ts`, `rate-limit.ts`, and the backup routes document specific CVEs they *fixed*. Findings below are the issues **still present** after that work.

---

## Summary

| # | Severity | Area | Location |
|---|----------|------|----------|
| 1 | **Critical** | IDOR — geography by-id routes have no tenant check | `src/app/api/fgmp/geography/{regions,governorates,districts}/[id]/route.ts` |
| 2 | **High** | Backup download = full cross-tenant DB dump | `src/app/api/fgmp/backups/[id]/download/route.ts:41` |
| 3 | **High** | Identity falls back to a hardcoded mock user | `src/lib/fgmp/rbac.ts:232` |
| 4 | **Medium** | Realtime `subscribe:site` / `subscribe:region` has no tenant check | `mini-services/realtime/index.ts:207` |
| 5 | **Medium** | In-memory rate limiter is per-process | `src/lib/fgmp/rate-limit.ts:26` |
| 6 | **Medium** | Secrets present in working-tree `.env` | `.env:1` |
| 7 | **Low** | Non-constant-time comparison of service/API secrets | `src/app/api/fgmp/iot/ingest/route.ts:107` |
| 8 | **Low** | CSP allows `unsafe-eval` + any-`https:` `frame-ancestors` | `next.config.ts:49`, `next.config.ts:56` |
| 9 | **Info** | `$queryRawUnsafe` / `eval` — none found | repo-wide |

---

## 1. CRITICAL — IDOR: geography by-id routes perform no tenant ownership check

The three geography by-id handlers fetch the record by id, **select the owning `tenantId`, and then never compare it to the caller's tenant.** The value is read only to attribute the audit log.

**`src/app/api/fgmp/geography/regions/[id]/route.ts`**

- `:61` — `db.region.findUnique({ where: { id }, select: { id, tenantId, name } })`
- `:62-66` — only `if (!existing)` → 404. **No `existing.tenantId !== user.tenantId`.**
- `:85` — `db.region.update({ where: { id }, data })` — mutates any tenant's region.
- `:165` — `db.region.delete({ where: { id } })` — deletes any tenant's region (cascades to governorates/districts).
- `:102`, `:169` — the fetched `tenantId` is used **only** as the audit-log `tenantId`.

**`src/app/api/fgmp/geography/governorates/[id]/route.ts`**

- `:60` fetches `region: { select: { tenantId } }`; `:61-65` null-check only; `:84` `update({ where: { id } })`; `:95` uses the tenant only for audit.
- `:128` DELETE — same shape.

**`src/app/api/fgmp/geography/districts/[id]/route.ts`**

- `:60-63` fetches `governorate.region.tenantId`; `:64-68` null-check only; `:87` `update({ where: { id } })`; `:95` audit only.
- `:128` DELETE — same shape.

**Exploit:** any `ADMIN` of tenant *A* sends `PATCH /api/fgmp/geography/regions/<id-from-tenant-B>` with `{"name":"pwned"}` → 200 and tenant B's region is renamed. `DELETE` removes it, and because `Region.governorates` is `onDelete: Cascade` (see the comment at `:162-164`), the attacker cascades a destructive delete into tenant B's geography hierarchy. No role beyond tenant ADMIN is needed; ids are CUIDs, and the same leak is reachable by enumerating them from any IDOR-friendly list surface or via `GET /api/fgmp/geography` (which *is* correctly scoped).

**Proof of inconsistency:** the sibling list route scopes correctly —
`src/app/api/fgmp/geography/route.ts:50-51` uses `db.region.findMany({ where: tenantWhereOrAll(user) })`. Only the by-id family dropped the check.

**Fix:** use the existing helper, as the rest of the codebase does —
```ts
const denied = assertTenantOwned(existing, user);   // regions
if (denied) return denied;
```
and for governorates/districts pass `existing.region` / `existing.governorate.region` to `assertTenantOwned`. Audit lines should attribute to `me.tenantId`, not the target's.

---

## 2. HIGH — Backup "download" is a full cross-tenant database dump

`src/app/api/fgmp/backups/[id]/download/route.ts:41-49` correctly scopes the *record* by tenant, then at `:64` streams the file with no content filtering.

The defect is upstream, in the data model. A backup is **not tenant-scoped data** — `src/lib/fgmp/backup.ts:149` does `fs.promises.copyFile(DB_PATH, filepath)`, a byte-for-byte copy of the **entire** SQLite database. Per `prisma/schema.prisma`, `User` has a `passwordHash` column, so the file contains every tenant's bcrypt hashes, alarms, deliveries, audit logs and API-key hashes.

**Exploit:** tenant *A*'s ADMIN calls `POST /api/fgmp/backups` (`:147`, creates a snapshot tagged with *their own* `tenantId`), then `GET /api/fgmp/backups/<own-id>/download`. Every access check passes — the record legitimately belongs to them — and the response body is the complete multi-tenant database, offline, for hash-cracking.

The legacy family is identical: `src/app/api/fgmp/backup/[filename]/route.ts:139` streams the same whole-DB file, and `src/app/api/fgmp/backup/[filename]` is reachable with the caller's own snapshot.

Aggravating factor: the **restore** endpoints let that same tenant-admin overwrite the live DB. `src/lib/fgmp/backup.ts:234` — `await fs.promises.copyFile(backupFilepath, DB_PATH)` replaces the production database file wholesale.

**Fix:** do not expose whole-DB snapshots to tenant-scoped callers. Either (a) restrict create/download/restore to `SUPERADMIN_ONLY`, or (b) build per-tenant backups by exporting only rows where `tenantId` matches, and never ship `User.passwordHash`.

---

## 3. HIGH — Authenticated identity silently degrades to a hardcoded mock user

`src/lib/fgmp/rbac.ts:217-256`. `getCurrentUser()` attempts the NextAuth session inside a bare `try`, and the `catch` at `:232` **falls through** instead of failing:

```ts
try {
  const session = await getServerSession(authOptions);
  if (session?.user?.id) return { ... };
} catch {
  // Import-time / seed-script contexts where next-auth isn't reachable —
  // fall through to the legacy mock-user path below.
}
if (_current) return _current;
// :246 upserts tenant "t-default", user "u-noc-1" — role NOC_OPERATOR
```

`src/lib/fgmp/index.ts:7-12` — `bootstrap()` returns this as `{ user }`, and **106 call sites** destructure it as the acting identity. **23 of those routes use that identity for tenant scoping**, not merely for a rate-limit key:

`api-keys`, `tanks/[id]`, `batteries/[id]`, `generators/[id]`, `dispensers/[id]`(+`control`,`commands`), `assets/{tanks,generators,iot,dispensers}/[id]`, `edge/gateways/[id]`, `edge/esp/[dispenserId]/reboot`, `edge/firmware/deploy`, `maintenance/[id]`-adjacent routes, `shift-handover`, `suppressions`, `iot/[id]/ota-status`, `users/[id]`, `geography`.

**Exploit:** any transient failure of the dynamic `import("next-auth")` (module-init race, bundler chunk error, edge/runtime difference) makes every one of those routes evaluate `assertTenantOwned(record, t-default)` instead of the caller's tenant. For every tenant *other than* `t-default` the effective scope becomes the **wrong tenant** — a fail-open authorization bug in the security-critical path, triggered by an operational fault rather than an attacker. Worse, `_current` is **process-global module state** (`:215`), so the degraded identity persists for the lifetime of the process and leaks across requests.

**Fix:** make the fallback unreachable from the request path. `getCurrentUser()` should throw when no session is present; seed/CLI contexts should call a separate explicit `getSeedUser()`. Routes should use `auth.user` (which they already have from `requireRole`) rather than `bootstrap()`'s return value.

---

## 4. MEDIUM — Realtime socket allows joining any tenant's site/region room

`mini-services/realtime/index.ts:168-190` correctly authenticates every socket (server secret **or** HMAC-signed browser token) and pins browsers to `tenant:<tid>` at `:202-204`. Signature verification is constant-time (`:110`) and checks the MAC before parsing (`:109-114`) — good.

But the subscription handlers take the client's string verbatim and join an arbitrary room:

```ts
:207  socket.on("subscribe:site", (siteId) => { if (!siteId) return; socket.join(`site:${siteId}`); })
:216  socket.on("subscribe:region", (name) => { if (!name) return; socket.join(`region:${name}`); })
```

There is **no check that the requested site belongs to `socket.data.tenantId`** — unlike the `tenant:` room, which is derived from the signed `tid` and therefore trustworthy (the comment at `:183-184` says exactly that, but the guarantee is not applied to these two handlers).

**Exploit:** an authenticated but low-privilege user (even `READONLY`) connects with their own valid token, then emits `subscribe:site` with a site id belonging to another tenant. The socket joins `site:<victim-site-id>` and receives any event emitted to that room — real-time alarm text, delivery status, telemetry — for a fleet they have no read rights to.

**Mitigating factor (why this is Medium, not Critical):** the one server-side broadcast path does **not** currently target `site:` rooms — `internal:broadcast` resolves `siteId → tenantId` and emits only `io.to(\`tenant:${tenantId}\`)` (`:271`). So today the socket joins a room nothing publishes to. This is a **latent** IDOR: it becomes exploitable the moment any emitter uses the documented `emitToRealtime(event, payload, "site:<id>")` third argument — which `src/lib/fgmp/realtime-emitter.ts:161,164,167,183,186` already does for `alarmNew`/`deliveryUpdate`/`telemetry`. Treat as a must-fix before adding any site-targeted emitter.

**Fix:** validate membership before joining —
```ts
socket.on("subscribe:site", (siteId) => {
  if (typeof siteId !== "string") return;
  const owner = siteTenant.get(siteId);           // already maintained at :297/:386
  if (!owner || owner !== socket.data.tenantId) return next(new Error("forbidden"));
  socket.join(`site:${siteId}`);
});
```

---

## 5. MEDIUM — Rate limiting is in-process only; ineffective under horizontal scale

`src/lib/fgmp/rate-limit.ts:26` — `const buckets = new Map<string, Bucket>()` is module-level process state. Every limit (`AUTH_LIMIT` 5/15min, `MUTATION_LIMIT` 60/min, `READ_LIMIT` 300/min, `IOT_LIMIT` 100/min) is therefore **per replica**.

**Exploit:** with the app behind N replicas (or a rolling deploy), every counter is effectively `limit × N`. Against the login limiter specifically, an attacker gets 5 attempts *per replica per window* and can distribute them across backends to defeat the brute-force protection — which is the limiter's stated purpose. The per-account `lockedUntil` counter in `src/lib/auth.ts:122-135` is DB-backed and does not share this weakness, so credential guessing is capped there, but the `x-api-key` IoT ingest limiter (`ingest/route.ts:120`) is keyed purely in memory and is the cleaner bypass.

Secondary: **`:121-132` `getClientIp()` returns the literal string `"anon"` whenever `TRUSTED_PROXY` is unset** (the default, and `docker-compose.yml` never sets it). All direct clients collapse into one shared bucket — a deliberately safe failure mode per the comment, but it means the per-IP limiter degrades to a *global* one that a single client can exhaust to deny service to everyone.

**Fix:** back the limiter with Redis (`INCR` + `EXPIRE`) so counters are shared; or document `TRUSTED_PROXY=1` as a **required** production setting in `docker-compose.yml`. Do not add `deploy.replicas` without the Redis backing.

---

## 6. MEDIUM — Production-grade secrets present in the working tree

`.env:1-6` contains live values for `NEXTAUTH_SECRET`, `IOT_API_KEY`, `REALTIME_SERVER_SECRET`, `REALTIME_SERVICE_TOKEN`, and `REALTIME_TOKEN_SECRET`.

**Severity is conditional.** `.gitignore:34` covers `.env*`, so these are *not* in version control — the repo's secret hygiene is otherwise excellent (`docker-compose.yml:20-26` uses `${VAR:?}` with no defaults, and `auth.ts:48` deliberately refuses a committed fallback secret). Treat as **Medium in production** (any host compromise, image layer, or backup yields full auth-forgery capability), **Low for local dev**. Rotate before this `.env` reaches any shared machine or CI context.

Also note `.env:1` — `DATABASE_URL=file:/home/z/my-project/db/custom.db` — points outside the project, suggesting a copy-paste from another host; `src/lib/fgmp/backup.ts:38-47` resolves `DB_PATH` from this, so a restore would target that path.

---

## 7. LOW — Non-constant-time secret comparison

- `src/app/api/fgmp/iot/ingest/route.ts:107` — `if (!apiKey || apiKey !== expected)`
- `src/app/api/fgmp/realtime/snapshot/route.ts:71` — `if (!token || token !== expected)`

Plain `!==` on a shared secret leaks its prefix through timing. Contrast with `src/lib/fgmp/realtime-token.ts:129-130` and `mini-services/realtime/index.ts:109-110`, which correctly use `timingSafeEqual` — the standard was simply not applied here.

**Exploit:** theoretical remote timing attack (many samples, noisy network). Practical impact is low, but these guards front telemetry ingest and the cross-tenant snapshot endpoint, so use `crypto.timingSafeEqual` with a length pre-check for consistency.

---

## 8. LOW — Permissive CSP

`next.config.ts:49` — `script-src 'self' 'unsafe-inline' 'unsafe-eval'`. `unsafe-eval` removes the main browser-side mitigation for DOM-XSS-to-RCE escalation; the justification given (dev/HMR) does not hold for a production build.

`next.config.ts:56` — `frame-ancestors 'self' https:` lets **any HTTPS origin** frame the app, a broad clickjacking surface. Note this is *not* rescued by Caddy's `X-Frame-Options: DENY` ([Caddyfile](/home/ubuntu/FGMP1/Caddyfile) line 47): per the CSP3 spec, `frame-ancestors` **takes precedence** over `X-Frame-Options`, so the permissive Next.js header wins and framing stays open. The stated reason is a Z.ai preview iframe — a dev-only concern that should be confined to a dev-only header.

**Fix:** ship `script-src 'self'` without `unsafe-eval` in production, and move the wildcard `frame-ancestors` to the dev branch only.

---

## 9. INFO — Injection sinks: clean

Repo-wide sweep across `src/` for `$queryRawUnsafe`, `$queryRaw`, `$executeRawUnsafe`, `eval(`, and `new Function(` returned **no matches**. No raw SQL anywhere; all DB access goes through Prisma's typed query builder, and all by-id lookups use bound `where` params.

The single `dangerouslySetInnerHTML` is `src/components/ui/chart.tsx:83`, in the vendored shadcn/ui `ChartStyle` component. Its input is the static `ChartConfig` literal plus Recharts' own generated `id` — no user-controlled data reaches it. Not exploitable.

---

## What is genuinely solid

Worth recording, because it bounds the blast radius of the findings above:

- **`assertTenantOwned` returns 404, not 403** (`auth-helpers.ts:303-312`) — correct, avoids cross-tenant existence disclosure. Used consistently across ~30 routes.
- **NextAuth `jwt` callback reads role/tenant from the DB, not the client-supplied `session` argument** (`auth.ts:176-185`) — closes the `POST /api/auth/session {"data":{"role":"SUPERADMIN"}}` self-promotion vector.
- **Fail-closed secret handling** — `auth.ts:48`, `realtime-token.ts:49`, `mini-services/realtime/index.ts:48-56`, `ingest/route.ts:77-85` all throw/503 rather than fall back to a committed default. `docker-compose.yml` uses `${VAR:?}`.
- **API keys are hashed correctly** — `api-keys/route.ts:32-38` generates 128-bit random keys, stores only SHA-256, returns the raw value exactly once (`:245`); `GET` returns `keyPrefix` only and strips `keyHash` (`:113-130`).
- **Passwords** — bcrypt via `bcryptjs`, 5-attempt/15-min lockout (`auth.ts:26-27, 121-135`), uniform `null` return to prevent user enumeration.
- **`EspFirmwareRelease` correctly restricted to `SUPERADMIN_ONLY`** (`edge/firmware/[id]/route.ts:40`) — a table with no `tenantId`, guarded by role instead.
- **Caddy open-proxy removed** — the old `?XTransformPort=<n>` passthrough is replaced by a fixed upstream; realtime port 3003 is no longer published (`docker-compose.yml:46-50`).

---

## Priority order

1. **Critical** — add tenant checks to the three geography by-id routes (`assertTenantOwned`). One-line fixes, highest impact.
2. **High** — stop serving whole-DB backups to tenant admins (#2); remove the mock-user fallback from the request path (#3).
3. **Medium** — authorize `subscribe:site`/`subscribe:region` before the first site-targeted emitter ships (#4); move rate limiting to shared storage if scaling (#5).
4. **Low/Info** — constant-time secret compares (#7); tighten CSP (#8); rotate `.env` (#6).

---
*Generated by static review of the FGMP codebase. Findings #1, #2, and #4 are latent-but-real and were verified against call sites; #3's exploit requires an operational fault to trigger but the fallback is unambiguously wrong for the request path.*