# Task 43-A — Map Clustering Subagent

**Task:** Implement deferred roadmap item #16 — distance-based marker
clustering on the NationalMap component so that nearby sites are visually
grouped into a single cluster marker when they overlap.

## Files changed

| File | Was | Now | Delta |
|------|-----|-----|-------|
| `src/lib/fgmp/i18n.ts` | 1876 | 1882 | +6 |
| `src/components/fgmp/national-map.tsx` | 180 | 576 | +396 |

## What was built

### 1. i18n — 4 new `dash.cluster*` keys (EN + AR)

Inserted a dedicated `/* ===== Map clustering (#16) ===== */` section
immediately after `dash.sites` (line 243) and before the existing
`/* ===== Common KPI labels ===== */` section. Keys added:

- `dash.clusterSites` — "Sites in cluster" / "مواقع في العنقود"
- `dash.clusterExpand` — "Click to expand" / "انقر للتوسيع"
- `dash.clusterCollapse` — "Click to collapse" / "انقر للطي"
- `dash.clusterWorstStatus` — "Worst status" / "أسوأ حالة"

No duplicate keys. Verified via grep: exactly 4 `dash.cluster*` occurrences.

### 2. national-map.tsx — Distance-based clustering

**Architecture:**

A `buildClusters(markers, threshold)` function performs greedy distance-based
clustering using a spatial hash grid:

- The SVG space is divided into `threshold × threshold` cells (threshold =
  22 SVG units, configurable via the `CLUSTER_THRESHOLD` constant).
- Each marker is hashed into its cell.
- For each marker, look at its cell + 8 neighbors (3×3 neighborhood). The
  first existing cluster whose centroid is within `threshold` distance of
  the marker wins.
- If no match, create a new cluster at the marker's position.
- Cluster centroid = running average of member positions (avoids O(n)
  re-scan on each addition).
- When a cluster's centroid crosses a cell boundary (because a new member
  shifted the running average), the cluster is re-bucketed so subsequent
  markers can still find it.
- Worst-status is cached per cluster and updated incrementally as members
  are added (uses the existing `SEVERITY_RANK` map + worst-wins rule).
- Complexity: ~O(n) average, O(n²) pathological worst case (all markers in
  one cell). For n=50 sites this is trivially fast.

**Props added:**

- `enableClustering?: boolean` (default `true`) — when `false`, all markers
  render individually (the pre-#16 behavior). Lets callers opt out (e.g. a
  view that already filters the site list to a small subset).

**State (all `useState`, NO `useEffect` — fully compliant with the
`react-hooks/set-state-in-effect` ESLint rule):**

- `hover`, `hoverGov` (existing, unchanged)
- `hoverCluster: string | null` — currently-hovered cluster id (drives the
  r+2 + halo ring hover effect)
- `expandedClusterId: string | null` — when non-null, this cluster's members
  render individually (with connecting lines to the centroid) instead of as
  a single cluster marker. Cleared by clicking the SVG background, the
  centroid dot, or any non-marker child (governorate path, etc.).

**Derived state (all `useMemo`):**

