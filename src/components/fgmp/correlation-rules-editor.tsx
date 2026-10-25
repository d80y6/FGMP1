"use client";

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ShieldAlert,
  Plus,
  Edit3,
  Trash2,
  Power,
  RotateCcw,
  AlertTriangle,
  CheckCircle2,
  List,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDestructive } from "@/components/fgmp/confirm-destructive";
import { cn } from "@/lib/utils";
import { useFgmp } from "@/lib/fgmp/store";
import {
  useCorrelationRules,
  useCorrelationRulesList,
  type CorrelationRule,
} from "@/lib/fgmp/use-correlation-rules-server";
import type {
  RuleAlarmTypeValue as AlarmType,
  CorrelationSeverity as Severity,
  CorrelationRuleScope as RuleScope,
} from "@/lib/fgmp/correlation-types";
import { useCorrelationMatches } from "@/lib/fgmp/use-correlation-matches";
import { useT } from "@/lib/fgmp/use-language";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const ALARM_TYPES: AlarmType[] = [
  "FUEL_THEFT",
  "FUEL_REFILL",
  "FUEL_LOW",
  "FUEL_CRITICAL",
  "GEN_OFFLINE",
  "GEN_FAILURE",
  "GEN_OVERHEAT",
  "BATT_LOW_VOLTAGE",
  "BATT_FAILURE",
  "COMM_LOSS",
  "ANY",
];

const SEVERITIES: Severity[] = ["L1", "L2", "L3"];
const SCOPES: RuleScope[] = ["SITE", "REGION", "GOVERNORATE", "NATIONAL"];

/**
 * Role gating:
 *   - ADMIN           → full CRUD (can create, edit, delete, toggle, reset)
 *   - REGIONAL_MANAGER → view + toggle enabled/disabled only (acts as the
 *                        "supervisor" role described in the task spec — the
 *                        FGMP Role enum has no SUPERVISOR literal, so this is
 *                        the closest supervisor-equivalent in the existing
 *                        role taxonomy).
 *   - All other roles → dialog hidden at the trigger-button level (handled
 *                        in alarms-view.tsx). Defensively, we also hide all
 *                        edit controls here.
 */
function useRulePermissions(): { canEdit: boolean; canToggle: boolean; canView: boolean } {
  const me = useFgmp((s) => s.me);
  const role = me?.role ?? "READONLY";
  return {
    canView: role === "ADMIN" || role === "REGIONAL_MANAGER",
    canEdit: role === "ADMIN",
    canToggle: role === "ADMIN" || role === "REGIONAL_MANAGER",
  };
}

const ALARM_TYPE_TONE: Record<string, string> = {
  FUEL_THEFT: "text-rose-700 dark:text-rose-400",
  FUEL_REFILL: "text-emerald-700 dark:text-emerald-400",
  FUEL_LOW: "text-amber-700 dark:text-amber-400",
  FUEL_CRITICAL: "text-rose-700 dark:text-rose-400",
  GEN_OFFLINE: "text-amber-700 dark:text-amber-400",
  GEN_FAILURE: "text-rose-700 dark:text-rose-400",
  GEN_OVERHEAT: "text-orange-700 dark:text-orange-400",
  BATT_LOW_VOLTAGE: "text-amber-700 dark:text-amber-400",
  BATT_FAILURE: "text-rose-700 dark:text-rose-400",
  COMM_LOSS: "text-violet-700 dark:text-violet-400",
  ANY: "text-slate-600 dark:text-slate-400",
};

function AlarmTypeSpan({ value }: { value: AlarmType }) {
  const t = useT();
  return (
    <span className={cn("font-mono font-semibold", ALARM_TYPE_TONE[value] ?? "text-foreground")}>
      {value === "ANY" ? t("rules.anyLabel") : value.replace(/_/g, " ")}
    </span>
  );
}

function SeveritySpan({ value }: { value: Severity }) {
  const tone =
    value === "L3"
      ? "text-rose-700 dark:text-rose-400"
      : value === "L2"
        ? "text-amber-700 dark:text-amber-400"
        : "text-sky-700 dark:text-sky-400";
  return <span className={cn("font-mono font-semibold", tone)}>{value}</span>;
}

