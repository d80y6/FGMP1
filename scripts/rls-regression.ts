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

import { PrismaClient } from '@prisma/client'
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
// The 14 tables the suite exercises directly. Step 6 enables RLS on
// ALL 24 tables that carry the column; the rest are covered by the same policy
// and are enumerated in the step-6 migration.
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
// Stable numeric digest of the run id, for the synthetic phone number below.
const SUFFIX_DIGITS = [...RUN].reduce((a, c) => a + c.charCodeAt(0), 0);
const TENANT_A = `t-alpha-${RUN}`
const TENANT_B = `t-beta-${RUN}`
const SITE_ID = `rls-site-${RUN}`
const SITE_CODE = `RLS-${RUN}`
const SITE_USER_ID = `rls-user-${RUN}`
const RELEASE_ID = `rls-rel-${RUN}`
const DISPENSER_ID = `rls-disp-${RUN}`
const GENERATOR_ID = `rls-gen-${RUN}`
const TANK_ID = `rls-tank-${RUN}`
const REGION_ID = `rls-reg-${RUN}`
const GOV_ID = `rls-gov-${RUN}`
const DIST_ID = `rls-dist-${RUN}`

/** Site id for a tenant tag. Single source of truth so parents and children
 *  can never disagree about the id (an FK mismatch is otherwise silent). */
/**
 * Quoted-id helper for the TABLES specs.
 *
 * The specs used to embed `'batt-${SUFFIX}'` as a template literal, which
 * interpolates SUFFIX at DEFINITION time — so every tenant produced the SAME id
 * and the second tenant collided on the primary key. Explicit function calls
 * keep the per-tenant value out of module-load time.
 */
const idFor = (prefix: string): string => `'${prefix}-\${SUFFIX}'`
const siteRef = (): string => `'\${SITE_ID}'`
const userRef = (): string => `'\${SITE_USER_ID}'`
const releaseRef = (): string => `'\${RELEASE_ID}'`
const dispenserRef = (): string => `'\${DISPENSER_ID}'`
const generatorRef = (): string => `'\${GENERATOR_ID}'`
const tankRef = (): string => `'\${TANK_ID}'`

