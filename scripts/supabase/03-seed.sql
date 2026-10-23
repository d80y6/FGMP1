-- ═══════════════════════════════════════════════════════════════════════════
-- FGMP — minimum data for a working deployment
--
-- Run AFTER 02-schema.sql, connected as a SUPERUSER (or a role with BYPASSRLS).
-- On Supabase: SQL editor (runs as `postgres`).
--
-- WHY A SUPERUSER: this script writes rows for TWO tenants (t-platform holds
-- the platform operator, t-default holds the fleet). FORCE ROW LEVEL SECURITY
-- is active on every tenant table, and a single `app.tenant_id` cannot cover
-- two tenants — so the seed runs where RLS does not apply, exactly like
-- `bun run db:seed` does through FGMP_MIGRATE_DATABASE_URL in compose/CI.
--
-- SAFE TO RE-RUN. Every insert is keyed on a fixed id and uses
-- `on conflict do nothing`, so an existing row is never overwritten and a
-- partially-applied seed can simply be run again.
--
-- ── CREDENTIALS CREATED HERE ───────────────────────────────────────────────
--   superadmin@fgmp.telecom  Super@2026    (SUPERADMIN, tenant t-platform)
--   admin@fgmp.telecom       Admin@2026    (ADMIN,     tenant t-default)
--   noc.operator@… / regional.manager@… / field.engineer@… / cto@…
--                            Admin@2026    (one per role, for RBAC review)
--
-- These are DEMO credentials and are in the repository on purpose: the seed in
-- src/lib/fgmp/seed.ts creates the same accounts, so a deployment that never
-- rotates them is indistinguishable from the demo. Before exposing the app to
-- a network you do not control:
--     1. sign in as the super-admin and change its password, or delete it and
--        create your own through the UI (Users → New user);
--     2. change or delete the five demo accounts;
--     3. confirm `select email, role from "User"` shows only accounts you own.
-- The seed is CREATE-ONLY (an existing row is never updated), so a password
-- changed in the UI survives a re-seed.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if not (select rolsuper from pg_roles where rolname = current_user)
     and not (select rolbypassrls from pg_roles where rolname = current_user) then
    raise exception
      'Run this seed as a superuser or a BYPASSRLS role. It writes rows for more than one tenant, and FORCE RLS rejects every such insert with "new row violates row-level security policy".';
  end if;

  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'Tenant') then
    raise exception 'The FGMP schema is missing — run 02-schema.sql first.';
  end if;
end $$;

begin;

-- ── Tenants ────────────────────────────────────────────────────────────────
insert into "Tenant" (id, name, code, country, "createdAt", "updatedAt") values
  ('t-platform', 'FGMP Platform',              'PLATFORM',       'Global', now() - interval '30 days', now()),
  ('t-default',  'National Telecom Operator',  'NATIONAL-TELCO', 'Yemen',  now() - interval '30 days', now())
on conflict do nothing;

-- ── Users ──────────────────────────────────────────────────────────────────
-- updatedAt is NOT NULL without a default: it is maintained by Prisma's
-- @updatedAt, which does not exist for a raw INSERT.
insert into "User" (id, "tenantId", email, name, role, "passwordHash", active, "createdAt", "updatedAt") values
  ('u-super-1', 't-platform', 'superadmin@fgmp.telecom', 'Platform Administrator', 'SUPERADMIN', '$2b$10$2xIUZRH34dfn24hdyOS5Ou3UtJuESeY/uqv1IKiQCP3IkSCOQIFeC', true, now() - interval '30 days', now()),
  ('u-admin-1', 't-default', 'admin@fgmp.telecom', 'L. Al-Hadhrami', 'ADMIN', '$2b$10$na8yAbGqhuKTbVhr0OF1neKLlAHNkKf9s6vwjleM1Ng00PjP6NYRm', true, now() - interval '30 days', now()),
  ('u-noc-1', 't-default', 'noc.operator@fgmp.telecom', 'A. Al-Rashid', 'NOC_OPERATOR', '$2b$10$na8yAbGqhuKTbVhr0OF1neKLlAHNkKf9s6vwjleM1Ng00PjP6NYRm', true, now() - interval '30 days', now()),
  ('u-rm-1', 't-default', 'regional.manager@fgmp.telecom', 'M. Al-Mikhlafi', 'REGIONAL_MANAGER', '$2b$10$na8yAbGqhuKTbVhr0OF1neKLlAHNkKf9s6vwjleM1Ng00PjP6NYRm', true, now() - interval '30 days', now()),
  ('u-fe-1', 't-default', 'field.engineer@fgmp.telecom', 'S. Al-Subeihi', 'FIELD_ENGINEER', '$2b$10$na8yAbGqhuKTbVhr0OF1neKLlAHNkKf9s6vwjleM1Ng00PjP6NYRm', true, now() - interval '30 days', now()),
  ('u-exec-1', 't-default', 'cto@fgmp.telecom', 'Dr. K. Al-Mutawakel', 'EXECUTIVE', '$2b$10$na8yAbGqhuKTbVhr0OF1neKLlAHNkKf9s6vwjleM1Ng00PjP6NYRm', true, now() - interval '30 days', now())
