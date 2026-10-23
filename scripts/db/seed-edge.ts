// Standalone script to seed ESP firmware releases, site gateways, and a few
// historical firmware deployments into an already-seeded FGMP database.
// Run with: bun run scripts/db/seed-edge.ts
//
// This is idempotent: it checks for existing rows before inserting.
import { PrismaClient, type OtaStatus } from "@prisma/client";

/**
 * Owner-role client for system-level seeding (Phase 1 step 6).
 *
 * RLS is FORCE-enabled on every tenant-carrying table, so a write with no
 * `app.tenant_id` in scope fails its WITH CHECK:
 *
 *   ERROR: new row violates row-level security policy for table "User"
 *
 * These scripts seed across tenants (and seed the tenants themselves), so a
 * single per-tenant context cannot cover the work. They run on the owner role
 * instead — the same pattern as src/lib/fgmp/seed.ts. This is a ROLE SPLIT,
 * not a bypass of a tenant boundary: the script picks which tenant each row
 * belongs to.
 */
function systemDb(): PrismaClient {
  const url = process.env.FGMP_MIGRATE_DATABASE_URL;
  if (!url) {
    throw new Error(
      "FGMP_MIGRATE_DATABASE_URL is required: RLS blocks writes on the app role.",
    );
  }
  return new PrismaClient({
    datasources: { db: { url } },
    log: [
      { level: "warn", emit: "stdout" as const },
      { level: "error", emit: "stdout" as const },
    ],
  });
}

