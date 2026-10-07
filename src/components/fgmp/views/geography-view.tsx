"use client";

import type React from "react";
import { useState, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Globe2, Map, MapPin, Plus, Pencil, Trash2,
  ShieldAlert, Building2, Layers,
} from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi, apiPost, apiPatch } from "@/lib/fgmp/use-api";
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
import { useT, useDir, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
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

  const isAdmin = me?.role === "ADMIN";

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

  // Access control: only ADMIN may manage geography.
  if (me && !isAdmin) {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Access denied</AlertTitle>
          <AlertDescription>
            Only administrators can manage the geographic hierarchy. Contact your platform administrator if you need access.
          </AlertDescription>
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
        <KpiCard label="Regions" value={formatNumber(stats.regions, numLang)} icon={<Globe2 className="h-4 w-4" />} />
        <KpiCard label="Governorates" value={formatNumber(stats.governorates, numLang)} icon={<Map className="h-4 w-4" />} tone="good" />
        <KpiCard label="Districts" value={formatNumber(stats.districts, numLang)} icon={<MapPin className="h-4 w-4" />} tone="warn" />
        <KpiCard label="Sites" value={formatNumber(stats.sites, numLang)} icon={<Building2 className="h-4 w-4" />} tone="info" />
      </div>

      {/* Drill-down — 3 columns on md+ */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {/* Column 1 — Regions */}
        <ColumnShell
          title="Regions"
          count={stats.regions}
          icon={<Globe2 className="h-4 w-4" />}
          onAdd={isAdmin ? () => setRegionCreateOpen(true) : undefined}
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
              canEdit={isAdmin}
              onEdit={() => setRegionEditTarget(r)}
              canDelete={isAdmin}
              onDelete={() =>
                setDeleteTarget({
                  kind: "region",
                  id: r.id,
                  name: r.name,
                  countLabel: `${r._count.governorates} governorates · ${r._count.sites} sites`,
                })
              }
              dir={dir}
            />
          ))}
          {(regions ?? []).length === 0 && !loading && (
            <EmptyColumn text="No regions yet. Click + to create one." />
          )}
        </ColumnShell>

        {/* Column 2 — Governorates */}
        <ColumnShell
          title="Governorates"
          count={selectedRegion?.governorates.length ?? 0}
          icon={<Map className="h-4 w-4" />}
          onAdd={isAdmin && selectedRegion ? () => setGovCreateOpen(true) : undefined}
          loading={false}
          parentHint={selectedRegion?.name}
          dir={dir}
        >
          {selectedRegion ? (
            selectedRegion.governorates.length === 0 ? (
              <EmptyColumn text="No governorates in this region yet." />
            ) : (
              selectedRegion.governorates.map((g) => (
                <ListItem
                  key={g.id}
                  active={g.id === selectedGovId}
                  onClick={() => setSelectedGovId(g.id)}
                  title={g.name}
                  meta={`${formatNumber(g.districts.length, numLang)} districts · ${formatNumber(g._count.sites, numLang)} sites`}
                  canEdit={isAdmin}
                  onEdit={() => setGovEditTarget(g)}
                  canDelete={isAdmin}
                  onDelete={() =>
                    setDeleteTarget({
                      kind: "governorate",
                      id: g.id,
                      name: g.name,
                      countLabel: `${g.districts.length} districts · ${g._count.sites} sites`,
                    })
                  }
                  dir={dir}
                />
              ))
            )
          ) : (
            <EmptyColumn text="Select a region to see its governorates." />
          )}
        </ColumnShell>

        {/* Column 3 — Districts */}
        <ColumnShell
          title="Districts"
          count={selectedGov?.districts.length ?? 0}
          icon={<MapPin className="h-4 w-4" />}
          onAdd={isAdmin && selectedGov ? () => setDistrictCreateOpen(true) : undefined}
          loading={false}
          parentHint={selectedGov?.name}
          dir={dir}
        >
          {selectedGov ? (
            selectedGov.districts.length === 0 ? (
              <EmptyColumn text="No districts in this governorate yet." />
            ) : (
              selectedGov.districts.map((d) => (
                <ListItem
                  key={d.id}
                  active={d.id === selectedDistrictId}
                  onClick={() => setSelectedDistrictId(d.id)}
                  title={d.name}
                  meta={`${formatNumber(d._count.sites, numLang)} sites`}
                  canEdit={isAdmin}
                  onEdit={() => setDistrictEditTarget(d)}
                  canDelete={isAdmin}
                  onDelete={() =>
                    setDeleteTarget({
                      kind: "district",
                      id: d.id,
                      name: d.name,
                      countLabel: `${d._count.sites} sites`,
                    })
                  }
                  dir={dir}
                />
              ))
            )
          ) : (
            <EmptyColumn text="Select a governorate to see its districts." />
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
              <div className="py-10 text-center text-sm text-muted-foreground">
                No sites in this district yet.
              </div>
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
            <div className="py-10 text-center text-sm text-muted-foreground">
              Select a district above to see its sites.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Region create/edit */}
      <NameDialog
        open={regionCreateOpen}
        onOpenChange={setRegionCreateOpen}
        title="Add Region"
        description="Create a new region under your tenant."
        initialName=""
        submitLabel="Create Region"
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
        title="Edit Region"
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
        title="Add Governorate"
        description={`Under region: ${selectedRegion?.name ?? ""}`}
        initialName=""
        submitLabel="Create Governorate"
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
        title="Edit Governorate"
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
        title="Add District"
        description={`Under governorate: ${selectedGov?.name ?? ""}`}
        initialName=""
        submitLabel="Create District"
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
        title="Edit District"
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
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      className={cn(
        "group flex items-center justify-between rounded-md border px-2.5 py-2 text-sm transition-all cursor-pointer",
        "hover:border-emerald-500/40 hover:bg-emerald-500/5",
        active ? "border-emerald-500/60 bg-emerald-500/10" : "border-transparent",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{title}</div>
        <div className="text-[10px] text-muted-foreground">{meta}</div>
      </div>
      {(canEdit || canDelete) && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {canEdit && onEdit && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              aria-label="Edit"
            >
              <Pencil className="h-3 w-3" />
            </Button>
          )}
          {canDelete && onDelete && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              aria-label="Delete"
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
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
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
            placeholder="Name"
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
      const res = await fetch(endpoint, { method: "DELETE", credentials: "include" });
      if (res.ok) {
        toast.success(`${target.kind.charAt(0).toUpperCase() + target.kind.slice(1)} deleted`);
        onDeleted();
      } else {
        const json = await res.json().catch(() => ({}));
        toast.error((json as { error?: string }).error ?? "Delete failed");
      }
    } finally {
      setDeleting(false);
    }
  };

  const hasSites = target?.countLabel.includes("sites") && !target.countLabel.includes("0 sites");

  return (
    <AlertDialog open={!!target} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-rose-500" />
            Delete {target?.kind}
          </AlertDialogTitle>
          <AlertDialogDescription>
            You are about to permanently delete{" "}
            <span className="font-medium text-foreground">{target?.name}</span>.
            <br />
            <span className="text-[11px]">{target?.countLabel}</span>
            {hasSites ? (
              <>
                <br /><br />
                <span className="text-rose-600 dark:text-rose-400 font-medium">
                  This {target?.kind} still has sites. Remove or reassign them first.
                </span>
              </>
            ) : (
              <>
                <br />
                {target?.kind === "region" && "All governorates and districts under this region will be cascade-deleted."}
                {target?.kind === "governorate" && "All districts under this governorate will be cascade-deleted."}
                {target?.kind === "district" && "This action cannot be undone."}
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); void onConfirm(); }}
            disabled={deleting || hasSites}
            className="bg-rose-500 hover:bg-rose-600 text-white"
          >
            {deleting ? "…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