on conflict do nothing;

-- ── Geography (tenant t-default) ───────────────────────────────────────────
insert into "Region" (id, "tenantId", name, "createdAt") values
  ('r-north', 't-default', 'Northern Highlands', now() - interval '30 days'),
  ('r-central', 't-default', 'Central Highlands', now() - interval '30 days'),
  ('r-coastal', 't-default', 'Coastal & Tihama', now() - interval '30 days'),
  ('r-south', 't-default', 'Southern & Eastern', now() - interval '30 days')
on conflict do nothing;

insert into "Governorate" (id, "regionId", name, "createdAt") values
  ('g-sanaa', 'r-north', 'Sana''a', now() - interval '30 days'),
  ('g-dhamar', 'r-north', 'Dhamar', now() - interval '30 days'),
  ('g-amran', 'r-north', 'Amran', now() - interval '30 days'),
  ('g-ibb', 'r-central', 'Ibb', now() - interval '30 days'),
  ('g-taiz', 'r-central', 'Taiz', now() - interval '30 days'),
  ('g-hodeidah', 'r-coastal', 'Al-Hodeidah', now() - interval '30 days'),
  ('g-mokha', 'r-coastal', 'Al-Mokha', now() - interval '30 days'),
  ('g-aden', 'r-south', 'Aden', now() - interval '30 days'),
  ('g-abyan', 'r-south', 'Abyan', now() - interval '30 days'),
  ('g-hadramaut', 'r-south', 'Hadhramaut', now() - interval '30 days'),
  ('g-marib', 'r-south', 'Marib', now() - interval '30 days')
on conflict do nothing;

insert into "District" (id, "governorateId", name, "createdAt") values
  ('d-old-sanaa', 'g-sanaa', 'Old Sana''a', now() - interval '30 days'),
  ('d-maain', 'g-sanaa', 'Ma''ain', now() - interval '30 days'),
  ('d-bani-matar', 'g-sanaa', 'Bani Matar', now() - interval '30 days'),
  ('d-dhamar-city', 'g-dhamar', 'Dhamar City', now() - interval '30 days'),
  ('d-utmah', 'g-dhamar', 'Utmah', now() - interval '30 days'),
  ('d-anss', 'g-dhamar', 'Anss', now() - interval '30 days'),
  ('d-amran-city', 'g-amran', 'Amran City', now() - interval '30 days'),
  ('d-khamir', 'g-amran', 'Khamir', now() - interval '30 days'),
  ('d-ibb-city', 'g-ibb', 'Ibb City', now() - interval '30 days'),
  ('d-jiblah', 'g-ibb', 'Jiblah', now() - interval '30 days'),
  ('d-taiz-city', 'g-taiz', 'Taiz City', now() - interval '30 days'),
  ('d-al-mudhaffar', 'g-taiz', 'Al-Mudhaffar', now() - interval '30 days'),
  ('d-salh', 'g-taiz', 'Salh', now() - interval '30 days'),
  ('d-hodeidah-city', 'g-hodeidah', 'Hodeidah City', now() - interval '30 days'),
  ('d-bajil', 'g-hodeidah', 'Bajil', now() - interval '30 days'),
  ('d-zabid', 'g-hodeidah', 'Zabid', now() - interval '30 days'),
  ('d-mokha', 'g-mokha', 'Mokha', now() - interval '30 days'),
  ('d-dhubab', 'g-mokha', 'Dhubab', now() - interval '30 days'),
  ('d-crater', 'g-aden', 'Crater', now() - interval '30 days'),
  ('d-khormaksar', 'g-aden', 'Khormaksar', now() - interval '30 days'),
  ('d-dar-saad', 'g-aden', 'Dar Saad', now() - interval '30 days'),
  ('d-zinjibar', 'g-abyan', 'Zinjibar', now() - interval '30 days'),
  ('d-khanfar', 'g-abyan', 'Khanfar', now() - interval '30 days'),
  ('d-mukalla', 'g-hadramaut', 'Mukalla', now() - interval '30 days'),
  ('d-seiyun', 'g-hadramaut', 'Seiyun', now() - interval '30 days'),
  ('d-marib-city', 'g-marib', 'Marib City', now() - interval '30 days'),
  ('d-al-jubah', 'g-marib', 'Al-Jubah', now() - interval '30 days')
