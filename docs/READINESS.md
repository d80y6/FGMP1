# Production-readiness record

What was broken, what was changed, how it was verified, and what remains
external. This is a record of an audit and a remediation pass, not a marketing
claim: every item below was executed in this checkout, and the items under
§7 are genuinely not done.

## 1. The build did not work

| Defect | Why it mattered | Fix |
|---|---|---|
| `next/font/google` downloaded Geist, Geist Mono and Cairo from `fonts.googleapis.com` during `next build` | The production build failed offline, in an air-gapped runner, or whenever Google was slow — and the error looked like a code failure (`Turbopack build failed`) | Fonts vendored under `src/app/fonts/` (woff2, ~270 KB) and declared in `src/app/fonts.css`. Cairo ships per-subset files, so `unicode-range` keeps Arabic and Latin glyphs in their own faces |
| `config/alerts.json` is read with `fs` at request time; standalone output traces modules, not data files | `/api/fgmp/ops/alerts/preview` would throw **in the container** while working in dev | `outputFileTracingIncludes` in `next.config.ts` **and** an explicit `COPY config` in the Dockerfile (they cover different build paths) |
| The tracer pulled the whole repository into the standalone output because of that `readFileSync` | Oversized image and a build warning pointing at a real problem | `turbopackIgnore` on the call, with the file shipped explicitly |

**Verified:** `next build` completes; `.next/standalone/config/alerts.json`
exists; fonts are emitted into `.next/static/media/*.woff2`.

## 2. The process did not fail closed

There was no environment validation at all. A missing `NEXTAUTH_SECRET` surfaced
as `JWEDecryptionFailed` at login; a missing `IOT_API_KEY` rejected every device
telemetry silently; a `DATABASE_URL` pointing at the owner role disabled every
RLS policy while the UI stayed green.

`src/lib/env.ts` now validates at boot (`instrumentation.ts`):

* **errors** stop the process — missing/invalid `DATABASE_URL`, missing or short
  `NEXTAUTH_SECRET`, short `IOT_API_KEY`/`FGMP_MFA_ENCRYPTION_KEY`,
  `FGMP_REQUIRE_RLS=0` in production, partially configured Apinator credentials;
* **warnings** are printed and the server starts — no realtime credentials, no
  MFA key, no service token. Each degrades one feature; none is unsafe;
* **no value is ever printed**, only names and verdicts.

The first implementation threw from `register()`. That is **not** fail-closed:
Next logs "Failed to prepare server", marks the hook failed and keeps the port
open, so an orchestrator sees a healthy socket on a process that will 500 every
request. The hook now calls `process.exit(1)`.

**Verified:** booting the standalone server without a secret exits 1 with a
readable list; booting with a valid environment logs 4 warnings and serves.

## 3. Nothing could health-check it

`/api/fgmp/health` is ADMIN-only (process memory, table counts, error ring
buffer) — correctly so. But the compose healthcheck probed it and treated *any*
response as success, the Render blueprint had `healthCheckPath` commented out,
and the CI boot test used `wget ... || true`, which cannot fail.

Two unauthenticated probes now exist:

| Route | Answers | Status |
|---|---|---|
| `/api/health/live` | is the process serving HTTP (no database) | always 200 while alive |
| `/api/health/ready` | can it reach PostgreSQL **and** has the schema been migrated | 200 / 503 with a coarse reason |

The readiness body carries only `{status, reason}`. It is wired into the
Dockerfile `HEALTHCHECK`, the compose healthcheck, `render.yaml`
(`healthCheckPath`) and the CI container boot test, which now asserts
`"status":"ready"`.

**Verified:** against a real standalone server — `live` 200,
`ready` 503 `db_unreachable` with no database, `fgmp/health` 401 unauthenticated.

## 4. The web surface had no failure UI

There was no `error.tsx`, `global-error.tsx`, `not-found.tsx` or `loading.tsx`,
so a render failure showed Next's bare "Application error" page with no retry and
no correlation id. All four are added; the route error logs the digest, which is
the only identifier that ties a browser render to a server stack trace.

## 5. Security hardening

* **CSP is now environment-aware.** Production no longer allows
  `script-src 'unsafe-eval'`, and `connect-src` is limited to the app origin plus
  `*.apinator.io` instead of `ws:`/`wss:` wildcards. Dev keeps the permissive
  policy HMR needs. `object-src 'none'`, `base-uri 'self'` and
  `form-action 'self'` added.
