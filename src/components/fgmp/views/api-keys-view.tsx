"use client";

/**
 * API Keys view (Task 35-E)
 * ────────────────────────────────────────────────────────────────────────────
 * Programmatic API key management. ADMIN-only. Layout:
 *
 *   1. Header (SectionHeader) with "Create API Key" button.
 *   2. KPI strip: Total / Active / Revoked / Expired counts.
 *   3. Keys table: Name | Key Prefix | Scopes | IP Allowlist | Created By |
 *      Last Used | Created | Status | Actions (Revoke).
 *   4. Create dialog: name, scopes (checkboxes), expiry (date picker), IP
 *      allowlist (comma-separated CIDRs).
 *   5. Raw key reveal dialog: shown ONCE after create. Displays the raw key
 *      in a read-only input with a copy button and a "store securely" warning.
 *   6. Revoke confirm: AlertDialog → PATCH revoke.
 *
 * The raw key is returned by POST /api/fgmp/api-keys ONCE and never exposed
 * again (only the keyPrefix is shown in the list). Operators must copy it
 * immediately — losing it means revoking + recreating.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  KeyRound, Plus, Copy, Check, Ban, MoreVertical, ShieldAlert,
  AlertCircle, Loader2, Clock, Globe, ShieldCheck,
} from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi, apiPost, apiPatch } from "@/lib/fgmp/use-api";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { fmtDateTime, timeAgo } from "@/lib/fgmp/format";
import { useT, useTF, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { cn } from "@/lib/utils";

/* ────────────────────────────────────────────────────────────────────────
 * Types & constants
 * ──────────────────────────────────────────────────────────────────────── */

interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string;
  ipAllowlist: string | null;
  createdBy: string;
  creatorName: string | null;
  creatorEmail: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revoked: boolean;
  createdAt: string;
}

interface CreatedKeyResponse {
  id: string;
  name: string;
  key: string;            // raw key — only ever returned by POST
  keyPrefix: string;
  scopes: string;
  ipAllowlist: string | null;
  expiresAt: string | null;
  createdAt: string;
}

// Keys, not text: this table is module scope (no hook) and the dialog is used
// in Arabic too.
const ALL_SCOPES = [
  { code: "read",    labelKey: "apiKeys.scopeRead",    hintKey: "apiKeys.scopeReadHint" },
  { code: "write",   labelKey: "apiKeys.scopeWrite",   hintKey: "apiKeys.scopeWriteHint" },
  { code: "control", labelKey: "apiKeys.scopeControl", hintKey: "apiKeys.scopeControlHint" },
  { code: "admin",   labelKey: "apiKeys.scopeAdmin",   hintKey: "apiKeys.scopeAdminHint" },
] as const;

/* ────────────────────────────────────────────────────────────────────────
 * Status helper
 * ──────────────────────────────────────────────────────────────────────── */

type KeyStatus = "active" | "revoked" | "expired";

function keyStatus(k: ApiKeyRow): KeyStatus {
  if (k.revoked) return "revoked";
  if (k.expiresAt && new Date(k.expiresAt).getTime() < Date.now()) return "expired";
  return "active";
}

