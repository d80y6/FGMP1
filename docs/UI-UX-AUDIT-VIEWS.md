# Per-view UI/UX audit — all 27 authenticated views

**Date:** 2026-10-25 · **Scope:** every view in `src/components/fgmp/views/` (27 files, mounted from
`VIEW_COMPONENTS` in `app-shell.tsx`). **Method:** each view was read in full and its structure measured
mechanically (endpoints, tables, dialogs, charts, selects, caps, empty branches) rather than judged from
screenshots. Findings that the browser can decide — contrast, focus order, overflow, axe rules — are
**not** re-litigated here; they belong to the axe sweep in `views.e2e.ts`, which renders all 30 surfaces.

**What this document is for.** The sweep answers "does this view violate a rule?". It cannot answer "does
this view tell the operator what they need, in the state they are actually in?" — zero rows, a capped
list, a failed fetch. That is what is audited here.

## 1. The 27 views, measured

| View | What it is | Capability | Lines | Data | Render | Empty | Cap |
|---|---|---|---|---|---|---|---|
| `alarms` | Alarm queue with severity/status filters, ack and suppression actions | all roles | 909 | 1 endpoint(s) | 1 table, 2 select | yes | — |
| `analytics` | Consumption/runtime, 7-day forecast, top consumers, regions, theft table | ADMIN, REGIONAL_MANAGER, EXECUTIVE | 382 | 1 endpoint(s) | 7 chart | **no** | 20 |
| `api-keys` | Create / reveal-once / revoke credentials; 2 dialogs | ADMIN, SUPERADMIN | 680 | 2 endpoint(s) | 1 table, 2 dialog | **no** | — |
| `asset-registry` | 5 tabs (tanks, generators, batteries, IoT, dispensers) with create/edit dialogs | ADMIN + operational | 2262 | 9 endpoint(s) | 5 table, 5 dialog, 24 select | yes | — |
| `audit` | Audit-log browser with filters and a 200-row cap | all roles | 156 | 1 endpoint(s) | 1 table, 1 select | yes | 200 |
| `batteries` | Battery banks by site: charge, health, voltage, temperature. Read-only | operational roles | 147 | shared snapshot | — | **no** | 60 |
| `consumption-patterns` | Hourly heatmap, std-dev/variance table, top-5 site stats | ADMIN, REGIONAL_MANAGER, EXECUTIVE | 424 | shared snapshot | 1 table, 2 chart | **no** | — |
| `dashboard` | KPI cards, 3 charts, critical-alarm list, activity feed, runout ETA, shift handover | all roles | 579 | 2 endpoint(s) | 3 chart | yes | 40 events |
| `dispensers` | Dispenser list, transaction log, calibration/preset dialogs, 3 charts | ADMIN, operational | 1399 | 3 endpoint(s) | 4 table, 3 chart, 3 dialog, 8 select | yes | 100 / 200 |
| `edge-firmware` | ESP gateway inventory, OTA targeting, per-device firmware state | ADMIN, operational | 1023 | 3 endpoint(s) | 4 table, 1 chart, 1 dialog, 1 select | yes | — |
| `fuel` | Tank levels by site, national gauge, refill plan | operational roles | 289 | 2 endpoint(s) | 2 chart, 1 select | yes | 60 |
| `fuel-forecast` | Refuel risk ranking, 7-day projection, scrollable forecast table | ADMIN, REGIONAL_MANAGER, EXECUTIVE | 375 | shared snapshot | 1 table, 2 chart | **no** | — |
| `generators` | Generator status, runtime/maintenance counters, control buttons | operational roles | 224 | 1 endpoint(s) | 2 chart | **no** | 40 |
| `geography` | Site map by governorate with governorate/district dialogs | ADMIN, SUPERADMIN | 797 | 7 endpoint(s) | 1 table, 1 dialog | yes | — |
| `inventory` | Spare parts and stock movements | ADMIN, operational | 312 | 3 endpoint(s) | 1 table, 1 chart, 2 dialog, 3 select | **no** | — |
| `iot` | Device registry with reboot and firmware actions | ADMIN, operational, READONLY | 208 | 2 endpoint(s) | 1 table, 1 dialog, 2 select | **no** | 100 |
| `maintenance` | Ticket pipeline, Gantt schedule, prediction panel, correlation rules | ADMIN, operational | 417 | 1 endpoint(s) | 1 table, 1 dialog, 3 select | **no** | — |
| `preferences` | Notification channels, quiet hours, display and density | all roles | 854 | 1 endpoint(s) | 2 select | **no** | — |
| `reports` | Four report tables with CSV export | ADMIN, REGIONAL_MANAGER, EXECUTIVE | 214 | 2 endpoint(s) | 4 table, 1 chart, 2 select | **no** | 4 × 50 |
| `roles` | RBAC matrix, role → capabilities, read-only | ADMIN only | 326 | shared snapshot | 1 table | **no** | — |
| `sites` | Site list with filters, per-site asset counts, detail sheet | all roles | 545 | 1 endpoint(s) | 1 table, 2 select | yes | 100 |
| `suppressions` | Alarm suppression rules and history | ADMIN, operational | 848 | 2 endpoint(s) | 1 table, 1 dialog, 2 select | **no** | — |
| `system-health` | Service health, database gauges, queue depth, scheduler | ADMIN, SUPERADMIN | 793 | 1 endpoint(s) | 2 table | **no** | — |
| `system-settings` | Typed platform settings | ADMIN, SUPERADMIN | 511 | 1 endpoint(s) | — | **no** | — |
| `tenant-isolation` | SUPERADMIN cross-tenant access simulation | SUPERADMIN only | 417 | 1 endpoint(s) | — | **no** | — |
| `tenants` | Tenant CRUD with dependent-aware delete | SUPERADMIN only | 918 | 4 endpoint(s) | 1 table, 4 dialog | **no** | — |
| `users` | User CRUD, role assignment, activation | ADMIN, SUPERADMIN | 900 | 3 endpoint(s) | 1 table, 3 dialog, 3 select | **no** | — |

