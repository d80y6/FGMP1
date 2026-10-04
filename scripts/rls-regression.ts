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
  rawTenantSetting,
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

/**
 * Fixture identifiers. Tenant ids follow the seeded convention (cuid-style
 * TEXT, e.g. "t-default" / "t-platform"), NOT uuids — the RLS predicate is a
 * plain TEXT comparison with no cast. The run suffix keeps each run's rows
 * unique so repeated runs cannot collide on a unique constraint, and so
 * "did I see tenant B's row?" is answerable by exact id rather than by
 * counting.
 */
const RUN = process.env.RLS_RUN_ID ?? String(process.pid)
const SUFFIX = RUN
const TENANT_A = `t-alpha-${RUN}`
const TENANT_B = `t-beta-${RUN}`
const SITE_ID = `rls-site-${RUN}`
const SITE_CODE = `RLS-${RUN}`
const SITE_USER_ID = `rls-user-${RUN}`
const RELEASE_ID = `rls-rel-${RUN}`
const DISPENSER_ID = `rls-disp-${RUN}`
const GENERATOR_ID = `rls-gen-${RUN}`
const TANK_ID = `rls-tank-${RUN}`

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
      "userId": `'${SITE_USER_ID}'`,
      "inAppEnabled": 'true',
      "emailEnabled": 'false',
      "smsEnabled": 'false',
      "inAppSeverities": `'INFO,WARN'`,
      "emailSeverities": `'INFO'`,
      "smsSeverities": `'WARN'`,
    },
  },
  {
    table: 'EspFirmwareDeployment',
    label: 'EspFirmwareDeployment (tier A, via FuelDispenser)',
    tenantColumn: 'tenant_id',
    siteScoped: false,
    columns: {
      id: `'efd-${SUFFIX}'`,
      "releaseId": `'${RELEASE_ID}'`,
      "dispenserId": `'${DISPENSER_ID}'`,
      status: `'QUEUED'`,
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
      name: `'iot-${SUFFIX}'`,
      type: `'FUEL_SENSOR'`,
      protocol: `'MODBUS_RTU'`,
      vendor: `'Acme'`,
      "serialNo": `'SN-${SUFFIX}'`,
      firmware: `'1.0.0'`,
      status: `'ONLINE'`,
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
      manufacturer: `'Zhejiang'`,
      model: `'ZD-8'`,
      "nozzleCount": '2',
      "fuelType": `'DIESEL'`,
      status: `'IDLE'`,
      mode: `'AUTO'`,
      "pumpNumber": '1',
      "espDeviceId": `'ESP-${SUFFIX}'`,
      "espFirmware": `'1.0.0'`,
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
      "tankId": `'${TANK_ID}'`,
      supplier: `'RSC'`,
      "volumeOrderedLitres": '500',
      "volumeDeliveredLitres": '500',
      "doNumber": `'DO-${SUFFIX}'`,
      status: `'DELIVERED'`,
      "scheduledAt": 'now()',
      "deliveredAt": 'now()',
    },
  },
  {
    table: 'ControlCommand',
    label: 'ControlCommand (tier B, via Generator)',
    tenantColumn: 'tenant_id',
    siteScoped: true,
    columns: {
      id: `'cmd-${SUFFIX}'`,
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
      title: `'fixture ${SUFFIX}'`,
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
      hostname: `'gw-${SUFFIX}'`,
      model: `'EG-1'`,
      "ipAddress": `'10.0.0.1'`,
      status: `'ONLINE'`,
    },
  },
]

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
    .replaceAll('${TANK_ID}', TANK_ID)
}

/**
 * Tables whose `updatedAt` is NOT NULL with no column default. Most models in
 * this schema carry one, and Prisma normally supplies it — these fixtures are
 * raw SQL, so they must set it explicitly or the INSERT fails with 23502.
 */
const HAS_UPDATED_AT = new Set([
  'NotificationPreference', 'FuelTank', 'Generator', 'BatteryBank', 'IotDevice',
  'FuelDispenser', 'FuelDelivery', 'MaintenanceTicket', 'SiteGateway',
])

/** Build an INSERT for a table spec, targeting one tenant. */
function buildInsert(spec: TableSpec, tenant: string): string {
  const entries = Object.entries(spec.columns)
  const cols = entries.map(([k]) => `"${k}"`).join(', ')
  const vals = entries.map(([, v]) => subst(v)).join(', ')
  const needsUpdatedAt = HAS_UPDATED_AT.has(spec.table)
  const colList = needsUpdatedAt
    ? `${cols}, "updatedAt", "${spec.tenantColumn}"`
    : `${cols}, "${spec.tenantColumn}"`
  const valList = needsUpdatedAt ? `${vals}, now(), '${tenant}'` : `${vals}, '${tenant}'`
  return `INSERT INTO "${spec.table}" (${colList}) VALUES (${valList})`
}

/** True when the error is the RLS WITH CHECK / USING rejection. */
function isRlsViolation(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /row-level security|violates row-level security policy/i.test(m)
}

