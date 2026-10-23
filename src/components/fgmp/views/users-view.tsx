"use client";

import { useEffect, useMemo, useState } from "react";
import { Users, Search, Plus, Pencil, KeyRound, MoreVertical, ShieldCheck, UserCheck, UserX, ShieldAlert, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi, apiPost, apiPatch } from "@/lib/fgmp/use-api";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "sonner";
import { fmtDateTime, timeAgo } from "@/lib/fgmp/format";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { roleLabel } from "@/lib/fgmp/labels";
import { ALL_ROLES } from "@/lib/fgmp/rbac";
import type { Role } from "@/lib/fgmp/types";

/* ────────────────────────────────────────────────────────────────────────
 * Types & helpers
 * ──────────────────────────────────────────────────────────────────────── */

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  phone: string | null;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  tenantId: string;
  tenant?: { name: string } | null;
}

interface TenantRow {
  id: string;
  name: string;
  code: string;
  country: string;
  createdAt: string;
  updatedAt: string;
  _count: { users: number; sites: number; suppressions: number };
}


/* ────────────────────────────────────────────────────────────────────────
 * Form schemas
 * ──────────────────────────────────────────────────────────────────────── */

const createSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  role: z.enum(ALL_ROLES as [Role, ...Role[]]),
  // tenantId is supplied by super-admins (any tenant); tenant-admins omit
  // it and the backend forces the user into their own tenant.
  tenantId: z.string().optional(),
  phone: z.string().max(40).optional().or(z.literal("")),
  password: z.string().min(8),
  confirmPassword: z.string().min(8),
}).refine((d) => d.password === d.confirmPassword, {
  path: ["confirmPassword"],
  message: "Passwords do not match",
});

type CreateForm = z.infer<typeof createSchema>;

const editSchema = z.object({
  name: z.string().min(2).max(120),
  role: z.enum(ALL_ROLES as [Role, ...Role[]]),
  phone: z.string().max(40).optional().or(z.literal("")),
  active: z.boolean(),
});

type EditForm = z.infer<typeof editSchema>;

const resetSchema = z.object({
  password: z.string().min(8),
  confirmPassword: z.string().min(8),
}).refine((d) => d.password === d.confirmPassword, {
  path: ["confirmPassword"],
  message: "Passwords do not match",
});

type ResetForm = z.infer<typeof resetSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Main view
 * ──────────────────────────────────────────────────────────────────────── */

