"use client";

/**
 * Notification Preferences view (Task 33-A)
 * ────────────────────────────────────────────────────────────────────────────
 * Per-user notification preferences panel. Lets each operator customize
 * which alarm notifications they receive, by severity and channel (in-app /
 * email / SMS), plus optional quiet hours during which in-app notifications
 * are silenced (L3 critical alarms still trigger audible alerts).
 *
 * Layout:
 *   1. Header (SectionHeader) with title + subtitle.
 *   2. Channel cards grid (3 cols lg / 1 col mobile):
 *        - In-App (Bell icon) — toggle + 3 severity checkboxes.
 *        - Email (Mail icon) — toggle + 3 severity checkboxes + override input.
 *        - SMS (MessageSquare icon) — toggle + 3 severity checkboxes + override input.
 *      Cards dim (opacity-50) when the channel is disabled.
 *   3. Quiet Hours card — toggle + start/end selects (24h) + timeline bar.
 *   4. Sticky bottom action bar — Save (primary) + Reset to defaults (ghost).
 *
 * Form state is managed by react-hook-form + zodResolver using the shared
 * notificationPreferenceSchema. Auto-loads on mount via GET; submits via
 * PUT to /api/fgmp/preferences. Toasts on success / error.
 *
 * Visible to ALL authenticated users (`view:preferences` capability is on
 * every role in rbac.ts). The PUT endpoint enforces self-only edits; an
 * admin-managed variant lives at /api/fgmp/preferences/[userId].
 */