Two notes on how to read the table:

* **"shared snapshot"** means the view derives from `useFgmp(s => s.snapshot)` rather than fetching. Those
  views have no loading or error branch of their own **by design**: `ViewHost` in `app-shell.tsx` renders
  `hasSnapshot ? <Component/> : <LoadingSkeleton/>`, so a snapshot-less view never mounts. A `return null`
  on `!snapshot` inside such a view is therefore unreachable, not a blank screen. This is recorded as
  correct, not as a finding.
* **"Empty"** means the file renders an explicit zero-row state (`<EmptyState>` or an inline
  "nothing here" line) somewhere. Where it says **no**, the primary list rendered nothing at all — see §2.

## 2. What was found

### A. Nine lists were silently capped (FIXED)

`sites` cut at 100, `batteries` at 60, `fuel` at 60, `generators` at 40, `iot` at 100, `dispensers` at
100 and 200, `reports` at 50 rows per table, `audit` at 200 — all with `slice(0, N)` and no indication.

The failure is specific and worth stating precisely: on a tenant with 140 sites, row 100 looks exactly
like the last row that exists. An operator who filters for a site that sorts past the cap concludes the
site is not there. **A rendering decision produced a data-integrity impression.** Fixed with
`TruncationNote`, which renders "Showing {shown} of {total}. Narrow the filters to see the rest." and
nothing at all when the list fits, so the common case gains no noise. Applied to **every** capped list in
the 27 views: `sites`, `batteries`, `fuel`, `generators`, `iot`, `dispensers` (both tables), `reports` (all
four), `audit`, `analytics` and the dashboard activity feed. A mechanical check now fails if a view caps a
list at 20+ rows without importing `TruncationNote`, which is how the last four were caught after the first
five had been wired.

### B. Three primary lists had no zero-row state (FIXED)

`batteries`, `fuel` and `generators` rendered an empty grid under a heading that said `(0)`. On a newly
provisioned tenant — exactly the state a first-time operator sees — the page looked broken rather than
empty. Each now renders "Nothing here yet." The distinction matters: an empty grid reads as a failed
load; a sentence reads as an empty fleet.

### C. Views that are correct as they stand

* **`asset-registry` (2 262 lines, 5 tabs, 24 selects).** The largest surface in the app and the most
  likely to hide a defect. It survives the sweep with no rule violation; its five form dialogs all use
  the shared `Select`, which cannot be constructed without a `label` (D-17), so the naming defect that
  produced 102 unnamed buttons cannot recur here.
* **`tenant-isolation`.** The dead `aria-hidden` refetch button found in the truncated annotation is
  removed (commit `031716b`). The view now has no focusable element inside a hidden subtree.
* **`dashboard`, `alarms`, `maintenance`, `users`, `tenants`.** Each has an explicit empty branch and an
  explicit error branch. The dashboard's alarm row was rebuilt from `role="button"` to a real `<button>`
  (nested-interactive, latent because the list is empty on a fresh database).

## 3. What this audit could not do

* **It is not a substitute for the sweep.** No claim here is marked VERIFIED. Contrast ratios, focus
  order, target sizes and overflow at 1440/390 are decided in Chromium by `views.e2e.ts`.
* **No performance claim.** No view has a measured render cost. A dev server without a database cannot
  produce an honest number, and reporting one would be dishonest.
* **Responsive behaviour is inspected, not exercised.** Every view uses responsive utilities
  (`sm:`/`md:`/`xl:`) and the sweep checks horizontal overflow at two widths, but intermediate widths
  (768, 1024) have not been rendered.
* **Density is a product decision, deliberately not overridden.** 10px and 11px type remain throughout
  (682 occurrences). The 8px/9px band — genuinely unreadable — was raised to 10px (D-10) and is now
  enforced; the rest is a judgement about the operator's real screen that this audit cannot make.