on conflict do nothing;

-- ── Sites ──────────────────────────────────────────────────────────────────
insert into "Site" (id, "tenantId", code, name, "regionId", "governorateId", "districtId",
                   latitude, longitude, address, "loadKw", "protectedLoadKw", "gridAvailable",
                   status, criticality, "powerSource", "createdAt", "updatedAt") values
  ('s-sanaa-01', 't-default', 'FGMP-001', 'Sana''a North BTS', 'r-north', 'g-sanaa', 'd-old-sanaa',
   15.39, 44.21, 'Ring Road, Sana''a', 45, 30, true,
   'ONLINE', 'CRITICAL', 'HYBRID', now() - interval '30 days', now()),
  ('s-dhamar-01', 't-default', 'FGMP-002', 'Dhamar Ridge', 'r-north', 'g-dhamar', 'd-dhamar-city',
   14.56, 44.42, 'Dhamar ridge road', 32, 20, true,
   'DEGRADED', 'HIGH', 'GENERATOR', now() - interval '30 days', now()),
  ('s-taiz-01', 't-default', 'FGMP-003', 'Taiz Summit', 'r-central', 'g-taiz', 'd-taiz-city',
   13.6, 44.04, 'Jabal Sabir approach, Taiz', 60, 45, false,
   'ONLINE', 'HIGH', 'HYBRID', now() - interval '30 days', now()),
  ('s-ibb-01', 't-default', 'FGMP-004', 'Ibb Junction', 'r-central', 'g-ibb', 'd-ibb-city',
   13.99, 44.2, 'Junction 4, Ibb', 25, 15, true,
   'ONLINE', 'MEDIUM', 'GRID', now() - interval '30 days', now()),
  ('s-hodeidah-01', 't-default', 'FGMP-005', 'Hodeidah Coastal', 'r-coastal', 'g-hodeidah', 'd-hodeidah-city',
   14.81, 42.97, 'Coastal highway, Hodeidah', 80, 55, false,
   'ONLINE', 'CRITICAL', 'GENERATOR', now() - interval '30 days', now()),
  ('s-mokha-01', 't-default', 'FGMP-006', 'Mokha Tower', 'r-coastal', 'g-mokha', 'd-mokha',
   13.34, 43.3, 'Port road, Mokha', 20, 12, false,
   'OFFLINE', 'MEDIUM', 'HYBRID', now() - interval '30 days', now()),
  ('s-aden-01', 't-default', 'FGMP-007', 'Aden Plaza', 'r-south', 'g-aden', 'd-crater',
   12.8, 45.04, 'Crater district, Aden', 55, 40, true,
   'ONLINE', 'HIGH', 'HYBRID', now() - interval '30 days', now()),
  ('s-mukalla-01', 't-default', 'FGMP-008', 'Mukalla Data Center', 'r-south', 'g-hadramaut', 'd-mukalla',
   14.55, 49.15, 'Industrial zone, Mukalla', 120, 90, true,
   'ONLINE', 'CRITICAL', 'HYBRID', now() - interval '30 days', now())
