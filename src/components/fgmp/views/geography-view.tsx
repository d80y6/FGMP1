"use client";

import type React from "react";
import { useState, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Globe2, Map, MapPin, Plus, Pencil, Trash2,
  ShieldAlert, Building2, Layers,
} from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi, apiPost, apiPatch, apiDelete } from "@/lib/fgmp/use-api";
import { hasCapability } from "@/lib/fgmp/rbac-core";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { StatusBadge } from "@/components/fgmp/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { useT, useTF, useDir, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { cn } from "@/lib/utils";

/* ────────────────────────────────────────────────────────────────────────
 * Types — match the /api/fgmp/geography response shape
 * ──────────────────────────────────────────────────────────────────────── */

interface DistrictNode {
  id: string;
  name: string;
  createdAt: string;
  _count: { sites: number };
}

interface GovernorateNode {
  id: string;
  name: string;
  createdAt: string;
  districts: DistrictNode[];
  _count: { sites: number };
}

interface RegionNode {
  id: string;
  name: string;
  tenantId: string;
  createdAt: string;
  governorates: GovernorateNode[];
  _count: { sites: number; governorates: number };
}

type EntityKind = "region" | "governorate" | "district";

interface DeleteTarget {
  kind: EntityKind;
  id: string;
  name: string;
  /** How many sites hang off this entity. The delete guard reads THIS. */
  siteCount: number;
  countLabel: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * Main view
 * ──────────────────────────────────────────────────────────────────────── */

export function GeographyView() {
  const { me, snapshot } = useFgmp(useShallow((s) => ({ me: s.me, snapshot: s.snapshot })));
  const t = useT();
  const dir = useDir();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";

  // Two different questions, two different capabilities:
  //   view:geography  — may open the hierarchy at all (GET /api/fgmp/geography)
  //   geography:manage — may create/edit/delete (POST/PATCH/DELETE)
  // Both are read from the matrix; a role literal also hid the whole view from
  // SUPERADMIN, which holds the wildcard and is offered the nav entry.
  const canViewGeography = me ? hasCapability(me.role, "view:geography") : true;
  const canManageGeography = me ? hasCapability(me.role, "geography:manage") : false;

  const { data: regions, loading, refetch } = useApi<RegionNode[]>("/api/fgmp/geography", { interval: 30000 });

  // Selection state — drill-down the hierarchy.
  // Note: downstream selections (governorate / district) are *not* reset
  // imperatively when the parent changes. Instead they're derived: when the
  // parent no longer contains the stale child id, `selectedGov` /
  // `selectedDistrict` (below) resolve to `null` and the column renders its
  // "select a parent" empty state. This avoids the setState-in-effect
  // anti-pattern and naturally restores the previous selection if the user
  // re-selects the original parent.
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [selectedGovId, setSelectedGovId] = useState<string | null>(null);
  const [selectedDistrictId, setSelectedDistrictId] = useState<string | null>(null);

  // Dialog state — region/governorate/district create + edit + delete.
  const [regionCreateOpen, setRegionCreateOpen] = useState(false);
  const [regionEditTarget, setRegionEditTarget] = useState<RegionNode | null>(null);
  const [govCreateOpen, setGovCreateOpen] = useState(false);
  const [govEditTarget, setGovEditTarget] = useState<GovernorateNode | null>(null);
  const [districtCreateOpen, setDistrictCreateOpen] = useState(false);
  const [districtEditTarget, setDistrictEditTarget] = useState<DistrictNode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const selectedRegion = useMemo(
    () => (regions ?? []).find((r) => r.id === selectedRegionId) ?? null,
    [regions, selectedRegionId],
  );
  const selectedGov = useMemo(
    () => selectedRegion?.governorates.find((g) => g.id === selectedGovId) ?? null,
    [selectedRegion, selectedGovId],
  );
  const selectedDistrict = useMemo(
    () => selectedGov?.districts.find((d) => d.id === selectedDistrictId) ?? null,
    [selectedGov, selectedDistrictId],
  );

  // Sites that belong to the selected district — sourced from the live
  // snapshot (already tenant-scoped + kept fresh by the global tick).
  const districtSites = useMemo(() => {
    if (!selectedDistrictId || !snapshot) return [];
    return snapshot.sites
      .filter((s) => s.districtId === selectedDistrictId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [snapshot, selectedDistrictId]);

  // Aggregate KPIs across the whole hierarchy.
  const stats = useMemo(() => {
    const list = regions ?? [];
    let govCount = 0;
    let districtCount = 0;
    let siteCount = 0;
    list.forEach((r) => {
      govCount += r.governorates.length;
      r.governorates.forEach((g) => {
        districtCount += g.districts.length;
        siteCount += g._count.sites;
      });
    });
    return { regions: list.length, governorates: govCount, districts: districtCount, sites: siteCount };
  }, [regions]);

  // Access control: the same `view:geography` capability the nav filter and
  // GET /api/fgmp/geography enforce.
  if (me && !canViewGeography) {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>{t("common.accessDenied")}</AlertTitle>
          <AlertDescription>{t("geography.adminOnly")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.geography")}
        description={t("desc.geography")}
        icon={<Globe2 className="h-5 w-5" />}
        tone="emerald"
      />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label={t("geography.regionsTitle")} value={formatNumber(stats.regions, numLang)} icon={<Globe2 className="h-4 w-4" />} />
        <KpiCard label={t("geography.governoratesTitle")} value={formatNumber(stats.governorates, numLang)} icon={<Map className="h-4 w-4" />} tone="good" />
        <KpiCard label={t("geography.districtsTitle")} value={formatNumber(stats.districts, numLang)} icon={<MapPin className="h-4 w-4" />} tone="warn" />
        <KpiCard label={t("kpi.sites")} value={formatNumber(stats.sites, numLang)} icon={<Building2 className="h-4 w-4" />} tone="info" />
      </div>

      {/* Drill-down — 3 columns on md+ */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {/* Column 1 — Regions */}
        <ColumnShell
          title={t("geography.regionsTitle")}
          count={stats.regions}
          icon={<Globe2 className="h-4 w-4" />}
          onAdd={canManageGeography ? () => setRegionCreateOpen(true) : undefined}
          loading={loading && !regions}
          dir={dir}
        >
          {(regions ?? []).map((r) => (
            <ListItem
              key={r.id}
              active={r.id === selectedRegionId}
              onClick={() => setSelectedRegionId(r.id)}
              title={r.name}
              meta={`${formatNumber(r.governorates.length, numLang)} govs · ${formatNumber(r._count.sites, numLang)} sites`}
              canEdit={canManageGeography}
              onEdit={() => setRegionEditTarget(r)}
              canDelete={canManageGeography}
              onDelete={() =>
                setDeleteTarget({
                  kind: "region",
                  id: r.id,
                  name: r.name,
                  siteCount: r._count.sites,
                  countLabel: `${r._count.governorates} governorates · ${r._count.sites} sites`,
                })
              }
              dir={dir}
            />
          ))}
          {(regions ?? []).length === 0 && !loading && (
            <EmptyColumn text={t("geography.noRegions")} />
          )}
        </ColumnShell>

        {/* Column 2 — Governorates */}
        <ColumnShell
          title={t("geography.governoratesTitle")}
          count={selectedRegion?.governorates.length ?? 0}
          icon={<Map className="h-4 w-4" />}
          onAdd={canManageGeography && selectedRegion ? () => setGovCreateOpen(true) : undefined}
          loading={false}
          parentHint={selectedRegion?.name}
          dir={dir}
        >
          {selectedRegion ? (
            selectedRegion.governorates.length === 0 ? (
              <EmptyColumn text={t("geography.noGovernorates")} />
            ) : (
              selectedRegion.governorates.map((g) => (
                <ListItem
                  key={g.id}
                  active={g.id === selectedGovId}
                  onClick={() => setSelectedGovId(g.id)}
                  title={g.name}
                  meta={`${formatNumber(g.districts.length, numLang)} districts · ${formatNumber(g._count.sites, numLang)} sites`}
                  canEdit={canManageGeography}
                  onEdit={() => setGovEditTarget(g)}
                  canDelete={canManageGeography}
                  onDelete={() =>
                    setDeleteTarget({
                      kind: "governorate",
                      id: g.id,
                      name: g.name,
                      siteCount: g._count.sites,
                      countLabel: `${g.districts.length} districts · ${g._count.sites} sites`,
                    })
                  }
                  dir={dir}
                />
              ))
            )
          ) : (
            <EmptyColumn text={t("geography.selectRegion")} />
          )}
        </ColumnShell>

        {/* Column 3 — Districts */}
        <ColumnShell
          title={t("geography.districtsTitle")}
          count={selectedGov?.districts.length ?? 0}
          icon={<MapPin className="h-4 w-4" />}
          onAdd={canManageGeography && selectedGov ? () => setDistrictCreateOpen(true) : undefined}
          loading={false}
          parentHint={selectedGov?.name}
          dir={dir}
        >
          {selectedGov ? (
            selectedGov.districts.length === 0 ? (
              <EmptyColumn text={t("geography.noDistricts")} />
            ) : (
              selectedGov.districts.map((d) => (
                <ListItem
                  key={d.id}
                  active={d.id === selectedDistrictId}
                  onClick={() => setSelectedDistrictId(d.id)}
                  title={d.name}
                  meta={`${formatNumber(d._count.sites, numLang)} sites`}
                  canEdit={canManageGeography}
                  onEdit={() => setDistrictEditTarget(d)}
                  canDelete={canManageGeography}
                  onDelete={() =>
                    setDeleteTarget({
                      kind: "district",
                      id: d.id,
                      name: d.name,
                      siteCount: d._count.sites,
                      countLabel: `${d._count.sites} sites`,
                    })
                  }
                  dir={dir}
                />
              ))
            )
          ) : (
            <EmptyColumn text={t("geography.selectGovernorate")} />
          )}
        </ColumnShell>
      </div>

      {/* Sites of selected district */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            Sites
            {selectedDistrict && (
              <span className="text-muted-foreground">
                · {selectedRegion?.name} › {selectedGov?.name} › {selectedDistrict.name}
              </span>
            )}
          </CardTitle>
          <Badge variant="outline" className="text-[10px] tabular-nums">
            {formatNumber(districtSites.length, numLang)}
          </Badge>
        </CardHeader>
        <CardContent className="p-0">
          {selectedDistrict ? (
            districtSites.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">{t("geography.noSitesDistrict")}</div>
            ) : (
              <ScrollArea className="max-h-[420px]">
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow>
                      <TableHead className="w-[100px]">Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead className="hidden md:table-cell w-[110px]">Criticality</TableHead>
                      <TableHead className="w-[100px]">Status</TableHead>
                      <TableHead className="w-[80px] text-right">Load (kW)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {districtSites.map((s) => (
                      <TableRow key={s.id} className="transition-colors hover:bg-muted/30">
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[10px]" dir="ltr">{s.code}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">{s.name}</span>
                            <span className="text-[10px] text-muted-foreground" dir="ltr">{s.address}</span>
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <Badge variant="outline" className="text-[10px]">{s.criticality}</Badge>
                        </TableCell>
                        <TableCell><StatusBadge value={s.status} /></TableCell>
                        <TableCell className="text-right tabular-nums text-xs" dir="ltr">
                          {formatNumber(s.loadKw, numLang)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            )
          ) : (
            <div className="py-10 text-center text-sm text-muted-foreground">{t("geography.selectDistrict")}</div>
          )}
        </CardContent>
      </Card>

      {/* Region create/edit */}
      <NameDialog
        open={regionCreateOpen}
        onOpenChange={setRegionCreateOpen}
        title={t("geography.addRegion")}
        description={t("geography.addRegionDesc")}
        initialName=""
        submitLabel={t("geography.createRegion")}
        onSubmit={async (name) => {
          const res = await apiPost("/api/fgmp/geography/regions", { name });
          if (res.ok) {
            toast.success("Region created");
            refetch();
            setRegionCreateOpen(false);
          } else {
            toast.error((res.data as { error?: string } | undefined)?.error ?? "Error");
          }
          return res.ok;
        }}
      />
      <NameDialog
        open={!!regionEditTarget}
        onOpenChange={(o) => !o && setRegionEditTarget(null)}
        title={t("geography.editRegion")}
        description={regionEditTarget?.name ?? ""}
        initialName={regionEditTarget?.name ?? ""}
        submitLabel={t("common.save")}
        onSubmit={async (name) => {
          if (!regionEditTarget) return false;
          const res = await apiPatch(`/api/fgmp/geography/regions/${regionEditTarget.id}`, { name });
          if (res.ok) {
            toast.success("Region updated");
            refetch();
            setRegionEditTarget(null);
          } else {
            toast.error((res.data as { error?: string } | undefined)?.error ?? "Error");
          }
          return res.ok;
        }}
      />

      {/* Governorate create/edit */}
      <NameDialog
        open={govCreateOpen}
        onOpenChange={setGovCreateOpen}
        title={t("geography.addGovernorate")}
        description={`Under region: ${selectedRegion?.name ?? ""}`}
        initialName=""
        submitLabel={t("geography.createGovernorate")}
        onSubmit={async (name) => {
          if (!selectedRegion) return false;
          const res = await apiPost("/api/fgmp/geography/governorates", {
            regionId: selectedRegion.id,
            name,
          });
          if (res.ok) {
            toast.success("Governorate created");
            refetch();
            setGovCreateOpen(false);
          } else {
            toast.error((res.data as { error?: string } | undefined)?.error ?? "Error");
          }
          return res.ok;
        }}
      />
      <NameDialog
        open={!!govEditTarget}
        onOpenChange={(o) => !o && setGovEditTarget(null)}
        title={t("geography.editGovernorate")}
        description={govEditTarget?.name ?? ""}
        initialName={govEditTarget?.name ?? ""}
        submitLabel={t("common.save")}
        onSubmit={async (name) => {
          if (!govEditTarget) return false;
          const res = await apiPatch(`/api/fgmp/geography/governorates/${govEditTarget.id}`, { name });
          if (res.ok) {
            toast.success("Governorate updated");
            refetch();
            setGovEditTarget(null);
          } else {
            toast.error((res.data as { error?: string } | undefined)?.error ?? "Error");
          }
          return res.ok;
        }}
      />

      {/* District create/edit */}
      <NameDialog
        open={districtCreateOpen}
        onOpenChange={setDistrictCreateOpen}
        title={t("geography.addDistrict")}
        description={`Under governorate: ${selectedGov?.name ?? ""}`}
        initialName=""
        submitLabel={t("geography.createDistrict")}
        onSubmit={async (name) => {
          if (!selectedGov) return false;
          const res = await apiPost("/api/fgmp/geography/districts", {
            governorateId: selectedGov.id,
            name,
          });
          if (res.ok) {
            toast.success("District created");
            refetch();
            setDistrictCreateOpen(false);
          } else {
            toast.error((res.data as { error?: string } | undefined)?.error ?? "Error");
          }
          return res.ok;
        }}
      />
      <NameDialog
        open={!!districtEditTarget}
        onOpenChange={(o) => !o && setDistrictEditTarget(null)}
        title={t("geography.editDistrict")}
        description={districtEditTarget?.name ?? ""}
        initialName={districtEditTarget?.name ?? ""}
        submitLabel={t("common.save")}
        onSubmit={async (name) => {
          if (!districtEditTarget) return false;
          const res = await apiPatch(`/api/fgmp/geography/districts/${districtEditTarget.id}`, { name });
          if (res.ok) {
            toast.success("District updated");
            refetch();
            setDistrictEditTarget(null);
          } else {
            toast.error((res.data as { error?: string } | undefined)?.error ?? "Error");
          }
          return res.ok;
        }}
      />

      {/* Universal delete confirmation */}
      <DeleteEntityDialog
        target={deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        onDeleted={() => {
          // Clear the now-invalid downstream selection if needed.
          if (deleteTarget?.kind === "region") setSelectedRegionId(null);
          if (deleteTarget?.kind === "governorate") setSelectedGovId(null);
          if (deleteTarget?.kind === "district") setSelectedDistrictId(null);
          setDeleteTarget(null);
          refetch();
        }}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Sub-components
 * ──────────────────────────────────────────────────────────────────────── */

function ColumnShell({
  title, count, icon, onAdd, loading, parentHint, children, dir,
}: {
  title: string;
  count: number;
  icon: React.ReactNode;
  onAdd?: () => void;
  loading?: boolean;
  parentHint?: string;
  children: React.ReactNode;
  dir: "rtl" | "ltr";
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{icon}</span>
          {title}
          <Badge variant="outline" className="text-[10px] tabular-nums">{formatNumber(count, dir === "rtl" ? "ar" : "en")}</Badge>
        </CardTitle>
        {onAdd && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onAdd}>
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        )}
      </CardHeader>
      {parentHint && (
        <div className="px-4 pb-2 text-[11px] text-muted-foreground">
          {parentHint}
        </div>
      )}
      <CardContent className="flex-1 p-0">
        {loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <ScrollArea className="max-h-[420px]">
            <div className="space-y-1 p-2">{children}</div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

function ListItem({
  active, onClick, title, meta, canEdit, onEdit, canDelete, onDelete, dir,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  meta: string;
  canEdit?: boolean;
  onEdit?: () => void;
  canDelete?: boolean;
  onDelete?: () => void;
  dir: "rtl" | "ltr";
}) {
  void dir;
  // Module-scope component: the translate hook has to be called here, not
  // inherited from the view that renders it.
  const t = useT();
  return (
    // The row used to BE a button (role="button" + tabIndex + synthetic
    // Enter/Space), with the Edit and Delete buttons nested inside it. A button
    // inside a button is not one control with extra affordances: it is invalid
    // and axe reports nested-interactive (serious) once per row — a screen
    // reader announces a button that contains buttons, and Enter on a focused
    // Delete fires both handlers. Now the row is a plain container, the name is
    // a real <button>, and the actions are its siblings.
    <div
      className={cn(
        "group flex items-center justify-between rounded-md border transition-all",
        "hover:border-emerald-500/40 hover:bg-emerald-500/5",
        active ? "border-emerald-500/60 bg-emerald-500/10" : "border-transparent",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="min-w-0 flex-1 cursor-pointer rounded-sm px-2.5 py-2 text-start focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block text-[10px] text-muted-foreground">{meta}</span>
      </button>
      {(canEdit || canDelete) && (
        <div className="flex items-center gap-0.5 pr-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {canEdit && onEdit && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={onEdit}
              aria-label={t("common.edit")}
            >
              <Pencil className="h-3 w-3" />
            </Button>
          )}
          {canDelete && onDelete && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-rose-500 hover:text-rose-700 dark:hover:text-rose-400 hover:bg-rose-500/10"
              onClick={onDelete}
              aria-label={t("common.delete")}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyColumn({ text }: { text: string }) {
  return (
    <div className="px-3 py-8 text-center text-xs text-muted-foreground">{text}</div>
  );
}

/**
 * Generic name-only create/edit dialog (used for regions, governorates,
 * districts). Keeps the geography view compact — every entity in the
 * hierarchy has just a `name` field at this layer.
 */
function NameDialog({
  open, onOpenChange, title, description, initialName, submitLabel, onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  initialName: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<boolean>;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error(t("common.nameRequired"));
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(name.trim());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-1.5">
          <Label className="text-xs">Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9"
            placeholder={t("common.name")}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleSubmit(); } }}
          />
        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "…" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteEntityDialog({
  target, onOpenChange, onDeleted,
}: {
  target: DeleteTarget | null;
  onOpenChange: (o: boolean) => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const tFmt = useTF();
  const [deleting, setDeleting] = useState(false);

  const endpoint = target
    ? target.kind === "region"
      ? `/api/fgmp/geography/regions/${target.id}`
      : target.kind === "governorate"
        ? `/api/fgmp/geography/governorates/${target.id}`
        : `/api/fgmp/geography/districts/${target.id}`
    : "";

  const onConfirm = async () => {
    if (!target) return;
    setDeleting(true);
    try {
      // `apiDelete`, not a raw fetch: it parses the JSON body and returns the
      // server's reason, which the old code re-implemented by hand.
      const res = await apiDelete(endpoint);
      if (res.ok) {
        toast.success(tFmt("geography.deletedToast", { kind: t(`geo.${target.kind}`) }));
        onDeleted();
      } else {
        toast.error(t("geography.deleteFailed"), { description: res.error });
      }
    } finally {
      setDeleting(false);
    }
  };

  // D-16. This used to read `countLabel.includes("sites") && !countLabel.includes("0 sites")`.
  // "10 sites" contains "0 sites", so a governorate with 10 sites was treated as
  // EMPTY: the warning was hidden and the delete button — disabled only when
  // `hasSites` — was enabled, cascade-deleting all ten. It also broke the moment
  // the label was translated. A count is a number; compare it as one.
  const hasSites = (target?.siteCount ?? 0) > 0;

  return (
    <AlertDialog open={!!target} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-rose-500" />
            {target ? tFmt("geography.deleteTitle", { kind: t(`geo.${target.kind}`) }) : ""}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {tFmt("geography.deleteBody", { name: target?.name ?? "" })}
            <br />
            <span className="text-[11px]">{target?.countLabel}</span>
            {hasSites ? (
              <>
                <br /><br />
                <span className="text-rose-700 dark:text-rose-400 font-medium">
                  {target ? tFmt("geography.stillHasSites", { kind: t(`geo.${target.kind}`), n: target.siteCount }) : ""}
                </span>
              </>
            ) : (
              <>
                <br />
                {target?.kind === "region" && t("geography.cascadeRegion")}
                {target?.kind === "governorate" && t("geography.cascadeGovernorate")}
                {target?.kind === "district" && t("tenants.cannotUndo")}
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); void onConfirm(); }}
            disabled={deleting || hasSites}
            className="bg-rose-500 hover:bg-rose-600 text-white"
          >
            {deleting ? "…" : t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
