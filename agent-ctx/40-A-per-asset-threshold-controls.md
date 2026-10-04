# Task 40-A — Per-asset Threshold Controls Subagent

Work record for Task ID: 40-A (Enhancement #8: Per-asset threshold controls).

## Summary
Added inline per-asset threshold editors (Popover-based) to the site-detail-sheet
so an ADMIN can update fuel-tank low/critical thresholds (in litres) and
generator maintenance-due runtime (in hours) without leaving the drawer.

## Files changed
1. `src/app/api/fgmp/tanks/[id]/route.ts` — extended the existing `updateTankSchema`
   with two alias keys `lowFuelLitres` / `criticalFuelLitres` (positive numbers)
   plus a `.refine()` cross-field rule (`criticalFuelLitres < lowFuelLitres`).
   The route handler now maps the alias keys to the canonical DB columns
   (`lowThreshold` / `criticalThreshold`) before the Prisma update, and also
   keeps the engine's in-memory `live.low` / `live.critical` in sync.
2. `src/app/api/fgmp/generators/[id]/route.ts` — extended `updateGeneratorSchema`
   with the alias key `maintenanceDueHours` (positive number). The route
   handler maps it to `nextMaintenanceHrs` for both the DB update and the
   engine's in-memory state.
3. `src/lib/fgmp/i18n.ts` — added a new `/* ===== Per-asset threshold controls (#8) ===== */`
   section with 15 keys (`thresholds.*`) in BOTH EN and AR. Placed before the
   onboarding (#9) section.
4. `src/components/fgmp/site-detail-sheet.tsx` — added two new sub-components
   (`TankThresholdEditor`, `GenMaintenanceEditor`), wired a per-row Pencil
   button into both the tanks and generators tabs, gated on `role === "ADMIN"`.
   On save: PATCH the API → toast.success/error → refetch the site snapshot
   via the existing `useApi().refetch` callback. All form state is held in
   `useState` and mutated only from event handlers (no `setState` in
   `useEffect`), so the `react-hooks/set-state-in-effect` rule is satisfied.
   Drive-by fix: renamed the tank map variable `t` → `tk` to stop shadowing
   the translation function `t` (the original `t("detail.low")` inside the
   tank map callback would have thrown a TypeError because `t` was the tank
   object, not the i18n function).

## Schema decision (no changes)
The Prisma schema already had semantically-equivalent fields, so no
`db:push` was needed:
- `FuelTank.lowThreshold` / `FuelTank.criticalThreshold` (Float, litres)
  → exposed via API as `lowFuelLitres` / `criticalFuelLitres` (alias).
- `Generator.nextMaintenanceHrs` (Float, runtime hours)
  → exposed via API as `maintenanceDueHours` (alias).

## Verification
- `cd /home/z/my-project && timeout 90 bun run lint` → 0 errors, 0 warnings.
- Dev server stays healthy (no compile errors in `dev.log`).
- Did NOT run `bun run build` (would OOM the 4GB cgroup).
- Did NOT restart the dev server.

## New i18n keys (EN / AR)
| Key | EN | AR |
|-----|----|----|
| thresholds.edit | Edit | تعديل |
| thresholds.editThresholds | Edit thresholds | تعديل العتبات |
| thresholds.lowFuel | Low fuel | وقود منخفض |
| thresholds.criticalFuel | Critical fuel | وقود حرج |
| thresholds.maintenanceDueHours | Maintenance due hours | ساعات الصيانة المستحقة |
| thresholds.save | Save | حفظ |
| thresholds.saving | Saving… | جارٍ الحفظ… |
| thresholds.cancel | Cancel | إلغاء |
| thresholds.invalidLowFuel | Must be a positive number | يجب أن يكون رقمًا موجبًا |
| thresholds.invalidCritical | Must be less than the low fuel threshold | يجب أن يكون أقل من عتبة الوقود المنخفض |
| thresholds.invalidMaintenance | Must be a positive number | يجب أن يكون رقمًا موجبًا |
| thresholds.saveSuccess | Thresholds updated | تم تحديث العتبات |
| thresholds.saveFailure | Failed to update thresholds | فشل تحديث العتبات |
| thresholds.litres | litres | لتر |
| thresholds.hours | hours | ساعة |

## Deviations from spec
- **No Prisma schema changes**: the schema already had equivalent fields
  (`lowThreshold`/`criticalThreshold` on Tank, `nextMaintenanceHrs` on
  Generator). Adding redundant `lowFuelLitres`/`criticalFuelLitres`/
  `maintenanceDueHours` columns would have been wasteful and required
  `db:push`. Instead, the API accepts the spec's preferred JSON keys as
  aliases and the route handler maps them to the canonical DB columns.
  This keeps the public API contract identical to what the spec asked for
  while avoiding schema churn.
- **Button shown only to ADMIN**: the spec didn't explicitly mention RBAC
  gating, but the existing PATCH routes are `ROLES.ADMIN_ONLY`. To avoid
  showing users a button that would 403 on click, the editor buttons are
  only rendered when `me?.role === "ADMIN"`. Non-admins still see the
  threshold values in read-only form (as before).
- **Drive-by fix**: renamed the tank map variable from `t` to `tk` because
  it was shadowing the i18n `t` translation function and would have caused
  a TypeError the moment a user opened the Tanks tab in the site detail
  sheet. The new code now actually calls the translation function
  correctly.
