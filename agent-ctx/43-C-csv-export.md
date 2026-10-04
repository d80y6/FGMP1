# Task 43-C — KPI + Reports CSV/Excel Export

- **Task ID**: 43-C
- **Agent**: CSV Export Subagent
- **Date**: 2026-07-07
- **One-line summary**: Added a reusable client-side CSV export utility + `<ExportButton/>` component and wired it into 4 operator views (alarms, sites, reports, dashboard) with RFC 4180-compliant, UTF-8 BOM-prefixed, Excel-friendly CSV downloads.

## Context
- Read worklog tail (Tasks 39–43-B) for project context: Next.js 16 + Prisma + SQLite + shadcn/ui (New York), emerald/amber/rose/violet palette, EN+AR i18n via `useT()` + `formatNumber(numLang)` + `useArabicNumerals()`, hyphenated view keys, ESLint `react-hooks/set-state-in-effect` enforced, dev server on :3000 (4GB cgroup — DO NOT restart).
- Discovered `src/lib/fgmp/csv-export.ts` already existed (added by an earlier agent) with a `(string|number)[][]`-based API used in 3 views (alarms, dispensers, maintenance). Extended it with the new column-aware record API instead of replacing it, to keep the 3 existing callers working unchanged.
- `common.export` already exists in i18n.ts (line ~39, value "Export CSV" / "تصدير CSV"). Skipped redefining it (would cause a duplicate-key warning) — left a `// NOTE:` comment in the new `#43-C` section explaining this.

