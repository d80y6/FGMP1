# Task 42-A — Optimistic Updates Subagent

**Task:** Implement deferred roadmap item #20 — optimistic UI updates for alarm
acknowledge/resolve + bulk ack/resolve, and optimistic create/delete for one
CRUD view.

## Files changed

| File | Was | Now | Delta |
|------|-----|-----|-------|
| `src/lib/fgmp/i18n.ts` | 1865 | 1876 | +11 |
| `src/components/fgmp/views/alarms-view.tsx` | 791 | 913 | +122 |
| `src/components/fgmp/views/asset-registry-view.tsx` | 2040 | 2165 | +125 |

## What was built

### 1. i18n — 10 new `common.*` keys (EN + AR)

Inserted a dedicated `/* ===== Optimistic updates (#20) ===== */` section right
after `common.reboot` and before the existing `/* ===== Alarm view ===== */`
block. Keys added:

- `common.saving` — "Saving…" / "جارٍ الحفظ…"
- `common.optimisticError` — "Action failed — reverted" / "فشل الإجراء — تم التراجع"
- `common.acknowledging` — "Acknowledging…" / "جارٍ الإقرار…"
- `common.resolving` — "Resolving…" / "جارٍ الحل…"
- `common.creating` — "Creating…" / "جارٍ الإنشاء…"
- `common.deleting` — "Deleting…" / "جارٍ الحذف…"
- `common.acknowledgeSuccess` — "Alarm acknowledged" / "تم إقرار الإنذار"
- `common.resolveSuccess` — "Alarm resolved" / "تم حل الإنذار"
- `common.createSuccess` — "Created successfully" / "تم الإنشاء بنجاح"
- `common.deleteSuccess` — "Deleted successfully" / "تم الحذف بنجاح"

No duplicate keys. Verified with grep.

### 2. alarms-view.tsx — Optimistic ack / resolve / bulkAck / bulkResolve

**Architecture:**

Two pieces of local state overlay on top of the polled `alarms` list from
`useApi`:
- `optimisticPatches: Record<alarmId, Partial<Alarm>>` — patches like
  `{ status: "ACKNOWLEDGED", acknowledgedAt: now, acknowledgedById: meId }`
  that are applied on top of the polled alarm rows so the UI updates instantly.
- `savingIds: Set<alarmId>` — alarm IDs whose mutation is in flight (drives
  the `opacity-50` + `Loader2` spinner saving indicator on the row).