function ScopeSpan({ value }: { value: RuleScope }) {
  return <span className="font-mono font-semibold text-violet-700 dark:text-violet-400">{value}</span>;
}

/** Format the trigger condition with color-coded parts. */
function TriggerCondition({ rule }: { rule: CorrelationRule }) {
  // Module-scope component: the hook has to be called here, not inherited.
  const t = useT();
  return (
    <code className="block rounded bg-muted/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed">
      <span className="font-semibold text-amber-700 dark:text-amber-400">{rule.threshold}+</span>{" "}
      <AlarmTypeSpan value={rule.alarmType} /> {t("rules.summaryIn")} <ScopeSpan value={rule.scope} /> {t("rules.summaryWithin")}{" "}
      <span className="font-semibold text-amber-700 dark:text-amber-400">{rule.windowMinutes}min</span>{" "}
      → <SeveritySpan value={rule.escalateTo} />
    </code>
  );
}

/** "TRIGGERED" badge with a pulsing dot. */
function TriggeredBadge() {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-rose-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
      </span>
      {t("rules.triggeredBadge")}
    </span>
  );
}

export function CorrelationRulesEditor({ open, onOpenChange }: Props) {
  const t = useT();

  const rules = useCorrelationRulesList();
  const { canView } = useRulePermissions();
  // Phase 2: the counts used to come from `evaluateAllRules(rules, alarms,
  // sites)` running in this browser — so "triggered" meant "would fire, per my
  // local copy of the alarms". They now come from matches the server evaluated
  // and persisted, which is the only figure that reflects what the platform
  // actually acted on, so this component no longer fetches alarms at all.
  //
  // It did, on an 8-second interval, into state nothing read: an authenticated
  // request every 8 seconds per operator, forever, for data discarded on
  // arrival. Evaluation is triggered from the server side (see
  // useTriggerEvaluation in the panel header), so the feed was pure cost.
  const { matches: serverMatches } = useCorrelationMatches(0, open);

  const triggeredCount = useMemo(
    () => new Set(serverMatches.map((m) => m.ruleId)).size,
    [serverMatches],
  );
  const disabledCount = useMemo(
    () => rules.filter((r) => !r.enabled).length,
    [rules],
  );
  // "Idle" is now derived from authored rules minus those that have fired,
  // rather than from a local evaluation of every rule.
  const enabledRuleCount = useMemo(() => rules.filter((r) => r.enabled).length, [rules]);
  const firedRuleIds = useMemo(
    () => new Set(serverMatches.map((m) => m.ruleId)),
    [serverMatches],
  );
  // Newest match per rule. serverMatches is ordered evaluatedAt DESC, so the
  // first entry seen for a rule id is its most recent one.
  const matchByRuleId = useMemo(() => {
    const m = new Map<string, { scopeLabel: string; matchCount: number }>();
    for (const match of serverMatches) {
      if (!m.has(match.ruleId)) {
        m.set(match.ruleId, {
          scopeLabel: match.scopeLabel,
          matchCount: match.matchCount,
        });
      }
    }
    return m;
  }, [serverMatches]);
  const idleCount = Math.max(0, enabledRuleCount - triggeredCount);

  if (!canView) {
    // Defensive: the trigger button is also gated, but if the dialog opens
    // for a role without access (e.g. role switched while dialog open), show
    // a clean "no access" state instead of leaking controls.
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-rose-500" />
              {t("rules.title")}
            </DialogTitle>
            <DialogDescription>
              {t("rules.noPermission")}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl gap-0 p-0">
        <DialogHeader className="border-b p-4 pb-3">
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-violet-500" />
            {t("rules.alarmCorrelationRules")}
            <span className="ml-1 inline-flex items-center gap-1.5 rounded-full border bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              <span className="tabular-nums">{rules.length} {t("rules.rulesCount")}</span>
              <span className="text-rose-500">·</span>
              <span className="tabular-nums text-rose-500">{triggeredCount} {t("rules.triggered")}</span>
              <span className="text-muted-foreground/60">·</span>
              <span className="tabular-nums">{idleCount} {t("rules.idle")}</span>
              {disabledCount > 0 && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <span className="tabular-nums text-muted-foreground">{disabledCount} {t("rules.off")}</span>
                </>
              )}
            </span>
          </DialogTitle>
          <DialogDescription>
            {t("rules.description")}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="active" className="flex min-h-0 flex-1 flex-col">
          <div className="border-b px-4 pt-3">
            <TabsList className="h-9">
              <TabsTrigger value="active" className="text-xs">
                <List className="mr-1.5 h-3.5 w-3.5" />
                {t("rules.activeRules")}
                {triggeredCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="ml-1.5 h-4 bg-rose-500/20 px-1 text-[9px] text-rose-700 dark:text-rose-400"
                  >
                    {triggeredCount}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="editor" className="text-xs">
                <Edit3 className="mr-1.5 h-3.5 w-3.5" />
                {t("rules.editor")}
              </TabsTrigger>
            </TabsList>
          </div>

          <ScrollArea className="max-h-[calc(80vh-9rem)] flex-1">
            <TabsContent value="active" className="m-0 p-4">
              <ActiveRulesTab
                rules={rules}
                firedRuleIds={firedRuleIds}
                matchByRuleId={matchByRuleId}
              />
            </TabsContent>
            <TabsContent value="editor" className="m-0 p-4">
              <EditorTab rules={rules} />
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Active Rules tab — read-only list with live evaluation                     */
/* -------------------------------------------------------------------------- */

function ActiveRulesTab({
  rules,
  firedRuleIds,
  matchByRuleId,
}: {
  rules: CorrelationRule[];
  /** Rule ids the SERVER evaluated and recorded a match for. */
  firedRuleIds: Set<string>;
  /** Newest persisted match per rule, for scope label and alarm count. */
  matchByRuleId: Map<string, { scopeLabel: string; matchCount: number }>;
}) {
  const t = useT();
  // Sort: rules the server has fired first, then by name ascending. Disabled
  // rules sink to the bottom of their respective tier.
  const sorted = useMemo(() => {
    return [...rules].sort((a, b) => {
      const at = firedRuleIds.has(a.id);
      const bt = firedRuleIds.has(b.id);
      if (at !== bt) return at ? -1 : 1;
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [rules, firedRuleIds]);

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <ShieldAlert className="mb-3 h-10 w-10 text-muted-foreground/40" />
        <p className="text-sm font-medium text-muted-foreground">{t("rules.noRulesConfigured")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("rules.switchToEditor")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {sorted.map((rule, idx) => (
        <ActiveRuleCard
            key={rule.id}
            rule={rule}
            index={idx}
            triggered={firedRuleIds.has(rule.id)}
            match={matchByRuleId.get(rule.id)}
          />
      ))}
    </div>
  );
}

function ActiveRuleCard({
  rule,
  index,
  triggered,
  match,
}: {
  rule: CorrelationRule;
  index: number;
  /** True when the server recorded a match for this rule. */
  triggered: boolean;
  /** The newest persisted match, for the scope label and alarm count. */
  match?: { scopeLabel: string; matchCount: number };
}) {
  const t = useT();
  const { canToggle } = useRulePermissions();
  const toggleRule = useCorrelationRules((s) => s.toggleRule);

  // Border tone: rose if triggered, amber if enabled-but-not-triggered, slate if disabled.
  const borderTone = triggered
    ? "border-l-rose-500"
    : rule.enabled
      ? "border-l-amber-500"
      : "border-l-slate-400/50";

  const bgTone = triggered
    ? "bg-rose-500/[0.04] hover:bg-rose-500/[0.07]"
    : rule.enabled
      ? "bg-card hover:bg-muted/40"
      : "bg-muted/20 hover:bg-muted/40";

  return (
    <div
      className={cn(
        "animate-slide-in-up rounded-lg border border-l-4 p-3 transition-all",
        borderTone,
        bgTone,
        !rule.enabled && "opacity-60",
      )}
      style={{ animationDelay: `${Math.min(index * 30, 240)}ms` }}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* Header row */}
          <div className="flex flex-wrap items-center gap-2">
            <h4
              className={cn(
                "text-sm font-semibold leading-tight",
                !rule.enabled && "line-through decoration-muted-foreground/50",
              )}
            >
              {rule.name}
            </h4>
            {triggered && <TriggeredBadge />}
            {!rule.enabled && (
              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                <Power className="h-2.5 w-2.5" /> {t("rules.disabled")}
              </span>
            )}
          </div>

          {/* Trigger condition (monospace, color-coded) */}
          <div className="mt-2">
            <TriggerCondition rule={rule} />
          </div>

          {/* Description */}
          {rule.description && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {rule.description}
            </p>
          )}

          {/* Evaluation status */}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            {triggered ? (
              <span className="inline-flex items-center gap-1 font-medium text-rose-700 dark:text-rose-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t("rules.triggeredIn")} {match?.scopeLabel ?? "—"} ({match?.matchCount ?? 0})
              </span>
            ) : rule.enabled ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                {t("rules.notTriggered")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Power className="h-3.5 w-3.5" />
                {t("rules.inactive")}
              </span>
            )}
          </div>
        </div>

        {/* Toggle (ADMIN + SUPERVISOR only) */}
        {canToggle && (
          <div className="flex shrink-0 items-center gap-2">
            <Label
              htmlFor={`toggle-active-${rule.id}`}
              className="text-[10px] uppercase tracking-wide text-muted-foreground"
            >
              {rule.enabled ? t("rules.on") : t("common.off")}
            </Label>
            <Switch
              id={`toggle-active-${rule.id}`}
              checked={rule.enabled}
              onCheckedChange={() => {
                toggleRule(rule.id);
                toast.success(rule.enabled ? t("rules.ruleDisabled") : t("rules.ruleEnabled"), {
                  description: rule.name,
                });
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Editor tab — CRUD for rules                                                */
/* -------------------------------------------------------------------------- */

function EditorTab({ rules }: { rules: CorrelationRule[] }) {
  const t = useT();
  const { canEdit } = useRulePermissions();
  const addRule = useCorrelationRules((s) => s.addRule);
  const hydrate = useCorrelationRules((s) => s.hydrate);
  // Phase 5 task 4 — confirm dialog for the reset action.
  const [resetOpen, setResetOpen] = useState(false);

  const sorted = useMemo(() => {
    return [...rules].sort((a, b) => {
      // Most recently updated first
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [rules]);

  const handleAdd = () => {
    addRule({
      name: t("rules.newRule"),
      description: t("rules.newRuleDesc"),
      enabled: true,
      alarmType: "FUEL_LOW",
      threshold: 3,
      windowMinutes: 15,
      scope: "REGION",
      escalateTo: "L2",
    });
    toast.success(t("rules.ruleCreated"), { description: t("rules.ruleCreatedDesc") });
  };

  // Phase 2: this used to call `replaceAll(DEFAULT_RULES…)`, writing demo rules
  // into localStorage. With server-backed storage there is nothing to bulk
  // replace, and DEFAULT_RULES was a browser-only concept the evaluator never
  // saw — so "reset" planted rules that could never fire. It now re-reads the
  // tenant's real rules from the API.
  // Phase 5 task 4 — gated by ConfirmDestructive instead of window.confirm.
  const performReset = () => {
    void hydrate();
    toast.success(t("rules.resetToast"), {
      description: t("rules.resetToastDesc"),
    });
    setResetOpen(false);
  };

  if (!canEdit) {
    // Supervisor (REGIONAL_MANAGER) lands here: read-only editor — switches to
    // the Active Rules tab effectively. Show a small banner explaining.
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" />
          {t("rules.viewOnlyBanner")}
        </div>
        <div className="space-y-2.5">
          {sorted.map((rule) => (
            <ReadOnlyRuleCard key={rule.id} rule={rule} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={handleAdd}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t("rules.addRule")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setResetOpen(true)}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {t("rules.resetToDefaults")}
        </Button>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {rules.length} {t("rules.rulesConfigured")}
        </span>
      </div>

      {sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-10 text-center">
          <ShieldAlert className="mb-2 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{t("rules.noRulesConfigured")}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("rules.clickAddOrCreate")}
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {sorted.map((rule, idx) => (
            <RuleEditorCard key={rule.id} rule={rule} index={idx} />
          ))}
        </div>
      )}
    </div>
      {/* Phase 5 task 4 — replaces window.confirm for the reset action. */}
      <ConfirmDestructive
        target={
          resetOpen
            ? {
                title: t("confirm.resetTitle"),
                description: t("rules.resetConfirm"),
                cancelLabel: t("confirm.cancel"),
                // `rules.reset` never existed: the confirm button rendered the raw key.
                confirmLabel: t("confirm.reset"),
              }
            : null
        }
        onCancel={() => setResetOpen(false)}
        onConfirm={performReset}
      />
    </>
  );
}

/** Read-only card shown to supervisor-level roles in the Editor tab. */
function ReadOnlyRuleCard({ rule }: { rule: CorrelationRule }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-l-4 p-3 transition-all",
        rule.enabled ? "border-l-amber-500 bg-card" : "border-l-slate-400/50 bg-muted/20 opacity-60",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h4
            className={cn(
              "text-sm font-semibold",
              !rule.enabled && "line-through decoration-muted-foreground/50",
            )}
          >
            {rule.name}
          </h4>
          <div className="mt-1.5">
            <TriggerCondition rule={rule} />
          </div>
          {rule.description && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">{rule.description}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Editable card — ADMIN only. Local draft, Save/Delete buttons. */
function RuleEditorCard({ rule, index }: { rule: CorrelationRule; index: number }) {
    // Phase 5 task 4 — confirm dialog for deleting this rule.
  const [deleteOpen, setDeleteOpen] = useState(false);
const t = useT();
  const updateRule = useCorrelationRules((s) => s.updateRule);
  const deleteRule = useCorrelationRules((s) => s.deleteRule);
  const toggleRule = useCorrelationRules((s) => s.toggleRule);

  // Local draft state — synced from the rule prop whenever the rule's
  // updatedAt changes (e.g. external toggle from the Active Rules tab, or a
  // cross-tab sync). Otherwise we keep the user's in-flight edits.
  //
  // Uses the "adjusting state during render" pattern (calling setState during
  // render guarded by a comparison against previously-stored information) —
  // see https://react.dev/reference/react/useState#storing-information-from-previous-renders.
  // This is the React-recommended alternative to setState-in-effect, which
  // trips the project's `react-hooks/set-state-in-effect` lint rule.
  const [draft, setDraft] = useState({
    name: rule.name,
    description: rule.description,
    alarmType: rule.alarmType,
    threshold: String(rule.threshold),
    windowMinutes: String(rule.windowMinutes),
    scope: rule.scope,
    escalateTo: rule.escalateTo,
  });
  const [lastSyncedAt, setLastSyncedAt] = useState(rule.updatedAt);

  if (rule.updatedAt !== lastSyncedAt) {
    // External update detected — re-seed the draft from the new rule. Safe to
    // call setState during render here because the guard ensures it converges:
    // once `lastSyncedAt` is set to `rule.updatedAt`, this branch is skipped
    // on subsequent renders until the prop changes again.
    setDraft({
      name: rule.name,
      description: rule.description,
      alarmType: rule.alarmType,
      threshold: String(rule.threshold),
      windowMinutes: String(rule.windowMinutes),
      scope: rule.scope,
      escalateTo: rule.escalateTo,
    });
    setLastSyncedAt(rule.updatedAt);
  }

  // Validation
  const nameTrimmed = draft.name.trim();
  const thresholdNum = Number(draft.threshold);
  const windowNum = Number(draft.windowMinutes);
  const nameValid = nameTrimmed.length > 0 && nameTrimmed.length <= 120;
  const thresholdValid = Number.isFinite(thresholdNum) && thresholdNum >= 1;
  const windowValid = Number.isFinite(windowNum) && windowNum >= 1;
  const formValid = nameValid && thresholdValid && windowValid;

  // Dirty check vs the saved rule.
  const dirty =
    nameTrimmed !== rule.name ||
    draft.description !== rule.description ||
    draft.alarmType !== rule.alarmType ||
    thresholdNum !== rule.threshold ||
    windowNum !== rule.windowMinutes ||
    draft.scope !== rule.scope ||
    draft.escalateTo !== rule.escalateTo;

  const handleSave = () => {
    if (!formValid) {
      toast.error(t("rules.cannotSave"), {
        description: !nameValid
          ? t("rules.nameRequired")
          : !thresholdValid
            ? t("rules.thresholdInvalid")
            : t("rules.windowInvalid"),
      });
      return;
    }
    updateRule(rule.id, {
      name: nameTrimmed,
      description: draft.description.trim(),
      alarmType: draft.alarmType,
      threshold: Math.floor(thresholdNum),
      windowMinutes: Math.floor(windowNum),
      scope: draft.scope,
      escalateTo: draft.escalateTo,
    });
    toast.success(t("rules.ruleSaved"), { description: nameTrimmed });
  };

  // Phase 5 task 4 — gated by ConfirmDestructive instead of window.confirm.
  const performDelete = () => {
    deleteRule(rule.id);
    toast.success(t("rules.ruleDeleted"), { description: rule.name });
    setDeleteOpen(false);
  };

  return (
    <>
    <div
      className={cn(
        "animate-slide-in-up rounded-lg border p-3 transition-all",
        rule.enabled ? "border-border bg-card" : "border-border bg-muted/20 opacity-70",
      )}
      style={{ animationDelay: `${Math.min(index * 30, 240)}ms` }}
    >
      {/* Header */}
      <div className="mb-2.5 flex items-center gap-2">
        <Switch
          checked={rule.enabled}
          onCheckedChange={() => toggleRule(rule.id)}
          aria-label={`${t("rules.toggleAria")} ${rule.name}`}
        />
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {rule.enabled ? t("common.enabled") : t("common.disabled")}
        </span>
        <span className="ml-auto font-mono text-[9px] text-muted-foreground/60">
          {rule.id.slice(-8)}
        </span>
      </div>

      {/* Form grid */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {/* Name */}
        <div className="sm:col-span-2">
          <Label htmlFor={`name-${rule.id}`} className="mb-1 text-[11px] text-muted-foreground">
            {t("rules.name")}
          </Label>
          <Input
            id={`name-${rule.id}`}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            className="h-8 text-xs"
            placeholder={t("rules.namePlaceholder")}
            maxLength={120}
            aria-invalid={!nameValid}
          />
        </div>

        {/* Description */}
        <div className="sm:col-span-2">
          <Label
            htmlFor={`desc-${rule.id}`}
            className="mb-1 text-[11px] text-muted-foreground"
          >
            {t("rules.descriptionLabel")}
          </Label>
          <Textarea
            id={`desc-${rule.id}`}
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            className="min-h-[48px] text-xs"
            placeholder={t("rules.descriptionPlaceholder")}
            maxLength={500}
          />
        </div>

        {/* Alarm Type */}
        <div>
          <Label className="mb-1 text-[11px] text-muted-foreground">{t("rules.alarmType")}</Label>
          <Select label={t("rules.alarmType")}
            value={draft.alarmType}
            onValueChange={(v) => setDraft((d) => ({ ...d, alarmType: v as AlarmType }))}
          >
            <SelectTrigger className="h-8 text-xs" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALARM_TYPES.map((tp) => (
                <SelectItem key={tp} value={tp} className="text-xs">
                  {tp === "ANY" ? t("rules.anyAllTypes") : tp.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Scope */}
        <div>
          <Label className="mb-1 text-[11px] text-muted-foreground">{t("rules.scope")}</Label>
          <Select label={t("rules.scope")}
            value={draft.scope}
            onValueChange={(v) => setDraft((d) => ({ ...d, scope: v as RuleScope }))}
          >
            <SelectTrigger className="h-8 text-xs" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCOPES.map((s) => (
                <SelectItem key={s} value={s} className="text-xs">
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Threshold */}
        <div>
          <Label
            htmlFor={`thr-${rule.id}`}
            className="mb-1 text-[11px] text-muted-foreground"
          >
            {t("rules.threshold")}
          </Label>
          <Input
            id={`thr-${rule.id}`}
            type="number"
            min={1}
            value={draft.threshold}
            onChange={(e) => setDraft((d) => ({ ...d, threshold: e.target.value }))}
            className="h-8 text-xs"
            aria-invalid={!thresholdValid}
          />
        </div>

        {/* Window Minutes */}
        <div>
          <Label
            htmlFor={`win-${rule.id}`}
            className="mb-1 text-[11px] text-muted-foreground"
          >
            {t("rules.window")}
          </Label>
          <Input
            id={`win-${rule.id}`}
            type="number"
            min={1}
            value={draft.windowMinutes}
            onChange={(e) => setDraft((d) => ({ ...d, windowMinutes: e.target.value }))}
            className="h-8 text-xs"
            aria-invalid={!windowValid}
          />
        </div>

        {/* Escalate To */}
        <div className="sm:col-span-2">
          <Label className="mb-1 text-[11px] text-muted-foreground">{t("rules.escalateTo")}</Label>
          <Select label={t("rules.escalateTo")}
            value={draft.escalateTo}
            onValueChange={(v) => setDraft((d) => ({ ...d, escalateTo: v as Severity }))}
          >
            <SelectTrigger className="h-8 text-xs" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEVERITIES.map((s) => (
                <SelectItem key={s} value={s} className="text-xs">
                  {s} — {s === "L1" ? t("alarms.notice") : s === "L2" ? t("alarms.warning") : t("alarms.critical")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Live condition preview */}
      <div className="mt-2.5">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("rules.preview")}
        </p>
        <TriggerCondition
          rule={{
            ...rule,
            name: nameTrimmed || rule.name,
            alarmType: draft.alarmType,
            threshold: thresholdValid ? Math.floor(thresholdNum) : rule.threshold,
            windowMinutes: windowValid ? Math.floor(windowNum) : rule.windowMinutes,
            scope: draft.scope,
            escalateTo: draft.escalateTo,
          }}
        />
      </div>

      {/* Action row */}
      <div className="mt-3 flex items-center gap-2 border-t pt-2.5">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!formValid || !dirty}
          className="h-7"
        >
          <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
          {t("rules.save")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setDraft({
              name: rule.name,
              description: rule.description,
              alarmType: rule.alarmType,
              threshold: String(rule.threshold),
              windowMinutes: String(rule.windowMinutes),
              scope: rule.scope,
              escalateTo: rule.escalateTo,
            });
            setLastSyncedAt(rule.updatedAt);
          }}
          disabled={!dirty}
          className="h-7"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {t("rules.revert")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDeleteOpen(true)}
          className="ml-auto h-7 border-rose-500/30 text-rose-700 dark:text-rose-400 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400"
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          {t("rules.delete")}
        </Button>
      </div>
    </div>
      {/* Phase 5 task 4 — replaces window.confirm for rule deletion. */}
      <ConfirmDestructive
        target={
          deleteOpen
            ? {
                title: t("confirm.deleteTitle"),
                description: `${t("rules.deleteConfirm")} "${rule.name}"${t("rules.deleteConfirmSuffix")}`,
                cancelLabel: t("confirm.cancel"),
                confirmLabel: t("confirm.deleteTitle"),
              }
            : null
        }
        onCancel={() => setDeleteOpen(false)}
        onConfirm={performDelete}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Exported trigger button — used by alarms-view.tsx                          */
/* -------------------------------------------------------------------------- */

export function CorrelationRulesTriggerButton({
  onOpen,
  triggeredCount,
}: {
  onOpen: () => void;
  triggeredCount: number;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onOpen}
      data-testid="open-correlation-rules"
      className="relative"
    >
      <ShieldAlert className="mr-1.5 h-4 w-4" />
      Rules
      {triggeredCount > 0 && (
        <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-rose-500 px-1.5 text-[9px] font-bold text-white">
          <Zap className="h-2.5 w-2.5" />
          {triggeredCount}
        </span>
      )}
    </Button>
  );
}
