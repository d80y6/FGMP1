import { db } from "@/lib/db";
import bcrypt from "bcryptjs";

/**
 * Default demo password for all seeded users. Mirrors the value documented in
 * the worklog (Task 41). Real deployments MUST rotate these via the
 * /api/fgmp/users/[id]/reset-password endpoint.
 */
const SEED_PASSWORD = "Admin@2026";
/**
 * Demo password for the platform super-admin (Task 49). Stronger default so
 * the cross-tenant account is not trivially guessable. Rotate on first login.
 */
const SUPERADMIN_PASSWORD = "Super@2026";
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20240617);
function pick<T>(arr: T[]): T { return arr[Math.floor(rnd() * arr.length)]; }
function range(min: number, max: number) { return min + rnd() * (max - min); }
function intRange(min: number, max: number) { return Math.floor(range(min, max + 1)); }

// National geography: Region -> Governorates (with centroid lat/lng) -> Districts
const GEO: {
  region: string;
  governorates: { name: string; lat: number; lng: number; districts: string[] }[];
}[] = [
  {
    region: "Northern Highlands",
    governorates: [
      { name: "Sana'a", lat: 15.36, lng: 44.19, districts: ["Old Sana'a", "Ma'ain", "Bani Matar", "Hamdan"] },
      { name: "Dhamar", lat: 14.54, lng: 44.4, districts: ["Dhamar City", "Utmah", "Anss"] },
      { name: "Amran", lat: 15.66, lng: 43.82, districts: ["Amran City", "Khamir", "Thula"] },
    ],
  },
  {
    region: "Central Highlands",
    governorates: [
      { name: "Ibb", lat: 13.97, lng: 44.18, districts: ["Ibb City", "Jiblah", "Al-Qafr"] },
      { name: "Taiz", lat: 13.58, lng: 44.02, districts: ["Taiz City", "Al-Mudhaffar", "Salh", "Maqbanah"] },
    ],
  },
  {
    region: "Coastal & Tihama",
    governorates: [
      { name: "Al-Hodeidah", lat: 14.79, lng: 42.95, districts: ["Hodeidah City", "Bajil", "Zabid", "Al-Mansuriyah"] },
      { name: "Al-Mokha", lat: 13.32, lng: 43.28, districts: ["Mokha", "Dhubab"] },
    ],
  },
  {
    region: "Southern & Eastern",
    governorates: [
      { name: "Aden", lat: 12.78, lng: 45.02, districts: ["Crater", "Khormaksar", "Sheikh Othman", "Dar Saad"] },
      { name: "Abyan", lat: 13.5, lng: 45.7, districts: ["Zinjibar", "Khanfar"] },
      { name: "Hadhramaut", lat: 14.53, lng: 49.13, districts: ["Mukalla", "Ghayl Bawazir", "Shihr", "Seiyun"] },
      { name: "Marib", lat: 15.46, lng: 45.32, districts: ["Marib City", "Al-Jubah"] },
    ],
  },
];

const SITE_PREFIXES = ["BTS", "MSC", "Hub", "Repeater", "Data Center", "Switch"];
const SITE_SUFFIXES = ["North", "South", "Ridge", "Summit", "Junction", "Tower", "Plaza", "Industrial", "Coastal", "Highway"];
const GEN_MAKERS = [
  { m: "Cummins", models: ["C220 D5", "C330 D5", "C440 D5"] },
  { m: "FG Wilson", models: ["P220", "P275", "P350"] },
  { m: "Caterpillar", models: ["C9", "C15", "C18"] },
  { m: "Perkins", models: ["4016-61TRS", "4012-46TWG2"] },
];
const IOT_VENDORS = ["E+E Elektronik", "Tetra Sensors", "Atlas Scientific", "Schneider PM5000", "Mikrotik hAP", "Siemens S7-1200"];
const PROTOCOLS = ["RS485", "MODBUS_RTU", "MODBUS_TCP", "MQTT", "HTTP", "SNMP"];
const DEVICE_TYPES = ["FUEL_SENSOR", "GENERATOR_CONTROLLER", "BATTERY_SENSOR", "POWER_METER", "ENVIRONMENTAL"];
const SUPPLIERS = ["Yemen Oil Co.", "Hadramout Fuel Trading", "Aden Petroleum", "Al-Mokha Diesel Supply"];

