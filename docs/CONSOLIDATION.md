# Repository consolidation — October 2026

What was removed, merged or moved, and the evidence that behaviour did not
change. Nothing here is a feature decision: every item is structure,
duplication, stale documentation or dead scaffolding.

Verification after the changes:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npx eslint .` | 24 errors, 443 warnings — all pre-existing `react-hooks` findings (was 26/444; two files were deleted) |
| `bun test` | 699 pass / 14 fail of 713 — the 14 are the DB-backed suites that need a live PostgreSQL (unchanged from the baseline) |
| Engine, auth, RLS, validation | untouched apart from the two behaviour-preserving fixes listed in §5 |

## 1. Deleted — harness and editor artefacts

| Path | Why |
|---|---|
| `.initial_snapshot.json`, `.v2c/`, `.zscripts/` | Agent-harness state and throwaway dev scripts hardcoding `/home/z/my-project`; not part of the product |
| `examples/websocket/` | Socket.io example for the retired self-hosted realtime service |
| `qa-debug.sh`, `qa-responsive.sh`, `qa-sweep.sh` | One-off QA shell scripts at the repository root |
| `package-lock.json` | `bun.lock` is the lockfile the `Dockerfile` actually uses |
| `.fgmp-settings.json` | Runtime state file committed by accident; settings live in `SystemSetting` |

## 2. Deleted — dead UI scaffolding

19 shadcn/ui components with **zero importers** were removed: aspect-ratio,
avatar, breadcrumb, calendar, carousel, chart, context-menu, drawer, hover-card,
input-otp, menubar, navigation-menu, pagination, radio-group, resizable, sidebar,
slider, toast, toaster. `toggle` and `toggle-group` were kept (used by the
dashboard). `use-toast.ts` and `use-mobile.ts` went with them.

`src/app/layout.tsx` mounted both the Radix toaster and the Sonner toaster; only
Sonner is used by the 30 files that raise toasts, so the Radix one and its layout
import were removed. `tailwind.config.ts` was deleted as well: Tailwind 4 is
CSS-first here (`postcss.config.mjs` uses `@tailwindcss/postcss`, and
`components.json` already declares an empty config path).

## 3. Deleted — duplicate API surface

`src/app/api/fgmp/assets/**` (11 route files) duplicated the create/update
handlers of `tanks`, `batteries`, `generators`, `dispensers` and `iot` under a
second path, and had no caller. The one behaviour that existed only there — IoT
device creation — was moved into `POST /api/fgmp/iot` before the subtree was
deleted, preserving its validation, tenant check, duplicate-serial 409 and audit
event.

All other routes were left in place, including ones with no in-app caller: they
are an API surface, not dead code.

## 4. Merged — duplicated logic

| Duplication | Now |
|---|---|
| `determineStatus` copied in the header indicator and the status banner | `determineSystemStatus` in `src/lib/fgmp/status.ts` |
| Four different status colour maps (map, comparison tool, pinned sites, region sheet) | `SITE_STATUS_HEX`, `siteStatusTextClass`, `siteStatusDotClass` in the same module |
| Arabic-Indic digit conversion in four places | `src/lib/fgmp/numerals.ts` |
| CSV escaping in the export renderer and in `/export` | `src/lib/fgmp/csv.ts` (RFC 4180 + formula-injection guard); the unit suite pins 30 cases |
| `alarmTypeLabel`, `roleLabel`, `commandTypeLabel` copied into 11 components | `src/lib/fgmp/labels.ts` |
| Region score colours duplicated between the leaderboard and the detail sheet | `src/components/fgmp/score-tone.ts` |
| Band lookups hand-written per surface | `bandFor()` in `src/lib/health/site-health-score.ts`; each surface keeps its own thresholds and labels |
| `fmtTime`/`fmtDateTimeLocal` re-implemented in the health view | `format.ts` |

The canonical health scorer (`src/lib/health/site-health-score.ts`) remains the
single implementation of site health; the region scale is deliberately separate
(three tiers over a different metric) and is documented as such at both sites.

## 5. Two correctness fixes made while consolidating

Both remove a stale assumption left over from the SQLite → PostgreSQL migration;
neither changes an API contract.

1. **`/api/fgmp/health` reported `type: "sqlite"` and a 0-byte database.** It
   computed `sizeBytes` with `fs.statSync()` on a SQLite file that no longer
   exists. It now asks PostgreSQL
   (`pg_database_size(current_database())`), reports `type: "postgres"`, and
   labels the database by name only (never the connection string). The response
   shape is unchanged.
2. **`fuelType` validation rejected `BIOFUEL`** in the tank and generator create
   schemas while the Prisma enum and the asset routes accepted it. Both schemas
   now accept `DIESEL | PETROL | BIOFUEL`.

## 6. Moved — documentation

The repository root carried five overlapping, partly obsolete documents plus two
dozen task notes. The current set is:

| Document | Contents |
|---|---|
| `README.md` | what the system is, quick start, layout, commands |
| `docs/ARCHITECTURE.md` | request path, engine/clock, tenancy, protocols, realtime |
| `docs/DEPLOYMENT.md` | compose + Render, migrate/seed split, backups, restore drill |
| `docs/SECURITY.md` | auth, RBAC, RLS, MFA, secrets, known gaps |
| `docs/OPERATIONS.md` | health, metrics, scheduler, broker, symptom table |
| `docs/TESTING.md` | suites, browser walk-through, expected non-bugs |
| `docs/MFA.md` | MFA design and recovery model |

Everything historical moved to `docs/history/` with an explicit "archived, not
current" banner: the code review, the Arabic presentation-compliance report, the
security audit, the phase 1–5 tenant-isolation records, the deployment runbooks
and the implementation notes. `PRODUCTION.md` said the platform used SQLite;
`RENDER.md` described a migration path that no longer applies. Both are preserved
there rather than kept at the root, where they read as current.

## 7. Moved — scripts

```
scripts/
  db/          seed, seed-admin, seed-dispensers, seed-edge, fix-demo-users,
               pg-init-roles.{sh,sql}, docker-init-db.js
  verify/      RLS/scheduler/tenant/correlation/MFA proofs, smoke tests,
               e2e harness + route sweep
  dev/         dev-server.sh, certificate and broker-password generators,
               bun-test shims
  docs-tools/  one-off document generators
  docker-entrypoint.mjs, db-preflight.mjs, collect-prisma-cli-deps.ts   (runtime)
```

`package.json` scripts and CI reference the new paths; the Dockerfile copies the
runtime files explicitly and `scripts/` wholesale, unchanged.

## 8. Known leftovers (deliberately not done here)

* **Unused dependencies.** Twenty-one packages have no importer (`@dnd-kit/*`,
  `@mdxeditor/editor`, `@tanstack/*`, `framer-motion`, `next-intl`, `sharp`,
  `uuid`, `z-ai-web-dev-sdk`, …). They were **not** removed: `bun.lock` is used
  with `--frozen-lockfile` in the Docker build, and this sandbox cannot reach the
  package CDN to regenerate it. Removing them is a one-line `bun remove` in an
  environment with registry access, followed by a lockfile commit.
* **`i18n.ts`** carries ~1,550 keys for 27 views; a sample suggests roughly a
  quarter are unused. Pruning needs per-key verification and is a separate task.
* **`energy-thresholds.ts`, `notification-dispatch.ts`, `alerting/metrics-wiring.ts`**
  have no importer, but they encode domain rules (solar/battery thresholds,
  the only writer that records `NO_TRANSPORT` instead of a false `SENT`, metric
  derivations). They are retained rather than deleted — wiring them is a product
  decision, not a cleanup.
* `alerting.ts` and `notification-dispatch.ts` describe a delivery-status model
  that `POST /api/fgmp/notifications` does not use yet (it writes `SENT`
  directly). Worth aligning when notifications are next touched.