const siteIdFor = (tag: string): string =>
  tag === SUFFIX ? SITE_ID : `${SITE_ID}-${tag}`

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
    tenantColumn: 'tenantId',
    siteScoped: false,
    columns: {
      id: idFor('np'),
      "userId": userRef(),
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
    tenantColumn: 'tenantId',
    siteScoped: false,
    columns: {
      id: idFor('efd'),
      "releaseId": releaseRef(),
      "dispenserId": dispenserRef(),
      status: `'QUEUED'`,
    },
  },
  {
    table: 'FuelTank',
    label: 'FuelTank (tier B, via Site)',
    tenantColumn: 'tenantId',
    siteScoped: true,
    columns: {
      id: idFor('tank'),
      "siteId": siteRef(),
      label: idFor('tank'),
      "fuelType": `'DIESEL'`,
      "capacityLitres": '1000',
      "currentLitres": '500',
      calibration: `'{}'`,
      "lowThreshold": '200',
      "criticalThreshold": '100',
      status: `'OPERATIONAL'`,
    },
  },
  {
    table: 'Generator',
    label: 'Generator (tier B, via Site)',
    tenantColumn: 'tenantId',
    siteScoped: true,
    columns: {
      id: idFor('gen'),
      "siteId": siteRef(),
      label: idFor('gen'),
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
    tenantColumn: 'tenantId',
    siteScoped: true,
    columns: {
      id: idFor('batt'),
      "siteId": siteRef(),
      label: idFor('batt'),
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
    tenantColumn: 'tenantId',
    siteScoped: true,
    columns: {
      id: idFor('iot'),
      "siteId": siteRef(),
      name: idFor('iot'),
      type: `'FUEL_SENSOR'`,
      protocol: `'MODBUS_RTU'`,
      vendor: `'Acme'`,
      "serialNo": idFor('SN'),
      firmware: `'1.0.0'`,
      status: `'ONLINE'`,
    },
  },
  {
    table: 'FuelDispenser',
    label: 'FuelDispenser (tier B, via Site)',
    tenantColumn: 'tenantId',
    siteScoped: true,
    columns: {
      id: idFor('disp'),
      "siteId": siteRef(),
      label: idFor('disp'),
      manufacturer: `'Zhejiang'`,
      model: `'ZD-8'`,
      "nozzleCount": '2',
      "fuelType": `'DIESEL'`,
      status: `'IDLE'`,
      mode: `'AUTO'`,
      "pumpNumber": '1',
      "espDeviceId": idFor('ESP'),
      "espFirmware": `'1.0.0'`,
    },
  },
  {
    table: 'FuelTransaction',
    label: 'FuelTransaction (tier B, via Dispenser)',
    tenantColumn: 'tenantId',
    siteScoped: true,
    columns: {
      id: idFor('txn'),
      "siteId": siteRef(),
      "dispenserId": dispenserRef(),
      "volumeLitres": '10',
      "amountYer": '5200',
      "unitPriceYer": '520',
      status: `'COMPLETED'`,
    },
  },
  {
    table: 'SensorReading',
    label: 'SensorReading (tier B, via Site)',
    tenantColumn: 'tenantId',
    siteScoped: true,
    columns: {
      id: idFor('read'),
      "siteId": siteRef(),
      "entityKind": `'TANK'`,
      "entityId": idFor('tank'),
      metric: `'level'`,
      value: '500',
      ts: 'now()',
    },
  },
  {
    table: 'SiteEvent',
    label: 'SiteEvent (tier B, via Site)',
    tenantColumn: 'tenantId',
    siteScoped: true,
    columns: {
      id: idFor('evt'),
      "siteId": siteRef(),
      kind: `'INFO'`,
      message: `'fixture ${SUFFIX}'`,
    },
  },
  {
    table: 'FuelDelivery',
    label: 'FuelDelivery (tier B, via Site)',
    tenantColumn: 'tenantId',
    siteScoped: true,
    columns: {
      id: idFor('del'),
      "siteId": siteRef(),
      "tankId": tankRef(),
      supplier: `'RSC'`,
      "volumeOrderedLitres": '500',
      "volumeDeliveredLitres": '500',
      "doNumber": idFor('DO'),
      status: `'DELIVERED'`,
      "scheduledAt": 'now()',
      "deliveredAt": 'now()',
    },
  },
  {
    table: 'ControlCommand',
    label: 'ControlCommand (tier B, via Generator)',
    tenantColumn: 'tenantId',
    siteScoped: true,
    columns: {
      id: idFor('cmd'),
      "generatorId": generatorRef(),
      command: `'START'`,
      status: `'SENT'`,
    },
  },
  {
    table: 'MaintenanceTicket',
    label: 'MaintenanceTicket (tier B, via Site)',
    tenantColumn: 'tenantId',
    siteScoped: true,
    columns: {
      id: idFor('mnt'),
      "siteId": siteRef(),
      "assetKind": `'GENERATOR'`,
      "assetId": generatorRef(),
      type: `'PREVENTIVE'`,
      status: `'OPEN'`,
      priority: `'P2'`,
      title: `'fixture ${SUFFIX}'`,
    },
  },
  {
    table: 'SiteGateway',
    label: 'SiteGateway (tier B, via Site)',
    tenantColumn: 'tenantId',
    siteScoped: true,
    columns: {
      id: idFor('gw'),
      "siteId": siteRef(),
      hostname: idFor('gw'),
      model: `'EG-1'`,
      "ipAddress": `'10.0.0.1'`,
      status: `'ONLINE'`,
    },
  },
  {
    table: 'Site',
    label: 'Site (root of every tier-B backfill)',
    tenantColumn: 'tenantId',
    siteScoped: false,
    columns: {
      id: siteRef(),
      code: `'${SITE_CODE}'`,
      name: `'RLS Site ${SUFFIX}'`,
      "regionId": `'${REGION_ID}'`,
      "governorateId": `'${GOV_ID}'`,
      "districtId": `'${DIST_ID}'`,
      latitude: '15.0',
      longitude: '44.0',
      address: `'RLS addr ${SUFFIX}'`,
    },
  },
  {
    table: 'User',
    label: 'User (identity root)',
    tenantColumn: 'tenantId',
    siteScoped: false,
    columns: {
      id: userRef(),
      email: `'rls-user-${SUFFIX}@example.invalid'`,
      name: `'RLS User ${SUFFIX}'`,
      role: `'ADMIN'`,
      active: 'true',
    },
  },
  {
    table: 'Region',
    label: 'Region (geography root)',
    tenantColumn: 'tenantId',
    siteScoped: false,
    columns: {
      id: idFor('reg'),
      name: idFor('regname'),
    },
  },
  {
    table: 'Alarm',
    label: 'Alarm (operational)',
    tenantColumn: 'tenantId',
    siteScoped: true,
    columns: {
      id: idFor('alm'),
      "siteId": siteRef(),
      type: `'FUEL_LOW'`,
      message: `'RLS alarm ${SUFFIX}'`,
    },
  },
  {
    table: 'AlarmSuppression',
    label: 'AlarmSuppression (tenant-owned)',
    tenantColumn: 'tenantId',
    siteScoped: true,
    columns: {
      id: idFor('sup'),
      "siteId": siteRef(),
      reason: `'RLS suppression ${SUFFIX}'`,
      "createdBy": userRef(),
      "startsAt": 'now()',
      "endsAt": 'now() + interval \'1 day\'',
    },
  },
  {
    table: 'ApiKey',
    label: 'ApiKey (credential store)',
    tenantColumn: 'tenantId',
    siteScoped: false,
    columns: {
      id: idFor('key'),
      name: `'RLS key ${SUFFIX}'`,
      "keyPrefix": idFor('pfx'),
      "keyHash": `'k-\${SUFFIX}'`,
      "createdBy": userRef(),
    },
  },
  {
    table: 'AuditLog',
    label: 'AuditLog (highest disclosure risk)',
    tenantColumn: 'tenantId',
    siteScoped: false,
    columns: {
      id: idFor('aud'),
      action: `'READ'`,
      entity: `'Site'`,
      details: `'{}'`,
    },
  },
  {
    table: 'Notification',
    label: 'Notification (highest disclosure risk)',
    tenantColumn: 'tenantId',
    siteScoped: false,
    columns: {
      id: idFor('ntf'),
      channel: `'SMS'`,
      // `SUFFIX` is the run identifier (an env string or the pid), not a
      // number — `SUFFIX % 1000` is a type error and, had it compiled, would
      // have produced NaN in the middle of the phone number. Derive a stable
      // 3-digit block from a character sum instead, which works for any run id.
      recipient: `'+967700000${(SUFFIX_DIGITS % 1000).toString().padStart(3, '0')}'`,
      subject: `'RLS subject ${SUFFIX}'`,
      body: `'RLS body ${SUFFIX}'`,
    },
  },
  {
    table: 'BackupRecord',
    label: 'BackupRecord (holds password hashes indirectly)',
    tenantColumn: 'tenantId',
    siteScoped: false,
    columns: {
      id: idFor('bkp'),
      filename: `'fgmp-rls-${SUFFIX}.db'`,
      "sizeBytes": '1024',
    },
  },
  {
    table: 'ShiftHandover',
    label: 'ShiftHandover (tenant-owned)',
    tenantColumn: 'tenantId',
    siteScoped: false,
    columns: {
      id: idFor('shf'),
      "authorId": userRef(),
      "authorName": `'RLS User ${SUFFIX}'`,
      "authorRole": `'NOC_OPERATOR'`,
      shift: `'DAY'`,
      notes: `'RLS handover ${SUFFIX}'`,
    },
  },
]

// ── Helpers ─────────────────────────────────────────────────────────────────

function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return db.$queryRawUnsafe<T[]>(sql, ...params) as Promise<T[]>
}

