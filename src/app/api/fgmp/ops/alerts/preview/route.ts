import { NextRequest, NextResponse } from "next/server";
import { requireRole, ROLES } from "@/lib/fgmp/auth-helpers";
import { errorResponse } from "@/lib/fgmp/api-error";
import { loadAlertRules, AlertConfigError } from "@/lib/fgmp/alerting/config";
import { currentReadings, readingFor, tickAgeSeconds } from "@/lib/fgmp/alerting/readings";
import {
  evaluateRule,
  overallPosture,
  type AlertRule,
  type MetricReading,
  type RuleEvaluation,
} from "@/lib/fgmp/alerting/rules";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/ops/alerts/preview — what WOULD fire, right now.
 *
 * ── WHY THIS ENDPOINT EXISTS ───────────────────────────────────────────────
 * Every threshold in config/alerts.json is INFERRED. Nobody has confirmed a
 * single one, because confirming them requires seeing them behave against real
 * traffic — which you cannot do by reading the file.
 *
 * Without a preview, those thresholds are guesses whose first real test is an
 * incident at 03:00. With one, an operator can look at what is breaching right
 * now and decide whether the number is right, BEFORE it matters.
 *
 * ── WHAT IT DELIBERATELY WILL NOT DO ───────────────────────────────────────
 * It does not DELIVER anything. No page, no webhook, no escalation. Delivery is
 * the notification transport layer's job, and routing through it means alerts
 * inherit the TransportOutcome vocabulary (SENT | FAILED | NO_TRANSPORT) rather
 * than inventing a second, parallel alerting path that could disagree with the
 * first. This endpoint evaluates and exposes state; a separate decision about
 * delivery can follow, reusing those words.
 *
 * ── ABSENCE IS NEVER REPORTED AS HEALTHY ───────────────────────────────────
 * A rule whose metric never reported evaluates to `unknown`, not `ok`. The
 * overall posture likewise has no "healthy" verdict available while any rule is
 * unknown — see overallPosture(). This is the property the whole module exists
 * to protect: a monitor that is green because it received nothing is worse than
 * no monitor, because it is trusted.
 *
 * ── WHO CAN READ IT ────────────────────────────────────────────────────────
 * ALARM_OPS, the same gate as /metrics and as alarm acknowledgement. The
 * response includes which rules are breaching and the reasoning behind each,
 * which is operational detail rather than customer data.
 */

interface PreviewResponse {
  posture: "firing" | "degraded" | "unknown";
  /** True when at least one rule could not be evaluated for lack of data. */
  partial: boolean;
  generatedAt: string;
  rulesVersion: number;
  rulesFile: string;
  summary: { firing: number; unknown: number; ok: number; total: number };
  evaluations: RuleEvaluation[];
  /** Rules that cannot distinguish "no data" from "zero", named explicitly. */
  absenceNotes: Array<{
    ruleId: string;
    policy: AlertRule["absencePolicy"];
    canDistinguish: boolean;
    note: string;
  }>;
  /** Which metrics the rules asked for that do not exist at all. */
  missingMetrics: string[];
  configError?: string;
}

export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ALARM_OPS);
  if ("error" in auth) return auth.error;

  const nowMs = Date.now();

  let rules: AlertRule[];
  let rulesVersion = 0;
  let configError: string | undefined;

  try {
    const file = loadAlertRules();
    rules = [...file.rules];
    rulesVersion = file.version;
  } catch (err) {
    // A broken rules file must be VISIBLE, not silently replaced by built-in
    // defaults. An operator who is looking at a preview and seeing plausible
    // thresholds has no way to know they are not the configured ones.
    const message =
      err instanceof AlertConfigError
        ? err.message
        : `Failed to load alert rules: ${err instanceof Error ? err.message : String(err)}`;
    return NextResponse.json(
      {
        posture: "unknown",
        partial: true,
        generatedAt: new Date(nowMs).toISOString(),
        // Provenance on the failure path too. A caller that cannot see WHICH
        // rules file failed to load cannot tell a typo from a missing file from
        // a version mismatch, and those need different operator responses —
        // which is the same reason the success path carries them.
        rulesVersion,
        rulesFile: "config/alerts.json",
        summary: { firing: 0, unknown: 0, ok: 0, total: 0 },
        evaluations: [],
        absenceNotes: [],
        missingMetrics: [],
        configError: message,
      } satisfies PreviewResponse,
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  const readings = currentReadings();

  const evaluations: RuleEvaluation[] = rules.map((rule) => {
    // The tick-age rules are the one case where the useful value is derived
    // rather than read directly: the gauge holds an absolute timestamp and the
    // operator wants an age.
    const reading: MetricReading =
      rule.metric === "fgmp_last_tick_timestamp_seconds"
        ? tickAgeSeconds(readings, nowMs)
        : readingFor(readings, rule);

    return evaluateRule(rule, reading);
  });

  const missingMetrics = [
    ...new Set(
      rules
        .filter(
          (r) =>
            r.metric !== "fgmp_last_tick_timestamp_seconds" &&
            !readings.has(r.metric),
        )
        .map((r) => r.metric),
    ),
  ].sort();

  const body: PreviewResponse = {
    posture: overallPosture(evaluations),
    partial: evaluations.some((e) => e.state === "unknown"),
    generatedAt: new Date(nowMs).toISOString(),
    rulesVersion,
    rulesFile: "config/alerts.json",
    summary: {
      firing: evaluations.filter((e) => e.state === "firing").length,
      unknown: evaluations.filter((e) => e.state === "unknown").length,
      ok: evaluations.filter((e) => e.state === "ok").length,
      total: evaluations.length,
    },
    evaluations,
    absenceNotes: rules.map((rule) => ({
      ruleId: rule.id,
      policy: rule.absencePolicy,
      canDistinguish: rule.absencePolicy === "ABSENT_IS_UNKNOWN",
      note:
        rule.absencePolicy === "ABSENT_IS_UNKNOWN"
          ? "Absent data is reported as unknown, so 'zero' and 'no data' remain distinguishable."
          : "This rule treats an absent metric as zero, so it CANNOT distinguish " +
            "'nothing happened' from 'nothing reported'. That is deliberate for a " +
            "counter, but it means this rule will not detect a dead pipeline.",
    })),
    missingMetrics,
  };
  if (configError) body.configError = configError;

  return NextResponse.json(body, {
    // Never cached: a stale preview during an incident is worse than none,
    // because it says the problem has stopped.
    headers: { "cache-control": "no-store" },
  });
}