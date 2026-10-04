# Task 39-B — Dashboard Enhancement Subagent

## Task
Three dashboard enhancements in `src/components/fgmp/views/dashboard-view.tsx`:
1. **Top 5 Critical Alarms** list (#7) — one-click triage card after KPI row.
2. **Time-range selector** (#17) — 1h/24h/7d ToggleGroup controlling the consumption-trend chart.
3. **KPI info-tooltips** (#23) — ⓘ tooltip next to each KPI card label.

## Files Changed
- `src/components/fgmp/views/dashboard-view.tsx` — +~95 lines (Top-Critical card, range state+fetch, ToggleGroup, info props on 8 KPIs, ackAlarm, topCriticalAlarms useMemo).
- `src/components/fgmp/kpi-card.tsx` — +~16 lines (optional `info` prop → Info-icon Tooltip).
- `src/app/api/fgmp/analytics/route.ts` — +~35 lines (`range` query param, range-aware consumptionTrend bucketing).
- `src/lib/fgmp/i18n.ts` — 16 new keys (5 common.kpiInfo*, 11 dash.*).

## Lint
0 errors, 0 warnings (`bun run lint` clean).

## Key Decisions
- Used existing `POST /api/fgmp/alarms { action:"acknowledge", alarmId }` (the `/[id]/acknowledge` route from the task description does NOT exist; alarms-view uses the action-based endpoint).
- Derived Top-5 from the polled alarms feed (snapshot has no `alarms` field); bumped limit 12→50 to feed both the live feed and the triage list from one fetch.
- Row click → `setView("alarms")` (not sites) because `setView` clears `selectedSiteId`.
- Range selector controls only the consumption-trend chart; backend derived metrics stay on fixed 24h so analytics-view/fuel-view are unaffected.
- Used `dash.*` i18n prefix (matches existing 60+ dashboard keys) instead of task's `dashboard.*` wording.

## Blockers
None.