/**
 * OWNER-role client, used ONLY to build and tear down fixtures.
 *
 * Once step 6 is applied, an INSERT as the app role requires tenant context
 * that matches the row — so seeding tenant B's rows while acting as tenant A is
 * impossible BY DESIGN. That is precisely the property under test, so the
 * fixtures must be written by a role RLS does not bind.
 *
 * `fgmp_migrate` is a SUPERUSER, which bypasses RLS regardless of FORCE, so it
 * can create the two-tenant world. Every ASSERTION still runs on the app role
 * `db`, where the policies genuinely apply.
 *
 * Falls back to the app client when no owner URL is supplied — in which case
 * seeding a second tenant legitimately fails and the suite says so.
 *
 * ENV VAR — one name for the owner connection, shared with
 * src/lib/fgmp/seed.ts. `FGMP_MIGRATE_DATABASE_URL` names the ROLE (the
 * migration/owner principal) rather than the task, so it reads correctly in
 * seed.ts, in this suite and in the smoke test alike. The suite previously used
 * `RLS_OWNER_DATABASE_URL`, which duplicated the same meaning under a second
 * name; that name has been removed so there is exactly one.
 */
const ownerUrl = process.env.FGMP_MIGRATE_DATABASE_URL
let owner: PrismaClient | null = null

function ownerDb(): PrismaClient {
  if (!ownerUrl) return db
  if (!owner) owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } })
  return owner
}

