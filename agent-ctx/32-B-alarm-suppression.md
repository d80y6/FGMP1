# Task 32-B — Alarm Suppression Feature Builder

## Summary
Added Alarm Suppression / Maintenance Windows feature to FGMP. NOC
operators and admins can now create time-bound rules that prevent
specific alarm types from firing during planned maintenance windows.

## Files Created
- `src/lib/fgmp/suppression-check.ts` — matcher with 30s in-memory cache
- `src/app/api/fgmp/suppressions/route.ts` — GET + POST
- `src/app/api/fgmp/suppressions/[id]/route.ts` — PATCH + DELETE
- `src/components/fgmp/views/suppressions-view.tsx` — full UI

## Files Modified
- `prisma/schema.prisma` — AlarmSuppression model + relations on Tenant/Site/User
- `src/lib/fgmp/schemas.ts` — createSuppressionSchema + updateSuppressionSchema
- `src/lib/fgmp/engine.ts` — isAlarmSuppressed check in raiseAlarm
- `src/lib/fgmp/i18n.ts` — 39 suppressions.* keys (EN + AR)
- `src/lib/fgmp/rbac.ts` — view:suppressions capability added
- `src/lib/fgmp/store.ts` — ViewKey += "suppressions"
- `src/components/fgmp/app-shell.tsx` — nav item + view registration

## Verification
- `bun run db:push` → schema applied
- `bun run lint` → 0 errors, 0 warnings
- Dev server running on :3000