export function UsersView() {
  const me = useFgmp((s) => s.me);
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";

  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserRow | null>(null);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);

  const { data: users, loading, refetch } = useApi<UserRow[]>("/api/fgmp/users", { interval: 60000 });

  const filtered = useMemo(() => {
    let list = users ?? [];
    if (roleFilter !== "all") list = list.filter((u) => u.role === roleFilter);
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((u) => `${u.name} ${u.email} ${u.phone ?? ""}`.toLowerCase().includes(needle));
    }
    return list;
  }, [users, q, roleFilter]);

  const stats = useMemo(() => {
    const list = users ?? [];
    return {
      total: list.length,
      active: list.filter((u) => u.active).length,
      admins: list.filter((u) => u.role === "ADMIN").length,
      tenants: new Set(list.map((u) => u.tenantId)).size,
    };
  }, [users]);

  // Access control: only ADMIN and SUPERADMIN may use this view.
  if (me && me.role !== "ADMIN" && me.role !== "SUPERADMIN") {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>{t("users.accessDenied")}</AlertTitle>
          <AlertDescription>{t("users.accessDeniedDescription")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("users.title")}
        description={t("users.description")}
        icon={<Users className="h-5 w-5" />}
        tone="primary"
        actions={
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">{t("users.createUser")}</span>
          </Button>
        }
      />

      {/* KPI strip */}
      <div className={cn("grid grid-cols-1 gap-3", me?.role === "SUPERADMIN" ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3")}>
        <KpiCard label={t("users.totalUsers")} value={formatNumber(stats.total, numLang)} icon={<Users className="h-4 w-4" />} />
        <KpiCard label={t("users.activeUsers")} value={formatNumber(stats.active, numLang)} icon={<UserCheck className="h-4 w-4" />} tone="good" />
        <KpiCard label={t("users.adminCount")} value={formatNumber(stats.admins, numLang)} icon={<ShieldCheck className="h-4 w-4" />} tone="info" />
        {me?.role === "SUPERADMIN" && (
          <KpiCard label={t("nav.tenants")} value={formatNumber(stats.tenants, numLang)} icon={<Building2 className="h-4 w-4" />} tone="warn" />
        )}
      </div>

      {/* Filter + table card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-sm">
            {t("nav.users")} ({formatNumber(filtered.length, numLang)})
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("users.searchUsers")}
                className="h-9 w-[200px] pl-8"
              />
            </div>
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="h-9 w-[170px] text-xs">
                <SelectValue placeholder={t("users.filterByRole")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("users.allRoles")}</SelectItem>
                {ALL_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>{roleLabel(r, numLang)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading && !users ? (
            <UserTableSkeleton />
          ) : (
            <ScrollArea className="max-h-[640px]">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>{t("users.name")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("users.tenant")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("users.role")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("users.phone")}</TableHead>
                    <TableHead className="w-[90px]">{t("users.status")}</TableHead>
                    <TableHead className="hidden md:table-cell w-[150px]">{t("users.lastLogin")}</TableHead>
                    <TableHead className="w-[60px] text-right">{t("users.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((u) => {
                    const isSelf = me?.id === u.id;
                    return (
                      <TableRow key={u.id} className={cn("transition-colors hover:bg-muted/30", u.active ? "" : "opacity-60")}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">{u.name}{isSelf && <Badge variant="outline" className="ml-2 h-4 px-1 text-[9px]">YOU</Badge>}</span>
                            <span className="text-[11px] text-muted-foreground">{u.email}</span>
                          </div>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">{u.tenant?.name ?? "—"}</TableCell>
                        <TableCell className="hidden md:table-cell">
                          <Badge variant="outline" className="text-[10px]">{roleLabel(u.role, numLang)}</Badge>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-xs text-muted-foreground" dir="ltr">{u.phone ?? "—"}</TableCell>
                        <TableCell>
                          {u.active ? (
                            <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px]">{t("users.active")}</Badge>
                          ) : (
                            <Badge variant="outline" className="border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-400 text-[10px]">{t("users.inactive")}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-[10px] text-muted-foreground">
                          {u.lastLoginAt ? (
                            <>
                              <p>{timeAgo(u.lastLoginAt, numLang)}</p>
                              <p className="text-[9px]">{fmtDateTime(u.lastLoginAt, numLang).slice(5, 16)}</p>
                            </>
                          ) : (
                            <span>{t("users.lastLoginNever")}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("users.moreActions")}>
                                <MoreVertical className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                              <DropdownMenuItem
                                onClick={() => {
                                  // Tenant admins cannot modify super-admin accounts.
                                  if (u.role === "SUPERADMIN" && me?.role === "ADMIN") {
                                    toast.error(t("users.cannotEditSuperadmin"));
                                    return;
                                  }
                                  setEditTarget(u);
                                }}
                                disabled={u.role === "SUPERADMIN" && me?.role === "ADMIN"}
                              >
                                <Pencil className="mr-2 h-3.5 w-3.5" />
                                {t("users.editUser")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => {
                                  if (u.role === "SUPERADMIN" && me?.role === "ADMIN") {
                                    toast.error(t("users.cannotEditSuperadmin"));
                                    return;
                                  }
                                  setResetTarget(u);
                                }}
                                disabled={isSelf || (u.role === "SUPERADMIN" && me?.role === "ADMIN")}
                              >
                                <KeyRound className="mr-2 h-3.5 w-3.5" />
                                {t("users.resetPassword")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                disabled={isSelf || (u.role === "SUPERADMIN" && me?.role === "ADMIN")}
                                onClick={async () => {
                                  if (u.role === "SUPERADMIN" && me?.role === "ADMIN") {
                                    toast.error(t("users.cannotEditSuperadmin"));
                                    return;
                                  }
                                  const next = !u.active;
                                  const res = await apiPatch(`/api/fgmp/users/${u.id}`, { active: next });
                                  if (res.ok) {
                                    toast.success(next ? t("users.activateSuccess") : t("users.deactivateSuccess"));
                                    refetch();
                                  } else {
                                    toast.error(res.error ?? "Error");
                                  }
                                }}
                              >
                                {u.active ? (
                                  <>
                                    <UserX className="mr-2 h-3.5 w-3.5" />
                                    {t("users.deactivate")}
                                  </>
                                ) : (
                                  <>
                                    <UserCheck className="mr-2 h-3.5 w-3.5" />
                                    {t("users.activate")}
                                  </>
                                )}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {filtered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-12 text-center text-sm text-muted-foreground">
                        {t("users.noUsers")}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Create user dialog */}
      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => { refetch(); setCreateOpen(false); }}
        lang={numLang}
        meRole={me?.role ?? "READONLY"}
        meTenantId={me?.tenantId ?? ""}
      />

      {/* Edit user dialog */}
      <EditUserDialog
        target={editTarget}
        onOpenChange={(o) => !o && setEditTarget(null)}
        onSaved={() => { refetch(); setEditTarget(null); }}
        lang={numLang}
        meRole={me?.role ?? "READONLY"}
      />

      {/* Reset password dialog */}
      <ResetPasswordDialog
        target={resetTarget}
        onOpenChange={(o) => !o && setResetTarget(null)}
        onDone={() => { refetch(); setResetTarget(null); }}
        lang={numLang}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Sub-components
 * ──────────────────────────────────────────────────────────────────────── */

function UserTableSkeleton() {
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-24 hidden md:block" />
          <Skeleton className="h-9 w-24 hidden lg:block" />
          <Skeleton className="h-9 w-16" />
          <Skeleton className="h-9 w-24 hidden md:block" />
          <Skeleton className="h-9 w-8" />
        </div>
      ))}
    </div>
  );
}

