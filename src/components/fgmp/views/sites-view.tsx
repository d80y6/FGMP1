"use client";

import { useState, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Building2, Search, MapPin, Filter, Star, Plus, Pencil, Trash2, MoreHorizontal, Loader2 } from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import { useFavorites, useFavoritesHydration, useIsFavorite } from "@/lib/fgmp/use-favorites";
import { apiDelete } from "@/lib/fgmp/use-api";
import { SectionHeader } from "@/components/fgmp/section-header";
import { NationalMap } from "@/components/fgmp/national-map";
import { StatusBadge } from "@/components/fgmp/status-badge";
import { SiteDetailSheet } from "@/components/fgmp/site-detail-sheet";
import { SiteFormDialog } from "@/components/fgmp/site-form-dialog";
import { SiteComparisonTool } from "@/components/fgmp/site-comparison-tool";
import { SiteHealthBadge } from "@/components/fgmp/site-health-badge";
import { SitesGridSkeleton } from "@/components/fgmp/skeletons";
import { EmptyState } from "@/components/fgmp/empty-state";
import { ExportButton } from "@/components/fgmp/export-button";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { csvFilename, type CsvColumn } from "@/lib/fgmp/csv-export";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import type { SiteState } from "@/lib/fgmp/types";
import { toast } from "sonner";

