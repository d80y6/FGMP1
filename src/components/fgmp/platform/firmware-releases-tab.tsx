"use client";

/**
 * The firmware release registry — the surface behind
 * `POST|DELETE /api/fgmp/edge/firmware` and the `GET` that was already served
 * with nobody reading it.
 *
 * ── WHY THIS IS A PLATFORM PANEL AND NOT A TENANT ONE ──────────────────────
 * `EspFirmwareRelease` has no `tenantId` column: it is a shared table, so a row
 * created here is immediately offered to EVERY tenant's dispensers. Publishing
 * it is therefore a platform act (`platform:firmware`, held only through the
 * super-admin wildcard) even though the SCREEN it lives on is a tenant screen
 * that field engineers use to read device health. The read (`view:edge-firmware`)
 * and the write are two different questions, and this tab keeps them apart: a
 * field engineer sees the release list, and never sees a Publish or Delete
 * button — not a disabled one.
 *
 * ── WHY THE FORM ASKS FOR A CHECKSUM BY HAND ───────────────────────────────
 * The device validates the image against the checksum recorded here, so the
 * value is not decoration: a wrong checksum produces a fleet that downloads the
 * binary and refuses to flash it. Uploading the binary and hashing it server-side
 * would be better, and there is no upload endpoint — inventing a "compute it
 * later" field would leave a row that cannot be deployed. So the field is
 * required and the dialog says what it is for.
 */

