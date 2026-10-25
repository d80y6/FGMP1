"use client";

/**
 * System Settings view (Task 35-E)
 * ────────────────────────────────────────────────────────────────────────────
 * Global platform configuration panel. ADMIN-only. Four sections organized as
 * Tabs:
 *
 *   1. Alarm Thresholds   (category=ALARM)
 *        fuelLowPct (%), fuelCriticalPct (%), genTempMax (°C),
 *        battVoltageMin (V), commLossMin (minutes)
 *
 *   2. Escalation Timers  (category=ESCALATION)
 *        l1ToL2Min, l2ToL3Min, autoResolveMin (minutes)
 *
 *   3. Branding           (category=BRANDING)
 *        platformName, primaryColor (color picker), logoUrl
 *
 *   4. Platform           (category=PLATFORM)
 *        maxSitesPerTenant, sessionTimeoutMin (numbers),
 *        enableRealtime, enableOta (toggles)
 *
 * Each section:
 *   - Loads its settings via useApi("/api/fgmp/settings?category=<X>").
 *   - Renders number/text inputs with a Save button (sends a batch PATCH).
 *   - Has a "Reset to Defaults" button that overwrites the section's values
 *     with the API's default catalog.
 *
 * The API auto-upserts defaults on first GET, so the UI always sees a
 * complete payload. Saves are optimistic-local then confirmed by refetch.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Settings, Bell, Timer, Palette, Server, Save, RotateCcw, Loader2,
  ShieldAlert, AlertCircle, CheckCircle2,
} from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi, apiPatch } from "@/lib/fgmp/use-api";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { cn } from "@/lib/utils";

/* ────────────────────────────────────────────────────────────────────────
 * Types & constants
 * ──────────────────────────────────────────────────────────────────────── */

type Category = "ALARM" | "ESCALATION" | "BRANDING" | "PLATFORM";

interface SettingEntry {
  value: unknown;
  type: string;
  category: string;
  updatedAt: string;
}

type SettingMap = Record<string, SettingEntry>;

/** Field descriptors — drive rendering + validation per setting key. */
interface FieldDef {
  key: string;
  label: string;
  hint?: string;
  unit?: string;
  min?: number;
  max?: number;
  /** For string fields, an optional HTML input type override (color, url). */
  inputType?: "text" | "number" | "color" | "url";
  default: string;
}

const FIELDS: Record<Category, FieldDef[]> = {
  ALARM: [
    { key: "fuelLowPct",      label: "Fuel Low Threshold",        unit: "%",      min: 0, max: 100, inputType: "number", default: "25",  hint: "Raise an L1 alarm when tank level drops below this % of capacity." },
    { key: "fuelCriticalPct", label: "Fuel Critical Threshold",  unit: "%",      min: 0, max: 100, inputType: "number", default: "10",  hint: "Raise an L2/L3 alarm when tank level drops below this %." },
    { key: "genTempMax",      label: "Generator Max Temperature", unit: "°C",     min: 50, max: 150, inputType: "number", default: "95",  hint: "GEN_OVERHEAT alarm threshold (coolant temperature)." },
    { key: "battVoltageMin",  label: "Battery Min Voltage",      unit: "V",      min: 0, max: 100, inputType: "number", default: "46",  hint: "BATT_LOW_VOLTAGE alarm threshold." },
    { key: "commLossMin",     label: "Comm Loss Timeout",        unit: "min",    min: 1, max: 1440, inputType: "number", default: "10",  hint: "Raise COMM_LOSS after this many minutes without telemetry." },
  ],
  ESCALATION: [
    { key: "l1ToL2Min",      label: "L1 → L2 Escalation",  unit: "min", min: 1, max: 1440, inputType: "number", default: "15",   hint: "Promote an open L1 alarm to L2 after this many minutes." },
    { key: "l2ToL3Min",      label: "L2 → L3 Escalation",  unit: "min", min: 1, max: 1440, inputType: "number", default: "60",   hint: "Promote an L2 alarm to L3 (critical) after this many minutes." },
    { key: "autoResolveMin", label: "Auto-Resolve Timeout", unit: "min", min: 5, max: 10080, inputType: "number", default: "1440", hint: "Auto-resolve acknowledged alarms after this many minutes (default 24h)." },
  ],
  BRANDING: [
    { key: "platformName", label: "Platform Name",   inputType: "text", default: "FGMP — Fuel & Generator Monitoring Platform", hint: "Displayed in the header, browser title, and email footers." },
    { key: "primaryColor", label: "Primary Color",   inputType: "color", default: "#10b981", hint: "Hex color for the primary accent (buttons, active states)." },
    { key: "logoUrl",      label: "Logo URL",        inputType: "url",  default: "/logo.svg", hint: "Absolute or relative URL to the platform logo asset." },
  ],
  PLATFORM: [
    { key: "maxSitesPerTenant", label: "Max Sites per Tenant", unit: "",  min: 1, max: 100000, inputType: "number", default: "200", hint: "Hard cap on the number of sites a single tenant may own." },
    { key: "sessionTimeoutMin", label: "Session Timeout",      unit: "min", min: 1, max: 1440, inputType: "number", default: "60",  hint: "Idle session timeout (JWT refresh window)." },
    { key: "enableRealtime",    label: "Realtime Telemetry",   inputType: "text", default: "true", hint: "Stream live telemetry updates via WebSocket to connected clients." },
    { key: "enableOta",         label: "OTA Firmware Updates", inputType: "text", default: "true", hint: "Allow OTA firmware update commands to ESP / IoT devices." },
  ],
};