function siteName(prefix: string, district: string) {
  return `${prefix} ${pick(SITE_SUFFIXES)} - ${district}`;
}

export async function seedIfNeeded(): Promise<{ seeded: boolean; siteCount: number }> {
  // Task 49 — always ensure the platform super-admin exists, even when the
  // rest of the topology is already seeded. This is idempotent and cheap
  // (a single upsert per call) so it's safe to run on every bootstrap().
  await seedSuperAdmin();

  const existing = await db.site.count();
  if (existing > 0) {
    // Even when the main topology is already seeded, ensure dispensers
    // (Task 34-B) are present. This idempotent step seeds dispensers +
    // historical transactions only at sites that have a DIESEL tank.
    await seedDispensers();
    // Task 48 — idempotent seeders for the new edge/OTA tables. Run on
    // every bootstrap() so an existing DB picks up the new rows without a
    // full re-seed. Each is guarded by an existence check so it's a no-op
    // on the second and subsequent calls.
    await seedGateways();
    await seedFirmwareReleases();
    return { seeded: false, siteCount: existing };
  }

  const tenant = await db.tenant.upsert({
    where: { code: "NATIONAL-TELCO" },
    update: {},
    create: { id: "t-default", name: "National Telecom Operator", code: "NATIONAL-TELCO", country: "Yemen" },
  });

  // Seed users for RBAC demo
  const usersData = [
    { id: "u-admin-1", name: "L. Al-Hadhrami", email: "admin@fgmp.telecom", role: "ADMIN" },
    { id: "u-noc-1", name: "A. Al-Rashid", email: "noc.operator@fgmp.telecom", role: "NOC_OPERATOR" },
    { id: "u-rm-1", name: "M. Al-Mikhlafi", email: "regional.manager@fgmp.telecom", role: "REGIONAL_MANAGER" },
    { id: "u-fe-1", name: "S. Al-Subeihi", email: "field.engineer@fgmp.telecom", role: "FIELD_ENGINEER" },
    { id: "u-exec-1", name: "Dr. K. Al-Mutawakel", email: "cto@fgmp.telecom", role: "EXECUTIVE" },
  ];
  // Hash the demo password once for all users (bcrypt is intentionally slow).
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
  for (const u of usersData) {
    // The `update` clause sets passwordHash too — this heals any users that
    // were created by an older seeder version that left passwordHash null
    // (the bug that broke login in Task 41). Idempotent + safe to re-run.
    await db.user.upsert({
      where: { email: u.email },
      update: { passwordHash },
      create: { ...u, tenantId: tenant.id, passwordHash },
    });
  }

  let siteCounter = 0;
  for (const reg of GEO) {
    const region = await db.region.create({ data: { tenantId: tenant.id, name: reg.region } });
    for (const gov of reg.governorates) {
      const governorate = await db.governorate.create({ data: { regionId: region.id, name: gov.name } });
      for (const distName of gov.districts) {
        const district = await db.district.create({ data: { governorateId: governorate.id, name: distName } });
        // 1-2 sites per district
        const nSites = intRange(1, 2);
        for (let i = 0; i < nSites; i++) {
          siteCounter++;
          const prefix = pick(SITE_PREFIXES);
          const code = `SITE-${String(siteCounter).padStart(3, "0")}`;
          const lat = gov.lat + range(-0.08, 0.08);
          const lng = gov.lng + range(-0.08, 0.08);
          const criticality = pick(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
          const loadKw = Math.round(range(2, 18) * 10) / 10;
          const gridAvailable = rnd() > 0.18;
          const powerSource = !gridAvailable ? "GENERATOR" : pick(["HYBRID", "GRID"]);

          const site = await db.site.create({
            data: {
              tenantId: tenant.id,
              code,
              name: siteName(prefix, distName),
              regionId: region.id,
              governorateId: governorate.id,
              districtId: district.id,
              latitude: Math.round(lat * 10000) / 10000,
              longitude: Math.round(lng * 10000) / 10000,
              address: `${distName}, ${gov.name} Governorate`,
              status: "ONLINE",
              criticality,
              loadKw,
              powerSource,
              gridAvailable,
            },
          });

          // Tanks (1-2)
          const tankCount = intRange(1, 2);
          for (let t = 0; t < tankCount; t++) {
            const capacity = pick([1000, 2000, 3000, 5000, 10000]);
            const low = capacity * 0.25;
            const critical = capacity * 0.12;
            const current = Math.round(range(critical * 0.4, capacity * 0.95));
            // Calibration strapping points — FuelTank.calibration stores a
            // JSON array of `{ litres, percent }` (see prisma/schema.prisma).
            const strap: { litres: number; percent: number }[] = [];
            for (let p = 0; p <= 10; p++) {
              strap.push({ litres: (capacity / 10) * p, percent: p * 10 });
            }
            await db.fuelTank.create({
              data: {
                tenantId: site.tenantId,
                siteId: site.id,
                label: `Tank ${String.fromCharCode(65 + t)}`,
                fuelType: "DIESEL",
                capacityLitres: capacity,
                currentLitres: current,
                calibration: JSON.stringify(strap),
                lowThreshold: low,
                criticalThreshold: critical,
                status: "OPERATIONAL",
                lastReadingAt: new Date(),
              },
            });
          }

          // Generators (1-2)
          const genCount = intRange(1, 2);
          for (let g = 0; g < genCount; g++) {
            const maker = pick(GEN_MAKERS);
            const rated = pick([20, 30, 50, 80, 120, 160]);
            const running = powerSource === "GENERATOR" ? rnd() > 0.2 : rnd() > 0.6;
            const runtime = Math.round(range(120, 9200) * 10) / 10;
            await db.generator.create({
              data: {
                tenantId: site.tenantId,
                siteId: site.id,
                label: `Gen ${String.fromCharCode(65 + g)}`,
                manufacturer: maker.m,
                model: pick(maker.models),
                ratedPowerKw: rated,
                status: running ? "RUNNING" : "STOPPED",
                mode: "AUTO",
                runtimeHours: runtime,
                oilChangeIntervalHrs: 250,
                lastOilChangeHrs: Math.round(runtime % 250),
                nextMaintenanceHrs: Math.round((Math.ceil(runtime / 250) + 1) * 250),
                temperatureC: running ? Math.round(range(70, 90)) : Math.round(range(28, 40)),
                oilPressureKpa: running ? Math.round(range(280, 380)) : 0,
                loadKw: running ? Math.round(range(rated * 0.3, rated * 0.75) * 10) / 10 : 0,
                fuelRateLph: running ? Math.round(range(3, 18) * 10) / 10 : 0,
                batteryVoltage: Math.round(range(23.5, 27.5) * 10) / 10,
                lastStartedAt: running ? new Date(Date.now() - intRange(1, 240) * 60000) : null,
                lastStoppedAt: running ? null : new Date(Date.now() - intRange(5, 600) * 60000),
                lastReadingAt: new Date(),
              },
            });
          }

          // Battery bank
          const nomV = pick([24, 48]);
          await db.batteryBank.create({
            data: {
              tenantId: site.tenantId,
              siteId: site.id,
              label: "Bank A",
              chemistry: "VRLA",
              capacityAh: pick([100, 200, 300]),
              nominalVoltage: nomV,
              voltage: Math.round(range(nomV * 0.9, nomV * 1.05) * 100) / 100,
              currentA: Math.round(range(-15, 20) * 10) / 10,
              stateOfCharge: Math.round(range(45, 98)),
              stateOfHealth: Math.round(range(72, 99)),
              temperatureC: Math.round(range(20, 38)),
              charging: rnd() > 0.5,
              status: "OK",
              lastReadingAt: new Date(),
            },
          });

          // IoT devices (2-4)
          const devCount = intRange(2, 4);
          const usedTypes = new Set<string>();
          for (let d = 0; d < devCount; d++) {
            let type = pick(DEVICE_TYPES);
            if (usedTypes.has(type) && d < DEVICE_TYPES.length) type = DEVICE_TYPES[d % DEVICE_TYPES.length];
            usedTypes.add(type);
            await db.iotDevice.create({
              data: {
                tenantId: site.tenantId,
                siteId: site.id,
                name: `${type.replace(/_/g, " ").toLowerCase()} #${d + 1}`,
                type,
                protocol: pick(PROTOCOLS),
                vendor: pick(IOT_VENDORS),
                serialNo: `SN-${site.code}-${d + 1}-${intRange(1000, 9999)}`,
                firmware: `v${pick([1, 2, 3])}.${pick([0, 1, 2, 4, 5])}.${pick([0, 1, 2, 3])}`,
                ipAddress: `10.${intRange(0, 60)}.${intRange(0, 255)}.${intRange(2, 254)}`,
                modbusUnit: type.includes("MODBUS") || rnd() > 0.5 ? intRange(1, 247) : null,
                status: "ONLINE",
                lastSeenAt: new Date(),
                signalRssi: -intRange(55, 95),
              },
            });
          }
        }
      }
    }
  }

  // Seed a few scheduled deliveries and maintenance tickets
  const tanks = await db.fuelTank.findMany({ include: { site: true } });
  const now = Date.now();
  for (let i = 0; i < 8; i++) {
    const tank = pick(tanks);
    const volume = Math.round(tank.capacityLitres * range(0.3, 0.8));
    const status = pick(["SCHEDULED", "SCHEDULED", "IN_TRANSIT", "DELIVERED", "VERIFIED"]);
    const scheduledAt = new Date(now + intRange(-2, 5) * 86400000);
    await db.fuelDelivery.create({
      data: {
        tenantId: tank.site.tenantId,
        siteId: tank.siteId,
        tankId: tank.id,
        supplier: pick(SUPPLIERS),
        driverName: pick(["Hassan", "Ali", "Mohammed", "Fares"]),
        vehiclePlate: `ADA-${intRange(1000, 9999)}`,
        volumeOrderedLitres: volume,
        volumeDeliveredLitres: status === "DELIVERED" || status === "VERIFIED" ? volume : null,
        doNumber: `DO-${intRange(10000, 99999)}`,
        status,
        scheduledAt,
        dispatchedAt: status === "IN_TRANSIT" || status === "DELIVERED" || status === "VERIFIED" ? new Date(scheduledAt.getTime() - 3600000) : null,
        deliveredAt: status === "DELIVERED" || status === "VERIFIED" ? new Date(scheduledAt.getTime() + 1800000) : null,
        verifiedAt: status === "VERIFIED" ? new Date(scheduledAt.getTime() + 2700000) : null,
        unitPrice: Math.round(range(420, 680)),
      },
    });
  }

  const gens = await db.generator.findMany({ include: { site: true } });
  for (let i = 0; i < 6; i++) {
    const g = pick(gens);
    await db.maintenanceTicket.create({
      data: {
        tenantId: g.site.tenantId,
        siteId: g.siteId,
        assetKind: "GENERATOR",
        assetId: g.id,
        type: pick(["PREVENTIVE", "OIL_CHANGE", "INSPECTION", "CORRECTIVE"]),
        status: pick(["OPEN", "OPEN", "SCHEDULED", "IN_PROGRESS"]),
        priority: pick(["P1", "P2", "P3", "P4"]),
        title: `${pick(["Oil change", "Filter replacement", "Coolant service", "Load test", "Bearing inspection"])} — ${g.label}`,
        description: "Auto-generated maintenance requirement based on runtime telemetry.",
        assignedToId: "u-fe-1",
        scheduledFor: new Date(now + intRange(-1, 10) * 86400000),
      },
    });
  }

  // ── Fuel dispensers + historical transactions (Task 34-B) ──────────────
  await seedDispensers();

  // ── Task 48 — edge gateways + ESP firmware releases ─────────────────────
  await seedGateways();
  await seedFirmwareReleases();

  return { seeded: true, siteCount: siteCounter };
}

/**
 * Idempotent dispenser + transaction seeder (Task 34-B).
 *
 * Only seeds dispensers at sites that have a DIESEL tank — these are the
 * fuel/transport hubs. Skipped silently if any dispenser already exists so
 * this can be called on every bootstrap() without duplicating data.
 */
async function seedDispensers(): Promise<void> {
  const existingDispensers = await db.fuelDispenser.count();
  if (existingDispensers > 0) return;

  const dieselTanks = await db.fuelTank.findMany({
    where: { fuelType: "DIESEL" },
    include: { site: true },
  });
  // group DIESEL tanks by site so each site only seeds dispensers once.
  // tenantId is carried through so FuelDispenser/FuelTransaction creates can
  // supply their own required tenantId without re-querying the Site.
  const sitesWithDiesel = new Map<
    string,
    { siteId: string; siteName: string; siteCode: string; tenantId: string }
  >();
  for (const t of dieselTanks) {
    if (!sitesWithDiesel.has(t.siteId)) {
      sitesWithDiesel.set(t.siteId, {
        siteId: t.siteId,
        siteName: t.site.name,
        siteCode: t.site.code,
        tenantId: t.site.tenantId,
      });
    }
  }
  // Pick the first ~12 sites (deterministic — first 12 in insertion order)
  const dispenserSites = Array.from(sitesWithDiesel.values()).slice(0, 12);
  const FIRMWARES = ["v1.0.0", "v1.0.1", "v1.1.0", "v1.2.0", "v1.2.1"];
  const MANUFACTURERS = [
    { m: "Tatsuno", models: ["CR-200", "NRA-45"] },
    { m: "Gilbarco", models: ["Encore 500", "Encore 700"] },
    { m: "Wayne", models: ["iX", "Helix"] },
    { m: "NP", models: ["Sigma-90", "Phoenix-50"] },
  ];
  const PLATES = ["AB-1234", "CD-5678", "EF-9012", "GH-3456", "JK-7890", "LM-2345", "NP-6789", "QR-0123"];
  const OPERATORS = ["Hassan", "Ali", "Mohammed", "Fares", "Sami", "Waleed"];

  const now = Date.now();
  let dispIdx = 0;
  let txnCount = 0;
  const UNIT_PRICE_YER = 520; // ~520 YER per litre of diesel (2024)
  for (const ds of dispenserSites) {
    // 2 dispensers per site (so ~24 total across 12 sites)
    for (let n = 0; n < 2; n++) {
      dispIdx++;
      const maker = pick(MANUFACTURERS);
      const nozzleCount = pick([1, 1, 2, 2, 4]);
      const status = n === 0 && dispIdx % 7 === 0 ? "DISPENSING" : "IDLE";
      const dispenser = await db.fuelDispenser.create({
        data: {
          tenantId: ds.tenantId,
          siteId: ds.siteId,
          label: `Dispenser ${String.fromCharCode(65 + n)}`,
          manufacturer: maker.m,
          model: pick(maker.models),
          nozzleCount,
          fuelType: "DIESEL",
          maxFlowLpm: pick([40, 50, 60]),
          status,
          mode: "AUTO",
          // Task 48 — 1-based pump number per site (n is 0..1, so pumpNumber is 1..2).
          pumpNumber: n + 1,
          espDeviceId: `ESP32-DISP-${String(dispIdx).padStart(3, "0")}`,
          espFirmware: pick(FIRMWARES),
          rs485Baudrate: pick([9600, 19200]),
          rs485Address: (n % 4) + 1,
          rs485Parity: "8N1",
          wifiRssi: -intRange(45, 80),
          ipAddress: `10.${intRange(0, 60)}.${intRange(0, 255)}.${intRange(2, 254)}`,
          lastCommAt: new Date(),
          currentVolumeLitres: status === "DISPENSING" ? Math.round(range(5, 40)) : 0,
          flowRateLpm: status === "DISPENSING" ? Math.round(range(30, 50)) : 0,
          totalizerLitres: Math.round(range(5000, 50000)),
          lastTransactionAt: new Date(now - intRange(5, 240) * 60000),
          tempC: Math.round(range(28, 42)),
        },
      });

      // Seed ~7 historical transactions per dispenser (≈ 80 total)
      // spread over the last 7 days, with realistic volumes 15–75 L.
      for (let tx = 0; tx < 7; tx++) {
        const startedAt = new Date(now - intRange(0, 7 * 24 * 60) * 60000);
        const volume = Math.round(range(15, 75) * 10) / 10;
        const amount = Math.round(volume * UNIT_PRICE_YER);
        const duration = Math.round((volume / pick([35, 40, 45, 50])) * 60);
        const completed = new Date(startedAt.getTime() + duration * 1000);
        await db.fuelTransaction.create({
          data: {
            tenantId: ds.tenantId,
            dispenserId: dispenser.id,
            siteId: ds.siteId,
            nozzle: 1 + intRange(0, nozzleCount - 1),
            volumeLitres: volume,
            amountYer: amount,
            unitPriceYer: UNIT_PRICE_YER,
            vehiclePlate: pick(PLATES),
            operatorName: pick(OPERATORS),
            status: "COMPLETED",
            startedAt,
            completedAt: completed,
            durationSec: duration,
          },
        });
        txnCount++;
      }
    }
  }
  console.log(`[seed] dispensers: ${dispIdx}, transactions: ${txnCount}`);
}

/**
 * Idempotent platform super-admin seeder (Task 49).
 *
 * Ensures the cross-tenant SUPERADMIN account exists on every bootstrap().
 * The super-admin is homed in a dedicated "FGMP Platform" tenant (id
 * `t-platform`) — this is purely an FK anchor; the SUPERADMIN role bypasses
 * tenant isolation entirely (see src/lib/fgmp/auth-helpers.ts).
 *
 * Credentials (demo only — rotate on first login):
 *   email:    superadmin@fgmp.telecom
 *   password: Super@2026
 *
 * On an existing DB this is a no-op update (re-asserts the password hash so
 * a forgotten super-admin password can be healed by editing the constant
 * above and restarting the dev server).
 */
async function seedSuperAdmin(): Promise<void> {
  const platformTenant = await db.tenant.upsert({
    where: { code: "PLATFORM" },
    update: {},
    create: {
      id: "t-platform",
      name: "FGMP Platform",
      code: "PLATFORM",
      country: "Global",
    },
  });

  // CREATE-ONLY. This used to run an upsert whose `update` clause rewrote
  // passwordHash/role/active on every bootstrap() — 144 call sites — which
  // (a) made `superadmin@fgmp.telecom` / `Super@2026` a permanent backdoor,
  //     since no password change or deactivation could ever stick, and
  //     (b) burned a bcrypt cost-10 hash on every single API request.
  // Check existence first so the hash only runs on genuine first boot.
  const existing = await db.user.findUnique({
    where: { email: "superadmin@fgmp.telecom" },
    select: { id: true },
  });
  if (existing) return;

  const passwordHash = await bcrypt.hash(SUPERADMIN_PASSWORD, 10);
  await db.user.create({
    data: {
      id: "u-superadmin-1",
      tenantId: platformTenant.id,
      email: "superadmin@fgmp.telecom",
      name: "Platform Super-Admin",
      role: "SUPERADMIN",
      passwordHash,
    },
  });
  // Bootstrap credentials are a one-time install convenience. In production,
  // rotate this password immediately after first boot (the account now
  // survives rotation — see the create-only branch above).
  console.warn(
    "[seed] created bootstrap super-admin (superadmin@fgmp.telecom) with the default password — rotate it now.",
  );
}

/**
 * Idempotent site-gateway seeder (Task 48).
 *
 * Seeds one SiteGateway row per site that has at least one fuel dispenser
 * (i.e. the fuel/transport hubs where an ESP32 edge gateway would be
 * deployed). Each gateway gets a deterministic hostname like
 * `gw-SITE-001` and randomized live health values (uptime, CPU temp,
 * heap, WiFi RSSI) that the engine tick loop will jitter on every tick.
 *
 * Skipped silently if any gateway already exists so this is safe to call
 * on every bootstrap() without duplicating data.
 */
async function seedGateways(): Promise<void> {
  const existing = await db.siteGateway.count();
  if (existing > 0) return;

  // Pick sites that have at least one dispenser (these are the fuel hubs
  // where an edge gateway would be installed in the real world).
  const dispenserSites = await db.fuelDispenser.findMany({
    select: { siteId: true },
    distinct: ["siteId"],
  });
  if (dispenserSites.length === 0) return;

  const GATEWAY_MODELS = ["ESP32-WROOM-32", "ESP32-PICO-D4", "ESP8266-EX-12F"];
  let count = 0;
  for (const ds of dispenserSites) {
    // Pull the site code to build a friendly hostname.
    const site = await db.site.findUnique({
      where: { id: ds.siteId },
      select: { code: true, name: true, tenantId: true },
    });
    if (!site) continue;
    // 80% ONLINE, 15% DEGRADED, 5% OFFLINE — gives the dashboard a mix.
    const r = rnd();
    const status = r > 0.95 ? "OFFLINE" : r > 0.80 ? "DEGRADED" : "ONLINE";
    await db.siteGateway.create({
      data: {
        tenantId: site.tenantId,
        siteId: ds.siteId,
        hostname: `gw-${site.code.toLowerCase()}`,
        model: pick(GATEWAY_MODELS),
        ipAddress: `10.${intRange(0, 60)}.${intRange(0, 255)}.${intRange(2, 254)}`,
        status,
        uptimeSec: status === "OFFLINE" ? 0 : intRange(3600, 2_500_000),
        cpuTempC: Math.round(range(38, 72) * 10) / 10,
        heapKb: intRange(12, 48),
        wifiRssi: -intRange(48, 88),
        lastSeenAt: status === "OFFLINE" ? new Date(Date.now() - intRange(5, 60) * 60_000) : new Date(),
      },
    });
    count++;
  }
  console.log(`[seed] site gateways: ${count}`);
}

/**
 * Idempotent ESP firmware release seeder (Task 48).
 *
 * Seeds 3 firmware releases (one per channel: stable, beta, hotfix) so the
 * Edge & Firmware view has data to render on first load. Skipped silently
 * if any release already exists so this is safe to call on every
 * bootstrap() without duplicating data.
 *
 * Note: EspFirmwareDeployment rows are NOT seeded — they're created
 * on-demand when an admin kicks off an OTA deployment from the UI.
 */
async function seedFirmwareReleases(): Promise<void> {
  const existing = await db.espFirmwareRelease.count();
  if (existing > 0) return;

  const releases = [
    {
      version: "v2.4.1",
      channel: "stable",
      checksum: "9f1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
      sizeKb: 482,
      releaseNotes:
        "Stable release. Fixes RS485 CRC handling on noisy buses, adds WiFi reconnect backoff, reduces heap fragmentation during long-running dispensing sessions.",
      releasedAt: new Date(Date.now() - 14 * 86_400_000),
    },
    {
      version: "v2.5.0-beta2",
      channel: "beta",
      checksum: "1a2b3c4d5e6f7081920a3b4c5d6e7f8091a2b3c4d5e6f7081920a3b4c5d6e7f80",
      sizeKb: 496,
      releaseNotes:
        "Beta. New modbus-RTU batching for multi-nozzle dispensers, OTA delta-patch support, experimental MQTT telemetry transport. Not for production dispensers.",
      releasedAt: new Date(Date.now() - 3 * 86_400_000),
    },
    {
      version: "v2.4.0-hotfix1",
      channel: "hotfix",
      checksum: "0f1e2d3c4b5a69788796a5b4c3d2e1f00918273645546372a1b0c9d8e7f6a5b4",
      sizeKb: 478,
      releaseNotes:
        "Hotfix for v2.4.0. Resolves a watchdog reset that could occur when the dispenser totalizer exceeds 1,000,000 L. Immediate rollout recommended for high-throughput sites.",
      releasedAt: new Date(Date.now() - 21 * 86_400_000),
    },
  ];

  for (const rel of releases) {
    await db.espFirmwareRelease.create({ data: rel });
  }
  console.log(`[seed] ESP firmware releases: ${releases.length}`);
}
