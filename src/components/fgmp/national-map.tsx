"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { SiteState } from "@/lib/fgmp/types";
import { YEMEN_GOVERNORATES, govNameToId, projectLngLat } from "@/lib/fgmp/yemen-map-data";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { SITE_STATUS_HEX as STATUS_COLOR } from "@/lib/fgmp/status";

// SVG viewBox matches the amcharts Yemen governorate map (see yemen-map-data.ts).
const MAP_VIEWBOX = "127.69 -2.5 1015.63 674";

// Severity rank for "worst status wins" aggregation (higher = worse).
const SEVERITY_RANK: Record<string, number> = {
  ONLINE: 0,
  MAINTENANCE: 1,
  DEGRADED: 2,
  OFFLINE: 3,
};

/** Aggregate site statuses for a governorate → worst status wins. */
function worstStatus(statuses: string[]): string | null {
  if (statuses.length === 0) return null;
  let worst = "ONLINE";
  let worstRank = -1;
  for (const s of statuses) {
    const r = SEVERITY_RANK[s] ?? -1;
    if (r > worstRank) {
      worstRank = r;
      worst = s;
    }
  }
  return worst;
}

/* ====================================================================== */
/* Map clustering (#16)                                                    */
/* ====================================================================== */

/**
 * Distance threshold (in SVG units) below which two sites are merged into a
 * single cluster. 22 units ≈ a few pixels at typical zoom — tight enough that
 * only genuinely overlapping markers cluster, loose enough to declutter hot
 * regions (e.g. Sana'a city with 8+ sites in a small area).
 */
const CLUSTER_THRESHOLD = 22;

interface Marker {
  s: SiteState;
  x: number;
  y: number;
}

interface Cluster {
  /** Stable id = first member's site id. Used as the expansion key. */
  id: string;
  /** Centroid x (running average of member x positions). */
  cx: number;
  /** Centroid y (running average of member y positions). */
  cy: number;
  members: Marker[];
  /** Worst status across all members (cached, updated as members are added). */
  worst: string;
}

/**
 * Greedy distance-based clustering using a spatial hash grid.
 *
 * The SVG space is divided into `threshold × threshold` cells. Each marker is
 * hashed into its cell, then compared against existing clusters whose centroid
 * falls within the 3×3 neighborhood (its own cell + 8 neighbors). The first
 * cluster within `threshold` distance wins; if none, a new cluster is created.
 *
 * When a cluster's centroid drifts across a cell boundary (because a new
 * member shifted the running average), the cluster is re-bucketed so
 * subsequent markers can still find it.
 *
 * Complexity: ~O(n) average, O(n²) pathological worst case (all markers in
 * one cell). For n=50 sites this is trivially fast.
 */
function buildClusters(markers: Marker[], threshold: number): Cluster[] {
  const t2 = threshold * threshold;
  const bucket = new Map<string, Set<Cluster>>();

  const keyOf = (x: number, y: number) =>
    `${Math.floor(x / threshold)},${Math.floor(y / threshold)}`;

  const addToBucket = (c: Cluster, x: number, y: number) => {
    const k = keyOf(x, y);
    let set = bucket.get(k);
    if (!set) {
      set = new Set();
      bucket.set(k, set);
    }
    set.add(c);
  };

  for (const m of markers) {
    const cx = Math.floor(m.x / threshold);
    const cy = Math.floor(m.y / threshold);
    let assigned: Cluster | null = null;
    outer: for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const set = bucket.get(`${cx + dx},${cy + dy}`);
        if (!set) continue;
        for (const c of set) {
          if ((m.x - c.cx) ** 2 + (m.y - c.cy) ** 2 <= t2) {
            assigned = c;
            break outer;
          }
        }
      }
    }

    if (assigned) {
      const n = assigned.members.length; // before push
      const oldCx = assigned.cx;
      const oldCy = assigned.cy;
      assigned.members.push(m);
      // Recompute centroid as running average (avoids O(n) re-scan).
      assigned.cx = (assigned.cx * n + m.x) / (n + 1);
      assigned.cy = (assigned.cy * n + m.y) / (n + 1);
      // Re-bucket if the centroid crossed a cell boundary.
      if (keyOf(oldCx, oldCy) !== keyOf(assigned.cx, assigned.cy)) {
        const oldKey = keyOf(oldCx, oldCy);
        const oldSet = bucket.get(oldKey);
        if (oldSet) {
          oldSet.delete(assigned);
          if (oldSet.size === 0) bucket.delete(oldKey);
        }
        addToBucket(assigned, assigned.cx, assigned.cy);
      }
      // Update cached worst status.
      const r = SEVERITY_RANK[m.s.status] ?? -1;
      if (r > (SEVERITY_RANK[assigned.worst] ?? -1)) {
        assigned.worst = m.s.status;
      }
    } else {
      const c: Cluster = {
        id: m.s.id,
        cx: m.x,
        cy: m.y,
        members: [m],
        worst: m.s.status,
      };
      addToBucket(c, m.x, m.y);
    }
  }

  // Flatten buckets → unique cluster list (a cluster may appear in multiple
  // buckets if it drifted; the Set dedupes).
  const seen = new Set<Cluster>();
  const out: Cluster[] = [];
  for (const set of bucket.values()) {
    for (const c of set) {
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
  }
  return out;
}

