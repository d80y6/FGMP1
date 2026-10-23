# Operations

Day-two behaviour: what the platform reports about itself, how the clock
advances, how the broker is wired, and what to check first when something looks
wrong.

## 1. Probes and the health endpoint

Three different questions, three different routes — conflating them is what made
the first compose healthcheck meaningless:

| Route | Auth | Question | Use |
|---|---|---|---|
| `/api/health/live` | none | is the process serving HTTP? | container `HEALTHCHECK`, restart decisions |
| `/api/health/ready` | none | can it reach PostgreSQL *and* is the schema migrated? | load-balancer / orchestrator readiness, Render `healthCheckPath` |
| `/api/fgmp/health` | ADMIN | process memory, DB size, table counts, error ring buffer, verdict | operator dashboard |

`live` deliberately does not touch the database: a liveness probe that fails
when the database is slow restarts a healthy process and makes an outage worse.
`ready` returns 503 with a coarse reason (`db_unreachable`, `schema_missing`,
`timeout`) and never discloses the driver, host or exception.

Boot-time validation is the fourth gate: the server refuses to start when the
environment is invalid (see §9).

## 2. Health endpoint

`GET /api/fgmp/health` — **ADMIN only**, cached 10 s per scope.

```
{
  "uptime": "2d 14h 32m",
  "memory": { "rss": …, "heapUsed": … },
  "database": { "type": "postgres", "sizeBytes": …, "sizeMB": …,
                "tableCounts": { "sites": …, "alarms": … },
                "scopedToTenant": true },
  "realtime": { "connected": true, "clients": 3 },
  "api": { "avgResponseMs": … },
  "errors": [ { "timestamp": …, "method": …, "path": …, "status": … } ],
  "verdict": "HEALTHY",
  "scopeMode": "tenant"
}
```

* `verdict` is **three-state in effect**: an empty scope reports
  `HEALTHY_BUT_EMPTY`, not `HEALTHY`. The endpoint was rebuilt after it reported
  a 52-site platform as healthy with `sites: 0` — because an unscoped count under
  FORCE RLS returns zero and nothing distinguished "no rows" from "hidden rows".
* `scopeMode` is `tenant` for normal roles and `platform` for SUPER_ADMIN.
  Platform-wide counts require `FGMP_OPS_DATABASE_URL`; without it the endpoint
  refuses rather than reporting zeros.
* `database.sizeBytes` comes from `pg_database_size(current_database())`. It
  includes indexes and TOAST data.
* `errors[]` is a ring buffer of recent failures with the exception message
  **redacted** — the raw text leaked Prisma errors, table names and paths to any
  tenant admin.
* The realtime probe calls the Apinator channels API with an 800 ms budget and
  degrades to `connected: false` instead of hanging the dashboard.

Because the route is ADMIN-only, do **not** use it as an unauthenticated
platform health check. Use a TCP check on the app port.

## 3. Metrics

`GET /api/fgmp/metrics` — Prometheus text exposition, gated on `ALARM_OPS`
(metrics reveal operational shape even though labels are low-cardinality).
`Cache-Control: no-store`: a stale metrics page during an incident is worse than
none.

Useful series:

| Metric | Meaning |
|---|---|
| `fgmp_tick_duration_seconds` | engine advance duration |
| `fgmp_theft_detections_total` | unexplained-loss detections |
| `fgmp_alarms_total{severity}` | alarms raised |
| `fgmp_rate_limit_degraded` | Redis unavailable, limiter policy in effect |
| `fgmp_audit_write_failures_total` | audit writes that failed |

## 4. The scheduler (telemetry clock)

`instrumentation.ts` starts `scheduler.ts` once per process:

* interval: **5 s**, self-scheduling `setTimeout` (an overrunning tick cannot
  queue a second one behind it);
* single-flight: `pg_try_advisory_xact_lock`, held by the database — so N
  replicas advance exactly once per interval, and a crashed holder releases the
  lock automatically;
* **opt-in**: it starts only when simulation is permitted
  (`FGMP_SIMULATION`, never in production). If it is not permitted, the platform
  does not fabricate telemetry and the scheduler says so once at boot;
* the tick uses `FGMP_OPS_DATABASE_URL` (falling back to
  `FGMP_MIGRATE_DATABASE_URL`) because it spans tenants. It performs no
  per-tenant authorisation and reads no request input.

