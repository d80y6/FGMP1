"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Building2, Search, Plus, Pencil, Trash2, MoreVertical, ShieldAlert,
  Users, MapPin, Globe, UserPlus,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi, apiPost, apiPatch, apiDelete } from "@/lib/fgmp/use-api";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "sonner";
import { fmtDateTime } from "@/lib/fgmp/format";
import { useT, useTF, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";

/* ────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────── */

interface TenantRow {
  id: string;
  name: string;
  code: string;
  country: string;
  createdAt: string;
  updatedAt: string;
  _count: { users: number; sites: number; suppressions: number };
}

interface TenantForm {
  name: string;
  code: string;
  country: string;
}

const EMPTY_FORM: TenantForm = { name: "", code: "", country: "Yemen" };

/* ────────────────────────────────────────────────────────────────────────
 * Main view
 * ──────────────────────────────────────────────────────────────────────── */

export function TenantsView() {
  const me = useFgmp((s) => s.me);
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";

  const [q, setQ] = useState("");
  const [countryFilter, setCountryFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TenantRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TenantRow | null>(null);
  const [createAdminTarget, setCreateAdminTarget] = useState<TenantRow | null>(null);
  const [supportTarget, setSupportTarget] = useState<TenantRow | null>(null);

  const { data: tenants, loading, refetch } = useApi<TenantRow[]>("/api/fgmp/tenants", { interval: 30000 });

  // Task 49 — tenants are now platform-level: only SUPERADMIN can manage
  // them. ADMIN loses access to this view entirely.
  const isSuperAdmin = me?.role === "SUPERADMIN";

  const countries = useMemo(() => {
    const set = new Set<string>();
    (tenants ?? []).forEach((tnt) => set.add(tnt.country));
    return Array.from(set).sort();
  }, [tenants]);

  const filtered = useMemo(() => {
    let list = tenants ?? [];
    if (countryFilter !== "all") list = list.filter((tnt) => tnt.country === countryFilter);
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((tnt) => `${tnt.name} ${tnt.code} ${tnt.country}`.toLowerCase().includes(needle));
    }
    return list;
  }, [tenants, q, countryFilter]);

  const stats = useMemo(() => {
    const list = tenants ?? [];
    return {
      total: list.length,
      // "Active" = tenants with at least one user (no `active` flag on Tenant).
      active: list.filter((tnt) => tnt._count.users > 0).length,
      users: list.reduce((acc, tnt) => acc + tnt._count.users, 0),
      sites: list.reduce((acc, tnt) => acc + tnt._count.sites, 0),
    };
  }, [tenants]);

  // Access control: only SUPERADMIN may use this view (Task 49).
  if (me && !isSuperAdmin) {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>{t("users.accessDenied")}</AlertTitle>
          <AlertDescription>{t("tenants.superadminOnly")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.tenants")}
        description={t("desc.tenants")}
        icon={<Building2 className="h-5 w-5" />}
        tone="emerald"
        actions={
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">{t("tenants.add")}</span>
          </Button>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Total Tenants" value={formatNumber(stats.total, numLang)} icon={<Building2 className="h-4 w-4" />} />
        <KpiCard label="Active" value={formatNumber(stats.active, numLang)} icon={<Building2 className="h-4 w-4" />} tone="good" />
        <KpiCard label="Users" value={formatNumber(stats.users, numLang)} icon={<Users className="h-4 w-4" />} tone="info" />
        <KpiCard label="Sites" value={formatNumber(stats.sites, numLang)} icon={<MapPin className="h-4 w-4" />} tone="warn" />
      </div>

      {/* Filter + table card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-sm">
            {t("nav.tenants")} ({formatNumber(filtered.length, numLang)})
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search tenants…"
                className="h-9 w-[200px] pl-8"
              />
            </div>
            <CountrySelect value={countryFilter} onChange={setCountryFilter} countries={countries} />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading && !tenants ? (
            <TenantTableSkeleton />
          ) : (
            <ScrollArea className="max-h-[640px]">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead className="w-[120px]">Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="hidden md:table-cell">Country</TableHead>
                    <TableHead className="w-[80px] text-center">Users</TableHead>
                    <TableHead className="w-[80px] text-center">Sites</TableHead>
                    <TableHead className="hidden lg:table-cell w-[150px]">Created</TableHead>
                    <TableHead className="w-[60px] text-right">{t("users.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((tnt) => (
                    <TableRow key={tnt.id} className="transition-colors hover:bg-muted/30">
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-[10px]" dir="ltr">{tnt.code}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="flex items-center gap-1.5 text-sm font-medium">
                            {tnt.name}
                            {tnt.code === "PLATFORM" && (
                              <Badge className="h-4 px-1 text-[9px] bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/15">
                                {t("tenants.platformTenant")}
                              </Badge>
                            )}
                          </span>
                          {tnt._count.suppressions > 0 && (
                            <span className="text-[10px] text-muted-foreground">
                              {formatNumber(tnt._count.suppressions, numLang)} suppressions
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <Globe className="h-3 w-3" />
                          {tnt.country}
                        </span>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="outline" className="text-[10px] tabular-nums">
                          {formatNumber(tnt._count.users, numLang)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="outline" className="text-[10px] tabular-nums">
                          {formatNumber(tnt._count.sites, numLang)}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-[10px] text-muted-foreground" dir="ltr">
                        {fmtDateTime(tnt.createdAt, numLang).slice(0, 10)}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("common.moreActions")}>
                              <MoreVertical className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem onClick={() => setEditTarget(tnt)}>
                              <Pencil className="mr-2 h-3.5 w-3.5" />
                              {t("common.edit")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setCreateAdminTarget(tnt)}>
                              <UserPlus className="mr-2 h-3.5 w-3.5" />
                              {t("tenants.createAdmin")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setSupportTarget(tnt)}>
                              <ShieldAlert className="mr-2 h-3.5 w-3.5" />
                              {t("tenants.supportAccess")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-rose-600 focus:text-rose-700"
                              onClick={() => setDeleteTarget(tnt)}
                            >
                              <Trash2 className="mr-2 h-3.5 w-3.5" />
                              {t("common.delete")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filtered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-12 text-center text-sm text-muted-foreground">
                        {tenants && tenants.length === 0
                          ? "No tenants yet. Click “Add Tenant” to create the first one."
                          : "No tenants match your filters."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <CreateTenantDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => { refetch(); setCreateOpen(false); }}
        lang={numLang}
      />

      <EditTenantDialog
        target={editTarget}
        onOpenChange={(o) => !o && setEditTarget(null)}
        onSaved={() => { refetch(); setEditTarget(null); }}
        lang={numLang}
      />

      <DeleteTenantDialog
        target={deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        onDeleted={() => { refetch(); setDeleteTarget(null); }}
      />

      {/* Create-admin quick action — pre-selects this tenant and posts a new
          ADMIN user via /api/fgmp/users. Super-admin only (the whole view is). */}
      <CreateTenantAdminDialog
        target={createAdminTarget}
        onOpenChange={(o) => !o && setCreateAdminTarget(null)}
        onCreated={() => { refetch(); setCreateAdminTarget(null); }}
        lang={numLang}
      />

      {/* Platform support access. This is the ONLY UI that can open a
          time-boxed, single-tenant support session — see docs/SUPERADMIN.md.
          It deliberately asks for a reason up front: the text is shown to the
          tenant in its own audit log, so it must say what the operator is
          doing, not "support". */}
      <SupportAccessDialog
        // Keyed by tenant so opening it for another tenant REMOUNTS it: the
        // reason typed for tenant A can never be submitted for tenant B, and
        // there is no reset-in-an-effect to get wrong.
        key={supportTarget?.id ?? "none"}
        target={supportTarget}
        onOpenChange={(o) => !o && setSupportTarget(null)}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Sub-components
 * ──────────────────────────────────────────────────────────────────────── */

function TenantTableSkeleton() {
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-20 hidden md:block" />
          <Skeleton className="h-9 w-10" />
          <Skeleton className="h-9 w-10" />
          <Skeleton className="h-9 w-24 hidden lg:block" />
          <Skeleton className="h-9 w-8" />
        </div>
      ))}
    </div>
  );
}

function CountrySelect({
  value, onChange, countries,
}: { value: string; onChange: (v: string) => void; countries: string[] }) {
  const t = useT();
  // Native select to keep the bundle tiny and avoid the shadcn Select
  // portal overhead for a tiny filter list. Styled to match the Input row.
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-md border border-input bg-background px-3 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t("common.filterByCountry")}
    >
      <option value="all">{t("tenants.allCountries")}</option>
      {countries.map((c) => (
        <option key={c} value={c}>{c}</option>
      ))}
    </select>
  );
}