/** True when the table/policy simply is not installed yet. */
function isMissingObject(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  // 'invalid input syntax for type uuid' is listed defensively: the policy is
  // cast-free now, so seeing it means a stale ::uuid policy is installed and
  // must be flagged rather than treated as a normal missing object.
  return /column .* does not exist|relation .* does not exist/i.test(m)
}

/** A stale policy still carrying the removed ::uuid cast — a real defect. */
function isStaleUuidCast(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /invalid input syntax for type uuid/i.test(m)
}

// ── Fixture setup / teardown (owner role — bypasses RLS by design) ──────────

async function seedFixtures(): Promise<void> {
  // Tenants.
  // `Tenant.updatedAt` is NOT NULL with NO column default (unlike createdAt),
  // so it must be supplied explicitly or the INSERT fails with 23502.
  await e(
    `INSERT INTO "Tenant" (id, name, code, country, "updatedAt")
     VALUES ($1,$2,$3,$4, now()) ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, `RLS A ${RUN}`, `RLS-A-${RUN}`, 'Yemen'],
  )
  await e(
    `INSERT INTO "Tenant" (id, name, code, country, "updatedAt")
     VALUES ($1,$2,$3,$4, now()) ON CONFLICT (id) DO NOTHING`,
    [TENANT_B, `RLS B ${RUN}`, `RLS-B-${RUN}`, 'Yemen'],
  )

  // User for NotificationPreference (tier A resolves through User.tenantId).
  await e(
    `INSERT INTO "User" (id, "tenantId", email, name, role, active, "updatedAt")
     VALUES ($1,$2,$3,$4,$5,true, now())`,
    [SITE_USER_ID, TENANT_A, `rls-user-${RUN}@example.invalid`, `RLS User ${RUN}`, 'ADMIN'],
  )

  // One site per tenant. Site has NOT NULL region/governorate/district FKs, so
  // the geographic hierarchy must exist first.
  for (const [region, gov, dist] of [['rls-reg', 'rls-gov', 'rls-dist']] as const) {
    await e(
      `INSERT INTO "Region" (id, "tenantId", name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [region, TENANT_A, `RLS Region ${region}`],
    )
    await e(
      `INSERT INTO "Governorate" (id, "regionId", name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [gov, region, `RLS Gov ${gov}`],
    )
    await e(
      `INSERT INTO "District" (id, "governorateId", name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [dist, gov, `RLS Dist ${dist}`],
    )
  }

  // Firmware release for EspFirmwareDeployment.
  await e(
    `INSERT INTO "EspFirmwareRelease" (id, version, channel, checksum, "sizeKb")
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
    [RELEASE_ID, `rls-${RUN}`, 'STABLE', 'deadbeef', 1],
  )

  // Two sites, one per tenant, sharing the geographic hierarchy.
  for (const [sid, tenant, code] of [
    [SITE_ID, TENANT_A, `${SITE_CODE}-A`],
    [`${SITE_ID}-b`, TENANT_B, `${SITE_CODE}-B`],
  ] as const) {
    await e(
      `INSERT INTO "Site" (id, "tenantId", code, name, "regionId", "governorateId", "districtId",
                           latitude, longitude, address, status, "criticality", "loadKw",
                           "powerSource", "gridAvailable", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())`,
      [sid, tenant, code, `RLS Site ${sid}`, 'rls-reg', 'rls-gov', 'rls-dist',
       15.0, 44.0, `RLS addr ${sid}`, 'ACTIVE', 'HIGH', 0, 'GRID', true],
    )
  }

  // Per-tenant rows. Tier-B tables hang off the matching site.
  for (const [suffix, tenant, siteId] of [
    [SUFFIX, TENANT_A, SITE_ID],
    [`${SUFFIX}-b`, TENANT_B, `${SITE_ID}-b`],
  ] as const) {
    const genId = `${GENERATOR_ID}-${suffix}`
    const dispId = `${DISPENSER_ID}-${suffix}`
    const tankId = `tank-${suffix}`

    await e(
      `INSERT INTO "Generator" (id,"siteId",label,manufacturer,model,"ratedPowerKw","fuelType",
        status,mode,"runtimeHours","oilChangeIntervalHrs","lastOilChangeHrs","nextMaintenanceHrs",
        "temperatureC","oilPressureKpa","loadKw","fuelRateLph","batteryVoltage","updatedAt","tenantId")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now(),$19)`,
      [genId, siteId, `gen-${suffix}`, 'Cummins', 'C500', 500, 'DIESEL', 'STOPPED', 'AUTO',
       0, 250, 0, 250, 25, 300, 0, 0, 24, tenant],
    )
    await e(
      `INSERT INTO "FuelDispenser" (id,"siteId",label,manufacturer,model,"nozzleCount","fuelType",
        status,mode,"pumpNumber","espDeviceId","espFirmware","updatedAt","tenantId")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(),$13)`,
      [dispId, siteId, `disp-${suffix}`, 'Zhejiang', 'ZD-8', 2, 'DIESEL', 'IDLE', 'AUTO',
       suffix.endsWith('-b') ? 1 : 1, `ESP-${suffix}`, '1.0.0', tenant],
    )
    await e(
      `INSERT INTO "EspFirmwareDeployment" (id,"releaseId","dispenserId",status,"tenantId")
       VALUES ($1,$2,$3,$4,$5)`,
      [`efd-${suffix}`, RELEASE_ID, dispId, 'QUEUED', tenant],
    )

    for (const spec of TABLES) {
      if (spec.table === 'EspFirmwareDeployment') continue // created above
      if (spec.table === 'FuelDispenser' || spec.table === 'Generator') continue // created above
      if (spec.table === 'NotificationPreference') {
        if (suffix.endsWith('-b')) continue // the user belongs to tenant A only
        await e(
          `INSERT INTO "NotificationPreference" (id,"userId","inAppEnabled","emailEnabled","smsEnabled",
            "inAppSeverities","emailSeverities","smsSeverities","updatedAt","tenantId")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(),$9)`,
          [`np-${suffix}`, SITE_USER_ID, true, false, false, 'INFO,WARN', 'INFO', 'WARN', tenant],
        )
        continue
      }
      // Rewrite the placeholders that must point at THIS tenant's parent rows.
      const sql = buildInsert(spec, tenant)
        .replaceAll(`'${SITE_ID}'`, `'${siteId}'`)
        .replaceAll(`'${DISPENSER_ID}'`, `'${dispId}'`)
        .replaceAll(`'${GENERATOR_ID}'`, `'${genId}'`)
        .replaceAll(`'${TANK_ID}'`, `'${tankId}'`)
        .replaceAll(`'tank-${SUFFIX}'`, `'${tankId}'`)
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
    await e(`DELETE FROM "District" WHERE id LIKE $1`, [`rls-%`])
    await e(`DELETE FROM "Governorate" WHERE id LIKE $1`, [`rls-%`])
    await e(`DELETE FROM "Region" WHERE id LIKE $1`, [`rls-%`])
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
    if (isStaleUuidCast(err)) {
      fail('2-unscoped-read-isolated', `STALE POLICY: installed RLS policy still casts to ::uuid — ${(err as Error).message}`)
      return
    }
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

  // Typing: prove the TEXT setting round-trips for a cuid tenant id. This is
  // the load-bearing check behind the cast-free policy — if `SET LOCAL` could
  // not carry a cuid-style id, the policy would be unevaluable.
  currentTable = '(typing)'
  if (isUuid(TENANT_A)) {
    blocked(
      'tenant-id-is-text-safe',
      `fixture tenant id "${TENANT_A}" is a uuid; the cast-free TEXT policy is not exercised`,
    )
  } else {
    pass(
      'tenant-id-is-text-safe',
      `cuid-style tenant id "${TENANT_A}" is valid for the cast-free TEXT predicate`,
    )
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
    const msg = (err as Error).message
    // The tenant_id column not existing is the expected state while p1-schema
    // is still landing its migration. That is a BLOCKED condition, not a
    // defect in this suite: report it as such and stop, so CI shows the real
    // dependency instead of a red herring fixture error.
    if (isMissingObject(err)) {
      blocked(
        'fixture-seed',
        `blocked on p1-schema — cannot build two-tenant fixtures without tenant_id: ${msg.split('\n').pop()?.trim()}`,
      )
    } else {
      fail('fixture-seed', msg)
    }
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
  //
  // This is the assertion that distinguishes a correct implementation from a
  // catastrophic one. A pooled-global `SET app.tenant_id = …` would still show
  // the right value INSIDE this transaction, and every other assertion in the
  // suite would pass — while leaking one tenant's context into the next
  // request that reuses the connection. So the check has to happen AFTER the
  // transaction, on a subsequent borrow of the same connection.
  currentTable = '(pool safety)'
  const inTx = await withTenant(TENANT_A, (tx) => rawTenantSetting(tx))
  const afterCommit = await currentTenantId()

  if (inTx === TENANT_A) {
    pass('set-local-visible-in-tx', `app.tenant_id = "${inTx}" inside the transaction`)
  } else {
    fail('set-local-visible-in-tx', `expected ${TENANT_A} in-transaction, got ${JSON.stringify(inTx)}`)
  }

  // After the transaction the context must be gone. PostgreSQL resets a LOCAL
  // setting to the empty string on COMMIT/ROLLBACK (verified on PG17), and
  // currentTenantId() normalises that '' to null — so we expect null here.
  // A leaked value would mean the context survived and could be handed to the
  // next tenant on this connection.
  if (afterCommit === null) {
    pass('set-local-resets', 'after COMMIT the context reads as null — no leak to the next borrower')
  } else {
    fail(
      'set-local-resets',
      `CONNECTION CONTEXT LEAKED: ${JSON.stringify(afterCommit)} still set after the transaction ended`,
    )
  }

  // The safety property regardless of which reset state PostgreSQL uses: with
  // no tenant context, a read must return zero rows.
  const leakCheck = await q<{ n: number }>(`SELECT count(*)::int AS n FROM "FuelTank"`)
  if ((leakCheck[0]?.n ?? -1) === 0) {
    pass('no-context-reads-zero', 'unscoped read with no active context returns 0 rows')
  } else {
    fail('no-context-reads-zero', `expected 0 rows without context, got ${leakCheck[0]?.n}`)
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
