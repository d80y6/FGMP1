# Task 43-B — Pinned/Recent Sites Subagent

## Task
Implement deferred roadmap item #18 — Pinned/Recent Sites quick-access feature
in the FGMP (Fuel & Generator Monitoring Platform) Next.js app.

## Work Log
1. Read `/home/z/my-project/worklog.md` (tail through Tasks 39-43-A) for
   project context: Next.js 16 + Prisma + SQLite + shadcn/ui (New York),
   emerald/amber/rose/violet palette (NO indigo/blue), EN+AR i18n via useT()
   + formatNumber(numLang) + useArabicNumerals(), hyphenated view keys, ESLint
   react-hooks/set-state-in-effect rule (use derived state, never setState in
   useEffect), dev server on :3000 with 4GB RAM cgroup (DO NOT restart, just
   lint). Deferred item #18 is the target.
2. Read existing files for context:
   - `src/lib/fgmp/store.ts` — the global `useFgmp` Zustand store. Does NOT
     have a persist middleware (the spec was incorrect on this point).
   - `src/lib/fgmp/use-favorites.ts` — the existing favorites/pinned-sites
     store, persisted to localStorage under `fgmp:favorites`. Already handles
     `ids`, `toggle`, `isFavorite`, `clear`, `hydrate`. Used by
     `pinned-sites-widget.tsx`, `site-detail-sheet.tsx`, `sites-view.tsx`.
   - `src/components/fgmp/site-detail-sheet.tsx` — has an existing
     `HeaderPinButton` using `Star` icon + `detail.pinSite`/`detail.unpinSite`
     i18n keys.
   - `src/components/fgmp/app-shell.tsx` — the top-level shell with the header
     (where the global search/Command palette trigger lives).
   - `src/components/fgmp/views/sites-view.tsx` — has `openSite(id)` handler.
   - `src/components/fgmp/views/dashboard-view.tsx` — has Top Critical Alarms
     Ack button, Live Alarm Feed click handler, NationalMap onSelectSite.
3. **Extended `src/lib/fgmp/use-favorites.ts`** (+149 lines net):
   - Added `MAX_PINNED = 12` and `MAX_RECENT = 5` constants.
   - Added `RECENT_STORAGE_KEY = "fgmp:recent-sites"`.
   - Added `recentSiteIds: string[]` and `recentVisitedAt: Record<string,
     number>` to the state interface.
   - Added `readRecentFromStorage()` + `writeRecentToStorage()` helpers
     (parallel to the existing favorites ones; sanitize + dedupe + cap at
     MAX_RECENT on read, prune stale timestamps on write).
   - Modified `toggle(id)`: when adding a new pin and current length >=
     MAX_PINNED, slice off the front (oldest) — FIFO eviction. Preserves
     the existing insertion-order invariant (most-recently-added LAST).
   - Added `addRecent(id)`: dedupe + move to front + cap at MAX_RECENT +
     stamp `recentVisitedAt[id] = Date.now()` + prune stale timestamps.
   - Added `clearRecent()`: empties both `recentSiteIds` and `recentVisitedAt`
     + persists. Pinned sites untouched.
   - Updated `hydrate()` to also pull in the recent-sites slice.
   - Updated `useFavoritesHydration()` to listen for storage events on BOTH
     keys (so cross-tab changes to either slice trigger a re-hydrate).
   - Added `resolveRecentSites(ids, sites)` helper (parallel to the existing
     `resolvePinnedSites`).
4. **Added 9 new i18n keys** to `src/lib/fgmp/i18n.ts` (+17 lines: section
   header + 9 keys EN+AR + blank) in a new `/* ===== Pinned/Recent Sites
   (#18) ===== */` section at the end of the DICTIONARY. Verified no
   duplicates via grep (exactly 9 occurrences of the new keys).