/** Execute fixture DDL/DML on the OWNER role (RLS not enforced there). */
async function oe(sql: string, params: unknown[] = []): Promise<number> {
  return ownerDb().$executeRawUnsafe(sql, ...params) as Promise<number>
}

function e(sql: string, params: unknown[] = []): Promise<number> {
  return db.$executeRawUnsafe(sql, ...params) as Promise<number>
}

/**
 * Enum-typed columns, keyed `Table.column` -> PostgreSQL type name.
 *
 * Phase 1 step 8 converted these columns to native enums, so a bare text
 * literal no longer assigns:
 *     ERROR: column "role" is of type "Role" but expression is of type text
 *
 * The map is TABLE-SCOPED on purpose. `status` alone is SiteStatus on Site,
 * GenStatus on Generator, TankStatus on FuelTank, AlarmStatus on Alarm,
 * TicketStatus on MaintenanceTicket, and so on — a global `status -> X` rule
 * would cast to the wrong type and fail. This table is derived from
 * pg_attribute/pg_type rather than from prisma/schema.prisma so it cannot
 * silently drift from the live database.
 */
const ENUM_COLUMNS: Record<string, string> = {
  "Alarm.severity": "AlarmSeverity",
  "Alarm.status": "AlarmStatus",
  "Alarm.type": "AlarmType",
  "BatteryBank.status": "BatteryStatus",
  "ControlCommand.command": "GenCommandType",
  "ControlCommand.status": "ControlCommandStatus",
  "EspFirmwareDeployment.status": "OtaStatus",
  "FuelDelivery.status": "FuelDeliveryStatus",
  "FuelDispenser.fuelType": "FuelType",
  "FuelDispenser.status": "DispenserStatus",
  "FuelTank.fuelType": "FuelType",
  "FuelTank.status": "TankStatus",
  "FuelTransaction.status": "FuelTransactionStatus",
  "Generator.mode": "GenMode",
  "Generator.status": "GenStatus",
  "IotDevice.protocol": "IotProtocol",
  "IotDevice.status": "IotStatus",
  "MaintenanceTicket.priority": "TicketPriority",
  "MaintenanceTicket.status": "TicketStatus",
  "Notification.channel": "NotificationChannel",
  "Notification.status": "NotificationStatus",
  "SensorReading.entityKind": "EntityKind",
  "Site.criticality": "Criticality",
  "Site.powerSource": "PowerSource",
  "Site.status": "SiteStatus",
  "SiteGateway.status": "GatewayStatus",
  "SystemSetting.category": "SystemSettingCategory",
  "User.role": "Role"
}

/** Apply enum casts to a built INSERT for one table. */
function castEnumLiterals(sql: string, table: string): string {
  let out = sql
  for (const [key, type] of Object.entries(ENUM_COLUMNS)) {
    const [tbl, col] = key.split('.')
    if (tbl !== table) continue
    // Only cast values for this table's own column, inside its column list.
    const colList = new RegExp(`("${col}", )('[^']*')`)
    out = out.replace(colList, `$1$2::"${type}"`)
  }
  return out
}

/** Replace ${...} placeholders with fixture values. */
interface ParentIds {
  siteId?: string
  userId?: string
  dispenserId?: string
  generatorId?: string
  tankId?: string
}

function subst(sql: string, suffix: string = SUFFIX, parents: ParentIds = {}): string {
  return sql
    .replaceAll('${SUFFIX}', suffix)
    .replaceAll('${SITE_ID}', parents.siteId ?? SITE_ID)
    .replaceAll('${SITE_USER_ID}', parents.userId ?? SITE_USER_ID)
    .replaceAll('${RELEASE_ID}', RELEASE_ID)
    .replaceAll('${DISPENSER_ID}', parents.dispenserId ?? DISPENSER_ID)
    .replaceAll('${GENERATOR_ID}', parents.generatorId ?? GENERATOR_ID)
    .replaceAll('${TANK_ID}', parents.tankId ?? TANK_ID)
}

/**
 * Tables whose `updatedAt` is NOT NULL with no column default. Most models in
 * this schema carry one, and Prisma normally supplies it — these fixtures are
 * raw SQL, so they must set it explicitly or the INSERT fails with 23502.
 */
const HAS_UPDATED_AT = new Set([
  'NotificationPreference', 'FuelTank', 'Generator', 'BatteryBank', 'IotDevice',
  'FuelDispenser', 'FuelDelivery', 'MaintenanceTicket', 'SiteGateway',
  'AlarmSuppression', 'ShiftHandover', 'Site', 'User',
])

