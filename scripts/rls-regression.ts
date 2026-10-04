/**
 * RLS regression suite — Phase 1, step 11.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PROVES
 * ─────────────────────────────────────────────────────────────────────────────
 * `assertTenantOwned()` is the application's FIRST line of defence: a correct
 * guard, checked in application code, on every request. RLS is the BACKSTOP
 * UNDERNEATH it. The whole point of the backstop is that it holds when the
 * application guard is missing — a forgotten `where` clause, a new endpoint
 * written by someone who did not read the tenancy guide, a raw SQL migration,
 * a future service that reimplements the query badly.
 *
 * So every assertion below deliberately issues a WRONG query: one with no
 * `WHERE` clause on tenant at all, targeting another tenant's rows by id. If
 * RLS is doing its job, the database itself refuses or returns nothing.
 *
 * The suite therefore proves four properties per table:
 *
 *   1. SCOPED   — the app's correct query still works (RLS is not so strict
 *                 that it breaks normal operation).
 *   2. UNSCOPED — `SELECT * FROM t` with tenant A's context returns ONLY
 *                 tenant A's rows. No WHERE clause, and the database still
 *                 refuses to hand over tenant B's data.
 *   3. MUTATION — UPDATE/DELETE/INSERT aimed at tenant B's row from tenant A's
 *                 context affect zero rows / raise a WITH CHECK violation.
 *   4. UNSET    — with no tenant context at all, reads return ZERO rows.
 *                 This is the property that makes an unset context safe: the
 *                 `NULL = x → NULL → not TRUE` predicate drops every row
 *                 instead of defaulting to "no filter".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXIT CODE
 * ─────────────────────────────────────────────────────────────────────────────
 * Exits 0 only when every assertion passes. Any failure — including "policies
 * are not installed yet" — exits non-zero, so CI cannot pass on a database
 * where the backstop is absent. A silently-passing suite would be worse than
 * no suite: it would certify an unprotected database as protected.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPENDENCY ON p1-schema
 * ─────────────────────────────────────────────────────────────────────────────
 * This suite does NOT create tables, columns or policies — that is
 * prisma/schema.prisma + prisma/migrations/**, owned by `p1-schema`.
 * When the policies are absent, assertions 2, 3 and 4 fail LOUDLY and the
 * report says so explicitly, rather than reporting a false pass.
 */

import { db, rlsEnforced } from '@/lib/db'
import {
  TENANT_SETTING,
  withTenant,
  currentTenantId,
  normalizeTenantId,
  assertTenantId,
  TenantContextError,
  isUuid,
} from '@/lib/fgmp/tenant-context'

// ── Result plumbing ─────────────────────────────────────────────────────────

type Status = 'PASS' | 'FAIL' | 'BLOCKED'
interface Assertion {
  table: string
  name: string
  status: Status
  detail: string
}

const assertions: Assertion[] = []
let currentTable = ''

function record(name: string, status: Status, detail: string): void {
  assertions.push({ table: currentTable, name, status, detail })
  const icon = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'BLKD'
  const color =
    status === 'PASS' ? '\x1b[32m' : status === 'FAIL' ? '\x1b[31m' : '\x1b[33m'
  console.log(`  ${color}${icon}\x1b[0m ${name}\n       ${detail}`)
}

function pass(name: string, detail = ''): void {
  record(name, 'PASS', detail || 'ok')
}
function fail(name: string, detail: string): void {
  record(name, 'FAIL', detail)
}
function blocked(name: string, detail: string): void {
  record(name, 'BLOCKED', detail)
}

// ── Fixture definitions ─────────────────────────────────────────────────────
//
// The 14 tables that receive a `tenant_id` column, per
// docs/phase1-tenant-isolation.md §"Tier A"/"Tier B".
//
// Fixtures are inserted as the OWNER role (fgmp_migrate) because a
// non-owner role cannot INSERT tenant B's rows while tenant A's context is
// active — that is the very thing being tested. Owner writes are also
// unaffected by RLS, which is what lets us build a known two-tenant world.

interface TableSpec {
  /** Physical table name. */
  table: string
  /** Human label for the report. */
  label: string
  /** Column holding the tenant id. */
  tenantColumn: string
  /** Columns to INSERT, relative to ${tenant}, ${site}, ${suffix}. */
  columns: Record<string, string>
  /** True when the row belongs to a Site (tier B). */
  siteScoped: boolean
}