import { useMemo, useState } from "react";
import { AlertTriangle, HardDriveDownload, Plus, Trash2 } from "lucide-react";
import { apiDelete, apiPost, useApi } from "@/lib/fgmp/use-api";
import { hasCapability } from "@/lib/fgmp/rbac-core";
import { useFgmp } from "@/lib/fgmp/store";
import { EmptyState } from "@/components/fgmp/empty-state";
import { ResourceError } from "@/components/fgmp/resource-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDate } from "@/lib/fgmp/format";
import { useT, useTF, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { toast } from "sonner";

interface ReleaseRow {
  id: string;
  version: string;
  channel: string;
  checksum: string;
  sizeKb: number;
  releaseNotes: string;
  releasedAt: string;
  createdAt: string;
  _count?: { deployments: number };
}

const CHANNELS = ["stable", "beta", "hotfix"] as const;

export function FirmwareReleasesTab() {
  const me = useFgmp((s) => s.me);
  const t = useT();
  const tFmt = useTF();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";

  /**
   * The write capability, from the matrix. `platform:firmware` is one of the
   * five SUPERADMIN_ONLY_CAPABILITIES, so this is false for every tenant role —
   * including ADMIN, which used to be able to publish a global release.
   */
  const canPublish = me ? hasCapability(me.role, "platform:firmware") : false;

  const { data, loading, error, refetch } = useApi<ReleaseRow[]>("/api/fgmp/edge/firmware", {
    interval: 120_000,
  });
  const releases = useMemo(() => data ?? [], [data]);

  const [publishOpen, setPublishOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ReleaseRow | null>(null);
  const [saving, setSaving] = useState(false);

  const [version, setVersion] = useState("");
  const [channel, setChannel] = useState<string>("stable");
  const [checksum, setChecksum] = useState("");
  const [sizeKb, setSizeKb] = useState("");
  const [notes, setNotes] = useState("");

  const resetForm = () => {
    setVersion("");
    setChannel("stable");
    setChecksum("");
    setSizeKb("");
    setNotes("");
  };

  const size = Number(sizeKb);
  const invalid = !version.trim() || !checksum.trim() || !Number.isFinite(size) || size <= 0;

  const publish = async () => {
    if (invalid || saving) return;
    setSaving(true);
    try {
      const res = await apiPost("/api/fgmp/edge/firmware", {
        version: version.trim(),
        channel,
        checksum: checksum.trim(),
        sizeKb: Math.round(size),
        releaseNotes: notes.trim(),
      });
      if (res.ok) {
        toast.success(tFmt("firmware.publishSuccess", { version: version.trim() }));
        setPublishOpen(false);
        resetForm();
        refetch();
      } else {
        toast.error(res.error ?? t("common.error"));
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      const res = await apiDelete(`/api/fgmp/edge/firmware/${deleteTarget.id}`);
      if (res.ok) {
        toast.success(t("firmware.deleted"));
        setDeleteTarget(null);
        refetch();
      } else {
        toast.error(res.error ?? t("common.error"));
      }
    } finally {
      setSaving(false);
    }
  };

  const stats = useMemo(
    () => ({
      total: releases.length,
      stable: releases.filter((r) => r.channel === "stable").length,
      beta: releases.filter((r) => r.channel === "beta").length,
      hotfix: releases.filter((r) => r.channel === "hotfix").length,
    }),
    [releases],
  );

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <HardDriveDownload className="h-4 w-4 text-sky-500" />
              {t("firmware.releasesTitle")}
            </CardTitle>
            <p className="mt-1 max-w-2xl text-[11px] text-muted-foreground">{t("firmware.releasesDesc")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {formatNumber(stats.total, numLang)}
            </Badge>
            {/*
              The button exists only for the capability that can satisfy it. A
              disabled Publish for a field engineer would still tell them the
              platform lets somebody publish, which is fine — but it also
              invites the support ticket "why is this greyed out". The API
              answers 403; the UI does not offer it.
            */}
            {canPublish && (
              <Button size="sm" className="h-8" onClick={() => setPublishOpen(true)}>
                <Plus className="me-1.5 h-4 w-4" />
                {t("firmware.publish")}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ResourceError error={error} onRetry={refetch} compact />
          {loading && !data ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : releases.length === 0 ? (
            <EmptyState icon={HardDriveDownload} title={t("firmware.emptyReleases")} compact />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px]">{t("firmware.version")}</TableHead>
                  <TableHead className="w-[90px]">{t("firmware.channel")}</TableHead>
                  <TableHead className="hidden md:table-cell w-[140px]">{t("firmware.releasedAt")}</TableHead>
                  <TableHead className="hidden lg:table-cell w-[90px]">{t("firmware.sizeKb")}</TableHead>
                  <TableHead className="hidden lg:table-cell w-[90px]">{t("firmware.deployments")}</TableHead>
                  <TableHead>{t("firmware.releaseNotes")}</TableHead>
                  {canPublish && <TableHead className="w-[60px] text-end">{t("users.actions")}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {releases.map((r) => (
                  <TableRow key={r.id} className="hover:bg-muted/30">
                    <TableCell className="font-mono text-[11px]" dir="ltr">
                      {r.version}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          r.channel === "stable"
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-[10px]"
                            : r.channel === "hotfix"
                              ? "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400 text-[10px]"
                              : "text-[10px]"
                        }
                      >
                        {r.channel}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-[10px] text-muted-foreground" dir="ltr">
                      {fmtDate(r.releasedAt, numLang)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-[11px] tabular-nums">
                      {formatNumber(r.sizeKb, numLang)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-[11px] tabular-nums">
                      {formatNumber(r._count?.deployments ?? 0, numLang)}
                    </TableCell>
                    <TableCell className="max-w-[280px] truncate text-[10px] text-muted-foreground" title={r.releaseNotes}>
                      {r.releaseNotes || "—"}
                    </TableCell>
                    {canPublish && (
                      <TableCell className="text-end">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 text-rose-700 dark:text-rose-400"
                          onClick={() => setDeleteTarget(r)}
                          aria-label={t("firmware.delete")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Publishing is a platform act; the hint explains the absence rather than
          leaving a field engineer wondering where the button went. */}
      {!canPublish && <p className="text-[11px] text-muted-foreground">{t("firmware.platformOnly")}</p>}

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HardDriveDownload className="h-4 w-4 text-sky-500" />
              {t("firmware.publishTitle")}
            </DialogTitle>
            <DialogDescription>{t("firmware.publishDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="fw-version" className="text-xs">{t("firmware.version")}</Label>
                <Input
                  id="fw-version"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="1.4.0"
                  className="h-8 font-mono text-xs"
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fw-channel" className="text-xs">{t("firmware.channel")}</Label>
                <div className="flex gap-1">
                  {CHANNELS.map((c) => (
                    <Button
                      key={c}
                      type="button"
                      size="sm"
                      variant={channel === c ? "default" : "outline"}
                      className="h-8 flex-1 text-[10px]"
                      onClick={() => setChannel(c)}
                    >
                      {c}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fw-checksum" className="text-xs">{t("firmware.checksum")}</Label>
              <Input
                id="fw-checksum"
                value={checksum}
                onChange={(e) => setChecksum(e.target.value)}
                placeholder={t("firmware.checksumPlaceholder")}
                className="h-8 font-mono text-[11px]"
                dir="ltr"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fw-size" className="text-xs">{t("firmware.sizeKb")}</Label>
              <Input
                id="fw-size"
                value={sizeKb}
                onChange={(e) => setSizeKb(e.target.value)}
                inputMode="numeric"
                placeholder="512"
                className="h-8 text-xs"
                dir="ltr"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fw-notes" className="text-xs">{t("firmware.releaseNotes")}</Label>
              <Textarea
                id="fw-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                maxLength={1000}
              />
            </div>
          </div>
          <DialogFooter className="pt-2">
            <Button variant="outline" onClick={() => setPublishOpen(false)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button onClick={publish} disabled={invalid || saving}>
              {t("firmware.publish")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400" />
              {tFmt("firmware.deleteTitle", { version: deleteTarget?.version ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("firmware.deleteDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              onClick={(e) => {
                // Keep the dialog open until the request settles, so a failure
                // shows its toast against the row it concerns.
                e.preventDefault();
                void remove();
              }}
              disabled={saving}
            >
              {t("firmware.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