A derived `activePatches` memo filters the patches map to only entries that
haven't yet been absorbed by the polled data (i.e. `polled.status !==
patch.status`). This auto-evicts stale patches without needing
`setState` inside `useEffect` — compliant with the project's
`react-hooks/set-state-in-effect` ESLint rule.

A derived `mergedAlarms` memo applies the active patches on top of the polled
list. All downstream memos (`typeCounts`, `actionableIds`,
`validSelectedIds`, `filteredAlarms`, `triggeredRuleCount`) and the heatmap /
correlation panel now read from `mergedAlarms` instead of raw `alarms`.

**Action handlers:**

- `ack(id)`: applies patch → adds to savingIds → POSTs → on success keeps
  patch (auto-evicted when polled catches up) + toast `common.acknowledgeSuccess`
  + refetch + tick(10) → on error rolls back patch + toast
  `common.optimisticError` with `res.error` description.
- `resolve(id)`: same pattern, patch = `{ status: "RESOLVED", resolvedAt, resolvedById, }`, toast `common.resolveSuccess` on success.
- `bulkAck(ids)`: snapshots `optimisticPatches` for rollback → applies patch
  to all selected IDs → adds all to savingIds → POSTs → on success toast
  (existing `alarms.bulkAckToast` w/ count) + clearSelection + refetch →
  on error rolls back to snapshot + toast `common.optimisticError`.
- `bulkResolve(ids)`: same pattern, includes the resolution note from the
  prompt, patch = `{ status: "RESOLVED", resolvedAt, resolvedById, resolution }`.

**Visual saving indicator:**

Each `<TableRow>` gets `opacity-50` when `savingIds.has(a.id)`. The actions
cell now contains a tiny `Loader2 animate-spin` spinner (with
`aria-label={t("common.saving")}` for screen readers) when the row is mid-
flight, and the Ack/Resolve buttons are `disabled={isSaving}` to prevent
double-clicks. Because the patch flips `a.status` immediately, the Ack button
disappears the instant it's clicked (the row is now "ACKNOWLEDGED"), giving
instant visual confirmation that the click was registered.

### 3. asset-registry-view.tsx — Optimistic create/delete for DispensersTab

**Why dispensers?** The DispensersTab is the cleanest CRUD sub-view in
asset-registry (Tanks/Generators/Batteries/IoT all have similar shapes but
dispensers has the simplest form + the most complete i18n keys, and is the
only one whose create/delete dialog flow is fully localized). Augmenting it
demonstrates the optimistic pattern without rewriting the file.

**Architecture:**

Three pieces of local state:
- `pendingCreates: DispenserRow[]` — temp rows with `id: temp-${Date.now()}`
  appended instantly on form submit.
- `pendingDeleteIds: Set<id>` — IDs hidden instantly on delete confirm.
- `savingIds: Set<id>` — rows mid-flight (drives `opacity-50` + disables
  RowActions).

A derived `mergedDispensers` memo:
- Filters `pendingDeleteIds` out of the polled list.
- Filters `pendingCreates` to only those whose `espDeviceId` hasn't yet
  appeared in the polled list (auto-eviction once the real row arrives,
  matched by `espDeviceId` because temp IDs never collide with real cuids).
- Concatenates: `[...stillPendingCreates, ...visiblePolled]`.

The `filtered` memo and `loading` skeleton check now read from
`mergedDispensers`.

**Create flow (`handleCreateSubmit`):**

Called by `DispenserFormDialog` when `target === null` AND
`onCreateSubmit` is provided (new optional prop). The dialog was refactored
to take an `onCreateSubmit?: (payload) => Promise<void>` callback; when
present it delegates the API call to the parent and skips its own
`apiPost`/`onSaved`/toast logic. The edit path is unchanged.

Flow:
1. Build a `tempItem: DispenserRow` with `id: temp-${Date.now()}`,
   `status: "IDLE"`, `mode: "AUTO"`, all live fields zeroed, and `site`
   joined from the parent's `sites` list (so the Site column shows
   correctly).
2. `setPendingCreates((prev) => [tempItem, ...prev])` — append instantly.
3. `setSavingIds((prev) => add(tempId))` — mark saving.
4. `setCreateOpen(false)` — close dialog immediately (optimistic UX).
5. `await apiPost("/api/fgmp/dispensers", payload)`.
6. `setSavingIds((prev) => delete(tempId))` — clear saving.
7. On success: replace the temp row in `pendingCreates` with the real row
   from the API response, preserving the joined `site` (the API returns the
   bare `DispenserState` without a `site` relation). Toast
   `common.createSuccess`. `refetch()` (next poll will evict the temp row
   from `pendingCreates` via the `espDeviceId` match).
8. On error: `setPendingCreates((prev) => filter out tempId)` — rollback.
   Toast `common.optimisticError` with `res.error`.

**Delete flow (`handleDeleteConfirm`):**

Invoked from `DeleteConfirmDialog.onConfirm`. Flow:
1. `setPendingDeleteIds((prev) => add(target.id))` — hide instantly.
2. `setSavingIds((prev) => add(target.id))` — mark saving.
3. `setDeleteTarget(null)` — close dialog immediately.
4. `await fetch("/api/fgmp/dispensers/{id}", { method: "DELETE" })`.
5. `setSavingIds((prev) => delete(target.id))` — clear saving.
6. On success: keep removed. Toast `common.deleteSuccess`. `refetch()`.
7. On error: `setPendingDeleteIds((prev) => delete(target.id))` — restore.
   Toast `common.optimisticError` with server error (or fallback to
   `dispenser.deleteFailed`).

**Row saving indicator:**

`isSaving = savingIds.has(d.id) || d.id.startsWith("temp-")` — covers both
the in-flight create case (temp ID is in savingIds) and the brief window
after API success where the temp row has been promoted to a real-ID row
but the polled list hasn't caught up yet (matched by `temp-` prefix as a
belt-and-suspenders guard). `<TableRow className={cn("hover:bg-muted/30", isSaving && "opacity-50")}>`
and `<RowActions disabled={isSaving} />` prevent edits/deletes on rows that
aren't yet persisted.

## Compliance with project rules

- **ESLint `react-hooks/set-state-in-effect`**: All setState calls are inside
  event handlers (`ack`, `resolve`, `bulkAck`, `bulkResolve`,
  `handleCreateSubmit`, `handleDeleteConfirm`) — never inside `useEffect`.
  Auto-eviction of stale optimistic entries is done via derived `useMemo`
  (`activePatches`, `mergedAlarms`, `mergedDispensers`).
- **Color palette**: No new indigo/blue. The saving indicator uses
  `opacity-50` (no color) and `Loader2` with `text-muted-foreground`. Error
  toasts use the existing sonner styling.
- **i18n**: All 10 new keys added to BOTH `en` and `ar`. No duplicate keys.
  New `common.*` keys placed in a clearly-delimited `#20` section.
