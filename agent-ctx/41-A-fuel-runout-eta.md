# Task 41-A — Fuel Runout ETA Predictor

## What was built
A new "Fuel Runout ETA" predictor feature for FGMP: predicts when each fuel
tank will run dry based on the 24-hour consumption rate, and surfaces the most
urgent tanks on the NOC dashboard so operators can schedule refills before
sites go dark.

## Files
- **CREATED** `src/app/api/fgmp/fuel/runout-eta/route.ts` (196 lines)
  - GET handler, `dynamic = "force-dynamic"`
  - Auth: `requireAuth()` + `bootstrap()` + `rateLimitByUser(READ_LIMIT)`
  - Single `db.sensorReading.findMany` for all FUEL_LEVEL readings in last 24h
    (entityKind="TANK", metric="FUEL_LEVEL"), grouped client-side by tankId.
  - Rate = (first.l - last.l) / hours; 0 if stable/refilled.
  - ETA = current / rate; null if rate<=0 or pct>95%.
  - Urgency: critical(<12h)/urgent(<24h)/soon(<72h)/ok(>=72h|null).
  - Falls back to `engine.tanks[].history` (24h in-memory backfill) when DB
    has <2 readings for a tank — so the predictor works before IoT ingest
    populates SensorReading. DB remains the PRIMARY source.
  - Returns only urgency != "ok" tanks, sorted by etaHours asc, capped to 20.
  - Empty case → `{ tanks: [] }`.

- **CREATED** `src/components/fgmp/fuel-runout-eta.tsx` (226 lines)
  - `'use client'`. Polls `/api/fgmp/fuel/runout-eta` every 60s via `useApi`.
  - Card: Clock icon + title + Info tooltip (formula) + "View all tanks" btn.
  - List: max-h-72 divide-y overflow-y-auto, top 8 rows.
  - Row: urgency dot (rose/amber/emerald) + site name + tank label + rate +
    ETA duration ("2d 4h"/"8h 12m"/"5m"/"—") + fill-% Badge. Clickable → fuel view.
  - Loading: 3 skeleton rows. Error: AlertTriangle. Empty: CheckCircle2.
  - Arabic numerals via `formatNumber(n, numLang)`.

- **EDITED** `src/lib/fgmp/i18n.ts` (+15 lines)
  - New section `/* ===== Fuel Runout ETA predictor (#41-A) ===== */` after
    the existing dash.* keys. 12 keys EN+AR (runoutEtaTitle/Info/Empty/Error/
    ViewAll/Hours/Days/Min/UrgencyCritical/UrgencyUrgent/UrgencySoon/Rate).

- **EDITED** `src/components/fgmp/views/dashboard-view.tsx` (+4 lines, MINIMAL)
  - 1 import + 1 render line. `<FuelRunoutEta />` placed right after the Top
    Critical Alarms card (before Site Health widget).

## API response shape
```json
{ "tanks": [{
  "tankId": "ck...", "label": "Tank A", "siteId": "...",
  "siteName": "Data Center Junction - Old Sana'a", "region": "Northern Highlands",
  "currentLitres": 320, "capacityLitres": 3000, "pct": 10.7,
  "ratePerHour": 12.5, "etaHours": 25.6, "etaIso": "2025-..T..:..Z",
  "urgency": "urgent"
}] }
```

## Lint
`bun run lint` → 0 errors, 0 warnings. No build run. No dev server restart.

## Deviations (documented in code comments)
1. engine.tanks[].history fallback when DB has <2 readings (DB stays primary).
2. Endpoint returns only urgency != "ok" tanks (filters "ok" before serialize)
   so the widget empty-state triggers naturally + payload stays small. The "ok"
   enum is still computed internally.
