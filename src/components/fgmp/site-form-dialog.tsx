"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, Loader2 } from "lucide-react";

import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useFgmp } from "@/lib/fgmp/store";
import { useCap } from "@/lib/fgmp/use-access";
import { apiPost, apiPatch } from "@/lib/fgmp/use-api";
import { useT } from "@/lib/fgmp/use-language";
import { toast } from "sonner";
import type { SiteState } from "@/lib/fgmp/types";

/**
 * SiteFormDialog — shared create + edit dialog for the Sites view.
 *
 * Modes:
 *   • `site === null`  → CREATE  → POST /api/fgmp/sites
 *   • `site !== null`  → EDIT    → PATCH /api/fgmp/sites/[id]
 *
 * The geographic hierarchy (region → governorate → district) is sourced from
 * the live snapshot (`snapshot.regions`) — it's already tenant-scoped and kept
 * fresh by the global tick, so no extra fetch is needed. The three selects
 * cascade: picking a region filters governorates; picking a governorate
 * filters districts; changing a parent resets the child selection.
 *
 * On a successful mutation the parent calls `onSaved()` which refreshes the
 * global snapshot so the new/updated row appears immediately.
 *
 * The form is mounted fresh on every open (keyed by `site?.id ?? 'new'` plus
 * an open-nonce) so initial state always reflects the latest props — no stale
 * field-sync effects needed.
 */