on conflict do nothing;

-- ── Tanks: one per site, with a realistic fill level ───────────────────────
insert into "FuelTank" (id, "tenantId", "siteId", label, "capacityLitres", "currentLitres",
                      calibration, "lowThreshold", "criticalThreshold", "fuelType", status,
                      "createdAt", "updatedAt") values
  ('tk-001', 't-default', 's-sanaa-01', 'Main tank', 5000, 3600,
   'linear', 1250, 500, 'DIESEL', 'OPERATIONAL', now() - interval '30 days', now()),
  ('tk-002', 't-default', 's-dhamar-01', 'Main tank', 2000, 760,
   'linear', 500, 200, 'DIESEL', 'OPERATIONAL', now() - interval '30 days', now()),
  ('tk-003', 't-default', 's-taiz-01', 'Main tank', 5000, 4250,
   'linear', 1250, 500, 'DIESEL', 'OPERATIONAL', now() - interval '30 days', now()),
  ('tk-004', 't-default', 's-ibb-01', 'Main tank', 2000, 1100,
   'linear', 500, 200, 'DIESEL', 'OPERATIONAL', now() - interval '30 days', now()),
  ('tk-005', 't-default', 's-hodeidah-01', 'Main tank', 5000, 1050,
   'linear', 1250, 500, 'DIESEL', 'OPERATIONAL', now() - interval '30 days', now()),
  ('tk-006', 't-default', 's-mokha-01', 'Main tank', 2000, 180,
   'linear', 500, 200, 'DIESEL', 'EMPTY', now() - interval '30 days', now()),
  ('tk-007', 't-default', 's-aden-01', 'Main tank', 5000, 3300,
   'linear', 1250, 500, 'DIESEL', 'OPERATIONAL', now() - interval '30 days', now()),
  ('tk-008', 't-default', 's-mukalla-01', 'Main tank', 2000, 1820,
   'linear', 500, 200, 'DIESEL', 'OPERATIONAL', now() - interval '30 days', now())
on conflict do nothing;

-- ── Generators ─────────────────────────────────────────────────────────────
insert into "Generator" (id, "tenantId", "siteId", label, manufacturer, model, "ratedPowerKw",
                      "fuelType", "runtimeHours", "lastOilChangeHrs", "nextMaintenanceHrs",
                      "temperatureC", "oilPressureKpa", "loadKw", "fuelRateLph", "batteryVoltage",
                      status, mode, "createdAt", "updatedAt") values
  ('gen-001', 't-default', 's-sanaa-01', 'Main generator', 'Cummins', 'C220 D5', 250,
   'DIESEL', 380, 300, 550, 68, 330, 42, 9.2,
   24.4, 'RUNNING', 'AUTO', now() - interval '30 days', now()),
  ('gen-002', 't-default', 's-dhamar-01', 'Main generator', 'FG Wilson', 'P220', 250,
   'DIESEL', 427, 320, 570, 41, 330, 0, 0,
   24.4, 'STOPPED', 'AUTO', now() - interval '30 days', now()),
  ('gen-003', 't-default', 's-taiz-01', 'Main generator', 'Caterpillar', 'C9', 250,
   'DIESEL', 474, 340, 590, 72, 330, 55, 12.1,
   24.4, 'RUNNING', 'AUTO', now() - interval '30 days', now()),
  ('gen-004', 't-default', 's-ibb-01', 'Main generator', 'Perkins', '4016-61TRS', 250,
   'DIESEL', 521, 360, 610, 39, 330, 0, 0,
   24.4, 'STOPPED', 'AUTO', now() - interval '30 days', now()),
  ('gen-005', 't-default', 's-hodeidah-01', 'Main generator', 'Cummins', 'C220 D5', 250,
   'DIESEL', 568, 380, 630, 88, 330, 70, 15.4,
   24.4, 'RUNNING', 'AUTO', now() - interval '30 days', now()),
  ('gen-006', 't-default', 's-mokha-01', 'Main generator', 'FG Wilson', 'P220', 250,
   'DIESEL', 615, 400, 650, 95, 330, 0, 0,
   24.4, 'FAULT', 'AUTO', now() - interval '30 days', now()),
  ('gen-007', 't-default', 's-aden-01', 'Main generator', 'Caterpillar', 'C9', 250,
   'DIESEL', 662, 420, 670, 66, 330, 48, 10.6,
   24.4, 'RUNNING', 'AUTO', now() - interval '30 days', now()),
  ('gen-008', 't-default', 's-mukalla-01', 'Main generator', 'Perkins', '4016-61TRS', 250,
   'DIESEL', 709, 440, 690, 70, 330, 95, 20.9,
   24.4, 'RUNNING', 'AUTO', now() - interval '30 days', now())