const SITE_COLS = `
  id, code, name, status, "criticality", "loadKw", "powerSource",
  "tenantId", lat, lng
`

/**
 * Per-table INSERT column lists and literal values.
 *
 * Values are written as SQL literals with ${} placeholders substituted by
 * `buildInsert`. Ids are suffixed so every fixture row is uniquely
 * identifiable, which is what lets the suite prove "zero rows of B were
 * returned" rather than merely "fewer rows than expected".
 */
const TABLES: TableSpec[] = [
  {
    table: 'NotificationPreference',
    label: 'NotificationPreference (tier A, via User)',
    tenantColumn: 'tenant_id',
    siteScoped: false,
    columns: {
      id: `'np-${SUFFIX}'`,
      severity: `'INFO'`,
      "inAppSeverities": `'INFO,WARN'`,
      email: `'true'`,
      sms: `'false'`,
      push: `'false'`,
      whatsapp: `'false'`,
      "userId": `'${SITE_USER_ID}'`,
    },
  },
  {
    table: 'EspFirmwareDeployment',
    label: 'EspFirmwareDeployment (tier A, via FuelDispenser)',
    tenantColumn: 'tenant_id',
    siteScoped: false,
    columns: {
      id: `'efd-${SUFFIX}'`,
      status: `'QUEUED'`,
      progress: '0',
      "espFirmwareReleaseId": `'${RELEASE_ID}'`,
      "dispenserId": `'${DISPENSER_ID}'`,
    },
  },
  {
    table: 'FuelTank',
    label: 'FuelTank (tier B, via Site)',
    tenantColumn: 'tenant_id',
    siteScoped: true,
    columns: {
      id: `'tank-${SUFFIX}'`,
      "siteId": `'${SITE_ID}'`,
      label: `'tank-${SUFFIX}'`,
      "fuelType": `'DIESEL'`,
      "capacityLitres": '1000',
      "currentLitres": '500',
      calibration: `'{}'`,
      "lowThreshold": '200',
      "criticalThreshold": '100',
      status: `'NORMAL'`,
    },
  },
  {
    table: 'Generator',
    label: 'Generator (tier B, via Site)',
    tenantColumn: 'tenant_id',
    siteScoped: true,
    columns: {
      id: `'gen-${SUFFIX}'`,
      "siteId": `'${SITE_ID}'`,
      label: `'gen-${SUFFIX}'`,
      manufacturer: `'Cummins'`,
      model: `'C500'`,
      "ratedPowerKw": '500',
      "fuelType": `'DIESEL'`,
      status: `'STOPPED'`,
      mode: `'AUTO'`,
      "runtimeHours": '0',
      "oilChangeIntervalHrs": '250',
      "lastOilChangeHrs": '0',
      "nextMaintenanceHrs": '250',
      "temperatureC": '25',
      "oilPressureKpa": '300',
      "loadKw": '0',
      "fuelRateLph": '0',
      "batteryVoltage": '24',
    },
  },
  {
    table: 'BatteryBank',
    label: 'BatteryBank (tier B, via Site)',
    tenantColumn: 'tenant_id',
    siteScoped: true,
    columns: {
      id: `'batt-${SUFFIX}'`,
      "siteId": `'${SITE_ID}'`,
      label: `'batt-${SUFFIX}'`,
      chemistry: `'LEAD_ACID'`,
      "capacityAh": '200',
      "nominalVoltage": '24',
      voltage: '25',
      "currentA": '0',
      "stateOfCharge": '100',
      "stateOfHealth": '100',
      "temperatureC": '25',
      charging: 'false',
      status: `'OK'`,
    },
  },
  {
    table: 'IotDevice',
    label: 'IotDevice (tier B, via Site)',
    tenantColumn: 'tenant_id',
    siteScoped: true,
    columns: {
      id: `'iot-${SUFFIX}'`,
      "siteId": `'${SITE_ID}'`,
      label: `'iot-${SUFFIX}'`,
      "serialNo": `'SN-${SUFFIX}'`,
      type: `'FUEL_SENSOR'`,
      protocol: `'MODBUS_RTU'`,
      status: `'ONLINE'`,
      firmware: `'1.0.0'`,
    },
  },
  {
    table: 'FuelDispenser',
    label: 'FuelDispenser (tier B, via Site)',
    tenantColumn: 'tenant_id',
    siteScoped: true,
    columns: {
      id: `'disp-${SUFFIX}'`,
      "siteId": `'${SITE_ID}'`,
      label: `'disp-${SUFFIX}'`,
      "pumpNumber": '1',
      "nozzleCount": '2',
      status: `'IDLE'`,
      mode: `'AUTO'`,
    },
  },
  {
    table: 'FuelTransaction',
    label: 'FuelTransaction (tier B, via Dispenser)',
    tenantColumn: 'tenant_id',
    siteScoped: true,
    columns: {
      id: `'txn-${SUFFIX}'`,
      "siteId": `'${SITE_ID}'`,
      "dispenserId": `'${DISPENSER_ID}'`,
      "volumeLitres": '10',
      "amountYer": '5200',
      "unitPriceYer": '520',
      status: `'COMPLETED'`,
    },
  },
  {
    table: 'SensorReading',
    label: 'SensorReading (tier B, via Site)',
    tenantColumn: 'tenant_id',
    siteScoped: true,
    columns: {
      id: `'read-${SUFFIX}'`,
      "siteId": `'${SITE_ID}'`,
      "entityKind": `'TANK'`,
      "entityId": `'tank-${SUFFIX}'`,
      metric: `'level'`,
      value: '500',
      unit: `'L'`,
      ts: 'now()',
    },
  },
  {
    table: 'SiteEvent',
    label: 'SiteEvent (tier B, via Site)',
    tenantColumn: 'tenant_id',
    siteScoped: true,
    columns: {
      id: `'evt-${SUFFIX}'`,
      "siteId": `'${SITE_ID}'`,
      kind: `'INFO'`,
      message: `'fixture ${SUFFIX}'`,
    },
  },
  {
    table: 'FuelDelivery',
    label: 'FuelDelivery (tier B, via Site)',
    tenantColumn: 'tenant_id',
    siteScoped: true,
    columns: {
      id: `'del-${SUFFIX}'`,
      "siteId": `'${SITE_ID}'`,
      status: `'DELIVERED'`,
      "volumeOrderedLitres": '500',
      "volumeDeliveredLitres": '500',
      "scheduledAt": 'now()',
      "deliveredAt": 'now()',
    },
  },
  {
    table: 'ControlCommand',
    label: 'ControlCommand (tier B, via Site)',
    tenantColumn: 'tenant_id',
    siteScoped: true,
    columns: {
      id: `'cmd-${SUFFIX}'`,
      "siteId": `'${SITE_ID}'`,
      "generatorId": `'${GENERATOR_ID}'`,
      command: `'START'`,
      status: `'SENT'`,
    },
  },
  {
    table: 'MaintenanceTicket',
    label: 'MaintenanceTicket (tier B, via Site)',
    tenantColumn: 'tenant_id',
    siteScoped: true,
    columns: {
      id: `'mnt-${SUFFIX}'`,
      "siteId": `'${SITE_ID}'`,
      "assetKind": `'GENERATOR'`,
      "assetId": `'${GENERATOR_ID}'`,
      type: `'PREVENTIVE'`,
      status: `'OPEN'`,
      priority: `'MEDIUM'`,
    },
  },
  {
    table: 'SiteGateway',
    label: 'SiteGateway (tier B, via Site)',
    tenantColumn: 'tenant_id',
    siteScoped: true,
    columns: {
      id: `'gw-${SUFFIX}'`,
      "siteId": `'${SITE_ID}'`,
      "serialNo": `'GW-${SUFFIX}'`,
      status: `'ONLINE'`,
      firmware: `'1.0.0'`,
    },
  },
]

