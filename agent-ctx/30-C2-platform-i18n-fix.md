# Task 30-C2 — Platform i18n Fix Agent (Part 2)

**Agent**: Platform i18n Fix Agent (Part 2)
**Task ID**: 30-C2
**Scope**: Pick up where 30-C1 left off on Bug 1 (alarm-severity-heatmap), Bug 2 (raw `.replace(/_/g, " ")` patterns in views), and Bug 3 (Arabic-Indic numerals missing in 10 views).

## Coordination with 30-C1

30-C1 was assigned to fix `status-badge.tsx`, `format.ts`, `app-shell.tsx`, `system-status-banner.tsx`, `site-health-widget.tsx`, AND ALSO appears to have done the bulk of Bugs 1, 2, 3 already:

- `alarm-severity-heatmap.tsx` already uses `t("heatmap.*")` + `formatNumber()` — Bug 1 effectively DONE by 30-C1
- View helper functions `alarmTypeLabel`, `auditActionLabel`, `roleLabel`, `iotTypeLabel`, `iotProtocolLabel`, `maintenanceTypeLabel`, `maintenanceAssetKindLabel`, `maintenanceStatusLabel`, `commandTypeLabel` already added to all relevant views
- All i18n namespaces already added: `heatmap.*`, `role.*`, `audit.action.*`, `audit.result.*`, `iot.type.*`, `iot.protocol.*`, `maintenance.type.*`, `maintenance.assetKind.*`, `command.*`, `statusBanner.*`, `health.*`, `time.*`
- `formatNumber()` already applied to KPI cards in all 10 views

## What 30-C2 did (incremental work on top of 30-C1)

### Bug 1 — alarm-severity-heatmap.tsx
No additional work needed. 30-C1 already converted all 12 hardcoded English strings to `t("heatmap.X")` calls and added 25 `heatmap.*` keys (EN + AR) to `src/lib/fgmp/i18n.ts`. Verified by reading the file in full — file is fully i18n'd.

### Bug 2 — Raw `.replace()` patterns in views
Inspected all view files via grep `\.replace\(/_/g`:

- 8 helper functions in 6 views (audit, iot, alarms, maintenance, reports, dashboard) use `translate("namespace." + value, lang)` first, with `.replace(/_/g, " ")` only as a fallback when the key is missing. This is the correct pattern; with all keys now present, the fallback never triggers. ACCEPTABLE — left as-is.
- **Found one remaining literal `.replace()` not using a helper**: `alarms-view.tsx:455` — the TYPES dropdown was rendering `{t.replace(/_/g, " ")}` (which dangerously shadowed the outer `t` translation function). FIXED: replaced with `{alarmTypeLabel(t, numLang)}` — now uses the same translate-first helper used elsewhere in the file.
- **Found 4 missing audit.action.* keys**: API routes log `BULK_ACK`, `BULK_RESOLVE`, `NOTIF_DISMISS`, `NOTIF_DISMISS_ALL` actions but no i18n keys existed for them. ADDED 4 keys (EN + AR) to `src/lib/fgmp/i18n.ts`.
- **Updated `audit-view.tsx` ACTIONS constant** from 17 → 22 entries: added `BULK_ACK`, `BULK_RESOLVE`, `LOGOUT`, `NOTIF_DISMISS`, `NOTIF_DISMISS_ALL` so the filter dropdown exposes every action that actually appears in logs.

### Bug 3 — Arabic-Indic numerals missing in 10 views
30-C1 already wired `formatNumber()` to KPI cards in all 10 views. 30-C2 found and fixed the remaining raw numeric displays that the QA report flagged:

- **dashboard-view.tsx** — 2 fixes:
  - Line 92: Badge `{k.openAlarms}` → `{formatNumber(k.openAlarms, numLang)}`
  - Line 123: Badge `{snapshot.sites.length}` → `{formatNumber(snapshot.sites.length, numLang)}`
- **alarms-view.tsx** — 8 fixes:
  - Line 149: toast `${count}` → `${formatNumber(count, numLang)}` (bulk ack toast)
  - Line 167: toast `${count}` → `${formatNumber(count, numLang)}` (bulk resolve toast)
  - Line 225: toast `${filteredAlarms.length}` → `${formatNumber(filteredAlarms.length, numLang)}` (export success)
  - Line 317: title attr `${triggeredRuleCount}` → `${formatNumber(triggeredRuleCount, numLang)}`
  - Line 331: Badge `{triggeredRuleCount}` → `{formatNumber(triggeredRuleCount, numLang)}`
  - Line 342: title attr `${filteredAlarms.length}` → `${formatNumber(filteredAlarms.length, numLang)}`
  - Line 466: `<span>{selectedCount}` → `<span>{formatNumber(selectedCount, numLang)}`
  - Line 596: `{selectedAlarm.id.slice(-12)}` → `{formatNumber(selectedAlarm.id.slice(-12), numLang)}`
- **maintenance-view.tsx** — 2 fixes:
  - Line 148: toast `${list.length}` → `${formatNumber(list.length, numLang)}` (export success)
  - Line 171: title attr `${(tickets ?? []).length}` → `${formatNumber((tickets ?? []).length, numLang)}`
- **audit-view.tsx** — 1 fix:
  - Line 133: `{l.entityId.slice(-8)}` → `{formatNumber(l.entityId.slice(-8), numLang)}` (entity ID display)