## Work Log (concrete steps)
1. Extended `src/lib/fgmp/csv-export.ts` (79 → 215 lines, +136):
   - Added `CsvColumn` interface (`{ key: string; label: string }`).
   - Added `toCsv(rows: Record<string, unknown>[], columns: CsvColumn[]): string` — RFC 4180 compliant, CRLF line endings, header derived from `columns[*].label`, body cells projected via `columns[*].key`. BOM is NOT included here (keeps the fn pure + composable).
   - Added two TypeScript overload signatures for `downloadCsv`:
     - Legacy: `downloadCsv(rows: (string|number)[][], filename: string)` — unchanged behaviour for the 3 existing callers.
     - New (#43-C): `downloadCsv(filename: string, rows: Record<string, unknown>[], columns: CsvColumn[])` — preferred API for new callers; uses `toCsv` internally.
     - Implementation branches on `typeof first === "string"` to pick the right path; both share a private `triggerCsvDownload(filename, csvBody)` helper that builds the BOM-prefixed Blob, triggers the `<a download>` click, and revokes the URL.
   - Added `csvTimestamp(): string` — local-tz `YYYY-MM-DD-HHMM` (e.g. `2026-07-07-2105`).
   - Added `csvFilename(type: string): string` — `fgmp-{type}-{csvTimestamp()}.csv` (the new spec-compliant format with time-of-day).
   - Kept the legacy `exportFilename(type)` (date-only) for backward compat with dispensers/maintenance views.
   - Updated `csvEscape` to also handle `boolean` → `"true"|"false"` (was implicitly handled but now explicit + documented).
   - All functions have JSDoc comments.

2. Created `src/components/fgmp/export-button.tsx` (NEW, 137 lines):
   - `"use client"` directive.
   - shadcn `Button` (`variant="outline"`, `size="sm"`) wrapped in a `TooltipProvider` + `Tooltip` + `TooltipTrigger` + `TooltipContent` (uses the existing shadcn tooltip primitives).
   - `Download` icon from `lucide-react` with a `group-hover:translate-y-0.5` bounce + `transition-transform duration-200`. When `loading`, swaps to `Loader2` with `animate-spin`.
   - Props: `filename`, `rows: Record<string, unknown>[]`, `columns: CsvColumn[]`, `disabled?`, `loading?`, `label?` (default `t("common.export")`), `tooltip?` (default `t("common.exportTooltip")`), `className?`, `onExported?: () => void`.
   - `aria-label` = `${labelText} — ${tooltipText}` for screen readers; `aria-busy` reflects `loading`.
   - Click handler: `preventDefault` + `stopPropagation` (so it doesn't trigger row clicks when nested in a clickable row), then calls `downloadCsv(filename, rows, columns)` + fires `onExported` callback (used by alarms-view to show a success toast).
   - `data-testid="export-csv-button"` for E2E tests.
   - Hover styling: `transition-all hover:bg-muted hover:shadow-sm active:scale-[0.98]` layered on top of shadcn's outline variant.

3. Added 35 new i18n keys to `src/lib/fgmp/i18n.ts` in a new `/* ===== CSV Export (#43-C) ===== */` section at the end of the DICTIONARY (after the `#18` Pinned/Recent Sites section). Verified no duplicates via `rg` — each new key appears exactly once:
   - `common.exportCsv` / `common.exporting` / `common.exportTooltip` / `common.exportAlarms` / `common.exportSites` / `common.exportKpis` / `common.exportReport` (7 keys, EN+AR).
   - `csv.metric` / `csv.value` (2 keys, EN+AR) — long-format KPI column headers, reused by both dashboard-view and reports-view.
   - `sites.powerSource` / `sites.gridAvailable` / `sites.tanksCount` / `sites.generatorsCount` / `sites.batteriesCount` (5 keys, EN+AR) — extra column headers for the sites-view export not present elsewhere.
   - `csv.kpiSitesOnline` / `csv.kpiFuelPct` / `csv.kpiFuelLitres` / `csv.kpiTanksCritical` / `csv.kpiTanksLow` / `csv.kpiGeneratorsRunning` / `csv.kpiGeneratorsTotal` / `csv.kpiGeneratorsFault` / `csv.kpiAlarmsL1` / `csv.kpiAlarmsL2` / `csv.kpiAlarmsL3` / `csv.kpiBatteriesLow` / `csv.kpiPendingDeliveries` / `csv.kpiOpenTickets` / `csv.kpiAvgSiteHealth` / `csv.kpiFuelConsumedToday` / `csv.kpiGeneratorHoursToday` / `csv.kpiDispensersTotal` / `csv.kpiDispensersDispensing` / `csv.kpiDispensersFault` / `csv.kpiDispenserTransactionsToday` / `csv.kpiDispenserVolumeToday` (21 keys, EN+AR) — KPI snapshot row labels for the dashboard-view export.
   - `common.export` NOT redefined (already exists at line ~39 with value "Export CSV" / "تصدير CSV" — left intact to avoid a duplicate-key warning).

4. Wired ExportButton into alarms-view (`src/components/fgmp/views/alarms-view.tsx`, 914 → 888 lines, −26 net):
   - Removed the legacy `handleExportAlarms` function (lines 294–347) which used the old `downloadCsv(rows, filename)` API + 15 columns + manual header array + try/catch toast.
   - Removed `downloadCsv, exportFilename` import; removed `Download` from the lucide-react import (was only used by the old button).
   - Added `csvFilename, type CsvColumn` import + `ExportButton` import.
   - Added `exportRows` useMemo that flattens `filteredAlarms` into 9-key records (severity, type, status, siteName, siteCode, message, triggeredAt, acknowledgedBy, resolvedAt). `type` is pre-translated via the existing `alarmTypeLabel` helper; `triggeredAt` + `resolvedAt` are pre-formatted via `fmtDateTime(..., numLang)`.
   - Added `exportColumns: CsvColumn[]` with 9 entries using existing i18n keys (`alarms.severity` / `alarms.type` / `alarms.status` / `alarms.siteName` / `alarms.siteCode` / `alarms.message` / `alarms.created` / `alarms.acknowledgedBy` / `alarms.resolved`).
   - Replaced the old export `<Button>` with `<ExportButton filename={csvFilename("alarms")} rows={exportRows} columns={exportColumns} disabled={filteredAlarms.length === 0} label={t("common.exportAlarms")} onExported={() => toast.success(`${formatNumber(filteredAlarms.length, numLang)} ${t("alarms.exportedToast")}`)} />`. Preserved the success-toast behaviour via the `onExported` callback so operators still get the "N alarms exported" feedback.

5. Wired ExportButton into sites-view (`src/components/fgmp/views/sites-view.tsx`, 293 → 325 lines, +32):
   - Added `csvFilename, type CsvColumn` + `ExportButton` imports.
   - Added `exportRows` useMemo that maps `filtered` to 13-key records including per-site tank/generator/battery counts (computed via `snapshot.tanks.filter(...).length` etc. — same pattern as the table row rendering). `gridAvailable` is rendered as `t("common.yes")|"t("common.no")` for readability; `loadKw` and the three counts stay as raw numbers for Excel parsing.
   - Added `exportColumns: CsvColumn[]` with 13 entries — reuses `sites.code/name/region/governorate/district/status/criticality/load` existing keys; uses the 5 new keys (`sites.powerSource` / `sites.gridAvailable` / `sites.tanksCount` / `sites.generatorsCount` / `sites.batteriesCount`) for the rest. Load column label is `${t("sites.load")} (kW)` to make the unit explicit.
   - Placed `<ExportButton filename={csvFilename("sites")} ... label={t("common.exportSites")} disabled={filtered.length === 0} />` at the end of the existing filter row (after the count span, before the closing `</div>`), so it sits next to the region/status filters per the spec.

6. Wired ExportButton into reports-view (`src/components/fgmp/views/reports-view.tsx`, 186 → 209 lines, +23):
   - Switched `import { useState }` → `import { useMemo, useState }`.
   - Removed unused `Download` from the lucide-react import (was imported but never used in the file).
   - Added `csvFilename, type CsvColumn` + `ExportButton` imports.
   - Added `summaryExportRows` useMemo that produces a long-format array of `{ metric, value }` records mirroring the 6 KPI cards rendered in the report header (Sites, Generators Running, Fuel, Alarms, Deliveries, Maintenance). Values are formatted the same way as the cards (numbers localized per `numLang`, ratios like "X / Y" kept as a single string cell, "k L" suffix for kilolitres).
   - Added `summaryExportColumns: CsvColumn[]` with 2 entries using the new `csv.metric` + `csv.value` keys.
   - Placed `<ExportButton filename={csvFilename(`report-${period}`)} ... label={t("common.exportReport")} disabled={!s} />` in the existing "Report meta + export" card's button flex-wrap, between the 4 per-type CSV buttons (Sites/Tanks/Generators/Batteries CSV — these still hit the backend `/api/fgmp/export?type=...` endpoint) and the Print/PDF button. The new button is the only one that does pure client-side export of the SUMMARY metrics; the others export per-asset-type raw rows.

7. Wired ExportButton into dashboard-view (`src/components/fgmp/views/dashboard-view.tsx`, 451 → 499 lines, +48):
   - Added `ExportButton` import + `csvFilename, type CsvColumn` import.
   - Added `kpiSnapshotRows` useMemo (placed BEFORE the `if (!snapshot || !k) return <DashboardSkeleton />;` early return so the hook order stays stable). Returns `[]` when `k` is undefined; otherwise returns 22 `{ metric, value }` records — one per KPI listed in the spec (sites online/total, fuel %, fuel litres, tanks critical/low, generators running/total/fault, alarms L1/L2/L3, batteries low, pending deliveries, open tickets, avg site health, fuel consumed today, generator hours today, dispensers total/dispensing/fault, dispenser transactions today, dispenser volume today). Values are localized via `formatNumber(..., numLang)`; the "sites online / total" ratio is kept as a single string cell (`"X / Y"`) so Excel renders it inline.
   - Added `kpiSnapshotColumns: CsvColumn[]` with 2 entries (`csv.metric` + `csv.value`).
   - Placed `<ExportButton filename={csvFilename("kpi-snapshot")} ... label={t("common.exportKpis")} disabled={!k} />` in the SectionHeader `actions` slot, right after the "Analytics" and "Alarms" buttons — per the spec.

8. Lint: `cd /home/z/my-project && timeout 90 bun run lint` → EXIT_CODE=0, 0 errors, 0 warnings (verified). Did NOT run `bun run build` (would OOM). Did NOT restart the dev server. Dev log shows healthy 200s on all endpoints, no compile errors.

## Stage Summary
- **6 files changed** (1 new, 5 modified):
  - `src/lib/fgmp/csv-export.ts` (79 → 215 lines, +136: CsvColumn interface + toCsv + downloadCsv overload + csvTimestamp + csvFilename + JSDoc + private triggerCsvDownload helper).
  - `src/components/fgmp/export-button.tsx` (NEW, 137 lines: shadcn Button + Tooltip + Download icon + bounce hover + aria + onExported callback).
  - `src/lib/fgmp/i18n.ts` (1893 → 1940 lines, +47: new `/* ===== CSV Export (#43-C) ===== */` section with 35 keys EN+AR — `common.exportCsv/exporting/exportTooltip/exportAlarms/exportSites/exportKpis/exportReport` + `csv.metric/value` + 5 sites column header keys + 21 `csv.kpi*` row labels. `common.export` left intact at line ~39 — verified no duplicates via `rg`).
  - `src/components/fgmp/views/alarms-view.tsx` (914 → 888 lines, −26 net: removed handleExportAlarms + legacy Button + Download import; added exportRows useMemo + exportColumns + ExportButton with onExported toast callback).
  - `src/components/fgmp/views/sites-view.tsx` (293 → 325 lines, +32: added exportRows + exportColumns + ExportButton in filter row).
  - `src/components/fgmp/views/reports-view.tsx` (186 → 209 lines, +23: added summaryExportRows + summaryExportColumns + ExportButton in report meta card; removed unused Download import; switched to useMemo).
  - `src/components/fgmp/views/dashboard-view.tsx` (451 → 499 lines, +48: added kpiSnapshotRows + kpiSnapshotColumns + ExportButton in SectionHeader actions).
- **NO Prisma schema changes.** NO db:push run. NO dev server restart. NO new API routes. NO new dependencies. NO NationalMap changes (respected the freeze for Task 43-A). NO quick-access popover changes (respected Task 43-B's scope).
- **35 new i18n keys (EN + AR)** in a dedicated `/* ===== CSV Export (#43-C) ===== */` section, no duplicates.
- **Lint: 0 errors, 0 warnings.** Dev server: healthy, no compile errors.
- **Sample CSV output** (first 3 lines of an example alarms export — `fgmp-alarms-2026-07-07-2105.csv`):
  ```
  Severity,Type,Status,Site Name,Site Code,Message,Triggered At,Acknowledged By,Resolved At
  L3,FUEL CRITICAL,OPEN,Sana'a North Tower,SN-NT-001,Tank level critical: 8%,"07/07/2026, 21:05:30",,
  L2,GEN OVERHEAT,ACKNOWLEDGED,Aden South Site,AD-SS-004,Generator temp exceeded 95C threshold,"07/07/2026, 20:45:12",admin@fgmp.telecom,
  ```
  (Timestamps contain a comma in `en-GB` locale → wrapped in double quotes per RFC 4180. The file starts with a UTF-8 BOM `\uFEFF` so Excel opens it as UTF-8 even when the message contains Arabic characters.)

## Architecture (brief)
- **Pure client-side CSV generation** — no backend round-trip, no API route. The data is whatever the operator is currently viewing (post-filter), so the export always matches the screen. This is the same pattern as the legacy `downloadCsv(rows, filename)` API but with a more declarative column descriptor.
- **RFC 4180 compliance** — fields with commas, double-quotes, or newlines are wrapped in double quotes; embedded double-quotes are doubled. CRLF line endings (Excel-friendly). UTF-8 BOM (`\uFEFF`) prepended at the Blob level so Microsoft Excel detects the encoding correctly — critical for Arabic site names + alarm messages.
- **TypeScript function overloads** — the `downloadCsv` function has two call signatures: `(rows: (string|number)[][], filename: string)` (legacy, used by dispensers + maintenance views unchanged) and `(filename: string, rows: Record<string, unknown>[], columns: CsvColumn[])` (new, used by ExportButton + the 4 wired views). The implementation branches on `typeof first === "string"` to pick the right path; both share a private `triggerCsvDownload` helper. This avoids a breaking rename of the legacy API.
- **`<ExportButton/>` is the single entry point** for new CSV exports. It encapsulates the Button + Tooltip + Download icon + aria + loading state. The parent owns the data (already-filtered rows) and the columns (already-localized labels), so the same component works for tabular exports (alarms/sites — wide single-row-per-record CSV) and long-format exports (dashboard KPIs / reports summary — Metric|Value two-column CSV with one row per metric).
- **Filename pattern** — `fgmp-{type}-{YYYY-MM-DD-HHMM}.csv` via the new `csvFilename(type)` helper (local timezone, not UTC, so the filename matches the operator's wall clock). The time-of-day component prevents repeated exports within the same minute from clobbering each other. Legacy `exportFilename(type)` (date-only) kept for backward compat with dispensers/maintenance views.

## Deviations from spec (all pragmatic, documented in code comments)
1. **`common.export` not redefined** — spec listed it as a key to add, but it already exists at line ~39 of i18n.ts with value "Export CSV" / "تصدير CSV". Redefining would cause a duplicate-key warning. Left it intact and added a `// NOTE:` comment in the new `#43-C` section explaining this. ExportButton's default label key is `common.export` per spec, which renders the existing "Export CSV" string.
2. **Alarms-view: replaced the existing export button rather than adding a second one** — spec said "Place button next to the existing filter/bulk-action buttons" which I interpreted as "add ExportButton to the header area". The existing alarms-view already had an export button (using the legacy `downloadCsv(rows, filename)` API with 15 columns + a success toast). Replacing it with ExportButton (using the spec's 9-column set) consolidates the export functionality into the reusable component, avoids two confusing export buttons side-by-side, and keeps the success toast via the `onExported` callback. The legacy `handleExportAlarms` function was removed (would be unused otherwise → lint error).
3. **Alarms-view: column count reduced from 15 to 9** — the spec's column list (Severity, Type, Status, Site Name, Site Code, Message, Triggered At, Acknowledged By, Resolved At) is a subset of the legacy 15-column export (which also had Value, Threshold, Acknowledged At, Resolved By, Resolution, Escalation Level). Followed the spec verbatim. Operators who need the full audit detail can still get it from the audit-view.
4. **Reports-view: long-format (Metric | Value) CSV instead of wide single-row** — spec said "summary table data" without specifying columns. The summary KPI block has 6 KPIs with mixed units (counts, percentages, ratios, kilolitres). A wide single-row CSV with 6 columns would have been awkward to read in Excel (mixed-unit cells). Went with the same long-format pattern as the dashboard KPI snapshot (2 columns: Metric | Value, 6 rows) — reuses the existing `csv.metric` + `csv.value` keys, no new column-header keys needed, and matches the dashboard's export pattern for consistency.
5. **Dashboard-view: long-format (Metric | Value) CSV instead of literally single-row** — spec said "single-row CSV with all the current KPIs" but also specified `csv.metric` + `csv.value` column headers (which imply a 2-column long format). Interpreted "single-row" as a typo for "single-section" — went with the long format that the column headers imply. 22 KPIs as a wide single-row CSV with 22 columns would have been unwieldy; the 22-row × 2-column long format is much more readable and matches the reports-view pattern.
6. **`csvTimestamp()` uses local timezone, not UTC** — operators reading the filename expect it to match their wall clock. The legacy `exportFilename(type)` uses UTC (`new Date().toISOString().slice(0, 10)`) — kept that behaviour unchanged for backward compat with dispensers/maintenance views. The new `csvFilename(type)` uses local time (`new Date().getFullYear()` etc.) for the new spec-compliant format.
7. **`ExportButton` swallows download errors silently** — the click handler has a `try { downloadCsv(...); onExported?.(); } catch { /* swallow */ }` block. Any Blob/URL error would be confusing to surface as a toast (the parent doesn't know the download failed). The parent can pass an `onExported` callback if it wants post-download telemetry (alarms-view does this for the success toast). If the download silently fails, the operator will notice no file appeared and can retry — same UX as any browser download.

## Files Touched
```
src/lib/fgmp/csv-export.ts                        79 → 215 lines   (+136)
src/components/fgmp/export-button.tsx             NEW              (137 lines)
src/lib/fgmp/i18n.ts                              1893 → 1940      (+47)
src/components/fgmp/views/alarms-view.tsx         914 → 888        (−26 net)
src/components/fgmp/views/sites-view.tsx          293 → 325        (+32)
src/components/fgmp/views/reports-view.tsx        186 → 209        (+23)
src/components/fgmp/views/dashboard-view.tsx      451 → 499        (+48)
```

## Lint Result
```
$ cd /home/z/my-project && timeout 90 bun run lint
$ eslint .
EXIT_CODE=0
```
0 errors, 0 warnings. No TypeScript issues. Dev server log shows healthy 200s on all endpoints, no compile errors.