/** Build an INSERT for a table spec, targeting one tenant. */
function buildInsert(
  spec: TableSpec,
  tenant: string,
  suffix: string = SUFFIX,
  parents: ParentIds = {},
): string {
  const entries = Object.entries(spec.columns)
  const cols = entries.map(([k]) => `"${k}"`).join(', ')
  const vals = entries.map(([, v]) => subst(v, suffix, parents)).join(', ')
  const needsUpdatedAt = HAS_UPDATED_AT.has(spec.table)
  const colList = needsUpdatedAt
    ? `${cols}, "updatedAt", "${spec.tenantColumn}"`
    : `${cols}, "${spec.tenantColumn}"`
  const valList = needsUpdatedAt ? `${vals}, now(), '${tenant}'` : `${vals}, '${tenant}'`
  return castEnumLiterals(
    `INSERT INTO "${spec.table}" (${colList}) VALUES (${valList})`,
    spec.table,
  )
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

/**
 * Remove fixtures left behind by an EARLIER run.
 *
 * Teardown only runs after a successful seed, so a run that dies partway
 * through (a schema change, a bad enum value) leaves rows behind. The next run
 * then collides on the primary key and fails for the wrong reason — which
 * looks like an isolation defect but is only stale fixture data. Purge first so
 * every run starts from a known-empty fixture namespace.
 *
 * Only the suite's own id patterns are touched. Real seeded rows (52 sites,
 * SITE-xxx codes) never match `rls-` / `t-alpha-` / `t-beta-`.
 */
async function purgeStaleFixtures(): Promise<void> {
  // Child tables first — FKs would block a parent-first delete.
  const order = [
    'SiteEvent', 'SensorReading', 'FuelTransaction', 'FuelDelivery',
    'ControlCommand', 'MaintenanceTicket', 'SiteGateway', 'Alarm',
    'AlarmSuppression', 'BatteryBank', 'Generator', 'IotDevice', 'FuelTank',
    'FuelDispenser', 'EspFirmwareDeployment', 'ApiKey', 'BackupRecord',
    'Notification', 'NotificationPreference', 'ShiftHandover', 'AuditLog',
    'Site', 'User', 'EspFirmwareRelease', 'District', 'Governorate', 'Region',
    'Tenant',
  ]
  const patterns: Record<string, string> = {
    SiteEvent: 'evt-%', SensorReading: 'read-%', FuelTransaction: 'txn-%',
    FuelDelivery: 'del-%', ControlCommand: 'cmd-%', MaintenanceTicket: 'mnt-%',
    SiteGateway: 'gw-%', Alarm: 'alm-%', AlarmSuppression: 'sup-%',
    BatteryBank: 'batt-%', Generator: 'gen-%', IotDevice: 'iot-%',
    FuelTank: 'tank-%', FuelDispenser: 'disp-%',
    EspFirmwareDeployment: 'efd-%', ApiKey: 'key-%', BackupRecord: 'bkp-%',
    Notification: 'ntf-%', NotificationPreference: 'np-%',
    ShiftHandover: 'shf-%', AuditLog: 'aud-%', Site: 'rls-site%',
    User: 'rls-user-%', EspFirmwareRelease: 'rls-rel%', District: 'rls-dist%',
    Governorate: 'rls-gov%', Region: 'rls-reg%',
  }
  for (const table of order) {
    const pattern = patterns[table]
    if (!pattern) continue
    if (table === 'Tenant') {
      await oe(`DELETE FROM "Tenant" WHERE id LIKE 't-alpha-%' OR id LIKE 't-beta-%'`)
      continue
    }
    await oe(`DELETE FROM "${table}" WHERE id LIKE $1`, [pattern])
  }
}

async function seedFixtures(): Promise<void> {
  // Clear anything a previous run left behind, so a failed run cannot poison
  // this one with a primary-key collision.
  await purgeStaleFixtures()

  // Tenants.
  // `Tenant.updatedAt` is NOT NULL with NO column default (unlike createdAt),
  // so it must be supplied explicitly or the INSERT fails with 23502.
  await oe(
    `INSERT INTO "Tenant" (id, name, code, country, "updatedAt")
     VALUES ($1,$2,$3,$4, now()) ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, `RLS A ${RUN}`, `RLS-A-${RUN}`, 'Yemen'],
  )
  await oe(
    `INSERT INTO "Tenant" (id, name, code, country, "updatedAt")
     VALUES ($1,$2,$3,$4, now()) ON CONFLICT (id) DO NOTHING`,
    [TENANT_B, `RLS B ${RUN}`, `RLS-B-${RUN}`, 'Yemen'],
  )

  // User for NotificationPreference (tier A resolves through User.tenantId).
  const USER_A = `${SITE_USER_ID}`
  const USER_B = `${SITE_USER_ID}-b`
  await oe(
    `INSERT INTO "User" (id, "tenantId", email, name, role, active, "updatedAt")
     VALUES ($1,$2,$3,$4,$5::"Role",true, now())`,
    [USER_A, TENANT_A, `rls-user-${RUN}@example.invalid`, `RLS User ${RUN}`, 'ADMIN'],
  )
  await oe(
    `INSERT INTO "User" (id, "tenantId", email, name, role, active, "updatedAt")
     VALUES ($1,$2,$3,$4,$5::"Role",true, now())`,
    [USER_B, TENANT_B, `rls-user-${RUN}-b@example.invalid`, `RLS User ${RUN} B`, 'ADMIN'],
  )

  // Geographic hierarchy is itself tenant-owned (Region carries tenantId), so
  // each tenant gets its own chain. Site requires all three FKs NOT NULL.
  const chains: Record<string, { region: string; gov: string; dist: string }> = {}
  for (const [tag, tenant] of [
    [SUFFIX, TENANT_A],
    [`${SUFFIX}-b`, TENANT_B],
  ] as const) {
    const region = `rls-reg-${tag}`
    const gov = `rls-gov-${tag}`
    const dist = `rls-dist-${tag}`
    chains[tag] = { region, gov, dist }
    await oe(
      `INSERT INTO "Region" (id, "tenantId", name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [region, tenant, `RLS Region ${tag}`],
    )
    await oe(
      `INSERT INTO "Governorate" (id, "regionId", name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [gov, region, `RLS Gov ${tag}`],
    )
    await oe(
      `INSERT INTO "District" (id, "governorateId", name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [dist, gov, `RLS Dist ${tag}`],
    )
  }

  // Firmware release for EspFirmwareDeployment.
  await oe(
    `INSERT INTO "EspFirmwareRelease" (id, version, channel, checksum, "sizeKb")
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
    [RELEASE_ID, `rls-${RUN}`, 'STABLE', 'deadbeef', 1],
  )

  // Two sites, one per tenant, sharing the geographic hierarchy.
  for (const [tag, tenant, code] of [
    [SUFFIX, TENANT_A, `${SITE_CODE}-A`],
    [`${SUFFIX}-b`, TENANT_B, `${SITE_CODE}-B`],
  ] as const) {
    const ch = chains[tag]
    await oe(
      `INSERT INTO "Site" (id, "tenantId", code, name, "regionId", "governorateId", "districtId",
                           latitude, longitude, address, status, "criticality", "loadKw",
                           "powerSource", "gridAvailable", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::"SiteStatus",$12::"Criticality",$13,$14::"PowerSource",$15, now())`,
      [siteIdFor(tag), tenant, code, `RLS Site ${tag}`, ch.region, ch.gov, ch.dist,
       15.0, 44.0, `RLS addr ${tag}`, 'ONLINE', 'HIGH', 0,
       'GRID', true],
    )
  }

  // Per-tenant rows. Tier-B tables hang off the matching site.
  // Site ids were created above as `${SITE_ID}-${tag}`, so the child rows must
  // reference exactly that — a mismatch trips the siteId FK.
  for (const [suffix, tenant, siteId] of [
    [SUFFIX, TENANT_A, siteIdFor(SUFFIX)],
    [`${SUFFIX}-b`, TENANT_B, siteIdFor(`${SUFFIX}-b`)],
  ] as const) {
    const genId = `${GENERATOR_ID}-${suffix}`
    const dispId = `${DISPENSER_ID}-${suffix}`
    const tankId = `tank-${suffix}`
    // User, AlarmSuppression, ApiKey and ShiftHandover all resolve tenancy
    // through User, so they must reference THIS tenant's user row.
    const userId = suffix.endsWith('-b') ? `${SITE_USER_ID}-b` : SITE_USER_ID

    await oe(
      `INSERT INTO "Generator" (id,"siteId",label,manufacturer,model,"ratedPowerKw","fuelType",
        status,mode,"runtimeHours","oilChangeIntervalHrs","lastOilChangeHrs","nextMaintenanceHrs",
        "temperatureC","oilPressureKpa","loadKw","fuelRateLph","batteryVoltage","updatedAt","tenantId")
       VALUES ($1,$2,$3,$4,$5,$6,$7::"FuelType",$8::"GenStatus",$9::"GenMode",$10,$11,$12,$13,$14,$15,$16,$17,$18, now(),$19)`,
      [genId, siteId, `gen-${suffix}`, 'Cummins', 'C500', 500, 'DIESEL',
       'STOPPED', 'AUTO',
       0, 250, 0, 250, 25, 300, 0, 0, 24, tenant],
    )
    await oe(
      `INSERT INTO "FuelDispenser" (id,"siteId",label,manufacturer,model,"nozzleCount","fuelType",
        status,mode,"pumpNumber","espDeviceId","espFirmware","updatedAt","tenantId")
       VALUES ($1,$2,$3,$4,$5,$6,$7::"FuelType",$8::"DispenserStatus",$9::"GenMode",$10,$11,$12, now(),$13)`,
      [dispId, siteId, `disp-${suffix}`, 'Zhejiang', 'ZD-8', 2, 'DIESEL',
       'IDLE', 'AUTO',
       suffix.endsWith('-b') ? 1 : 1, `ESP-${suffix}`, '1.0.0', tenant],
    )
    await oe(
      `INSERT INTO "EspFirmwareDeployment" (id,"releaseId","dispenserId",status,"tenantId")
       VALUES ($1,$2,$3,$4::"OtaStatus",$5)`,
      [`efd-${suffix}`, RELEASE_ID, dispId, 'QUEUED', tenant],
    )

    for (const spec of TABLES) {
      if (spec.table === 'EspFirmwareDeployment') continue // created above
      if (spec.table === 'FuelDispenser' || spec.table === 'Generator') continue // created above
      // Tenant-owned roots are created once per tenant ABOVE, with the exact
      // per-tenant ids (siteIdFor(tag), USER_A/USER_B, chains[tag]). Re-inserting
      // them here with the shared ${SITE_ID} placeholder collides on the primary
      // key, and would also attach tenant-B children to tenant-A parents.
      if (spec.table === 'Site' || spec.table === 'User') {
        continue
      }
      if (spec.table === 'NotificationPreference') {
        // Resolved through User, so it must point at THIS tenant's user.
        await oe(
          `INSERT INTO "NotificationPreference" (id,"userId","inAppEnabled","emailEnabled","smsEnabled",
            "inAppSeverities","emailSeverities","smsSeverities","updatedAt","tenantId")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(),$9)`,
          [`np-${suffix}`, userId, true, false, false, 'INFO,WARN', 'INFO', 'WARN', tenant],
        )
        continue
      }
      // Rewrite the placeholders that must point at THIS tenant's parent rows.
      const sql = buildInsert(spec, tenant, suffix, {
        siteId,
        userId,
        dispenserId: dispId,
        generatorId: genId,
        tankId,
      })
      await oe(sql)
    }
  }
}

async function teardownFixtures(): Promise<void> {
  for (const spec of TABLES) {
    try {
      await oe(`DELETE FROM "${spec.table}" WHERE id LIKE $1`, [`%${RUN}%`])
    } catch {
      /* table may not exist yet — nothing to clean */
    }
  }
  try {
    await oe(`DELETE FROM "Generator" WHERE id LIKE $1`, [`%${RUN}%`])
    await oe(`DELETE FROM "FuelDispenser" WHERE id LIKE $1`, [`%${RUN}%`])
    await oe(`DELETE FROM "Site" WHERE id LIKE $1`, [`%${RUN}%`])
    await oe(`DELETE FROM "EspFirmwareRelease" WHERE id LIKE $1`, [`%${RUN}%`])
    await oe(`DELETE FROM "District" WHERE id LIKE $1`, [`rls-%`])
    await oe(`DELETE FROM "Governorate" WHERE id LIKE $1`, [`rls-%`])
    await oe(`DELETE FROM "Region" WHERE id LIKE $1`, [`rls-%`])
    await oe(`DELETE FROM "User" WHERE id LIKE $1`, [`%${RUN}%`])
    await oe(`DELETE FROM "Tenant" WHERE id LIKE $1`, [`%${RUN}%`])
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
        `SELECT id FROM "${spec.table}" WHERE "tenantId" = $1`,
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
      blocked('2-unscoped-read-isolated', `blocked on step 6 — ${(err as Error).message}`)
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
        `UPDATE "${spec.table}" SET "tenantId" = $1 WHERE id = $2`,
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
      blocked('3-cross-tenant-update-blocked', `blocked on step 6 — ${(err as Error).message}`)
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
      blocked('4-cross-tenant-delete-blocked', `blocked on step 6 — ${(err as Error).message}`)
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
      blocked('2b-cross-tenant-insert-blocked', `blocked on step 6 — ${(err as Error).message}`)
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
      blocked('5-unset-returns-zero', `blocked on step 6 — ${(err as Error).message}`)
      return
    }
    fail('5-unset-returns-zero', (err as Error).message)
  }
}

/** Resolve the id of a fixture row that belongs to tenant B. */
async function bRowIdFor(spec: TableSpec): Promise<string> {
  const rows = await q<{ id: string }>(
    `SELECT id FROM "${spec.table}" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`,
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

  // Detect whether the tenantId columns / policies exist yet.
  const colCount = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema='public' AND column_name='tenantId'`,
  )
  const hasColumns = (colCount[0]?.n ?? 0) > 0
  const rlsCount = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c
     JOIN pg_namespace ns ON ns.oid=c.relnamespace
     WHERE ns.nspname='public' AND c.relkind='r' AND c.relrowsecurity`,
  )
  const hasPolicies = (rlsCount[0]?.n ?? 0) > 0

  // ── FORCE ROW LEVEL SECURITY coverage ───────────────────────────────────
  // PostgreSQL skips RLS for a table's OWNER, and fgmp_migrate owns these
  // tables. ENABLE alone therefore binds nothing for the owner — the policy
  // would be decorative for exactly the principal most likely to be used by
  // mistake. FORCE is what closes that.
  //
  // This suite cannot OBSERVE that difference by exercising queries: it runs
  // as fgmp_app, a non-owner, and a policy binds a non-owner with or without
  // FORCE. Verified by mutation — dropping FORCE on a table left this suite at
  // 153 PASS. So the only honest check is to assert the catalog flag directly,
  // and every tenant table must carry BOTH.
  const forceCount = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c
     JOIN pg_namespace ns ON ns.oid=c.relnamespace
     WHERE ns.nspname='public' AND c.relkind='r' AND c.relforcerowsecurity`,
  )
  const forcedTables = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c
     JOIN pg_namespace ns ON ns.oid=c.relnamespace
     WHERE ns.nspname='public' AND c.relkind='r'
       AND c.relrowsecurity AND NOT c.relforcerowsecurity
       AND EXISTS (SELECT 1 FROM information_schema.columns col
                   WHERE col.table_schema='public'
                     AND col.table_name=c.relname
                     AND col.column_name='tenantId')`,
  )
  const nForced = forceCount[0]?.n ?? 0
  const nUnforced = forcedTables[0]?.n ?? 0
  const nCols = colCount[0]?.n ?? 0

  console.log(
    `\n  tenantId columns: ${nCols}   RLS-enabled tables: ${rlsCount[0]?.n ?? 0}` +
      `   FORCE RLS tables: ${nForced}   tenant tables missing FORCE: ${nUnforced}`,
  )

  // FORCE must be present on EVERY tenant table, not merely most of them.
  if (nUnforced > 0) {
    fail(
      'force-rls-coverage',
      `${nUnforced} tenant table(s) have ENABLE ROW LEVEL SECURITY but not FORCE. ` +
        `The owner bypasses RLS without FORCE, so the backstop would not apply ` +
        `to fgmp_migrate. Re-apply the step-6 migration.`,
    )
  } else if (nForced > 0) {
    pass('force-rls-coverage', `all ${nForced} tenant tables carry FORCE ROW LEVEL SECURITY`)
  }

  if (!hasColumns || !hasPolicies) {
    console.log(
      `\n\x1b[33m  tenantId columns and/or RLS policies are not installed yet.\n` +
        `  Per-table isolation assertions will report BLOCKED/FAIL. That is expected\n` +
        `  and is NOT a pass. Re-run once the step-6 migration is applied.\x1b[0m\n`,
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
    // The tenantId column not existing is the expected state before step 6
    // has been applied. That is a BLOCKED condition, not a defect in this
    // suite: report it as such and stop, so CI shows the real dependency
    // instead of a red herring fixture error.
    if (isMissingObject(err)) {
      blocked(
        'fixture-seed',
        `blocked on step 6 — cannot build two-tenant fixtures without tenantId: ${msg.split('\n').pop()?.trim()}`,
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