* `X-Powered-By` disabled.
* CI's container assertions were checking for **24** FORCE-RLS tables when the
  migrations create **36**, so that check failed (or would have passed only by
  accident had it been `-ge`). It now asserts `>= 36`.
* `render.yaml` no longer gives the web service the schema-owner URL; migrations
  run in a `fgmp-migrate` job, and `FGMP_REQUIRE_RLS` is `1` instead of `0`.

## 6. Quality gates

| Gate | Before | After |
|---|---|---|
| `next build` | **fails** (Google Fonts) | passes, standalone output verified |
| `npx tsc --noEmit` | 0 errors | 0 errors |
| `npx eslint .` | 24 errors / 443 warnings | **0 errors** / 423 warnings |
| `bun test` | 699 pass / 14 fail | **714 pass / 0 fail** (13 skipped without a database) |
| Dependency count | 78 production | **47** production, lockfile regenerated |

The 14 failures were not flaky: they were database-backed suites (RLS row
hiding, MFA challenge resolution, command persistence) failing on a machine with
no PostgreSQL. They now skip with a loud banner when `DATABASE_URL` is absent,
and `FGMP_REQUIRE_DB_TESTS=1` turns that skip into an error — CI sets it in the
job that provisions PostgreSQL, and `bun test` now actually runs there. A
1000-package supply chain (416 transitive packages from unused UI libraries:
`@mdxeditor`, CodeMirror, `@tanstack/*`, `framer-motion`, `next-intl`, `sharp`,
`uuid`, `z-ai-web-dev-sdk`, …) was removed from `package.json` and `bun.lock`;
`bun install --frozen-lockfile --dry-run` accepts the result and a static scan
confirms every bare import resolves to a declared dependency.

One real test bug was fixed: a metrics assertion assumed a fresh registry, so it
failed whenever another suite had already incremented the `login/degraded_closed`
series. It now uses a label pair unique to that test.

## 7. Still external — not fixable in this repository

| Item | Why it is not done |
|---|---|
| **A live PostgreSQL run** | No PostgreSQL binary and no Docker daemon in this environment, and `prisma generate` cannot download a query engine (binaries.prisma.sh is unreachable), so the local client can only speak to Prisma Accelerate. Compose/CI paths are syntax-checked and the code paths are type-checked, but `migrate → seed → RLS suite` has not been executed here. CI runs it — and the Dockerfile now **fails the build** if `prisma generate` produced no engine, because that image would build cleanly and then fail on the first query. |
| **Docker image build/boot** | No Docker daemon. The Dockerfile changes (config copy, healthcheck) are reviewed, not executed. CI's `docker` job builds and boots the image. |
| **Real device transports** | No Modbus/MQTT hardware is configured; `NO_TRANSPORT` is the honest answer. Wiring serial/TCP gateways is a deployment decision, not a code fix. |
| **`SensorReading` retention** | TimescaleDB retention/compression policy is a capacity decision (how long telemetry is kept) and must be agreed, not guessed. |
| **Object storage for exports/backups** | Backups currently land in a volume. Off-host storage needs a bucket and credentials. |
| **Alert delivery** | `notification-dispatch.ts` encodes the correct status model but is not wired into `POST /api/fgmp/notifications`, which writes `SENT` directly. Wiring it changes operator-visible notification semantics, so it is a product decision. |
| **MFA encryption key** | Must be generated per deployment (`openssl rand -base64 48`) and kept stable; the app warns, it cannot invent one. |
| **Redis** | Optional. A `fgmp-redis` service is in compose; without it the limiter degrades to per-process counters and reports `fgmp_rate_limit_degraded=1`. |

## 8. How to reproduce the verification

```bash
bun install --frozen-lockfile
bun run check:env          # expect errors in a bare checkout — that is the point
npx tsc --noEmit           # 0 errors
npx eslint .               # 0 errors
bun test                   # 714 pass, 13 skip, 0 fail without a database
bun run build              # standalone output
```

With PostgreSQL (compose or CI):

```bash
bun run db:deploy && bun run db:seed
FGMP_REQUIRE_DB_TESTS=1 bun test
bun run test:rls
bun run test:smoke
```