export function SiteFormDialog({
  open, onOpenChange, onSaved, site,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  site: SiteState | null;
}) {
  // The capability the form's endpoint needs — POST/PATCH /api/fgmp/sites both
  // require `asset:manage`. Today the only caller (sites-view) already gates the
  // button and the row menu on it, so this is the second lock on the same door;
  // it is here because "the parent happens to gate it" is not a property the
  // dialog can be sure of, and a dialog is exactly the thing that gets reused.
  const canManageSites = useCap("asset:manage");

  // The wrapper returns null while closed, so the inner SiteForm unmounts on
  // close and remounts fresh on the next open — initial state is always
  // derived from the latest `site` prop. The key additionally covers the case
  // where the target site changes while the dialog is already open (e.g. the
  // admin picks Edit on a different row without closing first): a key change
  // forces a clean remount with the new site's values.
  if (!open || !canManageSites) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[640px]">
        <SiteForm
          key={site?.id ?? "new"}
          site={site}
          onCancel={() => onOpenChange(false)}
          onSaved={() => {
            onOpenChange(false);
            onSaved();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Inner form — owns its own state, initialized from `site` on mount.      */
/* ──────────────────────────────────────────────────────────────────────── */

function SiteForm({
  site, onCancel, onSaved,
}: {
  site: SiteState | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const snapshot = useFgmp((s) => s.snapshot);
  // Stable fallback identity — a bare `?? []` is a new array on every render,
  // and `regions` feeds the cascading memos just below.
  const regions = useMemo(() => snapshot?.regions ?? [], [snapshot]);

  const isEdit = !!site;

  // ── Form state ──────────────────────────────────────────────────────────
  const [code, setCode] = useState(site?.code ?? "");
  const [name, setName] = useState(site?.name ?? "");
  const [regionId, setRegionId] = useState(site?.regionId ?? "");
  const [governorateId, setGovernorateId] = useState(site?.governorateId ?? "");
  const [districtId, setDistrictId] = useState(site?.districtId ?? "");
  const [latitude, setLatitude] = useState(site ? String(site.latitude) : "");
  const [longitude, setLongitude] = useState(site ? String(site.longitude) : "");
  const [address, setAddress] = useState(site?.address ?? "");
  const [criticality, setCriticality] = useState(site?.criticality ?? "MEDIUM");
  const [loadKw, setLoadKw] = useState(site ? String(site.loadKw) : "0");
  const [powerSource, setPowerSource] = useState(site?.powerSource ?? "HYBRID");
  const [gridAvailable, setGridAvailable] = useState(site?.gridAvailable ?? true);
  const [status, setStatus] = useState(site?.status ?? "ONLINE");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Cascading derived options ───────────────────────────────────────────
  const selectedRegion = useMemo(
    () => regions.find((r) => r.id === regionId) ?? null,
    [regions, regionId],
  );
  const governorates = useMemo(() => selectedRegion?.governorates ?? [], [selectedRegion]);
  const selectedGovernorate = useMemo(
    () => governorates.find((g) => g.id === governorateId) ?? null,
    [governorates, governorateId],
  );
  const districts = useMemo(() => selectedGovernorate?.districts ?? [], [selectedGovernorate]);

  // If the selected governorate is no longer in the (possibly changed) region,
  // reset it + the district. Same for district vs governorate. This keeps the
  // cascading selects internally consistent without setState-in-render.
  useEffect(() => {
    if (governorateId && !governorates.some((g) => g.id === governorateId)) {
      setGovernorateId("");
      setDistrictId("");
    }
  }, [governorates, governorateId]);
  useEffect(() => {
    if (districtId && !districts.some((d) => d.id === districtId)) {
      setDistrictId("");
    }
  }, [districts, districtId]);

  // ── Submit ──────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Basic required-field guard. The server re-validates with Zod, but a
    // client-side check gives instant feedback and avoids a round-trip for
    // obvious omissions.
    if (!code.trim() || !name.trim() || !regionId || !governorateId || !districtId) {
      setError(t("sites.fillRequired"));
      return;
    }
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      setError(t("sites.coordsHelp"));
      return;
    }
    const load = parseFloat(loadKw);
    if (Number.isNaN(load) || load < 0) {
      setError(t("sites.loadKw"));
      return;
    }

    const payload = {
      code: code.trim(),
      name: name.trim(),
      regionId,
      governorateId,
      districtId,
      latitude: lat,
      longitude: lng,
      address: address.trim(),
      criticality,
      loadKw: load,
      powerSource,
      gridAvailable,
      status,
    };

    setSubmitting(true);
    try {
      const res = isEdit && site
        ? await apiPatch(`/api/fgmp/sites/${site.id}`, payload)
        : await apiPost("/api/fgmp/sites", payload);
      if (res.ok) {
        toast.success(isEdit ? t("sites.updatedToast") : t("sites.createdToast"));
        onSaved();
      } else {
        const msg = (res.data as { error?: string } | undefined)?.error ?? res.error ?? "Error";
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-emerald-500" />
          {isEdit ? t("sites.edit") : t("sites.add")}
        </DialogTitle>
        <DialogDescription>
          {isEdit ? t("sites.editDesc") : t("sites.addDesc")}
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-1 gap-4 py-4 sm:grid-cols-2">
        {/* Code */}
        <div className="space-y-1.5">
          <Label htmlFor="site-code">{t("sites.siteCode")}</Label>
          <Input
            id="site-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="SANA-A1"
            className="font-mono"
            maxLength={40}
            required
          />
          <p className="text-[10px] text-muted-foreground">{t("sites.siteCodeHelp")}</p>
        </div>

        {/* Name */}
        <div className="space-y-1.5">
          <Label htmlFor="site-name">{t("sites.siteNameLabel")}</Label>
          <Input
            id="site-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("sites.siteNameLabel")}
            maxLength={200}
            required
          />
        </div>

        {/* Region */}
        <div className="space-y-1.5">
          <Label>{t("sites.region")}</Label>
          <Select label={t("sites.region")} value={regionId} onValueChange={(v) => { setRegionId(v); setGovernorateId(""); setDistrictId(""); }}>
            <SelectTrigger><SelectValue placeholder={t("sites.selectRegion")} /></SelectTrigger>
            <SelectContent>
              {regions.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Governorate */}
        <div className="space-y-1.5">
          <Label>{t("sites.governorate")}</Label>
          <Select label={t("sites.governorate")}
            value={governorateId}
            onValueChange={(v) => { setGovernorateId(v); setDistrictId(""); }}
            disabled={!regionId}
          >
            <SelectTrigger><SelectValue placeholder={t("sites.selectGovernorate")} /></SelectTrigger>
            <SelectContent>
              {governorates.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* District */}
        <div className="space-y-1.5 sm:col-span-2">
          <Label>{t("sites.district")}</Label>
          <Select label={t("sites.district")} value={districtId} onValueChange={setDistrictId} disabled={!governorateId}>
            <SelectTrigger><SelectValue placeholder={t("sites.selectDistrict")} /></SelectTrigger>
            <SelectContent>
              {districts.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Latitude */}
        <div className="space-y-1.5">
          <Label htmlFor="site-lat">{t("sites.latitude")}</Label>
          <Input
            id="site-lat"
            type="number"
            step="any"
            value={latitude}
            onChange={(e) => setLatitude(e.target.value)}
            placeholder="15.3694"
            required
          />
        </div>

        {/* Longitude */}
        <div className="space-y-1.5">
          <Label htmlFor="site-lng">{t("sites.longitude")}</Label>
          <Input
            id="site-lng"
            type="number"
            step="any"
            value={longitude}
            onChange={(e) => setLongitude(e.target.value)}
            placeholder="44.1910"
            required
          />
        </div>

        <p className="text-[10px] text-muted-foreground sm:col-span-2">{t("sites.coordsHelp")}</p>

        {/* Address */}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="site-address">{t("sites.address")}</Label>
          <Input
            id="site-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t("sites.address")}
            maxLength={500}
          />
        </div>

        {/* Criticality */}
        <div className="space-y-1.5">
          <Label>{t("sites.criticality")}</Label>
          <Select label={t("sites.criticality")} value={criticality} onValueChange={setCriticality}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="CRITICAL">{t("sites.criticalityCritical")}</SelectItem>
              <SelectItem value="HIGH">{t("sites.criticalityHigh")}</SelectItem>
              <SelectItem value="MEDIUM">{t("sites.criticalityMedium")}</SelectItem>
              <SelectItem value="LOW">{t("sites.criticalityLow")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Load */}
        <div className="space-y-1.5">
          <Label htmlFor="site-load">{t("sites.loadKw")}</Label>
          <Input
            id="site-load"
            type="number"
            step="any"
            min="0"
            value={loadKw}
            onChange={(e) => setLoadKw(e.target.value)}
            required
          />
        </div>

        {/* Power source */}
        <div className="space-y-1.5">
          <Label>{t("sites.powerSource")}</Label>
          <Select label={t("sites.powerSource")} value={powerSource} onValueChange={setPowerSource}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="GRID">{t("sites.powerGrid")}</SelectItem>
              <SelectItem value="GENERATOR">{t("sites.powerGenerator")}</SelectItem>
              <SelectItem value="HYBRID">{t("sites.powerHybrid")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Status */}
        <div className="space-y-1.5">
          <Label>{t("sites.status")}</Label>
          <Select label={t("sites.status")} value={status} onValueChange={setStatus}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ONLINE">{t("sites.statusOnline")}</SelectItem>
              <SelectItem value="DEGRADED">{t("sites.statusDegraded")}</SelectItem>
              <SelectItem value="OFFLINE">{t("sites.statusOffline")}</SelectItem>
              <SelectItem value="MAINTENANCE">{t("sites.statusMaintenance")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Grid available switch */}
        <div className="flex items-center justify-between rounded-md border p-3 sm:col-span-2">
          <div className="space-y-0.5">
            <Label htmlFor="site-grid" className="cursor-pointer">{t("sites.gridAvailable")}</Label>
          </div>
          <Switch id="site-grid" checked={gridAvailable} onCheckedChange={setGridAvailable} />
        </div>
      </div>

      {error && (
        <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {isEdit ? t("sites.save") : t("sites.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