on conflict do nothing;

-- ── Battery banks ──────────────────────────────────────────────────────────
insert into "BatteryBank" (id, "tenantId", "siteId", label, chemistry, "capacityAh",
                        "nominalVoltage", voltage, "currentA", "stateOfCharge", "stateOfHealth",
                        "temperatureC", charging, status, "installedAt", "updatedAt") values
  ('bat-001', 't-default', 's-sanaa-01', 'Battery bank A', 'VRLA', 200,
   48, 61.4, 21.5, 86, 88, 27.5, false,
   'OK', now() - interval '200 days', now()),
  ('bat-002', 't-default', 's-dhamar-01', 'Battery bank A', 'VRLA', 200,
   48, 53.8, 13.5, 54, 89, 27.5, true,
   'OK', now() - interval '240 days', now()),
  ('bat-003', 't-default', 's-taiz-01', 'Battery bank A', 'VRLA', 200,
   48, 62.9, 23.0, 92, 90, 27.5, true,
   'OK', now() - interval '280 days', now()),
  ('bat-004', 't-default', 's-ibb-01', 'Battery bank A', 'VRLA', 200,
   48, 59.5, 19.5, 78, 91, 27.5, false,
   'OK', now() - interval '320 days', now()),
  ('bat-005', 't-default', 's-hodeidah-01', 'Battery bank A', 'VRLA', 200,
   48, 48.7, 8.2, 33, 92, 27.5, true,
   'LOW', now() - interval '360 days', now()),
  ('bat-006', 't-default', 's-mokha-01', 'Battery bank A', 'VRLA', 200,
   48, 43.7, 3.0, 12, 93, 27.5, true,
   'LOW', now() - interval '400 days', now()),
  ('bat-007', 't-default', 's-aden-01', 'Battery bank A', 'VRLA', 200,
   48, 60.2, 20.2, 81, 94, 27.5, false,
   'OK', now() - interval '440 days', now()),
  ('bat-008', 't-default', 's-mukalla-01', 'Battery bank A', 'VRLA', 200,
   48, 63.6, 23.8, 95, 95, 27.5, false,
   'OK', now() - interval '480 days', now())
on conflict do nothing;

