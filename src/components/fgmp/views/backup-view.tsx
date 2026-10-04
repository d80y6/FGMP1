"use client";

/**
 * Backup & Restore view (Task 35-E)
 * ────────────────────────────────────────────────────────────────────────────
 * Database backup and restore operations. ADMIN-only. Layout:
 *
 *   1. SectionHeader with "Create Backup" + "Restore" buttons.
 *   2. Info panel: DATABASE PATH, BACKUP DIRECTORY, DB SIZE, LAST BACKUP.
 *   3. Warning banner — restore overwrites the live DB.
 *   4. Backup list table: Filename | Size | Created | Actions (Download,
 *      Restore, Delete).
 *   5. Restore dialog: select a backup from the list, confirm the destructive
 *      overwrite, POST /api/fgmp/backup/restore with the filename.
 *
 * All API routes are ADMIN-only. The restore endpoint auto-creates a
 * "prerestore-<ts>.db" snapshot of the current DB before overwriting so the
 * operator can roll back if needed.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Database, HardDriveDownload, Upload, Download, Trash2, RotateCcw,
  ShieldAlert, AlertCircle, AlertTriangle, Loader2, FileArchive,
  CheckCircle2, FolderArchive, Clock, HardDrive,
} from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi, apiPost } from "@/lib/fgmp/use-api";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { fmtDateTime, timeAgo } from "@/lib/fgmp/format";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { cn } from "@/lib/utils";

/* ────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────── */

interface BackupFile {
  filename: string;
  size: number;
  createdAt: string;
}

interface BackupListResponse {
  backups: BackupFile[];
  dbPath: string;
  backupDir: string;
  dbSize: number | null;
  lastBackup: string | null;
}

/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */

/** Format a byte count as a human-readable string (KB / MB / GB). */
function fmtBytes(n: number, lang: Language): string {
  if (n < 1024) return `${formatNumber(n, lang)} B`;
  if (n < 1024 * 1024) return `${formatNumber((n / 1024).toFixed(1), lang)} KB`;
  if (n < 1024 * 1024 * 1024) return `${formatNumber((n / 1024 / 1024).toFixed(2), lang)} MB`;
  return `${formatNumber((n / 1024 / 1024 / 1024).toFixed(2), lang)} GB`;
}

/* ────────────────────────────────────────────────────────────────────────
 * Main view
 * ──────────────────────────────────────────────────────────────────────── */