5. **Created `src/components/fgmp/quick-access-popover.tsx`** (242 lines):
   - `QuickAccessPopover` component — Popover with `Pin` icon trigger button
     + amber `Badge` counter (absolute-positioned, `bg-amber-500 text-white`,
     `text-[10px]`, `key={pinnedCount}` so it re-mounts on count change to
     retrigger the one-shot `animate-pin-pop` keyframe).
   - PopoverContent (w-80, p-0):
     * Header: `Pin` icon (filled amber) + "Quick Access" title.
     * Pinned Sites section: `Sparkles` icon + label + count chip +
       `ScrollArea` (`max-h-80`) of rows. Each row: clickable (opens site
       detail + addRecent + closes popover), `StatusBadge` (shape off, just
       colour), site name + code + governorate, hover X unpin button.
       Empty state: `Pin` icon + muted hint text.
     * Recent Sites section: `History` icon + label + count chip +
       `ScrollArea` (`max-h-80`) of rows. Each row: clickable, `StatusBadge`,
       site name + "2m ago" timestamp (via existing `timeAgo(ts, numLang)`).
       Empty state: `History` icon + muted hint text.
     * Footer: ghost `Trash2` + "Clear recent" button (disabled when empty).
   - Shared `EmptyState` helper: subtle icon + muted text (no plain text).
   - All rows: `transition-colors hover:bg-muted/60`, `focus-visible:opacity-
     100` on the unpin X for keyboard a11y.
6. **Mounted `QuickAccessPopover` in `src/components/fgmp/app-shell.tsx`**
   (+6 lines): added import + placed `<QuickAccessPopover />` right after the
   mobile Command palette trigger button, before the Clock — so it sits next
   to the global search as the spec requested.
7. **Updated `src/components/fgmp/views/sites-view.tsx`** (+10 lines): added
   `addRecent` selector + called it inside `openSite(id)` (the existing
   handler that opens the SiteDetailSheet).
8. **Updated `src/components/fgmp/views/dashboard-view.tsx`** (+19 lines):
   - Added `useFavorites` import + `addRecent` selector.
   - Top Critical Alarms Ack button onClick: now also opens the site detail
     (`selectSite + setView("sites")`) + `addRecent(a.siteId)`. Comment
     explains the UX rationale: operators can triage the underlying asset
     immediately after acknowledging.
   - NationalMap onSelectSite: appended `addRecent(id)`.
   - Live Alarm Feed row onClick: appended `addRecent(a.siteId)`.