// Fixture identifiers. The suffix keeps every run's rows unique so repeated
// runs cannot collide on a unique constraint, and so "did I see tenant B's
// row?" is answerable by exact id rather than by counting.
const RUN = process.env.RLS_RUN_ID ?? String(process.pid)
const SUFFIX = RUN
const TENANT_A = `rls-a-${RUN}`
const TENANT_B = `rls-b-${RUN}`
const SITE_ID = `rls-site-${RUN}`
const SITE_CODE = `RLS-${RUN}`
const SITE_USER_ID = `rls-user-${RUN}`
const RELEASE_ID = `rls-rel-${RUN}`
const DISPENSER_ID = `rls-disp-${RUN}`
const GENERATOR_ID = `rls-gen-${RUN}`

// ── Helpers ─────────────────────────────────────────────────────────────────

function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return db.$queryRawUnsafe<T[]>(sql, ...params) as Promise<T[]>
}

function e(sql: string, params: unknown[] = []): Promise<number> {
  return db.$executeRawUnsafe(sql, ...params) as Promise<number>
}

/** Replace ${...} placeholders with fixture values. */
function subst(sql: string): string {
  return sql
    .replaceAll('${SUFFIX}', SUFFIX)
    .replaceAll('${SITE_ID}', SITE_ID)
    .replaceAll('${SITE_USER_ID}', SITE_USER_ID)
    .replaceAll('${RELEASE_ID}', RELEASE_ID)
    .replaceAll('${DISPENSER_ID}', DISPENSER_ID)
    .replaceAll('${GENERATOR_ID}', GENERATOR_ID)
}

