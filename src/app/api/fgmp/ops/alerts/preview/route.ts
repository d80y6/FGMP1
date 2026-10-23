import { NextRequest, NextResponse } from "next/server";
import { requireRole, ROLES } from "@/lib/fgmp/auth-helpers";
import { loadAlertRules, AlertConfigError } from "@/lib/fgmp/alerting/config";
import {
  currentReadings,
  readingFor,
  tickAgeSeconds,
  parseExposition,
} from "@/lib/fgmp/alerting/readings";
import {
  findScenario,
  scenarioNames,
  rulesNotInScenario,
  SCENARIOS,
  type Scenario,
} from "@/lib/fgmp/alerting/scenarios";
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
  /**
   * Which readings produced this evaluation. Present on the success path only;
   * the failure path returns no evaluation, so it has nothing to describe.
   *
   * `live: false` is the important part. `?scenario=<name>` evaluates the rules
   * against SYNTHETIC readings so an operator can see a rule fire without
   * causing the condition — so a preview is capable of returning a plausible
   * firing state that describes nothing about this deployment. Carrying the
   * marker on the response is what stops that being read as real.
   */
  scenario?: {
    name: string;
    title: string;
    describes: string;
    live: boolean;
    warning: string;
    rulesNotCovered: string[];
  };
  /** Scenario names this deployment recognises, for UI pickers. */
  availableScenarios?: Array<{ name: string; title: string; describes: string }>;
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

  // ── Scenario mode ─────────────────────────────────────────────────────────
  // `?scenario=<name>` substitutes synthetic readings so an operator can see a
  // rule fire without causing the condition. Opt-in, never remembered, and it
  // never mutates the registry or delivers anything — a scenario is a view over
  // the rules, not a way to make an alert real.
  const scenarioParam = req.nextUrl.searchParams.get("scenario");
  const scenario = scenarioParam ? findScenario(scenarioParam) : undefined;
  if (scenarioParam && !scenario) {
    return NextResponse.json(
      {
        error: `Unknown scenario "${scenarioParam}".`,
        available: scenarioNames(),
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const readings = scenario ? readingsForScenario(scenario, nowMs) : currentReadings();

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

  // Under a scenario, an unread metric is a scenario that deliberately says
  // nothing about it — not a missing publisher. Reporting them as missingMetrics
  // would accuse live instrumentation of being unwired when the real cause is
  // the scenario's scope.
  const missingMetrics = scenario
    ? []
    : [
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
    // Which readings this evaluation used, and the synthetic marker when it did
    // not use live ones. A preview that can return plausible firing states
    // fabricated for demonstration MUST say so on the response, or an operator
    // reads a scenario's output as this deployment's health.
    scenario: scenario
      ? {
          name: scenario.name,
          title: scenario.title,
          describes: scenario.describes,
          live: false,
          warning:
            "SYNTHETIC READINGS. These are not this deployment's real state and " +
            "nothing here has been delivered to anybody.",
          rulesNotCovered: rulesNotInScenario(rules, scenario),
        }
      : {
          name: "live",
          title: "Live state",
          describes: "Read from this process's metric registry.",
          live: true,
          warning: "",
          rulesNotCovered: [],
        },
    availableScenarios: SCENARIOS.map((x) => ({
      name: x.name,
      title: x.title,
      describes: x.describes,
    })),
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

/**
 * Build a reading map for a scenario.
 *
 * Renders to exposition text and re-parses it, rather than hand-building a map.
 * That is deliberate: it exercises the SAME parser the live path uses, so a
 * scenario cannot appear to work because it bypassed the absent-versus-zero
 * logic that the live path depends on.
 */
function readingsForScenario(
  scenario: Scenario,
  nowMs: number,
): Map<string, MetricReading> {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(scenario.values)) {
    if (key.endsWith("_offset")) continue; // handled below as a timestamp
    lines.push(`${key} ${value}`);
  }
  // The offset key stands in for an absolute tick timestamp, so the same
  // tickAgeSeconds derivation runs and the age is what the rule compares.
  for (const [key, value] of Object.entries(scenario.values)) {
    if (!key.endsWith("_offset")) continue;
    lines.push(`fgmp_last_tick_timestamp_seconds ${nowMs / 1000 - value}`);
  }
  return parseExposition(lines.join("\n"));
}
