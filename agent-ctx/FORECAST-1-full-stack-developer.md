# FORECAST-1 — full-stack-developer

## Task
Build Predictive Fuel-Runout Forecast feature: new API endpoint + new view + nav registration + i18n + RBAC.

## Work Log
- Read worklog.md tail + 15 architecture files to understand conventions (analytics/route.ts, analytics-view.tsx, store.ts, types.ts, app-shell.tsx, rbac.ts, i18n.ts, auth-helpers.ts, rate-limit.ts, use-api.ts, use-chart-colors.ts, use-language.ts, section-header.tsx, kpi-card.tsx, skeletons.tsx).
- Created `/api/fgmp/forecast/route.ts` GET endpoint:
  - requireAuth → bootstrap → rateLimitByUser (READ_LIMIT) → try/catch with errorResponse.
  - For each `engine.tanks` tank: filter history to last 24h (fallback to full if < 4 recent points), compute least-squares linear regression slope of level (litres) vs time (hours). Returns slope; bails to "stable" if < 4 points or all-equal levels; treats non-negative slope as "refilling" (refuel detected); negative slope → consumptionRateLh = -slope.
  - Computes hoursToLow / hoursToCritical / hoursToEmpty (Infinity when not consuming).
  - Risk: CRITICAL if hoursToLow ≤ 6 OR tank.status === "EMPTY"; HIGH if ≤ 24; MEDIUM if ≤ 72; LOW otherwise.
  - refuelNeededLitres = capacity − current; recommendedRefuelTime = now + hoursToLow (ISO string), null if Infinity.
  - Joins to `engine.sites` for site name/code/region/governorate.
  - Summary: totalTanks, critical/high/medium/low counts, stable (rate===0), refuelingNeeded (litres > 0 AND hoursToLow < 72), totalRefuelLitres (sum within 72h), avgConsumptionRateLh (mean across consuming tanks).
  - regionRisk aggregation: per-region critical/high/medium/low counts + totalLitresNeeded.
  - Tanks sorted: risk rank asc (CRITICAL→LOW) then hoursToLow asc (null/Infinity last within bucket).
- Created `/components/fgmp/views/forecast-view.tsx`:
  - SectionHeader (Brain icon, violet tone) + subtitle model-note.
  - KPI row (6 cards): Critical Risk (rose), High Risk (amber), Refuel Needed (violet), Total Refuel Volume (emerald, "Xk L"), Avg Consumption (sky, L/h), Tanks Monitored (default).
  - Risk distribution donut (PieChart) + legend with count + percentage.
  - Region risk stacked bar chart (BarChart, x=region, stacked critical/high/medium/low).
  - Tank forecast table (max-h-[480px] overflow-y-auto, horizontal-scroll on mobile via min-w-[1100px]+overflow-x-auto):
    - Site (clickable → useFgmp.selectSite), Governorate, Tank, Current (litres + thin colored bar + pct), Rate (L/h), → Low, → Critical, → Empty (hours or ∞), Risk Badge, Refuel (L), Refuel By (datetime).
    - Filter row at top: 4 toggle-buttons (CRITICAL/HIGH/MEDIUM/LOW), colored when on, shows count per level.
  - Loading skeleton: 6 KpiCardSkeleton + 2 ChartSkeleton + TableSkeleton.
  - useApi<ForecastResponse>("/api/fgmp/forecast", { interval: 30000 }) — 30s refresh.
- Registered view:
  - store.ts: added "forecast" to ViewKey union after "analytics".
  - app-shell.tsx: imported Brain from lucide-react; imported ForecastView; added NAV entry after analytics (Insights group); added to VIEW_COMPONENTS map.
  - rbac.ts: added "view:forecast" capability to all 5 non-admin roles (NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY). ADMIN has "*" wildcard.
- Added i18n keys (EN+AR) — nav.forecast, desc.forecast, and 32 forecast.* keys (title, subtitle, riskLevel labels, KPI labels, table column labels, status labels, hours unit, infinite symbol, dataPoints, modelNote).
- Color policy respected: rose/amber/violet/emerald for risk levels; sky for chart accents. No indigo/blue.

## Verification
- `bun run lint` → 0 errors, 0 warnings.
- `curl /api/fgmp/forecast` unauthenticated → HTTP 401.
- `curl /` → HTTP 200 (home page intact).
- dev.log shows `GET /api/fgmp/forecast 401` (no runtime errors); no compilation errors.

## Files Created
- src/app/api/fgmp/forecast/route.ts (NEW)
- src/components/fgmp/views/forecast-view.tsx (NEW)

## Files Modified
- src/lib/fgmp/store.ts (added "forecast" to ViewKey)
- src/lib/fgmp/rbac.ts (added view:forecast to all 5 non-admin roles)
- src/lib/fgmp/i18n.ts (added nav.forecast, desc.forecast, 32 forecast.* keys EN+AR)
- src/components/fgmp/app-shell.tsx (Brain import, ForecastView import, NAV entry, VIEW_COMPONENTS entry)

## Stage Summary
- Lint: 0 errors, 0 warnings.
- Endpoint HTTP status (unauth): 401.
- Home page: 200.
- Dev server: running, no errors in tail of log.