export function SitesView() {
  // Hydrate the favorites store once on mount (idempotent).
  useFavoritesHydration();
  const { snapshot, selectSite, selectedSiteId, me, refresh } = useFgmp(useShallow((s) => ({ snapshot: s.snapshot, selectSite: s.selectSite, selectedSiteId: s.selectedSiteId, me: s.me, refresh: s.refresh })));
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const toggle = useFavorites((s) => s.toggle);
  const addRecent = useFavorites((s) => s.addRecent);
  const [q, setQ] = useState("");
  const [region, setRegion] = useState("all");
  const [status, setStatus] = useState("all");
  const [sheetOpen, setSheetOpen] = useState(false);

  // ── Site CRUD state ────────────────────────────────────────────────────
  // `formSite` = null → create mode; = SiteState → edit mode.
  // `deleteTarget` = the site pending deletion confirmation.
  const isAdmin = me?.role === "ADMIN";
  const [formOpen, setFormOpen] = useState(false);
  const [formSite, setFormSite] = useState<SiteState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SiteState | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openCreate = () => { setFormSite(null); setFormOpen(true); };
  const openEdit = (s: SiteState) => { setFormSite(s); setFormOpen(true); };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await apiDelete(`/api/fgmp/sites/${deleteTarget.id}`);
      if (res.ok) {
        toast.success(t("sites.deletedToast"));
        setDeleteTarget(null);
        await refresh();
      } else {
        const msg = (res.data as { error?: string } | undefined)?.error ?? res.error ?? "Error";
        toast.error(msg);
      }
    } finally {
      setDeleting(false);
    }
  };

  const filtered = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.sites.filter((s) => {
      if (region !== "all" && s.regionId !== region) return false;
      if (status !== "all" && s.status !== status) return false;
      if (q && !`${s.name} ${s.code} ${s.governorate} ${s.district}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [snapshot, q, region, status]);

  // Flattened site rows for the CSV export (#43-C). Pre-computes the per-site
  // tank / generator / battery counts (which the table renders on the fly) so
  // the export can produce a single self-contained file without re-walking the
  // snapshot arrays per cell. Numbers stay raw (not localized) so Excel parses
  // them as numbers; the boolean gridAvailable is rendered as Yes/No in the
  // active UI language for readability.
  const exportRows = useMemo(() => {
    if (!snapshot) return [];
    return filtered.map((s) => {
      const tanks = snapshot.tanks.filter((t) => t.siteId === s.id).length;
      const generators = snapshot.generators.filter((g) => g.siteId === s.id).length;
      const batteries = snapshot.batteries.filter((b) => b.siteId === s.id).length;
      return {
        code: s.code,
        name: s.name,
        region: s.region,
        governorate: s.governorate,
        district: s.district,
        status: s.status,
        criticality: s.criticality,
        loadKw: s.loadKw,
        powerSource: s.powerSource,
        gridAvailable: s.gridAvailable ? t("common.yes") : t("common.no"),
        tanks,
        generators,
        batteries,
      };
    });
  }, [filtered, snapshot, t]);
  const exportColumns: CsvColumn[] = [
    { key: "code", label: t("sites.code") },
    { key: "name", label: t("sites.name") },
    { key: "region", label: t("sites.region") },
    { key: "governorate", label: t("sites.governorate") },
    { key: "district", label: t("sites.district") },
    { key: "status", label: t("sites.status") },
    { key: "criticality", label: t("sites.criticality") },
    { key: "loadKw", label: `${t("sites.load")} (kW)` },
    { key: "powerSource", label: t("sites.powerSource") },
    { key: "gridAvailable", label: t("sites.gridAvailable") },
    { key: "tanks", label: t("sites.tanksCount") },
    { key: "generators", label: t("sites.generatorsCount") },
    { key: "batteries", label: t("sites.batteriesCount") },
  ];

  // Open the site detail sheet AND track the visit in the recent-sites list
  // (#18). addRecent dedupes + caps at 5 most-recent-first + stamps the visit
  // time so the Quick Access popover can show "2m ago" next to each row.
  const openSite = (id: string) => {
    selectSite(id);
    setSheetOpen(true);
    addRecent(id);
  };

  // While the snapshot is loading (initial mount), show the sites grid
  // skeleton so the operator sees shimmer placeholders instead of an empty
  // map + table. Keeps the SectionHeader visible for context.
  if (!snapshot) {
    return (
      <div className="space-y-4">
        <SectionHeader
          title={t("nav.sites")}
          description={t("desc.sites")}
          icon={<Building2 className="h-5 w-5" />}
        />
        <SitesGridSkeleton />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.sites")}
        description={t("desc.sites")}
        icon={<Building2 className="h-5 w-5" />}
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("sites.searchPlaceholder")} className="pl-8" />
        </div>
        <Select label={t("sites.region")} value={region} onValueChange={setRegion}>
          <SelectTrigger className="w-[180px]"><Filter className="mr-1.5 h-3.5 w-3.5" /><SelectValue placeholder={t("sites.regionPlaceholder")} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("sites.filterByRegion")}</SelectItem>
            {snapshot?.regions.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select label={t("sites.status")} value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder={t("sites.statusPlaceholder")} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("sites.filterByStatus")}</SelectItem>
            <SelectItem value="ONLINE">{t("common.online")}</SelectItem>
            <SelectItem value="DEGRADED">{t("common.degraded")}</SelectItem>
            <SelectItem value="OFFLINE">{t("common.offline")}</SelectItem>
            <SelectItem value="MAINTENANCE">{t("common.maintenance")}</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">{formatNumber(filtered.length, numLang)} {t("common.of")} {formatNumber(snapshot?.sites.length ?? 0, numLang)} {t("sites.sitesCount")}</span>
        {isAdmin && (
          <Button onClick={openCreate} size="sm" className="h-9 ms-auto">
            <Plus className="mr-1.5 h-4 w-4" />
            {t("sites.add")}
          </Button>
        )}
        <ExportButton
          filename={csvFilename("sites")}
          rows={exportRows}
          columns={exportColumns}
          disabled={filtered.length === 0}
          label={t("common.exportSites")}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        {/* Map */}
        <Card className="xl:col-span-3">
          <CardContent className="p-2">
            <div className="aspect-[16/10] w-full overflow-hidden rounded-lg border bg-muted/30">
              <NationalMap sites={filtered} selectedSiteId={selectedSiteId} onSelectSite={openSite} />
            </div>
          </CardContent>
        </Card>

        {/* Region tree */}
        <Card className="xl:col-span-2">
          <CardContent className="p-3">
            <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("sites.geographicHierarchy")}</p>
            <ScrollArea className="h-[360px]">
              <div className="space-y-1 pr-2">
                {snapshot?.regions.map((r) => {
                  const regionSites = snapshot.sites.filter((s) => s.regionId === r.id);
                  const online = regionSites.filter((s) => s.status === "ONLINE").length;
                  return (
                    <div key={r.id}>
                      <button onClick={() => setRegion(region === r.id ? "all" : r.id)} className={cn("flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted", region === r.id && "bg-muted font-medium")}>
                        <span className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 text-emerald-500" />{r.name}</span>
                        <span className="text-[10px] text-muted-foreground">{formatNumber(online, numLang)}/{formatNumber(regionSites.length, numLang)}</span>
                      </button>
                      {r.governorates.map((g) => {
                        const govSites = regionSites.filter((s) => s.governorateId === g.id);
                        if (!govSites.length) return null;
                        return (
                          <div key={g.id} className="ml-3 border-l pl-2">
                            <p className="px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{g.name} <span className="text-[10px]">({formatNumber(govSites.length, numLang)})</span></p>
                            {govSites.map((s) => (
                              <div key={s.id} className={cn("group flex w-full items-center justify-between rounded px-1 text-xs hover:bg-muted", selectedSiteId === s.id && "bg-muted")}>
                                <button onClick={() => openSite(s.id)} className="flex min-w-0 flex-1 items-center justify-between gap-1 px-1 py-1 text-left">
                                  <span className="truncate">{s.name}</span>
                                  <StatusBadge value={s.status} className="h-4 px-1 text-[10px]" />
                                </button>
                                <TreeStarButton siteId={s.id} />
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* Sites table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px] text-center">★</TableHead>
                <TableHead className="w-[110px]">{t("sites.code")}</TableHead>
                <TableHead>{t("sites.name")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("sites.region")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("sites.governorate")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("sites.criticality")}</TableHead>
                <TableHead className="w-[80px]">{t("sites.health")}</TableHead>
                <TableHead>{t("sites.status")}</TableHead>
                <TableHead className="hidden md:table-cell text-right">{t("sites.load")}</TableHead>
                {isAdmin && <TableHead className="w-[60px] text-right">{t("sites.actions")}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={isAdmin ? 10 : 9} className="p-0">
                    <EmptyState
                      icon={Building2}
                      title={t("common.noResultsTitle")}
                      description={t("common.noResultsDesc")}
                      action={
                        (q || region !== "all" || status !== "all") ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs transition-transform active:scale-95"
                            onClick={() => {
                              setQ("");
                              setRegion("all");
                              setStatus("all");
                            }}
                          >
                            {t("common.noResultsAction")}
                          </Button>
                        ) : undefined
                      }
                    />
                  </TableCell>
                </TableRow>
              )}
              {filtered.slice(0, 100).map((s) => {
                const siteTanks = snapshot?.tanks.filter((t) => t.siteId === s.id) ?? [];
                const siteGens = snapshot?.generators.filter((g) => g.siteId === s.id) ?? [];
                const siteBatts = snapshot?.batteries.filter((b) => b.siteId === s.id) ?? [];
                // Status-coloured hover accent bar colour — slides in from the
                // left edge of the row to make the hovered row obvious.
                const accentColor =
                  s.status === "OFFLINE" ? "bg-rose-500" :
                  s.status === "DEGRADED" ? "bg-amber-500" :
                  s.status === "MAINTENANCE" ? "bg-sky-500" :
                  "bg-emerald-500";
                return (
                  <TableRow
                    key={s.id}
                    className="group cursor-pointer transition-colors duration-150 hover:bg-muted/50 motion-reduce:transition-none"
                    onClick={() => openSite(s.id)}
                  >
                    <TableCell
                      className="relative text-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* Hover left-border accent (2px) — coloured by site status
                          so the operator sees at-a-glance which row they're on +
                          the row's overall health state. Implemented inside the
                          first cell with absolute positioning (table-row doesn't
                          honour absolute children reliably). */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          "pointer-events-none absolute inset-y-0 -left-2 w-[2px] opacity-0 transition-opacity duration-150 group-hover:opacity-100 motion-reduce:transition-none",
                          accentColor,
                        )}
                      />
                      <StarToggleButton siteId={s.id} onClick={toggle} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{s.code}</TableCell>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell className="hidden md:table-cell text-xs text-muted-foreground">{s.region}</TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">{s.governorate}</TableCell>
                    <TableCell className="hidden sm:table-cell"><StatusBadge value={s.criticality} className="h-5 text-[10px]" /></TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <SiteHealthBadge
                        site={s}
                        tanks={siteTanks}
                        generators={siteGens}
                        batteries={siteBatts}
                        compact
                      />
                    </TableCell>
                    <TableCell><StatusBadge value={s.status} className="h-5 text-[10px]" /></TableCell>
                    <TableCell className="hidden md:table-cell text-right text-xs tabular-nums">{formatNumber(s.loadKw, numLang)} kW</TableCell>
                    {isAdmin && (
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("sites.actions")}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel className="font-mono text-[10px] text-muted-foreground">{s.code}</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => openEdit(s)}>
                              <Pencil className="mr-2 h-3.5 w-3.5" />
                              {t("common.edit")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => setDeleteTarget(s)}
                            >
                              <Trash2 className="mr-2 h-3.5 w-3.5" />
                              {t("common.delete")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Site Comparison Tool */}
      <SiteComparisonTool />

      <SiteDetailSheet siteId={selectedSiteId} open={sheetOpen} onOpenChange={setSheetOpen} />

      {/* Create / Edit dialog (admin only — button + row menu are admin-gated) */}
      <SiteFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        onSaved={refresh}
        site={formSite}
      />

      {/* Delete confirmation — shows the cascade blast radius before the
          destructive delete. The counts come from the live snapshot so they're
          always accurate at the moment the admin opens the dialog. */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" />
              {t("sites.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("sites.deleteDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {deleteTarget && snapshot && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium">{deleteTarget.name}</span>
                <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px]">{deleteTarget.code}</code>
              </div>
              {(() => {
                const tanks = snapshot.tanks.filter((x) => x.siteId === deleteTarget.id).length;
                const gens = snapshot.generators.filter((x) => x.siteId === deleteTarget.id).length;
                const batts = snapshot.batteries.filter((x) => x.siteId === deleteTarget.id).length;
                const iot = snapshot.iotDevices.filter((x) => x.siteId === deleteTarget.id).length;
                const total = tanks + gens + batts + iot;
                return (
                  <>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">{t("sites.deleteCascade")}</p>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <span className="rounded bg-background px-1.5 py-0.5">{t("sites.tanksCount")}: <b className="tabular-nums">{formatNumber(tanks, numLang)}</b></span>
                      <span className="rounded bg-background px-1.5 py-0.5">{t("sites.generatorsCount")}: <b className="tabular-nums">{formatNumber(gens, numLang)}</b></span>
                      <span className="rounded bg-background px-1.5 py-0.5">{t("sites.batteriesCount")}: <b className="tabular-nums">{formatNumber(batts, numLang)}</b></span>
                      <span className="rounded bg-background px-1.5 py-0.5">IoT: <b className="tabular-nums">{formatNumber(iot, numLang)}</b></span>
                      {total === 0 && (
                        <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-400">
                          {t("sites.noChildAssets")}
                        </span>
                      )}
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDelete(); }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("sites.permDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Star toggle button used inside the sites table. Re-mounts on pin transition
 * so the `animate-pulse-once` keyframe replays on each new pin.
 */
function StarToggleButton({
  siteId,
  onClick,
}: {
  siteId: string;
  onClick: (id: string) => void;
}) {
  const isFav = useIsFavorite(siteId);
  const t = useT();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick(siteId);
      }}
      title={t("sites.pinUnpin")}
      aria-label={isFav ? t("sites.unpin") : t("sites.pin")}
      aria-pressed={isFav}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded transition-colors",
        isFav
          ? "text-amber-500 hover:bg-amber-500/10"
          : "text-muted-foreground hover:bg-muted hover:text-amber-500",
      )}
    >
      <Star
        key={isFav ? "on" : "off"}
        className={cn(
          "h-3.5 w-3.5 transition-colors",
          isFav && "fill-amber-400 text-amber-500 animate-pin-pop",
        )}
      />
    </button>
  );
}

/**
 * Smaller star toggle used inline in the geographic hierarchy tree.
 */
function TreeStarButton({ siteId }: { siteId: string }) {
  const isFav = useIsFavorite(siteId);
  const toggle = useFavorites((s) => s.toggle);
  const t = useT();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggle(siteId);
      }}
      title={t("sites.pinUnpin")}
      aria-label={isFav ? t("sites.unpin") : t("sites.pin")}
      aria-pressed={isFav}
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 transition-colors focus-visible:opacity-100 group-hover:opacity-100",
        isFav
          ? "opacity-100 text-amber-500 hover:bg-amber-500/10"
          : "text-muted-foreground hover:bg-muted hover:text-amber-500",
      )}
    >
      <Star
        key={isFav ? "on" : "off"}
        className={cn(
          "h-3 w-3 transition-colors",
          isFav && "fill-amber-400 text-amber-500 animate-pin-pop",
        )}
      />
    </button>
  );
}