-- ── Dispensers ─────────────────────────────────────────────────────────────
insert into "FuelDispenser" (id, "tenantId", "siteId", label, manufacturer, model, "nozzleCount",
                          "maxFlowLpm", mode, "pumpNumber", "espDeviceId", "espFirmware",
                          "currentVolumeLitres", "flowRateLpm", "totalizerLitres", "tempC",
                          "fuelType", status, "createdAt", "updatedAt") values
  ('disp-001', 't-default', 's-sanaa-01', 'Dispenser 1', 'Gilbarco', 'Encore 500', 1,
   40, 'AUTO', 1, 'esp-001-01', 'v1.4.2', 0, 0, 12000, 34.5,
   'DIESEL', 'IDLE', now() - interval '30 days', now()),
  ('disp-002', 't-default', 's-dhamar-01', 'Dispenser 1', 'Gilbarco', 'Encore 500', 1,
   40, 'AUTO', 1, 'esp-002-01', 'v1.4.2', 0, 0, 15100, 34.5,
   'DIESEL', 'IDLE', now() - interval '30 days', now()),
  ('disp-003', 't-default', 's-taiz-01', 'Dispenser 1', 'Gilbarco', 'Encore 500', 1,
   40, 'AUTO', 1, 'esp-003-01', 'v1.4.2', 0, 0, 18200, 34.5,
   'DIESEL', 'IDLE', now() - interval '30 days', now()),
  ('disp-004', 't-default', 's-ibb-01', 'Dispenser 1', 'Gilbarco', 'Encore 500', 1,
   40, 'AUTO', 1, 'esp-004-01', 'v1.4.2', 0, 0, 21300, 34.5,
   'DIESEL', 'IDLE', now() - interval '30 days', now()),
  ('disp-005', 't-default', 's-hodeidah-01', 'Dispenser 1', 'Gilbarco', 'Encore 500', 1,
   40, 'AUTO', 1, 'esp-005-01', 'v1.4.2', 0, 0, 24400, 34.5,
   'DIESEL', 'IDLE', now() - interval '30 days', now()),
  ('disp-006', 't-default', 's-mokha-01', 'Dispenser 1', 'Gilbarco', 'Encore 500', 1,
   40, 'AUTO', 1, 'esp-006-01', 'v1.4.2', 0, 0, 27500, 34.5,
   'DIESEL', 'FAULT', now() - interval '30 days', now()),
  ('disp-007', 't-default', 's-aden-01', 'Dispenser 1', 'Gilbarco', 'Encore 500', 1,
   40, 'AUTO', 1, 'esp-007-01', 'v1.4.2', 0, 0, 30600, 34.5,
   'DIESEL', 'IDLE', now() - interval '30 days', now()),
  ('disp-008', 't-default', 's-mukalla-01', 'Dispenser 1', 'Gilbarco', 'Encore 500', 1,
   40, 'AUTO', 1, 'esp-008-01', 'v1.4.2', 0, 0, 33700, 34.5,
   'DIESEL', 'IDLE', now() - interval '30 days', now())
on conflict do nothing;

-- ── IoT devices ────────────────────────────────────────────────────────────
insert into "IotDevice" (id, "tenantId", "siteId", name, type, vendor, "serialNo", firmware,
                      "signalRssi", protocol, status, "createdAt", "updatedAt") values
  ('iot-001', 't-default', 's-sanaa-01', 'Tank level sensor', 'LEVEL', 'E+E Elektronik',
   'SN-001-001', 'v2.1.0', -58, 'MQTT', 'ONLINE', now() - interval '30 days', now()),
  ('iot-002', 't-default', 's-dhamar-01', 'Tank level sensor', 'LEVEL', 'E+E Elektronik',
   'SN-002-001', 'v2.1.0', -61, 'MQTT', 'ONLINE', now() - interval '30 days', now()),
  ('iot-003', 't-default', 's-taiz-01', 'Tank level sensor', 'LEVEL', 'E+E Elektronik',
   'SN-003-001', 'v2.1.0', -64, 'MQTT', 'ONLINE', now() - interval '30 days', now()),
  ('iot-004', 't-default', 's-ibb-01', 'Tank level sensor', 'LEVEL', 'E+E Elektronik',
   'SN-004-001', 'v2.1.0', -67, 'MQTT', 'ONLINE', now() - interval '30 days', now()),
  ('iot-005', 't-default', 's-hodeidah-01', 'Tank level sensor', 'LEVEL', 'E+E Elektronik',
   'SN-005-001', 'v2.1.0', -70, 'MQTT', 'ONLINE', now() - interval '30 days', now()),
  ('iot-006', 't-default', 's-mokha-01', 'Tank level sensor', 'LEVEL', 'E+E Elektronik',
   'SN-006-001', 'v2.1.0', -73, 'MQTT', 'OFFLINE', now() - interval '30 days', now()),
  ('iot-007', 't-default', 's-aden-01', 'Tank level sensor', 'LEVEL', 'E+E Elektronik',
   'SN-007-001', 'v2.1.0', -76, 'MQTT', 'ONLINE', now() - interval '30 days', now()),
  ('iot-008', 't-default', 's-mukalla-01', 'Tank level sensor', 'LEVEL', 'E+E Elektronik',
   'SN-008-001', 'v2.1.0', -79, 'MQTT', 'ONLINE', now() - interval '30 days', now())