If state is not advancing: check that simulation is enabled, that the ops URL is
set in that process, and that the advisory lock is not held by a wedged backend
(`SELECT * FROM pg_locks WHERE locktype = 'advisory'`).

## 5. MQTT broker

`docker/mosquitto/config/` holds `mosquitto.conf`, `acl` and `passwd`. Compose
**copies** them into a volume rather than bind-mounting, because a bind mount
carries the host uid/gid and Mosquitto 2 then logs six permission warnings and
keeps running **with the ACL not enforced** — every tenant can subscribe to
every other tenant's subtree while health checks look fine.

Ports: `127.0.0.1:1885` on the host (1883/1884 are commonly taken; a hard
failure to start beats silently connecting to a stranger's broker).

Topic model (per-tenant ACLs): `fgmp/<tenantId>/site/<siteId>/…#`. The bridge
subscribes with a per-tenant credential; a cross-tenant subscribe must be denied
by the broker, and the live test asserts exactly that.

MQTT TLS: `scripts/dev/generate-mtls-certs.sh` produces a local CA, server and
client certificates for testing; `Caddyfile` terminates mTLS for device traffic
on `127.0.0.1:8443`.

## 6. IoT ingest

`POST /api/fgmp/iot/ingest` — device auth via `x-api-key`, not a session.

| Symptom | Cause |
|---|---|
| `503 ingest not configured` | `IOT_API_KEY` missing or shorter than 16 chars |
| `401 unauthorized` | key mismatch (rotate app + bridge together) |
| `429` | rate limit; ingest fails **open** when Redis is down, so this is a real limit |
| `400` with a field name | schema validation; unknown enum values are rejected |

The route upserts tank/generator/battery readings and pushes the change into
Apinator itself. The bridge holds no socket.

## 7. Logging

`src/lib/observability/log.ts` writes structured JSON and redacts sensitive keys
(`authorization`, `cookie`, `x-api-key`, passwords, tokens) before output. Route
errors are recorded to the in-process ring buffer that feeds `health.errors[]`.

Log lines carry a request id; correlate a browser failure with the server line by
timestamp + method + path + status.

## 8. First checks by symptom

| Symptom | Check |
|---|---|
| App container exits immediately | `docker compose logs fgmp-app`. The entrypoint prints which check failed; if the environment itself is invalid, the env validator lists every `[error]` by name (never by value). Usually: migrations not applied, `FGMP_REQUIRE_RLS=1` with a bypassing `DATABASE_URL`, or a missing/short secret. |
| Orchestrator marks the app down but it serves traffic | Something is probing `/api/fgmp/health`, which is ADMIN-only and returns 401. Point it at `/api/health/ready`. |
| Login fails for everyone | `NEXTAUTH_URL` / `NEXTAUTH_SECRET` changed? Sessions are invalidated by a secret change. |
| Dashboard looks empty | Is simulation enabled, and has the scheduler ticked? An empty platform is the honest state without devices. |
| Realtime indicator offline | Channel auth failed; the 5 s poll still updates data. Check `APINATOR_*` and `NEXT_PUBLIC_APINATOR_*` (the latter is baked at build time). |
| Alarms not firing | Check suppression rules, the alert rule file (`config/alerts.json`), and `fgmp_rate_limit_degraded` / Redis. |
| Commands stay `PENDING` | Expected: no dispatch transport is configured, so the command resolves to `NO_TRANSPORT`/`TIMEOUT`. `command-reconciliation.ts` clears abandoned rows. |
| Backup job "succeeds" but is tiny | It ran as `fgmp_app`: RLS-scoped dumps are silently incomplete. Use `fgmp_ops`. |

## 9. Rate limiting and Redis

Login and MFA fail **closed** when the shared limiter store is unavailable;
device ingest fails **open**. With no `REDIS_URL` every limit is per-process, so
N replicas multiply each budget by N, and the app reports
`fgmp_rate_limit_degraded=1`. Compose provides `fgmp-redis`; a deployment
without it is functional but weaker.

## 10. Routine maintenance

* **Daily** — verify the backup job ran and the dump is non-trivial in size.
* **Monthly** — run the restore drill (`fgmp-backup-restore`), review
  `health.errors[]`, and rotate any credential that appeared in a log.
* **Per deploy** — run `fgmp-migrate`, then roll the app. Never run two app
  versions against different schemas.