/** Build an INSERT for a table spec, targeting one tenant. */
function buildInsert(spec: TableSpec, tenant: string): string {
  const cols = Object.entries(spec.columns).map(([k, v]) => `"${k}"`).join(', ')
  const vals = Object.values(spec.columns).map((v) => subst(v)).join(', ')
  return `INSERT INTO "${spec.table}" (${cols}, "${spec.tenantColumn}") VALUES (${vals}, '${tenant}')`
}

/** True when the error is the RLS WITH CHECK / USING rejection. */
function isRlsViolation(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /row-level security|violates row-level security policy/i.test(m)
}

/** True when the table/policy simply is not installed yet. */
function isMissingObject(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return (
    /column .* does not exist|relation .* does not exist/i.test(m) ||
    /invalid input syntax for type uuid/i.test(m)
  )
}

// ── Fixture setup / teardown (owner role — bypasses RLS by design) ──────────

async function seedFixtures(): Promise<void> {
  // Tenants
  await e(`INSERT INTO "Tenant" (id, name, code, country) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, `RLS A ${RUN}`, `RLS-A-${RUN}`, 'Yemen'])
  await e(`INSERT INTO "Tenant" (id, name, code, country) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
    [TENANT_B, `RLS B ${RUN}`, `RLS-B-${RUN}`, 'Yemen'])

  // User (needed by NotificationPreference)
  await e(
    `INSERT INTO "User" (id, name, email, role, "tenantId", active) VALUES ($1,$2,$3,$4,$5,true)`,
    [SITE_USER_ID, `RLS User ${RUN}`, `rls-user-${RUN}@example.invalid`, 'ADMIN', TENANT_A],
  )

  // Two sites, one per tenant
  for (const [sid, tenant] of [[`${SITE_ID}`, TENANT_A], [`${SITE_ID}-b`, TENANT_B]] as const) {
    await e(
      `INSERT INTO "Site" (id, code, name, status, "criticality", "loadKw", "powerSource", "tenantId", lat, lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [sid, `${SITE_CODE}-${sid.endsWith('-b') ? 'B' : 'A'}`, `RLS Site ${sid}`, 'ACTIVE', 'HIGH', 0, 'GRID', tenant, 15.0, 44.0],
    )
  }

  // Firmware release (needed by EspFirmwareDeployment)
  await e(
    `INSERT INTO "EspFirmwareRelease" (id, version, channel, filename, checksum, "sizeKb", status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [RELEASE_ID, `rls-${RUN}`, 'STABLE', `rls-${RUN}.bin`, 'deadbeef', 1, 'RELEASED'],
  )

  // Per-tenant rows. Tier-B tables hang off the matching site; the dispenser /
  // generator / firmware-deployment ids referenced by child tables are created
  // once for tenant A and mirrored for tenant B.
  for (const [suffix, tenant, siteId] of [[SUFFIX, TENANT_A, SITE_ID], [`${SUFFIX}-b`, TENANT_B, `${SITE_ID}-b`]] as const) {
    // Site-scoped rows the child tables reference.
    await e(`INSERT INTO "Generator" (id,"siteId",label,manufacturer,model,"ratedPowerKw","fuelType",status,mode,"runtimeHours","oilChangeIntervalHrs","lastOilChangeHrs","nextMaintenanceHrs","temperatureC","oilPressureKpa","loadKw","fuelRateLph","batteryVoltage")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [`${GENERATOR_ID}-${suffix}`, siteId, `gen-${suffix}`, 'Cummins', 'C500', 500, 'DIESEL', 'STOPPED', 'AUTO', 0, 250, 0, 250, 25, 300, 0, 0, 24])
    await e(`INSERT INTO "FuelDispenser" (id,"siteId",label,"pumpNumber","nozzleCount",status,mode)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [`${DISPENSER_ID}-${suffix}`, siteId, `disp-${suffix}`, suffix.endsWith('-b') ? 1 : 1, 2, 'IDLE', 'AUTO'])
    await e(`INSERT INTO "EspFirmwareDeployment" (id,"espFirmwareReleaseId","dispenserId",status,progress,"tenant_id")
             VALUES ($1,$2,$3,$4,$5,$6)`,
      [`efd-${suffix}`, RELEASE_ID, `${DISPENSER_ID}-${suffix}`, 'QUEUED', 0, tenant])

    for (const spec of TABLES) {
      if (spec.table === 'EspFirmwareDeployment') continue // created above
      if (spec.table === 'FuelDispenser' || spec.table === 'Generator') continue // created above
      if (spec.table === 'NotificationPreference') {
        if (suffix.endsWith('-b')) continue // user belongs to tenant A only
        await e(`INSERT INTO "NotificationPreference" (id,"userId",severity,"inAppSeverities",email,sms,push,whatsapp,"tenant_id")
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [`np-${suffix}`, SITE_USER_ID, 'INFO', 'INFO,WARN', true, false, false, false, tenant])
        continue
      }
      const sql = buildInsert(spec, tenant)
        .replaceAll(`'${SITE_ID}'`, `'${siteId}'`)
        .replaceAll(`'${DISPENSER_ID}'`, `'${DISPENSER_ID}-${suffix}'`)
        .replaceAll(`'${GENERATOR_ID}'`, `'${GENERATOR_ID}-${suffix}'`)
        .replaceAll(`'tank-${SUFFIX}'`, `'tank-${suffix}'`)
        .replaceAll(`'tank-${suffix}'`, `'tank-${suffix}'`)
      await e(sql)
    }
  }
}

async function teardownFixtures(): Promise<void> {
  for (const spec of TABLES) {
    try {
      await e(`DELETE FROM "${spec.table}" WHERE id LIKE $1`, [`%${RUN}%`])
    } catch {
      /* table may not exist yet — nothing to clean */
    }
  }
  try {
    await e(`DELETE FROM "Generator" WHERE id LIKE $1`, [`%${RUN}%`])
    await e(`DELETE FROM "FuelDispenser" WHERE id LIKE $1`, [`%${RUN}%`])
    await e(`DELETE FROM "Site" WHERE id LIKE $1`, [`%${RUN}%`])
    await e(`DELETE FROM "EspFirmwareRelease" WHERE id LIKE $1`, [`%${RUN}%`])
    await e(`DELETE FROM "User" WHERE id LIKE $1`, [`%${RUN}%`])
    await e(`DELETE FROM "Tenant" WHERE id LIKE $1`, [`%${RUN}%`])
  } catch {
    /* ignore */
  }
}

// ── Assertions ──────────────────────────────────────────────────────────────

/** 6. Same-tenant access still works (RLS must not break the app). */
async function assertSameTenantAccess(spec: TableSpec): Promise<void> {
  try {
    const rows = await withTenant(TENANT_A, (tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "${spec.table}" WHERE "tenant_id" = $1`,
        TENANT_A,
      ) as Promise<Array<{ id: string }>>,
    )
    if (rows.length === 0) {
      fail('1-same-tenant-read', 'tenant A sees 0 of its own rows — RLS may be over-strict (or fixtures missing)')
      return
    }
    pass('1-same-tenant-read', `tenant A reads ${rows.length} own row(s) via a tenant-scoped WHERE`)
  } catch (err) {
    if (isMissingObject(err)) {
      blocked('1-same-tenant-read', `schema not ready: ${(err as Error).message}`)
      return
    }
    fail('1-same-tenant-read', (err as Error).message)
  }
}

/** 1. Unscoped read returns only tenant A's rows (DELIBERATELY WRONG query). */
async function assertUnscopedRead(spec: TableSpec): Promise<void> {
  try {
    const rows = await withTenant(TENANT_A, (tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "${spec.table}"`,
      ) as Promise<Array<{ id: string }>>,
    )
    // Any row whose id contains the tenant-B marker is a leak.
    const leaked = rows.filter((r) => r.id.endsWith('-b'))
    if (leaked.length > 0) {
      fail('2-unscoped-read-isolated', `LEAK: tenant A's context returned ${leaked.length} tenant B row(s): ${leaked.map((r) => r.id).join(', ')}`)
      return
    }
    pass('2-unscoped-read-isolated', `SELECT * returned ${rows.length} row(s), 0 belonging to tenant B`)
  } catch (err) {
    if (isMissingObject(err)) {
      blocked('2-unscoped-read-isolated', `blocked on p1-schema — ${(err as Error).message}`)
      return
    }
    fail('2-unscoped-read-isolated', (err as Error).message)
  }
}

/** 3. Cross-tenant UPDATE blocked — affects 0 rows. */
async function assertCrossTenantUpdate(spec: TableSpec): Promise<void> {
  const bRowId = await bRowIdFor(spec)
  try {
    const n = await withTenant(TENANT_A, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "${spec.table}" SET "tenant_id" = $1 WHERE id = $2`,
        TENANT_A,
        bRowId,
      ),
    )
    if (n !== 0) {
      fail('3-cross-tenant-update-blocked', `UPDATE affected ${n} row(s) — tenant A modified tenant B data`)
      return
    }
    pass('3-cross-tenant-update-blocked', `UPDATE of tenant B row affected 0 rows`)
  } catch (err) {
    if (isRlsViolation(err)) {
      pass('3-cross-tenant-update-blocked', 'UPDATE rejected by RLS WITH CHECK')
      return
    }
    if (isMissingObject(err)) {
      blocked('3-cross-tenant-update-blocked', `blocked on p1-schema — ${(err as Error).message}`)
      return
    }
    fail('3-cross-tenant-update-blocked', (err as Error).message)
  }
}

/** 4. Cross-tenant DELETE blocked — affects 0 rows. */
async function assertCrossTenantDelete(spec: TableSpec): Promise<void> {
  const bRowId = await bRowIdFor(spec)
  try {
    const n = await withTenant(TENANT_A, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "${spec.table}" WHERE id = $1`, bRowId),
    )
    if (n !== 0) {
      fail('4-cross-tenant-delete-blocked', `DELETE affected ${n} row(s) — tenant A deleted tenant B data`)
      return
    }
    pass('4-cross-tenant-delete-blocked', `DELETE of tenant B row affected 0 rows`)
  } catch (err) {
    if (isRlsViolation(err)) {
      pass('4-cross-tenant-delete-blocked', 'DELETE rejected by RLS USING')
      return
    }
    if (isMissingObject(err)) {
      blocked('4-cross-tenant-delete-blocked', `blocked on p1-schema — ${(err as Error).message}`)
      return
    }
    fail('4-cross-tenant-delete-blocked', (err as Error).message)
  }
}

/** 2b. INSERT with tenant B's id from tenant A's context → WITH CHECK violation. */
async function assertCrossTenantInsert(spec: TableSpec): Promise<void> {
  // Build an insert row stamped with TENANT_A in the tenant column but using
  // a tenant-B id, i.e. an attempt to plant data into B's namespace.
  const cols = Object.entries(spec.columns).map(([k, v]) => `"${k}"`).join(', ')
  const vals = Object.values(spec.columns).map((v) => subst(v)).join(', ')
  const sql = `INSERT INTO "${spec.table}" (${cols}, "${spec.tenantColumn}") VALUES (${vals}, '${TENANT_B}')`
  try {
    await withTenant(TENANT_A, (tx) => tx.$executeRawUnsafe(sql))
    fail('2b-cross-tenant-insert-blocked', 'INSERT of a tenant-B row SUCCEEDED — WITH CHECK not enforced')
  } catch (err) {
    if (isRlsViolation(err)) {
      pass('2b-cross-tenant-insert-blocked', `rejected: ${(err as Error).message.split('\n')[0]}`)
      return
    }
    if (isMissingObject(err)) {
      blocked('2b-cross-tenant-insert-blocked', `blocked on p1-schema — ${(err as Error).message}`)
      return
    }
    fail('2b-cross-tenant-insert-blocked', (err as Error).message)
  }
}

/** 5. Unset context → 0 rows (fails closed). THE critical property. */
async function assertUnsetContextFailsClosed(spec: TableSpec): Promise<void> {
  try {
    // No SET LOCAL at all — a raw transaction like any other.
    const rows = await db.$transaction((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "${spec.table}"`),
    ) as Array<{ id: string }>
    if (rows.length === 0) {
      pass('5-unset-returns-zero', 'unscoped SELECT with NO tenant context returned 0 rows (fails closed)')
    } else {
      fail('5-unset-returns-zero', `LEAK: unset context returned ${rows.length} row(s) — must be 0`)
    }
  } catch (err) {
    if (isMissingObject(err)) {
      blocked('5-unset-returns-zero', `blocked on p1-schema — ${(err as Error).message}`)
      return
    }
    fail('5-unset-returns-zero', (err as Error).message)
  }
}

/** Resolve the id of a fixture row that belongs to tenant B. */
async function bRowIdFor(spec: TableSpec): Promise<string> {
  const rows = await q<{ id: string }>(
    `SELECT id FROM "${spec.table}" WHERE "tenant_id" = $1 ORDER BY id LIMIT 1`,
    [TENANT_B],
  )
  if (rows[0]) return rows[0].id
  // Fall back to the deterministic suffix convention.
  const suffix = `${SUFFIX}-b`
  const col = spec.columns.id.replaceAll('${SUFFIX}', suffix)
  return col.replaceAll("'", '')
}

// ── Tenant-context unit assertions (independent of the DB) ──────────────────

function assertTenantContextUnits(): void {
  currentTable = '(tenant-context unit)'

  // Fail-fast on empty tenant id — must NOT open a transaction.
  try {
    assertTenantId('')
    fail('6-rejects-empty-tenant', 'assertTenantId("") did not throw')
  } catch (err) {
    if (err instanceof TenantContextError) {
      pass('6-rejects-empty-tenant', 'assertTenantId("") threw TenantContextError')
    } else {
      fail('6-rejects-empty-tenant', `wrong error type: ${String(err)}`)
    }
  }

  // Rejects non-identifier characters (injection guard).
  try {
    assertTenantId("t'; DROP TABLE \"Site\"; --")
    fail('6-rejects-unsafe-tenant', 'assertTenantId allowed SQL metacharacters')
  } catch (err) {
    if (err instanceof TenantContextError) {
      pass('6-rejects-unsafe-tenant', 'assertTenantId rejected SQL metacharacters')
    } else {
      fail('6-rejects-unsafe-tenant', `wrong error type: ${String(err)}`)
    }
  }

  // Accepts a real cuid tenant id.
  try {
    normalizeTenantId('  t-default  ')
    pass('6-accepts-cuid-tenant', 'normalizeTenantId("  t-default  ") → "t-default"')
  } catch (err) {
    fail('6-accepts-cuid-tenant', (err as Error).message)
  }

  // Typing: report whether tenant ids are uuids (drives the policy cast form).
  const cuid = !isUuid(TENANT_A)
  currentTable = '(typing)'
  if (cuid) {
    blocked(
      'tenant-id-type',
      `tenant ids are cuids ("${TENANT_A}") — a policy using ::uuid will THROW on them`,
    )
  } else {
    pass('tenant-id-type', `tenant ids are uuids; ::uuid cast is safe`)
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n\x1b[1mFGMP — Row Level Security regression suite\x1b[0m')
  console.log(`run id            : ${RUN}`)
  console.log(`tenant A         : ${TENANT_A}`)
  console.log(`tenant B         : ${TENANT_B}`)
  console.log(`DATABASE_URL role: ${rlsEnforced ? 'fgmp_app (RLS enforced)' : '\x1b[33mNOT fgmp_app — RLS may be bypassed as owner\x1b[0m'}`)

  // Pre-flight: can we even reach the tables?
  assertTenantContextUnits()

  currentTable = '(preflight)'
  try {
    await q(`SELECT 1`)
    pass('preflight-connect', 'connected to PostgreSQL')
  } catch (err) {
    fail('preflight-connect', (err as Error).message)
    return
  }

  // Detect whether the tenant_id columns / policies exist yet.
  const colCount = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema='public' AND column_name='tenant_id'`,
  )
  const hasColumns = (colCount[0]?.n ?? 0) > 0
  const rlsCount = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c
     JOIN pg_namespace ns ON ns.oid=c.relnamespace
     WHERE ns.nspname='public' AND c.relkind='r' AND c.relrowsecurity`,
  )
  const hasPolicies = (rlsCount[0]?.n ?? 0) > 0

  console.log(
    `\n  tenant_id columns: ${colCount[0]?.n ?? 0}   RLS-enabled tables: ${rlsCount[0]?.n ?? 0}`,
  )

  if (!hasColumns || !hasPolicies) {
    console.log(
      `\n\x1b[33m  p1-schema has not installed tenant_id columns and/or RLS policies yet.\n` +
        `  Per-table isolation assertions will report BLOCKED/FAIL. That is expected\n` +
        `  and is NOT a pass. Re-run once p1-schema lands its migration.\x1b[0m\n`,
    )
  }

  // Seed fixtures (owner role).
  try {
    await seedFixtures()
    currentTable = '(fixture)'
    pass('fixture-seed', `two tenants + 14 table fixtures created under run ${RUN}`)
  } catch (err) {
    currentTable = '(fixture)'
    fail('fixture-seed', (err as Error).message)
    report()
    return
  }

  // Run the six assertions per table.
  for (const spec of TABLES) {
    currentTable = spec.table
    console.log(`\n  \x1b[1m${spec.label}\x1b[0m`)
    await assertSameTenantAccess(spec)
    await assertUnscopedRead(spec)
    await assertCrossTenantInsert(spec)
    await assertCrossTenantUpdate(spec)
    await assertCrossTenantDelete(spec)
    await assertUnsetContextFailsClosed(spec)
  }

  // Prove SET LOCAL does not leak across pooled connections.
  currentTable = '(pool safety)'
  const a = await withTenant(TENANT_A, () => currentTenantId())
  const leaked = await currentTenantId()
  if (a === TENANT_A && leaked === null) {
    pass('set-local-resets', `SET LOCAL visible in-transaction (${a}), NULL after commit (${leaked})`)
  } else {
    fail(
      'set-local-resets',
      `connection context leaked: in-tx=${a}, after-commit=${leaked} (expected ${TENANT_A} then NULL)`,
    )
  }

  await teardownFixtures()
  report()
}

function report(): void {
  const totals = { PASS: 0, FAIL: 0, BLOCKED: 0 }
  for (const a of assertions) totals[a.status] += 1

  console.log(`\n\x1b[1m═══ RLS regression summary ═══\x1b[0m`)
  console.log(`  PASS    : ${totals.PASS}`)
  console.log(`  FAIL    : \x1b[31m${totals.FAIL}\x1b[0m`)
  console.log(`  BLOCKED : \x1b[33m${totals.BLOCKED}\x1b[0m (awaiting p1-schema)`)
  if (totals.FAIL > 0) {
    console.log('\n\x1b[31m  Failing assertions:\x1b[0m')
    for (const a of assertions.filter((x) => x.status === 'FAIL')) {
      console.log(`   • [${a.table}] ${a.name}: ${a.detail}`)
    }
  }

  const hasPolicies = assertions.some((a) => a.status === 'PASS' || a.name.includes('unscoped'))
  if (totals.FAIL > 0) {
    process.exitCode = 1
    console.log('\n\x1b[31m  RESULT: FAIL — backstop is not fully proven.\x1b[0m')
  } else if (totals.BLOCKED > 0) {
    process.exitCode = 2
    console.log('\n\x1b[33m  RESULT: BLOCKED — assertions awaiting p1-schema (not a pass).\x1b[0m')
  } else {
    process.exitCode = 0
    console.log('\n\x1b[32m  RESULT: PASS — RLS backstop proven across all tables.\x1b[0m')
  }
}

main().catch((err) => {
  console.error('suite crashed:', err)
  process.exitCode = 1
})