on conflict do nothing;

-- ── Alarms ─────────────────────────────────────────────────────────────────
insert into "Alarm" (id, "tenantId", "siteId", type, severity, status, "escalationLevel",
                   message, "createdAt") values
  ('al-001', 't-default', 's-sanaa-01', 'FUEL_LOW', 'L2', 'OPEN', 1, 'Main tank at 72% of low threshold', now() - interval '2 hours'),
  ('al-002', 't-default', 's-dhamar-01', 'GEN_OVERHEAT', 'L3', 'ACKNOWLEDGED', 2, 'Generator coolant 95 °C, above 90 °C limit', now() - interval '5 hours'),
  ('al-003', 't-default', 's-mokha-01', 'COMM_LOSS', 'L2', 'OPEN', 1, 'Tank sensor silent for 42 minutes', now() - interval '1 hour'),
  ('al-004', 't-default', 's-hodeidah-01', 'FUEL_CRITICAL', 'L3', 'ESCALATED', 2, 'Main tank below 10% critical threshold', now() - interval '25 minutes'),
  ('al-005', 't-default', 's-aden-01', 'DISPENSER_FAULT', 'L2', 'RESOLVED', 1, 'Nozzle totalizer mismatch, cleared after recalibration', now() - interval '2 days')
on conflict do nothing;

-- ── Fuel deliveries ────────────────────────────────────────────────────────
insert into "FuelDelivery" (id, "tenantId", "siteId", "tankId", supplier,
                         "volumeOrderedLitres", "doNumber", "scheduledAt", "unitPrice",
                         status, "createdAt", "updatedAt") values
  ('dl-001', 't-default', 's-sanaa-01', 'tk-001', 'Yemen Oil Co.', 3000, 'DO-2026-0411', now() + interval '-2 days', 745,
   'DELIVERED', now() - interval '10 days', now()),
  ('dl-002', 't-default', 's-hodeidah-01', 'tk-005', 'Aden Fuel Trading', 5000, 'DO-2026-0412', now() + interval '1 day', 752,
   'SCHEDULED', now() - interval '10 days', now()),
  ('dl-003', 't-default', 's-taiz-01', 'tk-003', 'Yemen Oil Co.', 2500, 'DO-2026-0413', now() + interval '-6 hours', 748,
   'IN_TRANSIT', now() - interval '10 days', now()),
  ('dl-004', 't-default', 's-mukalla-01', 'tk-008', 'Hadramaut Petroleum', 4000, 'DO-2026-0414', now() + interval '-1 day', 739,
   'VERIFIED', now() - interval '10 days', now())
on conflict do nothing;

-- ── Maintenance tickets ────────────────────────────────────────────────────
insert into "MaintenanceTicket" (id, "tenantId", "siteId", "assetKind", "assetId", type, title,
                              status, priority, "createdAt", "updatedAt") values
  ('mt-001', 't-default', 's-dhamar-01', 'GENERATOR', 'gen-002', 'CORRECTIVE', 'Replace coolant thermostat after overheat alarm', 'IN_PROGRESS', 'P1',
   now() - interval '3 days', now()),
  ('mt-002', 't-default', 's-mokha-01', 'IOT_DEVICE', 'iot-006', 'CORRECTIVE', 'Restore comms on tank level sensor', 'OPEN', 'P2',
   now() - interval '4 days', now()),
  ('mt-003', 't-default', 's-sanaa-01', 'GENERATOR', 'gen-001', 'PREVENTIVE', '250-hour oil and filter change', 'SCHEDULED', 'P3',
   now() - interval '5 days', now())
on conflict do nothing;