/** Category metadata for the Tabs + KPI strip. */
const CATEGORY_META: Record<Category, { label: string; description: string; icon: typeof Bell; tone: "amber" | "rose" | "violet" | "emerald" }> = {
  ALARM:      { label: "Alarm Thresholds",  description: "Trigger thresholds for telemetry-driven alarms.",                 icon: Bell,    tone: "amber"   },
  ESCALATION: { label: "Escalation Timers", description: "Auto-promotion and auto-resolve timers for open alarms.",         icon: Timer,   tone: "rose"    },
  BRANDING:   { label: "Branding",          description: "Platform name, primary accent color, and logo asset URL.",         icon: Palette, tone: "violet"  },
  PLATFORM:   { label: "Platform",          description: "Tenant limits, session policy, and global feature toggles.",        icon: Server,  tone: "emerald" },
};

/* ────────────────────────────────────────────────────────────────────────
 * Main view
 * ──────────────────────────────────────────────────────────────────────── */

export function SystemSettingsView() {
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const me = useFgmp((s) => s.me);
  const [activeTab, setActiveTab] = useState<Category>("ALARM");

  // Total setting count across all categories — drives the KPI strip.
  // (Declared before the access-control early return so hook order is stable.)
  const totalSettings = useMemo(
    () => Object.values(FIELDS).reduce((acc, fs) => acc + fs.length, 0),
    [],
  );

  // Access control — the rbac matrix only grants these views to ADMIN (via
  // the "*" wildcard). Non-admins who somehow navigate here get a clean
  // 403-style banner instead of a noisy page.
  if (me && me.role !== "ADMIN") {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>{t("common.accessDenied")}</AlertTitle>
          <AlertDescription>{t("settings.adminOnly")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.system-settings")}
        description={t("desc.system-settings")}
        icon={<Settings className="h-5 w-5" />}
        tone="primary"
      />

      {/* KPI strip — quick counts for orientation */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label={t("settings.categories")}      value={formatNumber(4, numLang)}                        icon={<Settings className="h-4 w-4" />} />
        <KpiCard label={t("settings.totalSettings")}  value={formatNumber(totalSettings, numLang)}            icon={<Server className="h-4 w-4" />} />
        <KpiCard label={t("settings.alarmThresholds")} value={formatNumber(FIELDS.ALARM.length, numLang)}     icon={<Bell className="h-4 w-4" />} tone="warn" />
        <KpiCard label={t("settings.platformToggles")} value={formatNumber(FIELDS.PLATFORM.length, numLang)}  icon={<Server className="h-4 w-4" />} tone="good" />
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Category)}>
        <TabsList className="w-full justify-start overflow-x-auto">
          {(Object.keys(CATEGORY_META) as Category[]).map((cat) => {
            const meta = CATEGORY_META[cat];
            const Icon = meta.icon;
            return (
              <TabsTrigger key={cat} value={cat} className="gap-1.5">
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{meta.label}</span>
                <span className="sm:hidden">{meta.label.split(" ")[0]}</span>
              </TabsTrigger>
            );
          })}
        </TabsList>

        {(Object.keys(CATEGORY_META) as Category[]).map((cat) => (
          <TabsContent key={cat} value={cat}>
            <SettingsSection category={cat} numLang={numLang} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Settings section — one per tab
 * ──────────────────────────────────────────────────────────────────────── */

function SettingsSection({ category, numLang }: { category: Category; numLang: Language }) {
  const meta = CATEGORY_META[category];
  const t = useT();
  const fields = FIELDS[category];
  const Icon = meta.icon;

  const { data, loading, error, refetch } = useApi<SettingMap>(
    `/api/fgmp/settings?category=${category}`,
  );

  // Local editable copy — initialized from server data, updated on user
  // input, and reset when the server data changes (refetch after save).
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const f of fields) {
      const entry = data[f.key];
      if (!entry) continue;
      // Booleans render as "true"/"false" strings for the Switch component's
      // checked state. Numbers and strings are stringified as-is.
      next[f.key] = String(entry.value);
    }
    setDraft(next);
  }, [data, fields]);

  /** Has the user edited any field since the last load? */
  const isDirty = useMemo(() => {
    if (!data) return false;
    for (const f of fields) {
      const server = String(data[f.key]?.value ?? "");
      const local = String(draft[f.key] ?? "");
      if (server !== local) return true;
    }
    return false;
  }, [data, draft, fields]);

  const handleSave = useCallback(async () => {
    if (!data) return;
    // Build a batch of changed settings only — fewer DB writes + audit noise.
    const changes: Array<{ key: string; value: string | number | boolean }> = [];
    for (const f of fields) {
      const server = String(data[f.key]?.value ?? "");
      const local = String(draft[f.key] ?? "");
      if (server === local) continue;
      // Coerce value to the field's expected type so the API can store it
      // back to the right column type.
      if (f.inputType === "number") {
        const n = Number(local);
        if (!isFinite(n)) {
          toast.error(`${f.label}: invalid number`);
          return;
        }
        if (f.min !== undefined && n < f.min) {
          toast.error(`${f.label}: must be ≥ ${formatNumber(f.min, numLang)}`);
          return;
        }
        if (f.max !== undefined && n > f.max) {
          toast.error(`${f.label}: must be ≤ ${formatNumber(f.max, numLang)}`);
          return;
        }
        changes.push({ key: f.key, value: n });
      } else if (data[f.key]?.type === "boolean") {
        changes.push({ key: f.key, value: local === "true" });
      } else {
        changes.push({ key: f.key, value: local });
      }
    }
    if (changes.length === 0) {
      toast.info("No changes to save");
      return;
    }

    setSaving(true);
    try {
      const res = await apiPatch("/api/fgmp/settings", { settings: changes });
      if (res.ok) {
        toast.success(`Saved ${formatNumber(changes.length, numLang)} setting${changes.length === 1 ? "" : "s"}`);
        refetch();
      } else {
        toast.error(res.error ?? "Save failed");
      }
    } finally {
      setSaving(false);
    }
  }, [data, draft, fields, numLang, refetch]);

  const handleResetDefaults = useCallback(async () => {
    setSaving(true);
    try {
      // Reset = overwrite every field in this category with its catalog default.
      const settings = fields.map((f) => {
        if (f.inputType === "number") {
          return { key: f.key, value: Number(f.default) };
        }
        if (f.key === "enableRealtime" || f.key === "enableOta") {
          return { key: f.key, value: f.default === "true" };
        }
        return { key: f.key, value: f.default };
      });
      const res = await apiPatch("/api/fgmp/settings", { settings });
      if (res.ok) {
        toast.success(`Reset ${meta.label} to defaults`);
        refetch();
      } else {
        toast.error(res.error ?? "Reset failed");
      }
    } finally {
      setSaving(false);
    }
  }, [fields, meta.label, refetch]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className={cn(
              "rounded-xl p-2.5 ring-1 ring-inset ring-border/50",
              meta.tone === "amber"   && "bg-amber-500/10 text-amber-500 dark:text-amber-400",
              meta.tone === "rose"    && "bg-rose-500/10 text-rose-500 dark:text-rose-400",
              meta.tone === "violet"  && "bg-violet-500/10 text-violet-500 dark:text-violet-400",
              meta.tone === "emerald" && "bg-emerald-500/10 text-emerald-500 dark:text-emerald-400",
            )}>
              <Icon className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">{meta.label}</CardTitle>
              <CardDescription className="text-xs">{meta.description}</CardDescription>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isDirty && (
              <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 text-[10px]">
                {t("settings.unsavedChanges")}
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleResetDefaults}
              disabled={loading || saving}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("rules.resetToDefaults")}</span>
              <span className="sm:hidden">Reset</span>
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!isDirty || saving || loading}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {t("systemSettings.saveChanges")}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{t("settings.loadFailed")}</AlertTitle>
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        )}

        {loading && !data ? (
          <div className="space-y-3">
            {fields.map((f) => (
              <div key={f.key} className="grid grid-cols-1 gap-2 sm:grid-cols-[200px_1fr] sm:items-center">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-9 w-full max-w-md" />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {fields.map((f) => (
              <FieldRow
                key={f.key}
                field={f}
                value={draft[f.key] ?? ""}
                onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                numLang={numLang}
                updatedAt={data?.[f.key]?.updatedAt}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Single field row
 * ──────────────────────────────────────────────────────────────────────── */

function FieldRow({
  field,
  value,
  onChange,
  numLang,
  updatedAt,
}: {
  field: FieldDef;
  value: string;
  onChange: (v: string) => void;
  numLang: Language;
  updatedAt?: string;
}) {
  const isBoolean = field.key === "enableRealtime" || field.key === "enableOta";
  const isColor = field.inputType === "color";
  const isNumber = field.inputType === "number";

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[220px_1fr] sm:items-start">
      <div className="space-y-0.5 pt-1.5">
        <Label htmlFor={`setting-${field.key}`} className="text-xs font-medium">
          {field.label}
        </Label>
        {field.hint && (
          <p className="text-[10px] leading-tight text-muted-foreground">{field.hint}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {isBoolean ? (
          <div className="flex items-center gap-3">
            <Switch
              id={`setting-${field.key}`}
              checked={value === "true"}
              onCheckedChange={(c) => onChange(c ? "true" : "false")}
            />
            <Badge
              variant="outline"
              className={cn(
                "text-[10px]",
                value === "true"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-400",
              )}
            >
              {value === "true" ? (
                <><CheckCircle2 className="mr-1 h-3 w-3" />Enabled</>
              ) : (
                "Disabled"
              )}
            </Badge>
          </div>
        ) : isColor ? (
          <div className="flex items-center gap-2">
            <input
              type="color"
              id={`setting-${field.key}`}
              value={value || "#10b981"}
              onChange={(e) => onChange(e.target.value)}
              className="h-9 w-14 cursor-pointer rounded-md border border-input bg-transparent p-1"
              aria-label={field.label}
            />
            <Input
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              dir="ltr"
              className="h-9 w-32 font-mono text-xs"
              placeholder="#10b981"
            />
            <div
              className="h-9 w-9 rounded-md border border-input"
              style={{ backgroundColor: value || "#10b981" }}
              aria-hidden
            />
          </div>
        ) : isNumber ? (
          <div className="flex items-center gap-2">
            <Input
              type="number"
              id={`setting-${field.key}`}
              value={value}
              min={field.min}
              max={field.max}
              onChange={(e) => onChange(e.target.value)}
              dir="ltr"
              className="h-9 w-32"
            />
            {field.unit && (
              <span className="text-xs text-muted-foreground">{field.unit}</span>
            )}
          </div>
        ) : (
          <Input
            type={field.inputType === "url" ? "url" : "text"}
            id={`setting-${field.key}`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            dir="ltr"
            className={cn("h-9 w-full max-w-md", field.key === "platformName" && "max-w-lg")}
          />
        )}
        {updatedAt && (
          <span className="text-[10px] text-muted-foreground" title={updatedAt}>
            updated {formatNumber(new Date(updatedAt).toLocaleDateString("en-GB"), numLang)}
          </span>
        )}
      </div>
    </div>
  );
}