function StatusBadge({ status }: { status: KeyStatus }) {
  if (status === "active") {
    return (
      <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-[10px]">
        Active
      </Badge>
    );
  }
  if (status === "revoked") {
    return (
      <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400 text-[10px]">
        Revoked
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 text-[10px]">
      Expired
    </Badge>
  );
}

/** Scope badge color per scope code (no indigo/blue). */
function ScopeBadge({ scope }: { scope: string }) {
  const tone =
    scope === "admin"   ? "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400"
    : scope === "control" ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
    : scope === "write"   ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
    : "border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-400";
  return (
    <Badge variant="outline" className={cn("text-[9px] font-mono uppercase", tone)}>
      {scope}
    </Badge>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Main view
 * ──────────────────────────────────────────────────────────────────────── */

export function ApiKeysView() {
  const tFmt = useTF();
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const me = useFgmp((s) => s.me);

  const { data: keys, loading, error, refetch } = useApi<ApiKeyRow[]>("/api/fgmp/api-keys", {
    interval: 30000,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<CreatedKeyResponse | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [revoking, setRevoking] = useState(false);

  // KPIs derived from the loaded list.
  const stats = useMemo(() => {
    const list = keys ?? [];
    let active = 0, revoked = 0, expired = 0;
    for (const k of list) {
      const s = keyStatus(k);
      if (s === "active") active++;
      else if (s === "revoked") revoked++;
      else expired++;
    }
    return { total: list.length, active, revoked, expired };
  }, [keys]);

  const handleRevoke = useCallback(async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      const res = await apiPatch(`/api/fgmp/api-keys/${revokeTarget.id}`, { revoked: true });
      if (res.ok) {
        toast.success(`Revoked "${revokeTarget.name}"`);
        setRevokeTarget(null);
        refetch();
      } else {
        toast.error(res.error ?? "Revoke failed");
      }
    } finally {
      setRevoking(false);
    }
  }, [revokeTarget, refetch]);

  // Access control — admin only.
  if (me && me.role !== "ADMIN") {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>{t("common.accessDenied")}</AlertTitle>
          <AlertDescription>{t("apiKeys.adminOnly")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.api-keys")}
        description={t("desc.api-keys")}
        icon={<KeyRound className="h-5 w-5" />}
        tone="primary"
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">{t("apiKeys.create")}</span>
            <span className="sm:hidden">{t("apiKeys.createShort")}</span>
          </Button>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label={t("apiKeys.totalKeys")}  value={formatNumber(stats.total, numLang)}   icon={<KeyRound className="h-4 w-4" />} />
        <KpiCard label={t("common.active")}      value={formatNumber(stats.active, numLang)} icon={<ShieldCheck className="h-4 w-4" />} tone="good" />
        <KpiCard label={t("apiKeys.revoked")}     value={formatNumber(stats.revoked, numLang)} icon={<Ban className="h-4 w-4" />} tone="danger" />
        <KpiCard label={t("apiKeys.expired")}     value={formatNumber(stats.expired, numLang)} icon={<Clock className="h-4 w-4" />} tone="warn" />
      </div>

      {/* Keys table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-sm">
            API Keys ({formatNumber(stats.total, numLang)})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <div className="p-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>{t("apiKeys.loadFailed")}</AlertTitle>
                <AlertDescription className="text-xs">{error}</AlertDescription>
              </Alert>
            </div>
          )}
          {loading && !keys ? (
            <KeyTableSkeleton />
          ) : (
            <ScrollArea className="max-h-[640px]">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>{t("common.name")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("apiKeys.keyPrefix")}</TableHead>
                    <TableHead>{t("apiKeys.scopes")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("apiKeys.ipAllowlist")}</TableHead>
                    <TableHead className="hidden xl:table-cell">{t("apiKeys.createdBy")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("apiKeys.lastUsed")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("common.created")}</TableHead>
                    <TableHead className="w-[90px]">{t("common.status")}</TableHead>
                    <TableHead className="w-[60px] text-right">{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(keys ?? []).map((k) => {
                    const status = keyStatus(k);
                    const scopes = k.scopes.split(",").filter(Boolean);
                    const ips = k.ipAllowlist ? k.ipAllowlist.split(",").filter(Boolean) : [];
                    return (
                      <TableRow key={k.id} className={cn("transition-colors hover:bg-muted/30", status !== "active" && "opacity-60")}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">{k.name}</span>
                            <span className="text-[10px] text-muted-foreground font-mono" dir="ltr">{k.keyPrefix}…</span>
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]" dir="ltr">{k.keyPrefix}…</code>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1 max-w-[180px]">
                            {scopes.length === 0 ? (
                              <span className="text-[10px] text-muted-foreground">—</span>
                            ) : (
                              scopes.map((s) => <ScopeBadge key={s} scope={s} />)
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          {ips.length === 0 ? (
                            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <Globe className="h-3 w-3" />{t("apiKeys.anyIp")}</span>
                          ) : (
                            <div className="flex flex-wrap gap-1 max-w-[160px]">
                              {ips.map((ip, i) => (
                                <code key={i} className="rounded bg-muted px-1 py-0.5 text-[9px]" dir="ltr">{ip}</code>
                              ))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="hidden xl:table-cell">
                          <div className="flex flex-col">
                            <span className="text-xs">{k.creatorName ?? "—"}</span>
                            {k.creatorEmail && (
                              <span className="text-[9px] text-muted-foreground" dir="ltr">{k.creatorEmail}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-[10px] text-muted-foreground">
                          {k.lastUsedAt ? (
                            <>
                              <p>{timeAgo(k.lastUsedAt, numLang)}</p>
                              <p className="text-[9px]">{fmtDateTime(k.lastUsedAt, numLang).slice(5, 16)}</p>
                            </>
                          ) : (
                            <span>{t("apiKeys.never")}</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-[10px] text-muted-foreground">
                          {fmtDateTime(k.createdAt, numLang).slice(0, 10)}
                        </TableCell>
                        <TableCell><StatusBadge status={status} /></TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("common.actions")}>
                                <MoreVertical className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                              <DropdownMenuItem
                                disabled={status !== "active"}
                                onClick={() => setRevokeTarget(k)}
                                className="text-rose-700 dark:text-rose-400 focus:text-rose-700 dark:focus:text-rose-400 focus:bg-rose-500/10"
                              >
                                <Ban className="mr-2 h-3.5 w-3.5" />
                                Revoke
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {(keys ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="py-12 text-center text-sm text-muted-foreground">
                        {t("apiKeys.emptyHint")}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(created) => {
          setCreateOpen(false);
          setRevealedKey(created);
          refetch();
        }}
        numLang={numLang}
      />

      {/* Raw key reveal dialog (one-shot) */}
      <RevealKeyDialog
        key={revealedKey?.id ?? "none"}
        created={revealedKey}
        onOpenChange={(o) => !o && setRevealedKey(null)}
        numLang={numLang}
      />

      {/* Revoke confirm */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("apiKeys.revokeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tFmt("apiKeys.revokeDesc", { prefix: `${revokeTarget?.keyPrefix ?? ""}…`, name: revokeTarget?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevoke}
              disabled={revoking}
              className={cn("bg-rose-600 hover:bg-rose-700 focus-visible:ring-rose-500 text-white")}
            >
              {revoking ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Ban className="mr-1 h-3.5 w-3.5" />}
              {t("apiKeys.revokeBtn")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Create dialog
 * ──────────────────────────────────────────────────────────────────────── */

function CreateKeyDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (c: CreatedKeyResponse) => void;
  numLang: Language;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set(["read"]));
  const [expiresAt, setExpiresAt] = useState("");
  const [ipAllowlist, setIpAllowlist] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reset form state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setName("");
      setScopes(new Set(["read"]));
      setExpiresAt("");
      setIpAllowlist("");
    }
  }, [open]);

  const toggleScope = (code: string) => {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      // If user clears everything, force at least "read" back so the API
      // doesn't reject with an empty-scopes 400.
      if (next.size === 0) next.add("read");
      return next;
    });
  };

  const handleSubmit = async () => {
    if (name.trim().length < 1 || name.trim().length > 80) {
      toast.error("Name must be 1–80 characters");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        scopes: Array.from(scopes),
      };
      if (expiresAt) body.expiresAt = expiresAt;
      if (ipAllowlist.trim()) body.ipAllowlist = ipAllowlist.trim();
      const res = await apiPost("/api/fgmp/api-keys", body);
      if (res.ok) {
        toast.success("API key created");
        onCreated(res.data as CreatedKeyResponse);
      } else {
        toast.error(res.error ?? "Create failed");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("apiKeys.create")}</DialogTitle>
          <DialogDescription>{t("apiKeys.createDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="apikey-name" className="text-xs">{t("common.name")}</Label>
            <Input
              id="apikey-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("apiKeys.namePlaceholder")}
              className="h-9"
              maxLength={80}
            />
            <p className="text-[10px] text-muted-foreground">
              A descriptive label for this key (max 80 chars).
            </p>
          </div>

          {/* Scopes */}
          <div className="space-y-2">
            <Label className="text-xs">{t("apiKeys.scopes")}</Label>
            <div className="grid grid-cols-2 gap-2">
              {ALL_SCOPES.map((s) => (
                <label
                  key={s.code}
                  htmlFor={`scope-${s.code}`}
                  className={cn(
                    "flex items-start gap-2 rounded-md border p-2 cursor-pointer transition-colors",
                    scopes.has(s.code) ? "border-emerald-500/40 bg-emerald-500/5" : "border-border hover:bg-muted/30",
                  )}
                >
                  <Checkbox
                    id={`scope-${s.code}`}
                    checked={scopes.has(s.code)}
                    onCheckedChange={() => toggleScope(s.code)}
                    className="mt-0.5"
                  />
                  <div className="space-y-0.5">
                    <div className="text-xs font-medium">{t(s.labelKey)}</div>
                    <div className="text-[10px] leading-tight text-muted-foreground">{t(s.hintKey)}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Expiry + IP allowlist */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="apikey-exp" className="text-xs">{t("apiKeys.expiryLabel")}</Label>
              <Input
                id="apikey-exp"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="h-9"
                dir="ltr"
              />
              <p className="text-[10px] text-muted-foreground">
                {t("apiKeys.expiryHint")}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="apikey-ip" className="text-xs">{t("apiKeys.ipFieldLabel")}</Label>
              <Input
                id="apikey-ip"
                value={ipAllowlist}
                onChange={(e) => setIpAllowlist(e.target.value)}
                placeholder={t("apiKeys.ipPlaceholder")}
                className="h-9"
                dir="ltr"
              />
              <p className="text-[10px] text-muted-foreground">
                {t("apiKeys.ipHint")}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting || !name.trim()}>
            {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <KeyRound className="mr-1 h-3.5 w-3.5" />}
            Generate Key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Reveal key dialog (one-shot)
 * ──────────────────────────────────────────────────────────────────────── */

function RevealKeyDialog({
  created, onOpenChange, numLang,
}: {
  created: CreatedKeyResponse | null;
  onOpenChange: (o: boolean) => void;
  numLang: Language;
}) {
  const t = useT();
  // `copied` resets on each new key reveal via the `key={revealedKey?.id}`
  // prop on this component in the parent — no useEffect needed here.
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error("Clipboard not available — copy manually");
    }
  };

  return (
    <Dialog open={!!created} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />{t("apiKeys.createdTitle")}</DialogTitle>
          <DialogDescription>{t("apiKeys.createdCopy")}</DialogDescription>
        </DialogHeader>

        {created && (
          <div className="space-y-4">
            <Alert className="border-amber-500/40 bg-amber-500/10">
              <AlertCircle className="h-4 w-4 text-amber-500" />
              <AlertTitle className="text-amber-700 dark:text-amber-400">{t("apiKeys.storeSecurely")}</AlertTitle>
              <AlertDescription className="text-xs text-amber-700 dark:text-amber-400">
                {t("apiKeys.rawShownOnce")}
              </AlertDescription>
            </Alert>

            <div className="space-y-1.5">
              <Label className="text-xs">{t("common.name")}</Label>
              <Input value={created.name} readOnly className="h-9" />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{t("apiKeys.rawKey")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  value={created.key}
                  readOnly
                  dir="ltr"
                  className="h-9 font-mono text-xs"
                  onFocus={(e) => e.target.select()}
                />
                <Button onClick={handleCopy} size="sm" className="shrink-0">
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Prefix: <code className="font-mono">{created.keyPrefix}</code> ·
                Scopes: {created.scopes.split(",").map((s) => <span key={s} className="ml-1 font-mono">{s}</span>)}
                {created.expiresAt && ` · Expires: ${formatNumber(new Date(created.expiresAt).toLocaleDateString("en-GB"), numLang)}`}
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t("apiKeys.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Skeleton
 * ──────────────────────────────────────────────────────────────────────── */

function KeyTableSkeleton() {
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-24 hidden md:block" />
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-32 hidden lg:block" />
          <Skeleton className="h-9 w-24 hidden xl:block" />
          <Skeleton className="h-9 w-24 hidden md:block" />
          <Skeleton className="h-9 w-24 hidden lg:block" />
          <Skeleton className="h-9 w-16" />
          <Skeleton className="h-9 w-8" />
        </div>
      ))}
    </div>
  );
}