9. **Updated `src/components/fgmp/site-detail-sheet.tsx`** (+17/-17 lines):
   - Swapped `Star` → `Pin` / `PinOff` icons in `HeaderPinButton` (per spec
     item #2). When pinned, the Pin icon gets `fill="currentColor"` so it
     renders as a solid amber shape; when unpinned, the PinOff icon renders
     as an outline. The existing `key={isFav ? "on" : "off"}` re-mount
     pattern + `animate-pin-pop` class is preserved.
   - Switched tooltip/aria-label from `detail.pinSite`/`detail.unpinSite`
     (existing keys) to the new `sites.pinSite`/`sites.unpinSite` keys (per
     spec item #6 — the new keys are added to i18n.ts and verified unique).
10. **Lint**: `cd /home/z/my-project && timeout 90 bun run lint` →
    EXIT_CODE=0, 0 errors, 0 warnings. Did NOT run `bun run build` (would
    OOM). Did NOT restart the dev server. Dev log shows healthy 200s on all
    endpoints, no compile errors.

## Stage Summary
- **7 files changed** (1 new, 6 modified):
  * `src/lib/fgmp/use-favorites.ts` (103 → 252 lines, +149: recent-sites
    slice + addRecent/clearRecent + FIFO eviction at MAX_PINNED=12 +
    resolveRecentSites helper + dual-key storage event listener)
  * `src/lib/fgmp/i18n.ts` (1876 → 1893 lines, +17: section header + 9 keys
    EN+AR, no duplicates — verified via grep: exactly 9 occurrences of the
    new keys)
  * `src/components/fgmp/quick-access-popover.tsx` (NEW, 242 lines: Pin icon
    trigger + amber count badge + 2 ScrollArea sections + Clear recent
    footer + shared EmptyState helper)
  * `src/components/fgmp/app-shell.tsx` (626 → 632 lines, +6: import +
    mount QuickAccessPopover next to global search)
  * `src/components/fgmp/views/sites-view.tsx` (283 → 293 lines, +10:
    addRecent in openSite)
  * `src/components/fgmp/views/dashboard-view.tsx` (432 → 451 lines, +19:
    addRecent on Ack + open site detail, on Live Alarm Feed click, on
    NationalMap onSelectSite)
  * `src/components/fgmp/site-detail-sheet.tsx` (820 → 837 lines, +17/-17:
    Star → Pin/PinOff icons in HeaderPinButton + use new i18n keys)
- **NO Prisma schema changes.** NO db:push run. NO dev server restart. NO new
  API routes. NO new dependencies. NO NationalMap changes (respected the
  freeze for Task 43-A).
- **9 new i18n keys** (EN + AR) in a dedicated `/* ===== Pinned/Recent Sites
  (#18) ===== */` section, no duplicates.
- **LINT: 0 errors, 0 warnings** (verified).
- **Dev server: healthy, no compile errors, all endpoints 200.**

## Architecture (brief)
- The pinned + recent sites state lives in the existing `useFavorites`
  Zustand store (extended, NOT in `useFgmp` — see Deviations #1). Two
  parallel persisted slices under separate localStorage keys
  (`fgmp:favorites` for pinned, `fgmp:recent-sites` for recent + timestamps).
  Both hydrate in a single `useFavoritesHydration()` effect (called by
  PinnedSitesWidget, SiteDetailSheet, SitesView, and now QuickAccessPopover
  — idempotent).
- `addRecent(siteId)` is called from every "open site detail" entry point:
  sites-view.openSite, dashboard NationalMap onSelectSite, dashboard Live
  Alarm Feed row click, dashboard Top Critical Alarms Ack button (which
  ALSO navigates to the site detail after acking — UX enhancement per spec),
  and the QuickAccessPopover row click itself. Dedupes + caps at 5 + stamps
  the visit time so the popover can show "2m ago" next to each recent row.
- The QuickAccessPopover is the single entry point for "jump to a site I
  care about": pinned sites (top, with unpin X buttons) + recent sites
  (below, with timestamps) + Clear recent footer. Clicking any row fires
  `selectSite + setView("sites") + addRecent + close popover` so the user
  lands on the SiteDetailSheet immediately.

## Deviations from spec (all pragmatic, documented in code comments):
1. **Store location**: spec said "Use the existing `useFgmp()` Zustand store
   at `src/lib/fgmp/store.ts`" and claimed it "already has a persist
   middleware pattern". This is incorrect — `useFgmp` has NO persist
   middleware (it's a pure in-memory store for server state: snapshot, me,
   view, etc.). The actual codebase pattern for client-persisted state is
   separate Zustand stores with manual localStorage read/write helpers
   (`useFavorites`, `useLanguage`, `useSiteNotes`). Extended `useFavorites`
   instead to (a) respect the existing pattern, (b) avoid polluting the
   server-state store with UI preferences, (c) reuse the existing
   `useFavoritesHydration()` hook for both slices in one effect, and (d)
   keep the existing `PinnedSitesWidget` working without changes. The
   persisted behaviour (max 12 pinned w/ FIFO, max 5 recent w/ MRU-first,
   deduped, timestamps) matches the spec exactly.
2. **Pin icon swap**: spec said "Add a Pin/Unpin button (use Pin/PinOff
   icons)" to the site detail header. An existing `HeaderPinButton` was
   already there (using `Star` icon). I REPLACED Star with Pin/PinOff
   rather than adding a second button — adding a second pin button next to
   the existing one would be redundant and confusing. The PinnedSitesWidget
   in the sidebar still uses Star (different visual context, out of scope
   to change). Documented as a deviation.
3. **i18n key duplication**: spec asked to add `sites.pinSite` /
   `sites.unpinSite` keys. The codebase already had `detail.pinSite` /
   `detail.unpinSite` and `sites.pin` / `sites.unpin` (different key names,
   same meaning). I added the spec's new keys verbatim (verified unique via
   grep — only the key NAMES are new, the values are intentional
   duplicates) and switched the HeaderPinButton's title/aria-label to use
   the new `sites.pinSite`/`sites.unpinSite` keys (so the new keys are
   actually referenced, not dead code).
4. **Top Critical Alarms Ack**: spec said "when clicking Ack → it should
   open site detail → call addRecent". The existing Ack button only acked
   the alarm and stopped propagation. I extended the onClick to ALSO
   navigate to the site detail (`selectSite + setView("sites")`) and call
   `addRecent`. This is a UX enhancement — operators can triage the
   underlying asset immediately after acknowledging the alarm.
5. **PinnedSitesWidget untouched**: spec didn't mention the existing sidebar
   widget. Left it as-is (still uses Star icon, still calls the same
   `useFavorites` store which now also handles recent sites). The widget
   and the new QuickAccessPopover coexist — the widget is always-visible in
   the sidebar, the popover is on-demand from the header.