function RoleSelect({
  value, onChange, lang, disabled, excludeSuperAdmin,
}: {
  value: string;
  onChange: (v: string) => void;
  lang: Language;
  disabled?: boolean;
  /** Hide the SUPERADMIN option — used when a tenant admin is the operator. */
  excludeSuperAdmin?: boolean;
}) {
  const t = useT();
  const roles = useMemo(
    () => (excludeSuperAdmin ? ALL_ROLES.filter((r) => r !== "SUPERADMIN") : ALL_ROLES),
    [excludeSuperAdmin],
  );
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {roles.map((r) => {
          const descKey = `roleDesc.${r.toLowerCase()}`;
          const desc = t(descKey);
          const hasDesc = desc && desc !== descKey;
          return (
            <SelectItem key={r} value={r} className="flex flex-col items-start gap-0.5 py-2">
              <span className="font-medium">{roleLabel(r, lang)}</span>
              {hasDesc && <span className="text-[10px] leading-tight text-muted-foreground">{desc}</span>}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function CreateUserDialog({
  open, onOpenChange, onCreated, lang, meRole, meTenantId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
  lang: Language;
  meRole: Role;
  meTenantId: string;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const isSuperAdmin = meRole === "SUPERADMIN";
  // Super-admin picks the tenant from a dropdown; tenant-admin is fixed to
  // their own tenant (the API ignores the field and forces own-tenant).
  const { data: tenants } = useApi<TenantRow[]>(
    isSuperAdmin ? "/api/fgmp/tenants" : null,
    { interval: 60000 },
  );
  const ownTenantName = useMemo(() => tenants?.[0]?.name ?? meTenantId, [tenants, meTenantId]);

  const form = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: "",
      email: "",
      role: "NOC_OPERATOR",
      tenantId: undefined,
      phone: "",
      password: "",
      confirmPassword: "",
    },
  });

  // Watch the role so we can re-render the scope hint when it changes.
  const selectedRole = form.watch("role");

  const onSubmit = async (values: CreateForm) => {
    // Super-admin must explicitly pick a tenant (unless they are creating
    // another super-admin, which is tenant-agnostic and the backend will
    // default to the platform tenant).
    if (isSuperAdmin && values.role !== "SUPERADMIN" && !values.tenantId) {
      form.setError("tenantId", { message: t("users.tenantRequired") });
      toast.error(t("users.tenantRequired"));
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: values.name,
        email: values.email,
        role: values.role,
        phone: values.phone || null,
        password: values.password,
      };
      if (isSuperAdmin && values.tenantId) body.tenantId = values.tenantId;
      const res = await apiPost("/api/fgmp/users", body);
      if (res.ok) {
        toast.success(t("users.createSuccess"));
        form.reset();
        onCreated();
      } else {
        const err = (res.data as { error?: string; code?: string } | undefined)?.error;
        const code = (res.data as { code?: string } | undefined)?.code;
        if (code === "CANNOT_ASSIGN_SUPERADMIN" || err === "CANNOT_ASSIGN_SUPERADMIN") {
          toast.error(t("users.cannotAssignSuperadmin"));
          form.setError("role", { message: t("users.cannotAssignSuperadmin") });
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
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) form.reset(); }}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t("users.createUser")}</DialogTitle>
          <DialogDescription>{t("users.description")}</DialogDescription>
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
            {/* Tenant selector — visible to super-admin only. Tenant-admins are
                fixed to their own tenant; show a small read-only badge. */}
            {isSuperAdmin ? (
              <FormField
                control={form.control}
                name="tenantId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">
                      {t("users.tenant")}
                      {selectedRole !== "SUPERADMIN" && <span className="text-rose-500"> *</span>}
                    </FormLabel>
                    <FormControl>
                      <Select
                        value={field.value ?? ""}
                        onValueChange={field.onChange}
                        disabled={selectedRole === "SUPERADMIN"}
                      >
                        <SelectTrigger className="w-full h-9">
                          <SelectValue placeholder={t("users.selectTenant")} />
                        </SelectTrigger>
                        <SelectContent>
                          {(tenants ?? []).map((tnt) => (
                            <SelectItem key={tnt.id} value={tnt.id} className="text-xs">
                              <span className="font-medium">{tnt.name}</span>
                              <span className="ml-1.5 font-mono text-[10px] text-muted-foreground" dir="ltr">{tnt.code}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
            ) : (
              <div className="space-y-1">
                <Label className="text-xs">{t("users.tenant")}</Label>
                <div>
                  <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[10px]">
                    <Building2 className="mr-1 h-3 w-3" />
                    {ownTenantName}
                  </Badge>
                </div>
              </div>
            )}
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">{t("users.role")}</FormLabel>
                  <FormControl>
                    <RoleSelect
                      value={field.value}
                      onChange={field.onChange}
                      lang={lang}
                      excludeSuperAdmin={!isSuperAdmin}
                    />
                  </FormControl>
                  <FormDescription className="text-[11px]">
                    {isSuperAdmin ? t("users.superadminScopeHint") : t("users.tenantAdminScopeHint")}
                  </FormDescription>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">{t("users.phone")}</FormLabel>
                  <FormControl>
                    <Input {...field} className="h-9" dir="ltr" />
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
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                {t("users.cancel")}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "…" : t("users.createUser")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({
  target, onOpenChange, onSaved, lang, meRole,
}: {
  target: UserRow | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
  lang: Language;
  meRole: Role;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const isSuperAdmin = meRole === "SUPERADMIN";

  const form = useForm<EditForm>({
    resolver: zodResolver(editSchema),
    values: target ? {
      name: target.name,
      role: target.role as Role,
      phone: target.phone ?? "",
      active: target.active,
    } : undefined,
  });

  const onSubmit = async (values: EditForm) => {
    if (!target) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/fgmp/users/${target.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.name,
          role: values.role,
          phone: values.phone || null,
          active: values.active,
        }),
        credentials: "include",
      });
      if (res.ok) {
        toast.success(t("users.updateSuccess"));
        onSaved();
      } else {
        const json = await res.json().catch(() => ({}));
        const code = (json as { code?: string }).code;
        const err = (json as { error?: string }).error;
        if (code === "CANNOT_MODIFY_SUPERADMIN") {
          toast.error(t("users.cannotEditSuperadmin"));
        } else if (code === "CANNOT_ASSIGN_SUPERADMIN" || err === "CANNOT_ASSIGN_SUPERADMIN") {
          toast.error(t("users.cannotAssignSuperadmin"));
        } else {
          toast.error(err ?? `HTTP ${res.status}`);
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
          <DialogTitle>{t("users.editUser")}</DialogTitle>
          <DialogDescription>{target?.email}</DialogDescription>
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
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">{t("users.role")}</FormLabel>
                  <FormControl>
                    <RoleSelect
                      value={field.value}
                      onChange={field.onChange}
                      lang={lang}
                      excludeSuperAdmin={!isSuperAdmin}
                    />
                  </FormControl>
                  <FormDescription className="text-[11px]">
                    {isSuperAdmin ? t("users.superadminScopeHint") : t("users.tenantAdminScopeHint")}
                  </FormDescription>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">{t("users.phone")}</FormLabel>
                  <FormControl>
                    <Input {...field} className="h-9" dir="ltr" />
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <FormLabel className="text-xs">{t("users.status")}</FormLabel>
                    <FormDescription className="text-[11px]">
                      {field.value ? t("users.active") : t("users.inactive")}
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                {t("users.cancel")}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "…" : t("users.save")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ target, onOpenChange, onDone }: {
  target: UserRow | null;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
  lang: Language;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<ResetForm>({
    resolver: zodResolver(resetSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  // Reset form whenever target changes (open a different user's dialog)
  const targetId = target?.id;
  useEffect(() => {
    form.reset({ password: "", confirmPassword: "" });
  }, [targetId, form]);

  const onSubmit = async (values: ResetForm) => {
    if (!target) return;
    setSubmitting(true);
    try {
      const res = await apiPost(`/api/fgmp/users/${target.id}/reset-password`, {
        password: values.password,
      });
      if (res.ok) {
        toast.success(t("users.resetPasswordSuccess"));
        form.reset();
        onDone();
      } else {
        toast.error(res.error ?? "Error");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t("users.resetPassword")}</DialogTitle>
          <DialogDescription>{target?.email}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">{t("users.newPassword")}</FormLabel>
                  <FormControl>
                    <Input type="password" {...field} className="h-9" dir="ltr" />
                  </FormControl>
                  <FormDescription className="text-[11px]">{t("users.newPasswordHint")}</FormDescription>
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
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />
            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                {t("users.cancel")}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "…" : t("users.resetPassword")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