- `clusters` — `buildClusters(markers, CLUSTER_THRESHOLD)` when
  `enableClustering` is on; `[]` otherwise. Deps: `[markers,
  enableClustering]` (markers is a stable memo of sites, so this satisfies
  the spec's "recomputes clusters only when sites or enableClustering
  changes" requirement).
- `expandedCluster` — the cluster matching `expandedClusterId` (must have
  > 1 member), or null.
- `individualMarkers` — which markers render individually?
  - Clustering OFF → all markers.
  - Clustering ON, no expansion → singletons (cluster size === 1).
  - Clustering ON, expanded → singletons + members of the expanded cluster.
  Collapsed multi-member clusters contribute NO individual markers.
- `alarmMarkers` — `individualMarkers` filtered to DEGRADED/OFFLINE. Drives
  the heatmap halos (only for visible individual markers — sites hidden
  inside a collapsed cluster don't get their own halo; the cluster's pulse
  animation takes over). This prevents collapsed cluster regions from
  looking "fuzzy" with hidden-marker halos.
- `collapsedClusters` — clusters with size > 1 AND id !== expandedClusterId.
- `expandedMemberIds` — Set of member ids for the expanded cluster, or null.
  Used to apply a subtle opacity dim (0.95) on individual markers that are
  members of the expanded cluster — visual hint that they're "freshly
  revealed" + ties them to the centroid via the dashed lines.

**Render changes:**

- SVG root: added `onClick={() => setExpandedClusterId(null)}` — clicking
  the background OR a governorate path (since clicks bubble) clears the
  expansion. Cluster and individual-marker click handlers call
  `e.stopPropagation()` so they don't trigger the background clear.
- Governorate polygons: unchanged.
- Alarm heatmap halos: now iterate `alarmMarkers` (only individually-
  rendered alarm markers) instead of `markers` (all markers).
- **NEW** connecting lines: when a cluster is expanded, render faint dashed
  lines (`stroke="currentColor"`, `strokeOpacity={0.2}`, `strokeWidth=1`,
  `strokeDasharray="3 3"`) from the cluster centroid to each individual
  member. `pointerEvents="none"` so clicks pass through to the background.
- **NEW** collapsed cluster markers: a `<g>` containing:
  - Pulse animation (existing `<animate>` pattern, `dur="2.4s"`) on an outer
    ring, only if any member is DEGRADED or OFFLINE.
  - Hover halo ring (r + 5, no fill, `stroke={color}`, `strokeOpacity=0.45`)
    shown when `isHover`.
  - Filled circle: `r = 12 + Math.min(size, 10) * 1.2` (size 2 → 14.4,
    size 10 → 24, capped at 24 for size ≥ 10). `fill = worst-status color`,
    `fillOpacity = 0.85`, white stroke 1.5px.
  - `<text>` count badge: `textAnchor="middle"`, `dominantBaseline="central"`,
    `fontSize=12`, `fill="white"`, `fontWeight="bold"`, `pointerEvents="none"`
    (so hover/click targets the circles, not the text). Count localized via
    `formatNumber(size, numLang)`.
  - `<title>` tooltip: lists ALL member site names + statuses
    (newline-separated, like the existing per-site tooltip), with a
    `dash.clusterSites` header + `dash.clusterWorstStatus` label +
    `dash.clusterExpand` hint footer.
  - Click handler: `stopPropagation` → `onSelectSite(c.members[0].s.id)`
    (preserves existing nav behavior) → `setExpandedClusterId(c.id)` (expand
    on next render) → `setHoverCluster(null)`.
- Individual markers: existing rendering path, with two changes:
  - `onClick` has `stopPropagation` so clicking a marker inside an expanded
    cluster doesn't collapse the cluster.
  - `style={inExpanded ? { opacity: 0.95 } : undefined}` — subtle dim on
    members of the expanded cluster.
- **NEW** centroid dot (rendered AFTER individual markers so it sits on top
  of the converging dashed lines): a small dashed circle at the centroid
  (`fill="var(--background)"`, `stroke="currentColor"`, `strokeOpacity=0.5`,
  `strokeWidth=1.2`, `strokeDasharray="2 2"`, `r=5`) with `onClick` that
  stops propagation and clears `expandedClusterId`. `<title>` is
  `t("dash.clusterCollapse")`. This gives users a clear "collapse"
  affordance that maps to the i18n key.
- Legend: localized the existing "Alarm heat" string to `t("dash.alarmHeat")`
  (existing key) — fell out of adding the `useT()` import. Added a new
  "Sites in cluster" swatch (amber-500/85 circle with white border) labeled
  with `t("dash.clusterSites")`, visible only when `enableClustering` is
  true, so users know what the larger cluster markers represent.
- SVG `aria-label`: localized from hardcoded "Yemen national site map" to
  `t("dash.nationalSiteMap")` (existing key).
- Tailwind `transition-all duration-200` classes on cluster groups, hover
  halo, cluster circle, individual marker group, individual marker circle —
  smooths the r/opacity changes during hover state transitions.

## Verification

- `cd /home/z/my-project && timeout 90 bun run lint` → EXIT_CODE=0, 0
  errors, 0 warnings (verified twice).
- Did NOT run `bun run build` (would OOM the 4GB cgroup).
- Did NOT restart the dev server.
- Dev log shows healthy 200s on all endpoints + regular
  POST /api/fgmp/iot/ingest 200s. No compile errors. Next.js HMR will pick
  up the file changes automatically.
- NO Prisma schema changes. NO db:push run. NO new API routes. NO new
  dependencies. NO other views touched.

## Deviations from spec

All pragmatic, documented in code comments + the worklog:

1. **useMemo dep `[markers, enableClustering]` vs `[sites, enableClustering]`**:
   Spec says "recomputes clusters only when sites or enableClustering
   changes". Used `markers` (which is itself a stable useMemo of `sites`)
   because `buildClusters` consumes `markers` directly — avoids recomputing
   the lng/lat projection inside the clustering memo. Semantically
   equivalent: when `sites` changes, `markers` changes, which triggers
   `clusters` to recompute.

2. **Dashed connecting lines (not solid)**: Spec says "faint connecting-line
   stroke". Implemented as `strokeDasharray="3 3"` dashed lines (not solid)
   for better visual distinction from the existing alarm pulse rings (which
   are solid). `stroke="currentColor"` + `strokeOpacity={0.2}` as specified.

3. **Added a small dashed centroid dot** in expanded mode: Spec didn't
   explicitly require a visible centroid, but it provides a clear "collapse"
   affordance that maps to the `dash.clusterCollapse` i18n key (otherwise
   that key would only be referenced in code, never shown to the user). The
   dot is small (r=5) and uses background fill + dashed currentColor stroke
   so it doesn't compete visually with the individual markers.

4. **Localized two pre-existing hardcoded strings**: SVG `aria-label`
   (`t("dash.nationalSiteMap")`) and legend "Alarm heat" (`t("dash.alarmHeat")`).
   Both keys already existed in i18n.ts — no new keys added for this. Fell
   out of adding the `useT()` import.

5. **Added a new legend entry** "Sites in cluster" (visible only when
   `enableClustering` is true) so users understand what the larger amber
   cluster markers represent. Uses the existing `dash.clusterSites` key.

## Notes for future agents

- The clustering threshold (22 SVG units) is a constant at the top of
  `national-map.tsx`. To make it tighter (more clusters) or looser (fewer
  clusters), adjust `CLUSTER_THRESHOLD`. At 22 units, only genuinely
  overlapping markers cluster — which is appropriate for the FGMP site
  density (50 sites nationwide, with a few clusters in major cities).
- The `enableClustering` prop defaults to `true`. Both current callers
  (dashboard-view.tsx and sites-view.tsx) use the default. If a future
  caller wants individual markers (e.g. a single-region drill-down view),
  pass `enableClustering={false}`.
- The cluster id is the first member's site id — this is stable across
  re-renders as long as the sites list order is stable. If the sites list
  reorders, the cluster ids will change, which could cause a stale
  `expandedClusterId`. The `expandedCluster` useMemo handles this safely
  (returns null if no cluster matches the id), so the worst case is the
  expansion silently clearing on a reorder — no crash.
- The centroid drift + re-bucketing logic is the trickiest part of
  `buildClusters`. If you ever need to debug "why didn't these two markers
  cluster?", check whether the first marker's centroid drifted out of the
  3×3 neighborhood of the second marker before the second marker was
  processed. For n=50 with threshold=22, this is unlikely but possible in
  dense clusters. The greedy approach is intentionally simple — a more
  sophisticated algorithm (e.g. k-means or DBSCAN) would be overkill for
  this use case.