const db = systemDb();

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20240715);
function pick<T>(arr: T[]): T { return arr[Math.floor(rnd() * arr.length)]; }
function range(min: number, max: number) { return min + rnd() * (max - min); }
function intRange(min: number, max: number) { return Math.floor(range(min, max + 1)); }
function sha256Fake(version: string): string {
  // Deterministic pseudo-SHA256 (64 hex chars) — not cryptographically real,
  // but stable per version + visually plausible for the dashboard.
  let h = 0x811c9dc5;
  for (let i = 0; i < version.length; i++) {
    h ^= version.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let s = "";
  let x = h >>> 0;
  for (let i = 0; i < 64; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += (x % 16).toString(16);
  }
  return s;
}

const GW_MODELS = ["ESP32-GW-PRO", "ESP32-GW-LITE", "RPI4-GW"];
// Unused: SiteGateway has no firmware column, so gateway firmware cannot be
// seeded until the schema carries one.

const RELEASES = [
  {
    version: "v2.4.0",
    channel: "stable",
    sizeKb: 384,
    releaseNotes:
      "Stable release. Improved Modbus RTU error recovery, fixed totalizer overflow on long-running dispensers, added heartbeat watchdog.",
    releasedAtDaysAgo: 180,
  },
  {
    version: "v2.4.1",
    channel: "stable",
    sizeKb: 392,
    releaseNotes:
      "Hot-fix on top of v2.4.0. Resolves an issue where the RS485 bus could deadlock under heavy traffic (>8 dispensers per gateway).",
    releasedAtDaysAgo: 14,
  },
  {
    version: "v2.5.0-beta",
    channel: "beta",
    sizeKb: 410,
    releaseNotes:
      "Beta preview of the v2.5 series. Adds over-the-air firmware partition swapping (A/B scheme) for zero-downtime updates. Not for production deployment yet.",
    releasedAtDaysAgo: 3,
  },
];


async function main() {
  // ── 1. ESP firmware releases ────────────────────────────────────────────
  let releasesInserted = 0;
  const releaseIdByVersion = new Map<string, string>();
  for (const r of RELEASES) {
    const existing = await db.espFirmwareRelease.findUnique({ where: { version: r.version } });
    if (existing) {
      releaseIdByVersion.set(r.version, existing.id);
      continue;
    }
    const created = await db.espFirmwareRelease.create({
      data: {
        version: r.version,
        channel: r.channel,
        checksum: sha256Fake(r.version),
        sizeKb: r.sizeKb,
        releaseNotes: r.releaseNotes,
        releasedAt: new Date(Date.now() - r.releasedAtDaysAgo * 24 * 3600 * 1000),
      },
    });
    releaseIdByVersion.set(r.version, created.id);
    releasesInserted++;
  }
  console.log(`ESP firmware releases: inserted ${releasesInserted}, total ${releaseIdByVersion.size}.`);

  // ── 2. Distribute dispenser firmware versions ───────────────────────────
  // Make sure dispensers span v2.3.x / v2.4.0 / v2.4.1 so OTA upgrades make
  // sense when an operator picks the v2.4.1 or v2.5.0-beta release in the UI.
  const dispensers = await db.fuelDispenser.findMany({ select: { id: true, espFirmware: true } });
  let dispensersUpdated = 0;
  for (const d of dispensers) {
    // Re-distribute ~30% v2.3.x, ~35% v2.4.0, ~35% v2.4.1
    const r = rnd();
    const target = r < 0.30 ? pick(["v2.3.0", "v2.3.1", "v2.3.2"])
      : r < 0.65 ? "v2.4.0"
      : "v2.4.1";
    if (d.espFirmware !== target) {
      await db.fuelDispenser.update({ where: { id: d.id }, data: { espFirmware: target } });
      dispensersUpdated++;
    }
  }
  console.log(`Dispenser firmware redistributed: ${dispensersUpdated} of ${dispensers.length} dispensers updated.`);

  // ── 3. Site gateways ────────────────────────────────────────────────────
  // One gateway per site that has dispensers. ~85% ONLINE, 10% DEGRADED, 5% OFFLINE.
  const sitesWithDispensers = await db.site.findMany({
    where: { dispensers: { some: {} } },
    // tenantId + dispensers are needed to stamp the denormalised tenant_id on
    // SiteGateway and EspFirmwareDeployment (Phase 1 steps 2-5).
    select: {
      id: true,
      code: true,
      name: true,
      tenantId: true,
      dispensers: { select: { id: true } },
    },
    orderBy: { code: "asc" },
  });

  let gatewaysInserted = 0;
  for (const site of sitesWithDispensers) {
    // SiteGateway has no unique key on siteId (several gateways may share a
    // site), so this is a findFirst existence probe, not findUnique.
    const existing = await db.siteGateway.findFirst({ where: { siteId: site.id } });
    if (existing) continue;

    const r = rnd();
    const status = r < 0.85 ? "ONLINE" : r < 0.95 ? "DEGRADED" : "OFFLINE";
    const codeShort = site.code.replace("SITE-", "").slice(0, 6);
    const hostname = `GW-${codeShort}-${String(intRange(1, 99)).padStart(2, "0")}`;
    const model = pick(GW_MODELS);
    const ip = `10.${intRange(20, 80)}.${intRange(0, 255)}.${intRange(2, 254)}`;
    const uptimeSec = status === "OFFLINE" ? intRange(0, 600) : intRange(3600, 90 * 24 * 3600);
    const cpuTemp = status === "OFFLINE" ? 0 : Math.round(range(42, 78) * 10) / 10;
    const heapKb = status === "OFFLINE" ? 0 : intRange(60, 200);
    const wifiRssi = status === "OFFLINE" ? 0 : status === "DEGRADED" ? intRange(-90, -75) : intRange(-70, -45);
    const lastSeenAt = status === "OFFLINE"
      ? new Date(Date.now() - intRange(5, 120) * 60 * 1000)
      : new Date();

    // NOTE: SiteGateway has no `firmware` or `macAddress` column — the
    // gateway firmware/mac identity it used to carry was never added to the
    // schema, so GW_FIRMWARES and the generated MAC are not persisted here.
    await db.siteGateway.create({
      data: {
        siteId: site.id,
        tenantId: site.tenantId,
        hostname,
        model,
        ipAddress: ip,
        uptimeSec,
        cpuTempC: cpuTemp,
        heapKb,
        wifiRssi,
        lastSeenAt,
        status,
      },
    });
    gatewaysInserted++;
  }
  console.log(`Site gateways: inserted ${gatewaysInserted} (sites-with-dispensers: ${sitesWithDispensers.length}).`);

  // ── 4. Historical firmware deployments ──────────────────────────────────
  // 5-10 mixed-status deployments on random dispensers. Idempotent: if the
  // DB already has ≥5 deployments, skip re-seeding (so re-running the script
  // doesn't pile up endless historical rows). Otherwise wipe & insert a
  // realistic mix: mostly SUCCESS, 1 FAILED, 1 in-progress DOWNLOADING.
  const existingDepCount = await db.espFirmwareDeployment.count();
  let deploymentsInserted = 0;
  const adminUser = await db.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });

  if (existingDepCount >= 5) {
    console.log(`Historical firmware deployments: already ${existingDepCount} present — skipping (idempotent).`);
  } else {
    // Wipe any stragglers so the mix is deterministic.
    if (existingDepCount > 0) await db.espFirmwareDeployment.deleteMany({});
    // NOTE: EspFirmwareDeployment has no fromVersion / toVersion / progressPct /
    // errorMessage columns — the "from" version, progress and failure reason
    // are not persisted. `fromVersion`, `progressPct` and `errMsg` are kept
    // here only to keep the fixture readable; `toVersion` is the one that
    // matters, because it selects the EspFirmwareRelease row.
    // Annotated so `status` keeps the OtaStatus enum type through the literal;
    // a bare array widens it to `string`, which the strict column rejects.
    const targets: Array<{
      fromVersion: string; toVersion: string; status: OtaStatus;
      progressPct: number; daysAgo: number; durSec: number;
      inProgress?: boolean; errMsg?: string;
    }> = [
      { fromVersion: "v2.3.0", toVersion: "v2.4.0", status: "SUCCESS", progressPct: 100, daysAgo: 28, durSec: 180 },
      { fromVersion: "v2.3.1", toVersion: "v2.4.1", status: "SUCCESS", progressPct: 100, daysAgo: 22, durSec: 220 },
      { fromVersion: "v2.3.2", toVersion: "v2.4.0", status: "SUCCESS", progressPct: 100, daysAgo: 18, durSec: 150 },
      { fromVersion: "v2.4.0", toVersion: "v2.4.1", status: "SUCCESS", progressPct: 100, daysAgo: 12, durSec: 95 },
      { fromVersion: "v2.3.0", toVersion: "v2.4.1", status: "SUCCESS", progressPct: 100, daysAgo: 8, durSec: 210 },
      { fromVersion: "v2.3.2", toVersion: "v2.4.0", status: "SUCCESS", progressPct: 100, daysAgo: 4, durSec: 130 },
      { fromVersion: "v2.3.1", toVersion: "v2.4.1", status: "FAILED", progressPct: 60, daysAgo: 6, durSec: 75, errMsg: "Flash verification failed — image checksum mismatch" },
      { fromVersion: "v2.4.0", toVersion: "v2.5.0-beta", status: "DOWNLOADING", progressPct: 20, daysAgo: 0, durSec: 0, inProgress: true },
    ];
    for (let i = 0; i < targets.length; i++) {
      const tgt = targets[i];
      const releaseId = releaseIdByVersion.get(tgt.toVersion);
      if (!releaseId || dispensers.length === 0) continue;
      const disp = dispensers[i % dispensers.length];
      // EspFirmwareDeployment inherits tenancy from the dispenser's site, so
      // resolve the owning tenant from the site rather than from the
      // deployment itself (Phase 1 steps 2-5).
      const dispSite = sitesWithDispensers.find((s) =>
        s.dispensers.some((d) => d.id === disp.id),
      );
      // Every dispenser was created under a site, so this must resolve. Skip
      // rather than invent a tenant: EspFirmwareDeployment.tenant_id is NOT
      // NULL, and a guessed tenant would be protected by RLS in the wrong
      // place forever.
      if (!dispSite) continue;
      const startedAt = new Date(Date.now() - tgt.daysAgo * 24 * 3600 * 1000 - (tgt.inProgress ? 90 * 1000 : 0));
      const completedAt = tgt.inProgress ? null : new Date(startedAt.getTime() + tgt.durSec * 1000);
      await db.espFirmwareDeployment.create({
        data: {
          dispenserId: disp.id,
          tenantId: dispSite.tenantId,
          releaseId,
          status: tgt.status,
          startedAt,
          completedAt,
          initiatedById: adminUser?.id ?? null,
        },
      });
      deploymentsInserted++;
    }
    console.log(`Historical firmware deployments: inserted ${deploymentsInserted} (idempotent reset).`);
  }
}

main()
  .then(() => db.$disconnect())
  .catch((e) => { console.error(e); process.exit(1); });