-- ── Fuel transactions: two days of dispensing history ──────────────────────
insert into "FuelTransaction" (id, "tenantId", "siteId", "dispenserId", nozzle, "volumeLitres",
                           "amountYer", "unitPriceYer", "startedAt", "durationSec", status, "createdAt") values
  ('tx-001', 't-default', 's-sanaa-01', 'disp-001', 1, 63, 46935, 745,
   now() - interval '1 days 0 hours', 180, 'COMPLETED', now() - interval '1 days 0 hours'),
  ('tx-002', 't-default', 's-taiz-01', 'disp-003', 1, 80, 59600, 745,
   now() - interval '1 days 1 hours', 205, 'COMPLETED', now() - interval '1 days 1 hours'),
  ('tx-003', 't-default', 's-ibb-01', 'disp-004', 1, 97, 72265, 745,
   now() - interval '1 days 2 hours', 230, 'COMPLETED', now() - interval '1 days 2 hours'),
  ('tx-004', 't-default', 's-hodeidah-01', 'disp-005', 1, 114, 84930, 745,
   now() - interval '1 days 3 hours', 255, 'COMPLETED', now() - interval '1 days 3 hours'),
  ('tx-005', 't-default', 's-aden-01', 'disp-007', 1, 131, 97595, 745,
   now() - interval '1 days 4 hours', 280, 'COMPLETED', now() - interval '1 days 4 hours'),
  ('tx-006', 't-default', 's-mukalla-01', 'disp-008', 1, 148, 110260, 745,
   now() - interval '1 days 5 hours', 305, 'COMPLETED', now() - interval '1 days 5 hours'),
  ('tx-007', 't-default', 's-sanaa-01', 'disp-001', 1, 86, 64070, 745,
   now() - interval '2 days 0 hours', 180, 'COMPLETED', now() - interval '2 days 0 hours'),
  ('tx-008', 't-default', 's-taiz-01', 'disp-003', 1, 103, 76735, 745,
   now() - interval '2 days 1 hours', 205, 'COMPLETED', now() - interval '2 days 1 hours'),
  ('tx-009', 't-default', 's-ibb-01', 'disp-004', 1, 120, 89400, 745,
   now() - interval '2 days 2 hours', 230, 'COMPLETED', now() - interval '2 days 2 hours'),
  ('tx-010', 't-default', 's-hodeidah-01', 'disp-005', 1, 137, 102065, 745,
   now() - interval '2 days 3 hours', 255, 'COMPLETED', now() - interval '2 days 3 hours'),
  ('tx-011', 't-default', 's-aden-01', 'disp-007', 1, 154, 114730, 745,
   now() - interval '2 days 4 hours', 280, 'COMPLETED', now() - interval '2 days 4 hours'),
  ('tx-012', 't-default', 's-mukalla-01', 'disp-008', 1, 171, 127395, 745,
   now() - interval '2 days 5 hours', 305, 'COMPLETED', now() - interval '2 days 5 hours')
on conflict do nothing;


commit;

-- ── Report ─────────────────────────────────────────────────────────────────
do $$
declare
  v_tenants integer; v_users integer; v_sites integer; v_tanks integer;
  v_gens integer; v_disp integer; v_alarms integer; v_txns integer;
begin
  select count(*) into v_tenants from "Tenant";
  select count(*) into v_users   from "User";
  select count(*) into v_sites   from "Site";
  select count(*) into v_tanks   from "FuelTank";
  select count(*) into v_gens    from "Generator";
  select count(*) into v_disp    from "FuelDispenser";
  select count(*) into v_alarms  from "Alarm";
  select count(*) into v_txns    from "FuelTransaction";
  raise notice 'FGMP seed ready: % tenants, % users, % sites, % tanks, % generators, % dispensers, % alarms, % fuel transactions.',
    v_tenants, v_users, v_sites, v_tanks, v_gens, v_disp, v_alarms, v_txns;
  if v_sites < 8 or v_users < 6 or v_tenants < 2 then
    raise exception 'Seed post-condition failed: expected >=2 tenants, >=6 users and >=8 sites (got %, %, %).', v_tenants, v_users, v_sites;
  end if;
end $$;