import { useEffect, useMemo, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Bell, Mail, MessageSquare, Moon, Volume2, VolumeX, Save, RotateCcw,
  Clock, Check, AlertCircle, Loader2,
} from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import { notificationPreferenceSchema } from "@/lib/fgmp/schemas";
import type { NotificationPreferenceInput } from "@/lib/fgmp/schemas";
import { SectionHeader } from "@/components/fgmp/section-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ConfirmDestructive } from "@/components/fgmp/confirm-destructive";
import { useT, useDir, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { cn } from "@/lib/utils";

/* ────────────────────────────────────────────────────────────────────────
 * Types & constants
 * ──────────────────────────────────────────────────────────────────────── */

interface PreferenceRow {
  id: string;
  userId: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  smsEnabled: boolean;
  inAppSeverities: string;
  emailSeverities: string;
  smsSeverities: string;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  emailOverride: string | null;
  phoneOverride: string | null;
  updatedAt: string;
}

/** Default form values — mirror the Prisma model defaults so the "Reset"
 *  button restores the same state a brand-new user would see. */
const DEFAULT_VALUES: NotificationPreferenceInput = {
  inAppEnabled: true,
  emailEnabled: false,
  smsEnabled: false,
  inAppSeverities: "L1,L2,L3",
  emailSeverities: "L2,L3",
  smsSeverities: "L3",
  quietHoursStart: null,
  quietHoursEnd: null,
  emailOverride: "",
  phoneOverride: "",
};

/** Severity catalog with colors (matches StatusBadge convention). */
const SEVERITIES = [
  { code: "L1", tone: "amber" as const, labelKey: "preferences.severityL1", shortKey: "preferences.severityL1Short" },
  { code: "L2", tone: "orange" as const, labelKey: "preferences.severityL2", shortKey: "preferences.severityL2Short" },
  { code: "L3", tone: "rose" as const, labelKey: "preferences.severityL3", shortKey: "preferences.severityL3Short" },
];

const TONE_BADGE: Record<"amber" | "orange" | "rose", string> = {
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  orange: "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30",
  rose: "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30",
};

const TONE_DOT: Record<"amber" | "orange" | "rose", string> = {
  amber: "bg-amber-500",
  orange: "bg-orange-500",
  rose: "bg-rose-500",
};

/** 24h hour options for the quiet-hours selects (00..23). */
const HOURS = Array.from({ length: 24 }, (_, i) => i);

/** Format an hour (0-23) as a 24h label "HH:00" (Latin or Arabic-Indic). */
function hourLabel(h: number, lang: Language): string {
  const s = `${String(h).padStart(2, "0")}:00`;
  return formatNumber(s, lang);
}

/** Parse a comma-separated severity string into a Set for O(1) lookups. */
function parseSeverities(s: string | null | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(s.split(",").map((x) => x.trim()).filter(Boolean));
}

/** Toggle a severity in a comma-separated string, preserving order L1,L2,L3. */
function toggleSeverity(current: string, sev: string): string {
  const set = parseSeverities(current);
  if (set.has(sev)) set.delete(sev);
  else set.add(sev);
  // Rejoin in canonical L1,L2,L3 order so the stored string is stable.
  return ["L1", "L2", "L3"].filter((s) => set.has(s)).join(",");
}

/* ────────────────────────────────────────────────────────────────────────
 * Main view
 * ──────────────────────────────────────────────────────────────────────── */

export function PreferencesView() {
  const t = useT();
  const dir = useDir();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const me = useFgmp((s) => s.me);

  const [loading, setLoading] = useState(true);

  // Phase 5 task 4 — drives the reset confirmation dialog.
  const [resetOpen, setResetOpen] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const form = useForm<NotificationPreferenceInput>({
    resolver: zodResolver(notificationPreferenceSchema),
    defaultValues: DEFAULT_VALUES,
    mode: "onChange",
  });

  const { reset, watch, handleSubmit, setValue, control, formState } = form;

  // Current values — used for derived UI state (card dimming, timeline).
  const values = watch();
  const quietHoursEnabled =
    values.quietHoursStart !== null && values.quietHoursEnd !== null;

  /* ── Load preferences on mount ─────────────────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setFetchError(null);
        const res = await fetch("/api/fgmp/preferences", { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: PreferenceRow = await res.json();
        if (cancelled) return;
        // Normalize nulls to empty strings for the form input values so
        // the Input components always see a string (RHF defaultValue=null
        // produces uncontrolled warnings).
        reset({
          inAppEnabled: data.inAppEnabled,
          emailEnabled: data.emailEnabled,
          smsEnabled: data.smsEnabled,
          inAppSeverities: data.inAppSeverities,
          emailSeverities: data.emailSeverities,
          smsSeverities: data.smsSeverities,
          quietHoursStart: data.quietHoursStart,
          quietHoursEnd: data.quietHoursEnd,
          emailOverride: data.emailOverride ?? "",
          phoneOverride: data.phoneOverride ?? "",
        });
      } catch (e) {
        if (!cancelled) setFetchError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reset]);

  /* ── Save handler ─────────────────────────────────────────────────── */
  const onSubmit = async (data: NotificationPreferenceInput) => {
    // Client-side integrity checks beyond the zod schema:
    // 1. Each enabled channel must have at least one severity selected.
    const channels: Array<[boolean, string, string]> = [
      [data.inAppEnabled, data.inAppSeverities, "preferences.inAppFull"],
      [data.emailEnabled, data.emailSeverities, "preferences.emailFull"],
      [data.smsEnabled, data.smsSeverities, "preferences.smsFull"],
    ];
    for (const [enabled, sevs, labelKey] of channels) {
      if (enabled && parseSeverities(sevs).size === 0) {
        toast.error(`${t(labelKey)}: ${t("preferences.atLeastOneSeverity")}`);
        return;
      }
    }
    // 2. Quiet hours start ≠ end (when enabled).
    if (
      data.quietHoursStart !== null &&
      data.quietHoursEnd !== null &&
      data.quietHoursStart === data.quietHoursEnd
    ) {
      toast.error(t("preferences.invalidTimeRange"));
      return;
    }

    try {
      setSaving(true);
      const res = await fetch("/api/fgmp/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const updated: PreferenceRow = await res.json();
      reset({
        inAppEnabled: updated.inAppEnabled,
        emailEnabled: updated.emailEnabled,
        smsEnabled: updated.smsEnabled,
        inAppSeverities: updated.inAppSeverities,
        emailSeverities: updated.emailSeverities,
        smsSeverities: updated.smsSeverities,
        quietHoursStart: updated.quietHoursStart,
        quietHoursEnd: updated.quietHoursEnd,
        emailOverride: updated.emailOverride ?? "",
        phoneOverride: updated.phoneOverride ?? "",
      });
      toast.success(t("preferences.saved"));
    } catch (e) {
      toast.error(`${t("preferences.saveError")} ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  /* ── Reset to defaults ────────────────────────────────────────────── */
  // Phase 5 task 4 — the reset is gated by a design-system dialog instead of
  // window.confirm. Split into ask/perform so the dialog can decide.
  const performReset = () => {
    reset(DEFAULT_VALUES);
    toast.success(t("preferences.resetDone"));
    setResetOpen(false);
  };

  /* ── Loading state ────────────────────────────────────────────────── */
  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full rounded-xl" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
        <Skeleton className="h-48 rounded-xl" />
        <p className="text-center text-sm text-muted-foreground">{t("preferences.loading")}</p>
      </div>
    );
  }

  /* ── Error state ──────────────────────────────────────────────────── */
  if (fetchError) {
    return (
      <div className="space-y-4">
        <SectionHeader
          title={t("preferences.title")}
          description={t("preferences.subtitle")}
          icon={<Bell className="h-5 w-5" />}
          tone="primary"
        />
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("preferences.fetchError")}</AlertTitle>
          <AlertDescription dir={dir === "rtl" ? "rtl" : undefined}>
            <span className="font-mono text-xs">{fetchError}</span>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  /* ── Derived summary state ────────────────────────────────────────── */
  const enabledChannelsCount = [
    values.inAppEnabled, values.emailEnabled, values.smsEnabled,
  ].filter(Boolean).length;

  const isDirty = formState.isDirty;

  /* ── Render ───────────────────────────────────────────────────────── */
  return (
    <>
    <form
      onSubmit={handleSubmit(onSubmit, () => {
        toast.error(t("preferences.saveError"));
      })}
      className="flex min-h-full flex-col gap-4 pb-24"
    >
      {/* Header */}
      <SectionHeader
        title={t("preferences.title")}
        description={t("preferences.subtitle")}
        icon={<Bell className="h-5 w-5" />}
        tone="primary"
        actions={
          <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex" dir={dir === "rtl" ? "rtl" : undefined}>
            <Check className="h-3.5 w-3.5 text-emerald-500" />
            <span>{t("preferences.astTimezone")}</span>
          </div>
        }
      />

      {/* Channel cards grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* ── In-App ────────────────────────────────────────────────── */}
        <ChannelCard
          icon={<Bell className="h-5 w-5" />}
          tone="emerald"
          title={t("preferences.inAppFull")}
          description={t("preferences.inAppDesc")}
          enabled={values.inAppEnabled}
          onToggle={(v) => setValue("inAppEnabled", v, { shouldDirty: true })}
          severities={values.inAppSeverities}
          onToggleSeverity={(sev) =>
            setValue("inAppSeverities", toggleSeverity(values.inAppSeverities, sev), { shouldDirty: true })
          }
          t={t}
          numLang={numLang}
        >
          <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground" dir={dir === "rtl" ? "rtl" : undefined}>
            <div className="flex items-center gap-1.5">
              {quietHoursEnabled ? (
                <>
                  <VolumeX className="h-3.5 w-3.5 text-amber-500" />
                  <span>{t("preferences.quietHours")}: {hourLabel(values.quietHoursStart ?? 0, numLang)} – {hourLabel(values.quietHoursEnd ?? 0, numLang)}</span>
                </>
              ) : (
                <>
                  <Volume2 className="h-3.5 w-3.5 text-emerald-500" />
                  <span>{t("preferences.noQuietHours")}</span>
                </>
              )}
            </div>
          </div>
        </ChannelCard>

        {/* ── Email ─────────────────────────────────────────────────── */}
        <ChannelCard
          icon={<Mail className="h-5 w-5" />}
          tone="violet"
          title={t("preferences.emailFull")}
          description={t("preferences.emailDesc")}
          enabled={values.emailEnabled}
          onToggle={(v) => setValue("emailEnabled", v, { shouldDirty: true })}
          severities={values.emailSeverities}
          onToggleSeverity={(sev) =>
            setValue("emailSeverities", toggleSeverity(values.emailSeverities, sev), { shouldDirty: true })
          }
          t={t}
          numLang={numLang}
        >
          <div className="space-y-1.5">
            <Label htmlFor="emailOverride" className="text-xs text-muted-foreground">
              {t("preferences.emailOverride")}
            </Label>
            <Input
              id="emailOverride"
              type="email"
              autoComplete="email"
              placeholder={me?.email ?? t("preferences.emailOverridePlaceholder")}
              value={values.emailOverride ?? ""}
              onChange={(e) => setValue("emailOverride", e.target.value, { shouldDirty: true })}
              className="h-9 text-sm"
              disabled={!values.emailEnabled}
            />
            <p className="text-[10px] text-muted-foreground" dir={dir === "rtl" ? "rtl" : undefined}>
              {t("preferences.emailOverridePlaceholder")}
            </p>
          </div>
        </ChannelCard>

        {/* ── SMS ───────────────────────────────────────────────────── */}
        <ChannelCard
          icon={<MessageSquare className="h-5 w-5" />}
          tone="amber"
          title={t("preferences.smsFull")}
          description={t("preferences.smsDesc")}
          enabled={values.smsEnabled}
          onToggle={(v) => setValue("smsEnabled", v, { shouldDirty: true })}
          severities={values.smsSeverities}
          onToggleSeverity={(sev) =>
            setValue("smsSeverities", toggleSeverity(values.smsSeverities, sev), { shouldDirty: true })
          }
          t={t}
          numLang={numLang}
        >
          <div className="space-y-1.5">
            <Label htmlFor="phoneOverride" className="text-xs text-muted-foreground">
              {t("preferences.phoneOverride")}
            </Label>
            <Input
              id="phoneOverride"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              placeholder={t("preferences.phoneOverridePlaceholder")}
              value={values.phoneOverride ?? ""}
              onChange={(e) => setValue("phoneOverride", e.target.value, { shouldDirty: true })}
              className="h-9 text-sm"
              disabled={!values.smsEnabled}
            />
            <p className="text-[10px] text-muted-foreground" dir={dir === "rtl" ? "rtl" : undefined}>
              {t("preferences.phoneOverridePlaceholder")}
            </p>
          </div>
        </ChannelCard>
      </div>

      {/* Quiet Hours card */}
      <Card>
        <CardHeader>
          <div className="flex flex-row items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-violet-500/10 p-2.5 text-violet-500 ring-1 ring-inset ring-border/50 dark:text-violet-400">
                <Moon className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">{t("preferences.quietHours")}</CardTitle>
                <CardDescription className="mt-0.5 text-xs" dir={dir === "rtl" ? "rtl" : undefined}>
                  {t("preferences.quietHoursDesc")}
                </CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="quietToggle" className="text-xs text-muted-foreground">
                {quietHoursEnabled ? t("preferences.enabled") : t("preferences.disabled")}
              </Label>
              <Switch
                id="quietToggle"
                checked={quietHoursEnabled}
                onCheckedChange={(v) => {
                  if (v) {
                    // Default to 22:00 → 06:00 (a typical NOC overnight window).
                    setValue("quietHoursStart", 22, { shouldDirty: true });
                    setValue("quietHoursEnd", 6, { shouldDirty: true });
                  } else {
                    setValue("quietHoursStart", null, { shouldDirty: true });
                    setValue("quietHoursEnd", null, { shouldDirty: true });
                  }
                }}
              />
            </div>
          </div>
        </CardHeader>
        {/* The two Selects inside are genuinely `disabled` when quiet hours
            are off — that is the accessible state. Dimming their labels on top
            of it only made them unreadable. */}
        <CardContent className="space-y-4">
          {/* Start / End selectors */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                {t("preferences.start")}
              </Label>
              <Controller
                control={control}
                name="quietHoursStart"
                render={({ field }) => (
                  <Select label={t("preferences.quietFrom")}
                    value={field.value !== null ? String(field.value) : undefined}
                    onValueChange={(v) => field.onChange(Number(v))}
                    disabled={!quietHoursEnabled}
                  >
                    <SelectTrigger className="h-9 w-full text-sm">
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      {HOURS.map((h) => (
                        <SelectItem key={h} value={String(h)}>
                          {hourLabel(h, numLang)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                {t("preferences.end")}
              </Label>
              <Controller
                control={control}
                name="quietHoursEnd"
                render={({ field }) => (
                  <Select label={t("preferences.quietTo")}
                    value={field.value !== null ? String(field.value) : undefined}
                    onValueChange={(v) => field.onChange(Number(v))}
                    disabled={!quietHoursEnabled}
                  >
                    <SelectTrigger className="h-9 w-full text-sm">
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      {HOURS.map((h) => (
                        <SelectItem key={h} value={String(h)}>
                          {hourLabel(h, numLang)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          {/* 24h timeline bar */}
          <QuietHoursTimeline
            start={values.quietHoursStart}
            end={values.quietHoursEnd}
            numLang={numLang}
            t={t}
          />

          <Separator />

          <div className="flex items-start gap-2 text-xs text-muted-foreground" dir={dir === "rtl" ? "rtl" : undefined}>
            <Volume2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
            <span>{t("preferences.criticalAlarmsAlways")}</span>
          </div>

          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground" dir={dir === "rtl" ? "rtl" : undefined}>
            <Clock className="h-3 w-3" />
            <span>{t("preferences.timezone")}</span>
          </div>
        </CardContent>
      </Card>

      {/* Summary card */}
      <Card className="bg-muted/30">
        <CardContent className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" dir={dir === "rtl" ? "rtl" : undefined}>
            <span className="font-medium text-foreground">{t("preferences.summary")}</span>
            <span className="flex items-center gap-1">
              <Bell className="h-3 w-3 text-emerald-500" />
              {formatNumber(enabledChannelsCount, numLang)} {t("preferences.summaryChannels")}
            </span>
            {quietHoursEnabled ? (
              <span className="flex items-center gap-1">
                <Moon className="h-3 w-3 text-violet-500" />
                {t("preferences.summaryQuietHours")
                  .replace("{start}", hourLabel(values.quietHoursStart ?? 0, numLang))
                  .replace("{end}", hourLabel(values.quietHoursEnd ?? 0, numLang))}
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <Moon className="h-3 w-3 text-muted-foreground" />
                {t("preferences.noQuietHours")}
              </span>
            )}
          </div>
          {isDirty && (
            <span className="flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400" dir={dir === "rtl" ? "rtl" : undefined}>
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
              {t("preferences.save")}
            </span>
          )}
        </CardContent>
      </Card>

      {/* Sticky bottom action bar */}
      <div className="sticky bottom-0 z-30 -mx-3 border-t bg-background/95 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-5 sm:px-5">
        <div className="mx-auto flex max-w-[1600px] items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setResetOpen(true)}
            disabled={saving}
            className="gap-1.5"
          >
            <RotateCcw className="h-4 w-4" />
            <span dir={dir === "rtl" ? "rtl" : undefined}>{t("preferences.reset")}</span>
          </Button>
          <Button
            type="submit"
            disabled={saving || !isDirty}
            className="gap-1.5"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            <span dir={dir === "rtl" ? "rtl" : undefined}>
              {saving ? t("preferences.saving") : t("preferences.save")}
            </span>
            {!isDirty && !saving && <Check className="h-3.5 w-3.5 text-emerald-400" />}
          </Button>
        </div>
      </div>
    </form>

    {/* Phase 5 task 4 — replaces window.confirm for the reset action. Sibling
        of the form so it is not nested inside it and cannot inherit submit
        semantics from it. */}
    <ConfirmDestructive
      target={
        resetOpen
          ? {
              title: t("confirm.resetTitle"),
              description: t("preferences.resetConfirm"),
              cancelLabel: t("confirm.cancel"),
              confirmLabel: t("preferences.reset"),
            }
          : null
      }
      onCancel={() => setResetOpen(false)}
      onConfirm={performReset}
    />
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * ChannelCard — reusable card for the In-App / Email / SMS channels
 * ──────────────────────────────────────────────────────────────────────── */

interface ChannelCardProps {
  icon: React.ReactNode;
  tone: "emerald" | "violet" | "amber";
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  severities: string;
  onToggleSeverity: (sev: string) => void;
  t: (key: string) => string;
  numLang: Language;
  children?: React.ReactNode;
}

const TONE_ICON_BG: Record<ChannelCardProps["tone"], string> = {
  emerald: "bg-emerald-500/10 text-emerald-500 dark:text-emerald-400",
  violet: "bg-violet-500/10 text-violet-500 dark:text-violet-400",
  amber: "bg-amber-500/10 text-amber-500 dark:text-amber-400",
};

function ChannelCard({
  icon, tone, title, description, enabled, onToggle,
  severities, onToggleSeverity, t, children,
}: ChannelCardProps) {
  const dir = useDir();
  const selected = parseSeverities(severities);
  return (
    // NOT opacity-50: dimming a whole card halves the contrast of every label
    // in it, and axe reports them (the labels are not the disabled control, so
    // WCAG's inactive-component exemption does not cover them). A dashed border
    // plus the "Disabled" label beside the switch carry the same state at full
    // contrast.
    <Card className={cn("flex flex-col", !enabled && "border-dashed")}>
      <CardHeader>
        <div className="flex flex-row items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className={cn("rounded-xl p-2.5 ring-1 ring-inset ring-border/50", TONE_ICON_BG[tone])}>
              {icon}
            </div>
            <div>
              <CardTitle className="text-base">{title}</CardTitle>
              <CardDescription className="mt-0.5 text-xs" dir={dir === "rtl" ? "rtl" : undefined}>
                {description}
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {enabled ? t("preferences.enabled") : t("preferences.disabled")}
            </span>
            {/* A switch is a checkbox with no text of its own: the visible
                title lives in a sibling CardTitle and is not associated with
                it, so without this the control is announced as "switch, on"
                with no indication of WHICH channel it enables. */}
            <Switch
              checked={enabled}
              onCheckedChange={onToggle}
              aria-label={`${title} — ${t("preferences.channelEnabled")}`}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {/* Severity filter */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground" dir={dir === "rtl" ? "rtl" : undefined}>
            {t("preferences.severityFilter")}
          </Label>
          <div className="grid grid-cols-3 gap-2">
            {SEVERITIES.map((sev) => {
              const checked = selected.has(sev.code);
              return (
                <label
                  key={sev.code}
                  className={cn(
                    "flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border p-2 transition-colors",
                    checked
                      ? "border-border bg-muted/50"
                      : "border-border/60 hover:bg-muted/30",
                    !enabled && "pointer-events-none",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => onToggleSeverity(sev.code)}
                      disabled={!enabled}
                    />
                    <Badge
                      variant="outline"
                      className={cn("h-5 px-1.5 text-[10px] font-medium", TONE_BADGE[sev.tone])}
                    >
                      <span className={cn("mr-1 inline-block h-1.5 w-1.5 rounded-full", TONE_DOT[sev.tone])} />
                      {t(sev.shortKey)}
                    </Badge>
                  </div>
                  <span className="text-center text-[10px] leading-tight text-muted-foreground" dir={dir === "rtl" ? "rtl" : undefined}>
                    {t(sev.labelKey).replace(/^[Ll][123]\s*[—\-:]\s*/, "")}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Channel-specific extra content (override inputs, quiet-hours hint) */}
        {children && <div className="mt-auto">{children}</div>}
      </CardContent>
    </Card>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * QuietHoursTimeline — 24h horizontal bar with the quiet period highlighted
 * ──────────────────────────────────────────────────────────────────────── */

interface QuietHoursTimelineProps {
  start: number | null;
  end: number | null;
  numLang: Language;
  t: (key: string) => string;
}

function QuietHoursTimeline({ start, end, numLang, t }: QuietHoursTimelineProps) {
  const dir = useDir();
  const enabled = start !== null && end !== null;

  // Compute which hours (0..23) are inside the quiet window. If start > end
  // (e.g. 22 → 6) the window wraps past midnight.
  const inWindow = useMemo(() => {
    const set = new Set<number>();
    if (!enabled || start === null || end === null) return set;
    if (start === end) {
      // Same hour → treat as "all day"
      for (let i = 0; i < 24; i++) set.add(i);
      return set;
    }
    let h = start;
    while (h !== end) {
      set.add(h);
      h = (h + 1) % 24;
    }
    return set;
  }, [start, end, enabled]);

  // Tick labels every 6 hours: 0, 6, 12, 18, 24
  const ticks = [0, 6, 12, 18, 24];

  const allDay = enabled && start === end;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground" dir={dir === "rtl" ? "rtl" : undefined}>
        <span>{hourLabel(0, numLang)}</span>
        <span>
          {enabled
            ? `${hourLabel(start ?? 0, numLang)} → ${hourLabel(end ?? 0, numLang)}`
            : t("preferences.noQuietHours")}
        </span>
        <span>{hourLabel(24, numLang)}</span>
      </div>
      {/* 24-segment bar — forced LTR so the timeline reads left-to-right regardless of UI language */}
      <div className="flex h-6 w-full overflow-hidden rounded-md border bg-muted/30" dir="ltr">
        {Array.from({ length: 24 }, (_, h) => {
          const active = inWindow.has(h);
          return (
            <div
              key={h}
              className={cn(
                "flex-1 border-r border-background last:border-r-0 transition-colors",
                active
                  ? "bg-violet-500/40 dark:bg-violet-500/30"
                  : "bg-emerald-500/10 dark:bg-emerald-500/5",
              )}
              title={`${hourLabel(h, numLang)}`}
            />
          );
        })}
      </div>
      {/* Tick labels */}
      <div className="relative h-3 text-[10px] text-muted-foreground" dir="ltr">
        {ticks.map((tick) => (
          <span
            key={tick}
            className="absolute -translate-x-1/2 tabular-nums"
            style={{ left: `${(tick / 24) * 100}%` }}
          >
            {formatNumber(String(tick).padStart(2, "0"), numLang)}
          </span>
        ))}
      </div>
      {allDay && (
        <p className="text-center text-[10px] text-muted-foreground" dir={dir === "rtl" ? "rtl" : undefined}>
          {t("preferences.allDay")}
        </p>
      )}
    </div>
  );
}