interface NationalMapProps {
  sites: SiteState[];
  selectedSiteId?: string | null;
  onSelectSite?: (id: string) => void;
  className?: string;
  showHeatmap?: boolean;
  /**
   * Enable marker clustering (default `true`). When `false`, every site is
   * rendered as an individual marker (the pre-#16 behavior). Callers that
   * already filter the site list to a small subset (e.g. the sites view) may
   * pass `false` to skip clustering.
   */
  enableClustering?: boolean;
}

export function NationalMap({
  sites,
  selectedSiteId,
  onSelectSite,
  className,
  showHeatmap = true,
  enableClustering = true,
}: NationalMapProps) {
  const [hover, setHover] = useState<string | null>(null);
  const [hoverGov, setHoverGov] = useState<string | null>(null);
  const [hoverCluster, setHoverCluster] = useState<string | null>(null);
  // When non-null, this cluster's members render individually (with connecting
  // lines to the centroid) instead of as a single cluster marker. Clicking the
  // background (or the centroid dot) clears it.
  const [expandedClusterId, setExpandedClusterId] = useState<string | null>(null);

  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";

  // Group sites by governorate ISO code for governorate-fill coloring.
  const govSites = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of sites) {
      const govId = govNameToId(s.governorate) ?? s.governorateId;
      if (!govId) continue;
      let statuses = map.get(govId);
      if (!statuses) {
        statuses = [];
        map.set(govId, statuses);
      }
      statuses.push(s.status);
    }
    return map;
  }, [sites]);

  // Pre-project all site markers into SVG space.
  const markers = useMemo<Marker[]>(
    () =>
      sites.map((s) => {
        const [x, y] = projectLngLat(s.longitude, s.latitude);
        return { s, x, y };
      }),
    [sites],
  );

  // Build clusters — recomputed only when sites or enableClustering changes.
  // (markers is a stable memo of sites, so depending on it is equivalent.)
  const clusters = useMemo(
    () => (enableClustering ? buildClusters(markers, CLUSTER_THRESHOLD) : []),
    [markers, enableClustering],
  );

  // The currently-expanded cluster (if any). Looked up by id each render so
  // we always have a fresh reference even if `clusters` is recomputed.
  const expandedCluster = useMemo(
    () =>
      clusters.find((c) => c.id === expandedClusterId && c.members.length > 1) ?? null,
    [clusters, expandedClusterId],
  );

  // Which markers render individually?
  //  - Clustering OFF: all markers.
  //  - Clustering ON, no expansion: singletons (cluster size === 1).
  //  - Clustering ON, expanded: singletons + members of the expanded cluster.
  // Collapsed multi-member clusters contribute NO individual markers (they
  // render as a single cluster marker instead).
  const individualMarkers = useMemo<Marker[]>(() => {
    if (!enableClustering) return markers;
    const out: Marker[] = [];
    for (const c of clusters) {
      if (c.members.length === 1) {
        out.push(c.members[0]);
      } else if (c.id === expandedClusterId) {
        out.push(...c.members);
      }
    }
    return out;
  }, [clusters, expandedClusterId, markers, enableClustering]);

  // Alarm heat halos — only for markers that are actually rendered as
  // individuals (sites hidden inside a collapsed cluster don't get their own
  // halo; the cluster's pulse animation takes over).
  const alarmMarkers = useMemo(
    () =>
      individualMarkers.filter(
        (m) => m.s.status === "DEGRADED" || m.s.status === "OFFLINE",
      ),
    [individualMarkers],
  );

  // Collapsed multi-member clusters (rendered as cluster markers).
  const collapsedClusters = useMemo(
    () => clusters.filter((c) => c.members.length > 1 && c.id !== expandedClusterId),
    [clusters, expandedClusterId],
  );

  // Precompute the set of expanded member ids for quick membership checks
  // during individual marker rendering (used to apply the expansion styling).
  const expandedMemberIds = useMemo(
    () =>
      expandedCluster
        ? new Set(expandedCluster.members.map((m) => m.s.id))
        : null,
    [expandedCluster],
  );

  return (
    <div className={cn("relative w-full", className)}>
      <svg
        viewBox={MAP_VIEWBOX}
        className="h-full w-full"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={t("dash.nationalSiteMap")}
        // Clicking the background (or any non-marker child, e.g. a governorate
        // path) clears the active cluster expansion.
        onClick={() => setExpandedClusterId(null)}
      >
        <defs>
          <linearGradient id="land-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--card)" stopOpacity={0.95} />
            <stop offset="100%" stopColor="var(--muted)" stopOpacity={0.7} />
          </linearGradient>
          <radialGradient id="heat-grad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.55} />
            <stop offset="60%" stopColor="#f59e0b" stopOpacity={0.18} />
            <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
          </radialGradient>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Governorate polygons — colored by aggregate site health (worst status wins). */}
        {YEMEN_GOVERNORATES.map((gov) => {
          const statuses = govSites.get(gov.id) ?? [];
          const ws = worstStatus(statuses);
          const fill = ws ? STATUS_COLOR[ws] : "url(#land-grad)";
          const fillOpacity = ws ? 0.22 : 1;
          const isHover = gov.id === hoverGov;
          return (
            <path
              key={gov.id}
              d={gov.path}
              fill={fill}
              fillOpacity={isHover ? Math.min(fillOpacity + 0.12, 0.5) : fillOpacity}
              stroke="currentColor"
              strokeOpacity={isHover ? 0.55 : 0.25}
              strokeWidth={isHover ? 2.2 : 1.4}
              className="text-foreground cursor-pointer transition-all"
              onMouseEnter={() => setHoverGov(gov.id)}
              onMouseLeave={() => setHoverGov(null)}
            >
              <title>{`${gov.name}${gov.nameAr ? ` (${gov.nameAr})` : ""}${statuses.length > 0 ? ` · ${statuses.length} site${statuses.length > 1 ? "s" : ""}${ws ? ` · ${ws}` : ""}` : " · no sites"}`}</title>
            </path>
          );
        })}

        {/* Alarm heatmap halos — only for individually-rendered alarm markers. */}
        {showHeatmap &&
          alarmMarkers.map((m) => (
            <circle key={`heat-${m.s.id}`} cx={m.x} cy={m.y} r={28} fill="url(#heat-grad)" />
          ))}

        {/* Connecting lines from the expanded cluster's centroid to each
            individual member — gives the user a clear visual anchor showing
            which markers belong to the expanded cluster. */}
        {expandedCluster &&
          expandedCluster.members.map((m) => (
            <line
              key={`link-${expandedCluster.id}-${m.s.id}`}
              x1={expandedCluster.cx}
              y1={expandedCluster.cy}
              x2={m.x}
              y2={m.y}
              stroke="currentColor"
              strokeOpacity={0.2}
              strokeWidth={1}
              strokeDasharray="3 3"
              className="text-foreground transition-opacity duration-200"
              // Lines are visual only — clicks pass through to the SVG
              // background (which clears the expansion).
              pointerEvents="none"
            />
          ))}

        {/* Collapsed cluster markers. */}
        {collapsedClusters.map((c) => {
          const size = c.members.length;
          const color = STATUS_COLOR[c.worst] ?? "#64748b";
          const hasAlarm = c.members.some(
            (m) => m.s.status === "DEGRADED" || m.s.status === "OFFLINE",
          );
          const baseR = 12 + Math.min(size, 10) * 1.2;
          const isHover = c.id === hoverCluster;
          const r = isHover ? baseR + 2 : baseR;
          // Tooltip: header (count + worst status), blank line, then each
          // member's name + status (newline-separated, like the existing
          // per-site tooltip), blank line, then the expand hint.
          const tooltipLines: string[] = [
            `${t("dash.clusterSites")}: ${formatNumber(size, numLang)}`,
            `${t("dash.clusterWorstStatus")}: ${c.worst}`,
            "",
            ...c.members.map(
              (m) => `• ${m.s.name} · ${m.s.status}`,
            ),
            "",
            t("dash.clusterExpand"),
          ];
          return (
            <g
              key={c.id}
              className="cursor-pointer transition-all duration-200"
              onClick={(e) => {
                // stopPropagation so the SVG-level background click handler
                // doesn't immediately clear the expansion we're setting.
                e.stopPropagation();
                onSelectSite?.(c.members[0].s.id);
                setExpandedClusterId(c.id);
                setHoverCluster(null);
              }}
              onMouseEnter={() => setHoverCluster(c.id)}
              onMouseLeave={() => setHoverCluster(null)}
            >
              {hasAlarm && (
                <circle cx={c.cx} cy={c.cy} r={baseR + 6} fill={color} opacity={0.25}>
                  <animate
                    attributeName="r"
                    values={`${baseR + 4};${baseR + 12};${baseR + 4}`}
                    dur="2.4s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    values="0.35;0.05;0.35"
                    dur="2.4s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
              {/* Hover halo ring */}
              {isHover && (
                <circle
                  cx={c.cx}
                  cy={c.cy}
                  r={r + 5}
                  fill="none"
                  stroke={color}
                  strokeOpacity={0.45}
                  strokeWidth={1.5}
                  className="transition-all duration-200"
                />
              )}
              <circle
                cx={c.cx}
                cy={c.cy}
                r={r}
                fill={color}
                fillOpacity={0.85}
                stroke="white"
                strokeWidth={1.5}
                className="transition-all duration-200"
              >
                <title>{tooltipLines.join("\n")}</title>
              </circle>
              <text
                x={c.cx}
                y={c.cy}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={12}
                fill="white"
                fontWeight="bold"
                pointerEvents="none"
                className="select-none"
              >
                {formatNumber(size, numLang)}
              </text>
            </g>
          );
        })}

        {/* Individual markers (singletons + members of the expanded cluster). */}
        {individualMarkers.map((m) => {
          const color = STATUS_COLOR[m.s.status] ?? "#64748b";
          const selected = m.s.id === selectedSiteId;
          const isHover = m.s.id === hover;
          const inExpanded = expandedMemberIds?.has(m.s.id) ?? false;
          const r = selected ? 7 : isHover ? 6 : 4.5;
          return (
            <g
              key={m.s.id}
              className="cursor-pointer transition-all duration-200"
              onClick={(e) => {
                // stopPropagation so clicking an individual marker inside an
                // expanded cluster doesn't collapse the cluster.
                e.stopPropagation();
                onSelectSite?.(m.s.id);
              }}
              onMouseEnter={() => setHover(m.s.id)}
              onMouseLeave={() => setHover(null)}
              // Subtle opacity dim on members of an expanded cluster so the
              // newly-revealed individual markers don't visually dominate the
              // other singletons — gives the expansion a "freshly revealed"
              // feel and visually ties them to the centroid via the lines.
              style={inExpanded ? { opacity: 0.95 } : undefined}
            >
              {(m.s.status === "DEGRADED" || m.s.status === "OFFLINE") && (
                <circle cx={m.x} cy={m.y} r={r + 5} fill={color} opacity={0.25}>
                  <animate
                    attributeName="r"
                    values={`${r + 3};${r + 10};${r + 3}`}
                    dur="2.4s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    values="0.35;0.05;0.35"
                    dur="2.4s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
              <circle
                cx={m.x}
                cy={m.y}
                r={r}
                fill={color}
                stroke="white"
                strokeOpacity={0.85}
                strokeWidth={selected ? 2.2 : 1.3}
                filter={selected ? "url(#glow)" : undefined}
                className="transition-all duration-200"
              >
                <title>{`${m.s.name}\n${m.s.code} · ${m.s.governorate || m.s.region}\n${m.s.status}`}</title>
              </circle>
            </g>
          );
        })}

        {/* Centroid dot for the expanded cluster — clickable to collapse.
            Renders AFTER individual markers so it sits on top of the
            converging dashed lines (a clean visual anchor). */}
        {expandedCluster && (
          <g
            className="cursor-pointer transition-all duration-200"
            onClick={(e) => {
              e.stopPropagation();
              setExpandedClusterId(null);
            }}
          >
            <circle
              cx={expandedCluster.cx}
              cy={expandedCluster.cy}
              r={5}
              fill="var(--background)"
              stroke="currentColor"
              strokeOpacity={0.5}
              strokeWidth={1.2}
              strokeDasharray="2 2"
              className="text-foreground"
            />
            <title>{t("dash.clusterCollapse")}</title>
          </g>
        )}
      </svg>

      {/* legend */}
      <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-3 rounded-lg border bg-background/80 px-3 py-1.5 text-[10px] backdrop-blur">
        {Object.entries(STATUS_COLOR).map(([k, c]) => (
          <span key={k} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: c }} />
            <span className="text-muted-foreground">{k}</span>
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-rose-500/40" />
          <span className="text-muted-foreground">{t("dash.alarmHeat")}</span>
        </span>
        {enableClustering && (
          <span className="flex items-center gap-1">
            <span className="h-3 w-3 rounded-full border border-white/70 bg-amber-500/85" />
            <span className="text-muted-foreground">{t("dash.clusterSites")}</span>
          </span>
        )}
      </div>
    </div>
  );
}