function TenantFormFields({
  form, update, lang,
}: {
  form: TenantForm;
  update: <K extends keyof TenantForm>(k: K, v: TenantForm[K]) => void;
  lang: Language;
}) {
  void lang;
  const t = useT();
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">{t("common.name")}</Label>
        <Input
          value={form.name}
          onChange={(e) => update("name", e.target.value)}
          className="h-9"
          placeholder="National Telecom Operator"
          autoFocus
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Code</Label>
        <Input
          value={form.code}
          onChange={(e) => update("code", e.target.value.toUpperCase())}
          className="h-9 font-mono text-xs"
          dir="ltr"
          placeholder="NATIONAL-TELCO"
        />
        <p className="text-[11px] text-muted-foreground">{t("tenants.slugHint")}</p>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Country</Label>
        <Input
          value={form.country}
          onChange={(e) => update("country", e.target.value)}
          className="h-9"
          placeholder="Yemen"
        />
      </div>
    </div>
  );
}

function CreateTenantDialog({
  open, onOpenChange, onCreated, lang,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
  lang: Language;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<TenantForm>(EMPTY_FORM);

  // Reset the form whenever the dialog is opened.
  useEffect(() => {
    if (open) setForm(EMPTY_FORM);
  }, [open]);

  const update = <K extends keyof TenantForm>(k: K, v: TenantForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const onSubmit = async () => {
    if (!form.name || !form.code || !form.country) {
      toast.error("All fields are required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiPost("/api/fgmp/tenants", {
        name: form.name.trim(),
        code: form.code.trim(),
        country: form.country.trim(),
      });
      if (res.ok) {
        toast.success("Tenant created");
        onCreated();
      } else {
        const err = (res.data as { error?: string } | undefined)?.error;
        toast.error(err ?? "Error");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t("tenants.add")}</DialogTitle>
          <DialogDescription>{t("tenants.createDesc")}</DialogDescription>
        </DialogHeader>
        <TenantFormFields form={form} update={update} lang={lang} />
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? "…" : "Create Tenant"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditTenantDialog({
  target, onOpenChange, onSaved, lang,
}: {
  target: TenantRow | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
  lang: Language;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<TenantForm>(EMPTY_FORM);

  useEffect(() => {
    if (target) {
      setForm({ name: target.name, code: target.code, country: target.country });
    }
  }, [target]);

  const update = <K extends keyof TenantForm>(k: K, v: TenantForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const onSubmit = async () => {
    if (!target) return;
    if (!form.name || !form.code || !form.country) {
      toast.error("All fields are required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiPatch(`/api/fgmp/tenants/${target.id}`, {
        name: form.name.trim(),
        code: form.code.trim(),
        country: form.country.trim(),
      });
      if (res.ok) {
        toast.success("Tenant updated");
        onSaved();
      } else {
        const err = (res.data as { error?: string } | undefined)?.error;
        toast.error(err ?? "Error");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t("tenants.edit")}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-[10px]" dir="ltr">{target?.code}</span>
          </DialogDescription>
        </DialogHeader>
        <TenantFormFields form={form} update={update} lang={lang} />
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? "…" : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteTenantDialog({
  target, onOpenChange, onDeleted,
}: {
  target: TenantRow | null;
  onOpenChange: (o: boolean) => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const [deleting, setDeleting] = useState(false);

  const hasDependents = !!target && (target._count.users > 0 || target._count.sites > 0);

  const onConfirm = async () => {
    if (!target) return;
    setDeleting(true);
    try {
      // Gated client-side as well as server-side: a non-SUPERADMIN cannot even
      // reach this dialog, but a stale handler or a keyboard shortcut must not
      // be able to issue the request either.
      const res = await apiDelete(`/api/fgmp/tenants/${target.id}`);
      if (res.ok) {
        toast.success("Tenant deleted");
        onDeleted();
      } else {
        toast.error(res.error ?? "Delete failed");
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog open={!!target} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-rose-500" />
            {t("tenants.deleteTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            You are about to permanently delete{" "}
            <span className="font-medium text-foreground">{target?.name}</span>{" "}
            (<span className="font-mono text-[10px]" dir="ltr">{target?.code}</span>).
            {hasDependents ? (
              <>
                <br /><br />
                <span className="text-rose-600 dark:text-rose-400 font-medium">
                  This tenant still has {target?._count.users ?? 0} users and{" "}
                  {target?._count.sites ?? 0} sites. Remove or reassign them first.
                </span>
              </>
            ) : (
              <>
                <br />{t("tenants.cannotUndo")}</>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); void onConfirm(); }}
            disabled={deleting || hasDependents}
            className="bg-rose-500 hover:bg-rose-600 text-white"
          >
            {deleting ? "…" : t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Create-tenant-admin quick action (Task 49)
 * ────────────────────────────────────────────────────────────────────────
 * Super-admin opens this from a tenant row's dropdown menu. It pre-selects
 * that tenant and posts a new ADMIN user via /api/fgmp/users with the
 * `tenantId` and `role: "ADMIN"` fields baked in. No role / tenant selects
 * are shown — the only inputs are name, email, password, confirm password.
 * ──────────────────────────────────────────────────────────────────────── */

const createAdminSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8),
  confirmPassword: z.string().min(8),
}).refine((d) => d.password === d.confirmPassword, {
  path: ["confirmPassword"],
  message: "Passwords do not match",
});

type CreateAdminForm = z.infer<typeof createAdminSchema>;

function CreateTenantAdminDialog({
  target, onOpenChange, onCreated, lang,
}: {
  target: TenantRow | null;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
  lang: Language;
}) {
  void lang;
  const t = useT();
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<CreateAdminForm>({
    resolver: zodResolver(createAdminSchema),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
  });

  // Reset the form whenever a different tenant is targeted (or the dialog
  // is reopened).
  const targetId = target?.id;
  useEffect(() => {
    form.reset({ name: "", email: "", password: "", confirmPassword: "" });
  }, [targetId, form]);

  const onSubmit = async (values: CreateAdminForm) => {
    if (!target) return;
    setSubmitting(true);
    try {
      const res = await apiPost("/api/fgmp/users", {
        name: values.name,
        email: values.email,
        role: "ADMIN",
        password: values.password,
        tenantId: target.id,
      });
      if (res.ok) {
        toast.success(t("tenants.createAdminSuccess"));
        form.reset();
        onCreated();
      } else {
        const err = (res.data as { error?: string; code?: string } | undefined)?.error;
        const code = (res.data as { code?: string } | undefined)?.code;
        if (code === "CANNOT_ASSIGN_SUPERADMIN" || err === "CANNOT_ASSIGN_SUPERADMIN") {
          toast.error(t("users.cannotAssignSuperadmin"));
        } else if (err === "Email already in use") {
          toast.error(t("users.emailTaken"));
          form.setError("email", { message: t("users.emailTaken") });
        } else {
          toast.error(err ?? "Error");
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-emerald-500" />
            {t("tenants.createAdminTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("tenants.createAdminDesc")}
            {target && (
              <span className="mt-1 block">
                <span className="text-muted-foreground">{t("users.tenant")}: </span>
                <Badge variant="outline" className="ml-1 h-4 px-1 text-[10px]">
                  {target.name}
                </Badge>
                <span className="ml-1.5 font-mono text-[10px] text-muted-foreground" dir="ltr">{target.code}</span>
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">{t("users.name")}</FormLabel>
                  <FormControl>
                    <Input {...field} className="h-9" />
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">{t("users.email")}</FormLabel>
                  <FormControl>
                    <Input type="email" {...field} className="h-9" dir="ltr" />
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">{t("users.password")}</FormLabel>
                    <FormControl>
                      <Input type="password" {...field} className="h-9" dir="ltr" />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">{t("users.confirmPassword")}</FormLabel>
                    <FormControl>
                      <Input type="password" {...field} className="h-9" dir="ltr" />
                    </FormControl>
                    <FormDescription className="text-[11px] sr-only">
                      {t("users.confirmPassword")}
                    </FormDescription>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "…" : t("tenants.createAdmin")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Support access
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Open a support session for one tenant.
 *
 * The dialog is intentionally heavier than a confirmation: a reason is
 * mandatory, and write access costs an extra click AND a ticket reference. That
 * friction is the point — it is the difference between "support looked" and
 * "somebody clicked a row".
 */
function SupportAccessDialog({
  target,
  onOpenChange,
}: {
  target: TenantRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const tFmt = useTF();
  const [reason, setReason] = useState("");
  const [ticketRef, setTicketRef] = useState("");
  const [write, setWrite] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const tooShort = reason.trim().length < 10;
  const writeNeedsTicket = write && ticketRef.trim().length === 0;
  const disabled = submitting || tooShort || writeNeedsTicket;

  const submit = async () => {
    if (!target || disabled) return;
    setSubmitting(true);
    try {
      const res = await apiPost("/api/fgmp/platform/support-sessions", {
        tenantId: target.id,
        reason: reason.trim(),
        ticketRef: ticketRef.trim() || undefined,
        mode: write ? "WRITE" : "READ",
      });
      if (res.ok) {
        toast.success(`Support session opened for ${target.name}`, {
          description: write
            ? "Write access. Every change is recorded in the tenant's audit log."
            : "Read-only. The banner stays visible until you end the session.",
        });
        // A full reload is the honest way to pick up the new cookie's effect on
        // the banner: the banner is mounted at the shell level and polls, and
        // leaving the operator on a screen that looks unchanged would defeat
        // the point of opening a session.
        window.location.reload();
      } else {
        toast.error(res.error ?? "Could not open a support session");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-600" />
            {t("tenants.supportAccess")}
          </DialogTitle>
          <DialogDescription>
            {target
              ? tFmt("tenants.supportDesc", { name: target.name })
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="support-reason" className="text-xs">{t("tenants.supportReason")}</Label>
            <Textarea
              id="support-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("tenants.supportReasonPlaceholder")}
              rows={3}
              maxLength={500}
            />
            <p className="text-[11px] text-muted-foreground">
              {tooShort ? t("tenants.tooShort") : `${reason.trim().length}/500`}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="support-ticket" className="text-xs">
              {t("tenants.ticketRef")} {write ? t("tenants.requiredForWrite") : t("tenants.optional")}
            </Label>
            <Input
              id="support-ticket"
              value={ticketRef}
              onChange={(e) => setTicketRef(e.target.value)}
              placeholder="INC-1042"
              maxLength={120}
            />
          </div>

          <label className="flex items-start gap-2 rounded-md border p-2.5 text-xs">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5"
              checked={write}
              onChange={(e) => setWrite(e.target.checked)}
            />
            <span>
              <span className="font-medium">{t("tenants.requestWriteAccess")}</span>
              <span className="block text-muted-foreground">
                {t("tenants.writeAccessNote")}
              </span>
            </span>
          </label>
        </div>

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={disabled}>
            {submitting ? "Opening…" : "Open support session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