export function BackupView() {
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const me = useFgmp((s) => s.me);

  const { data, loading, error, refetch } = useApi<BackupListResponse>("/api/fgmp/backup", {
    interval: 30000,
  });

  const [creating, setCreating] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BackupFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectedRestoreFile, setSelectedRestoreFile] = useState("");

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const res = await apiPost("/api/fgmp/backup", {});
      if (res.ok) {
        const r = res.data as { filename: string; size: number };
        toast.success(`Backup created: ${r.filename} (${fmtBytes(r.size, numLang)})`);
        refetch();
      } else {
        toast.error(res.error ?? "Backup failed");
      }
    } finally {
      setCreating(false);
    }
  }, [numLang, refetch]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/fgmp/backup/${encodeURIComponent(deleteTarget.filename)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        toast.success(`Deleted ${deleteTarget.filename}`);
        setDeleteTarget(null);
        refetch();
      } else {
        const j = await res.json().catch(() => ({}));
        toast.error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      }
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, refetch]);

  const handleDownload = useCallback((file: BackupFile) => {
    // Trigger a browser download via a temporary anchor — the API streams
    // the file with Content-Disposition: attachment so it saves instead of
    // rendering. We don't fetch+read the file in JS to avoid loading the
    // (potentially large) SQLite blob into memory.
    const url = `/api/fgmp/backup/${encodeURIComponent(file.filename)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = file.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast.info(`Downloading ${file.filename}…`);
  }, []);

  const backups = data?.backups ?? [];

  // Access control — admin only. Declared after all hooks so order is stable.
  if (me && me.role !== "ADMIN") {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Access denied</AlertTitle>
          <AlertDescription>
            Only platform administrators may manage database backups.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.backup")}
        description={t("desc.backup")}
        icon={<Database className="h-5 w-5" />}
        tone="primary"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRestoreOpen(true)}
              disabled={backups.length === 0}
            >
              <Upload className="h-4 w-4" />
              <span className="hidden sm:inline">Restore</span>
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={creating}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDriveDownload className="h-4 w-4" />}
              <span className="hidden sm:inline">Create Backup</span>
              <span className="sm:hidden">Backup</span>
            </Button>
          </div>
        }
      />

      {/* Info panel: KPI cards with DB path / backup dir / DB size / last backup */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Database Path"
          value={<code className="text-xs font-mono">{data?.dbPath ?? "db/custom.db"}</code>}
          icon={<Database className="h-4 w-4" />}
          hint="Live SQLite database file"
        />
        <KpiCard
          label="Backup Directory"
          value={<code className="text-xs font-mono">{data?.backupDir ?? "./backups"}</code>}
          icon={<FolderArchive className="h-4 w-4" />}
          hint="Where backups are stored"
          tone="info"
        />
        <KpiCard
          label="Database Size"
          value={data?.dbSize != null ? fmtBytes(data.dbSize, numLang) : "—"}
          icon={<HardDrive className="h-4 w-4" />}
          hint="Size of the live DB file"
          tone="good"
        />
        <KpiCard
          label="Last Backup"
          value={
            data?.lastBackup
              ? timeAgo(data.lastBackup, numLang)
              : "Never"
          }
          icon={<Clock className="h-4 w-4" />}
          hint={data?.lastBackup ? fmtDateTime(data.lastBackup, numLang) : "No backups yet"}
          tone={data?.lastBackup ? "good" : "warn"}
        />
      </div>

      {/* Restore warning */}
      <Alert className="border-amber-500/40 bg-amber-500/10">
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        <AlertTitle className="text-amber-700 dark:text-amber-400">Restore is destructive</AlertTitle>
        <AlertDescription className="text-xs text-amber-700 dark:text-amber-400">
          Restoring a backup overwrites the live database. Any telemetry, alarms, or
          configuration changes made after the backup will be lost. The API auto-creates
          a pre-restore snapshot so you can roll back, but you should still verify the
          backup you choose is correct. A server restart is recommended after restore.
        </AlertDescription>
      </Alert>

      {/* Backup list */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-sm">
            Backups ({formatNumber(backups.length, numLang)})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <div className="p-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Failed to load backups</AlertTitle>
                <AlertDescription className="text-xs">{error}</AlertDescription>
              </Alert>
            </div>
          )}
          {loading && !data ? (
            <BackupTableSkeleton />
          ) : (
            <ScrollArea className="max-h-[640px]">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>Filename</TableHead>
                    <TableHead className="w-[120px]">Size</TableHead>
                    <TableHead className="hidden md:table-cell w-[180px]">Created</TableHead>
                    <TableHead className="hidden sm:table-cell w-[100px]">Age</TableHead>
                    <TableHead className="w-[180px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {backups.map((f) => (
                    <TableRow key={f.filename} className="transition-colors hover:bg-muted/30">
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="rounded-md bg-muted p-1.5">
                            <FileArchive className="h-3.5 w-3.5 text-muted-foreground" />
                          </div>
                          <div className="flex flex-col">
                            <code className="text-xs font-mono" dir="ltr">{f.filename}</code>
                            {f.filename.includes("prerestore") && (
                              <Badge variant="outline" className="mt-0.5 w-fit border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[9px]">
                                Pre-restore snapshot
                              </Badge>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {fmtBytes(f.size, numLang)}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-[10px] text-muted-foreground">
                        {fmtDateTime(f.createdAt, numLang)}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-[10px] text-muted-foreground">
                        {timeAgo(f.createdAt, numLang)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => handleDownload(f)}
                            aria-label="Download backup"
                            title="Download"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => {
                              setSelectedRestoreFile(f.filename);
                              setRestoreOpen(true);
                            }}
                            aria-label="Restore from this backup"
                            title="Restore"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10"
                            onClick={() => setDeleteTarget(f)}
                            aria-label="Delete backup"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {backups.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-12 text-center text-sm text-muted-foreground">
                        <div className="flex flex-col items-center gap-2">
                          <FolderArchive className="h-8 w-8 opacity-50" />
                          <span>No backups yet. Click <strong>Create Backup</strong> to make one.</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Restore dialog (with file picker) */}
      <RestoreDialog
        open={restoreOpen}
        onOpenChange={(o) => {
          setRestoreOpen(o);
          if (!o) setSelectedRestoreFile("");
        }}
        backups={backups}
        selectedFile={selectedRestoreFile}
        onSelect={setSelectedRestoreFile}
        onRestored={refetch}
        numLang={numLang}
      />

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete backup file?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes <code className="font-mono">{deleteTarget?.filename}</code> from
              the backups directory. The live database is not affected. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-rose-600 hover:bg-rose-700 focus-visible:ring-rose-500 text-white"
            >
              {deleting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Restore dialog
 * ────────────────────────────────────────────────────────────────────────
 * Used for both the "Restore" header button (no pre-selected file) and the
 * per-row "Restore" action (pre-selected file). The user must confirm the
 * destructive overwrite by typing the filename or clicking through.
 */

function RestoreDialog({
  open, onOpenChange, backups, selectedFile, onSelect, onRestored, numLang,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  backups: BackupFile[];
  selectedFile: string;
  onSelect: (f: string) => void;
  onRestored: () => void;
  numLang: Language;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [restoring, setRestoring] = useState(false);

  // Reset confirm text each time the dialog opens.
  useEffect(() => {
    if (open) setConfirmText("");
  }, [open]);

  // Auto-select the first backup if none is pre-selected.
  useEffect(() => {
    if (open && !selectedFile && backups.length > 0) {
      onSelect(backups[0]!.filename);
    }
  }, [open, selectedFile, backups, onSelect]);

  const handleRestore = async () => {
    if (!selectedFile) {
      toast.error("Select a backup file first");
      return;
    }
    if (confirmText.trim() !== selectedFile.trim()) {
      toast.error("Filename confirmation does not match");
      return;
    }
    setRestoring(true);
    try {
      const res = await apiPost("/api/fgmp/backup/restore", { filename: selectedFile });
      if (res.ok) {
        const r = res.data as { preRestoreSnapshot?: string | null; restartRecommended?: boolean };
        toast.success(
          `Restored from ${selectedFile}` +
          (r.preRestoreSnapshot ? ` · pre-restore snapshot: ${r.preRestoreSnapshot}` : ""),
        );
        if (r.restartRecommended) {
          toast.info("A server restart is recommended for the restore to take full effect.");
        }
        onOpenChange(false);
        onRestored();
      } else {
        toast.error(res.error ?? "Restore failed");
      }
    } finally {
      setRestoring(false);
    }
  };

  const selected = backups.find((b) => b.filename === selectedFile);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4" />
            Restore Database from Backup
          </DialogTitle>
          <DialogDescription>
            Choose a backup file to restore. The current database will be overwritten.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* File picker */}
          <div className="space-y-1.5">
            <Label className="text-xs">Backup file</Label>
            <Select value={selectedFile} onValueChange={onSelect}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a backup file" />
              </SelectTrigger>
              <SelectContent>
                {backups.map((b) => (
                  <SelectItem key={b.filename} value={b.filename}>
                    <span className="font-mono text-xs" dir="ltr">{b.filename}</span>
                    <span className="ml-2 text-[10px] text-muted-foreground">
                      ({fmtBytes(b.size, numLang)} · {timeAgo(b.createdAt, numLang)})
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Selected file details */}
          {selected && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Size:</span>
                <span className="tabular-nums">{fmtBytes(selected.size, numLang)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Created:</span>
                <span>{fmtDateTime(selected.createdAt, numLang)}</span>
              </div>
            </div>
          )}

          {/* Destructive action warning */}
          <Alert className="border-rose-500/40 bg-rose-500/10">
            <AlertTriangle className="h-4 w-4 text-rose-500" />
            <AlertTitle className="text-rose-700 dark:text-rose-400">This will overwrite the live database</AlertTitle>
            <AlertDescription className="text-xs text-rose-700 dark:text-rose-400">
              All data created or modified after the selected backup will be lost. The API
              will create a pre-restore snapshot automatically, but you should still proceed
              with caution. Type the backup filename below to confirm.
            </AlertDescription>
          </Alert>

          {/* Type-to-confirm */}
          <div className="space-y-1.5">
            <Label htmlFor="restore-confirm" className="text-xs">
              Type the filename to confirm: <code className="font-mono">{selectedFile || "—"}</code>
            </Label>
            <Input
              id="restore-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={selectedFile || "filename"}
              dir="ltr"
              className="h-9 font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={restoring}>
            Cancel
          </Button>
          <Button
            onClick={handleRestore}
            disabled={restoring || !selectedFile || confirmText.trim() !== selectedFile.trim()}
            className="bg-rose-600 hover:bg-rose-700 focus-visible:ring-rose-500 text-white"
          >
            {restoring ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}
            Restore Now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Skeleton
 * ──────────────────────────────────────────────────────────────────────── */

function BackupTableSkeleton() {
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-32 hidden md:block" />
          <Skeleton className="h-9 w-24 hidden sm:block" />
          <Skeleton className="h-9 w-32" />
        </div>
      ))}
    </div>
  );
}