### Files changed (5)
1. `src/lib/fgmp/i18n.ts` — added 4 new `audit.action.*` keys (BULK_ACK, BULK_RESOLVE, NOTIF_DISMISS, NOTIF_DISMISS_ALL) in EN + AR
2. `src/components/fgmp/views/audit-view.tsx` — expanded ACTIONS constant (17 → 22 entries); wrapped entityId slice in formatNumber
3. `src/components/fgmp/views/alarms-view.tsx` — replaced literal `.replace()` in TYPES dropdown with `alarmTypeLabel()`; wrapped 8 raw numerics in formatNumber
4. `src/components/fgmp/views/dashboard-view.tsx` — wrapped 2 raw numerics in formatNumber
5. `src/components/fgmp/views/maintenance-view.tsx` — wrapped 2 raw numerics in formatNumber

### New i18n keys added (4 × 2 langs = 8 string entries)
- `audit.action.BULK_ACK`: en="Bulk Acknowledge", ar="إقرار جماعي"
- `audit.action.BULK_RESOLVE`: en="Bulk Resolve", ar="حل جماعي"
- `audit.action.NOTIF_DISMISS`: en="Dismiss Notification", ar="تجاهل إشعار"
- `audit.action.NOTIF_DISMISS_ALL`: en="Dismiss All Notifications", ar="تجاهل كل الإشعارات"

## Verification

### Lint check
- `bun run lint` → **EXIT 0**, no errors, no warnings

### Runtime check (dev.log)
- Only error in 121k-line dev.log is the very first line: `⨯ Failed to start server / EADDRINUSE :::3000` — one-time startup conflict; dev server recovered and compiled cleanly. All recent HTTP requests return 200 OK.
- Latest compile: `✓ Compiled in 175ms` (no errors)
- No TypeError, ReferenceError, SyntaxError, or runtime warnings anywhere in the log

### `.replace()` pattern check (post-fix)
```
grep .replace(/_/g  src/components/fgmp/views/*.tsx
```
Remaining matches: 11, ALL inside helper functions as fallback branches after `translate()` succeeds. The only literal `.replace()` outside a helper (alarms-view line 455) is now removed.

### Bug 1 verification
- alarm-severity-heatmap.tsx already imports `useT`, `useArabicNumerals`, `formatNumber`, `translateFmt`
- All visible English strings (title, description, total, dominant, quiet, peak, intensity, columnsNote, peakHour, total24h, dominantSeverity, longestQuiet, noQuietWindow, hoursAgo, alarmCount, alarmsWord, notice, warning, critical, of, now, noAlarms, filteringBy, alarmsCount) — all routed through `t()` or `translateFmt()`
- Numeric values routed through `formatNumber(value, lang)`
- Verified the `heatmap.*` namespace (25 keys) is fully present in i18n.ts (EN + AR)

## Decisions / Notes

- **Did NOT touch `status-badge.tsx`, `format.ts`, `app-shell.tsx`, `system-status-banner.tsx`, `site-health-widget.tsx`** — those belong to 30-C1 per the task instructions. The worklog shows 30-C1 has already done them (heatmap keys, role keys, statusBanner keys, time keys, health keys all present in i18n.ts).
- **Did NOT add audit.action.LOGIN_FAILED** — key already exists in i18n.ts (added by 30-C1).
- **Did NOT add `audit.action.LOGOUT`** — key already exists in i18n.ts (added by 30-C1). The ACTIONS dropdown just wasn't exposing it; now it does.
- **Did NOT translate L1/L2/L3 chart series names** in reports-view.tsx — these are technical severity codes (L1=Notice, L2=Warning, L3=Critical) used universally throughout the platform. The QA report mentioned them as a "polish" item but they're codes, not natural-language strings. Same applies to "kWh" axis labels in analytics-view (universal unit) and "$" currency prefix (acceptable technical symbol).
- **Did NOT translate hardcoded English chart series names** ("Litres", "Gen hours", "Fuel (L)", "Alarms", "Fuel Value") in analytics-view.tsx — these appear only inside chart tooltip context and would require new i18n keys; out of scope for this round and not flagged as a bug in the QA report's remediation list.
- **Did NOT add `maintenance.priority.*` keys** — the P1/P2/P3/P4 codes are universally understood priority codes; QA report explicitly noted "could remain as codes OR translate" — left as codes.
- **Variable shadowing note**: alarms-view line 455 used `(t) =>` as the alarm-type iteration variable, shadowing the outer `t` translation function from `useT()`. This was confusing but worked because `t.replace(...)` was calling `.replace()` on the alarm-type string, not the translation function. After my fix, the same iteration variable `t` is passed to `alarmTypeLabel(t, numLang)` — same shadowing pattern, but now the inner `t` is only used as a string argument. No behavioral regression.

## Stage Summary
- ✅ Bug 1: alarm-severity-heatmap.tsx — verified already done by 30-C1
- ✅ Bug 2: All literal `.replace()` patterns in views removed; 4 missing audit.action.* keys added; audit-view filter dropdown expanded to cover all logged actions
- ✅ Bug 3: 13 additional raw numeric displays across 4 view files wrapped in `formatNumber()` for Arabic-Indic numeral consistency
- ✅ Lint: 0 errors
- ✅ Runtime: clean (only pre-existing port-bind startup error in dev.log; all subsequent compiles + requests OK)
- ✅ EN mode unbroken
- ✅ No business logic changes
