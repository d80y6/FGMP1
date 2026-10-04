# Task 33-C — Skeletons & Polish Builder

## Mission
Add loading skeletons, shimmer animation, micro-interactions, and a reusable
empty-state component to the 3 most data-heavy views (dashboard, alarms,
sites) of the FGMP platform.

## Files Touched

### NEW FILES (2)
- `src/components/fgmp/skeletons.tsx` — 7 exported skeleton components
  - `KpiCardSkeleton()` — accent bar + label/value/hint lines + icon box
  - `DashboardSkeleton()` — full NOC dashboard layout (header + status banner + 8 KPIs + chart h-64 + 5-row alarm list + 3 smaller chart cards)
  - `TableSkeleton({rows=8, cols=5})` — header + N body rows in CSS grid
  - `ChartSkeleton({height=240})` — title + chart area with grid lines + 12 varying-height "bars"
  - `AlarmsListSkeleton()` — 8 alarm rows (dot + type + 2 text lines + 2 badges + action btns)
  - `SitesGridSkeleton()` — 8 site card placeholders, responsive 1/2/3/4-col
  - `DetailsSheetSkeleton()` — header (avatar + 2 lines) + 3 sections of 4 fields

- `src/components/fgmp/empty-state.tsx` — reusable EmptyState component
  - Props: `icon` (LucideIcon), `title`, `description?`, `action?`, `className?`
  - Centered layout: muted circle (size-12) + font-medium title + muted-foreground description + optional action

### MODIFIED FILES (7)
- `src/app/globals.css` — added `.shimmer` wrapper class using `color-mix(in oklch, ...)` so the gradient works with the project's oklch theme variables. background-size: 1000px 100%, animation: shimmer 2s linear infinite (existing `@keyframes shimmer` reused)
- `src/components/ui/button.tsx` — added `active:scale-[0.98]` to the cva base string for tactile press feedback on ALL button variants
- `src/components/fgmp/app-shell.tsx` — added explicit `duration-150` to nav button `transition-colors`
- `src/components/fgmp/views/dashboard-view.tsx` — replaced `if (!snapshot || !k) return null;` with `<DashboardSkeleton />`. Early return is AFTER all hooks.
- `src/components/fgmp/views/alarms-view.tsx`:
  - Imported `AlarmsListSkeleton` + `EmptyState`
  - Extracted `loading: alarmsLoading` from useApi()
  - `!snapshot` → renders SectionHeader + Card wrapping AlarmsListSkeleton
  - `alarmsLoading && !alarms` → wraps `<Table>` in a conditional rendering `<AlarmsListSkeleton />` in its place inside the same Card (KPIs/heatmap/filters stay visible)
  - Empty-state (no alarms match filters) → replaced with `<EmptyState>` + optional "Clear filters" action button
  - Added `transition-colors hover:bg-muted/30` to data TableRows
  - Added `active:scale-[0.98] transition-transform` to per-row Ack/Resolve buttons
- `src/components/fgmp/views/sites-view.tsx` — `!snapshot` → renders SectionHeader + SitesGridSkeleton; data TableRow gets `transition-colors hover:bg-muted/30`
- `src/components/fgmp/views/audit-view.tsx` — empty state (no match) → `<EmptyState icon={FileQuestion}>`; data TableRow gets `transition-colors hover:bg-muted/30`
- `src/components/fgmp/views/users-view.tsx` — data TableRow gets `transition-colors hover:bg-muted/30` (composed with existing opacity-60 via cn())

## Verification
- `bun run lint` → 0 errors, 0 warnings
- Dev server healthy: `GET /` → 200, `GET /api/fgmp/state` → 401 (auth enforced), `GET /api/fgmp/health` → 200
- No new compile errors in dev.log from 33-C code (pre-existing preferences-view error is from a parallel task)

## Notes for Future Tasks
- The `.shimmer` class uses `color-mix(in oklch, ...)` — modern CSS, supported in all evergreen browsers since 2023
- Skeletons all use `'use client'` directive (they may be wrapped in client components)
- EmptyState takes already-translated strings (parent calls useT()) — no useT inside, so it stays a pure presentation component
- KpiCard already exceeds the task's hover-lift spec (`hover:shadow-lg` vs requested `hover:shadow-md`) — left unchanged
- The shadcn Skeleton's built-in `bg-accent animate-pulse` is preserved; the `.shimmer` wrapper adds a moving gradient that shows through the gaps between skeleton pieces for a synchronized sweep effect