- **Minimal additions**: Did NOT rewrite either view file. Existing imports,
  layout, structure, and component hierarchy preserved. Changes are localized
  to (a) new state declarations, (b) new derived memos, (c) modified action
  handlers, (d) `mergedXxx` substituted for `xxx` in downstream consumers,
  (e) saving-indicator classNames + disabled props on action buttons.
- **No Prisma schema changes. No db:push run. No dev server restart.**

## Lint result

```
$ cd /home/z/my-project && timeout 90 bun run lint
$ eslint .
EXIT_CODE=0
```

**0 errors, 0 warnings.**

## Deviations from spec

1. **For the CRUD view, chose `DispensersTab` (inside
   `asset-registry-view.tsx`) instead of `users-view.tsx` or
   `maintenance-view.tsx`.** Reason: `users-view.tsx` has create but no
   delete (only activate/deactivate toggle). `maintenance-view.tsx` has
   create but only "complete" (no delete). The `DispensersTab` is the
   cleanest sub-view that has BOTH a create dialog AND a delete-confirm
   dialog, with full i18n keys already in place. (Spec allowed picking any
   of the three; I picked the one that exercises both halves of the
   optimistic CRUD pattern.)

2. **Bulk ack/resolve toasts still use the existing `alarms.bulkAckToast` /
   `alarms.bulkResolveToast` keys (which already include the count
   template)** rather than the new `common.acknowledgeSuccess` /
   `common.resolveSuccess` keys. Reason: the bulk toasts are
   count-templated ("3 alarms acknowledged"), which the common.* keys
   aren't. The new common.* keys are used for single-alarm ack/resolve
   toasts and for the create/delete toasts in the dispensers tab, exactly
   as specified.

3. **Edit path in `DispenserFormDialog` was NOT made optimistic.** Reason:
   the spec only asked for create + delete. Making edit optimistic would
   require a similar overlay patch system for in-place edits, which is a
   larger surface area and out of scope. The edit path is unchanged.

4. **A few pre-existing Prisma foreign-key errors in `dev.log`
   (`auditLog.create` and `user.create` violations)** are unrelated to this
   task — they're background cron/signup activity, not caused by my
   client-side changes. No API routes or DB schemas were touched.

## Dev server status

Healthy. No compile errors after the changes. `dev.log` shows normal 200s on
all endpoints. Did NOT restart the dev server (per spec). Did NOT run
`bun run build` (per spec).
