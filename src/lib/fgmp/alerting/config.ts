/**
 * Loading and validating `config/alerts.json`.
 *
 * ── WHY THE FILE IS VALIDATED RATHER THAN TRUSTED ─────────────────────────
 * This file is intended to be edited by an operator, by hand, at 03:00. That
 * means a typo is a realistic input, not a theoretical one, and a typo must
 * produce a clear message rather than a rule that silently never fires.
 *
 * The most dangerous version of that failure is a validator that ACCEPTS a bad
 * rule: a misspelled `comparator` defaulting to `ok` is a monitor that is
 * always green, which is the failure mode this whole module exists to prevent.
 * So unknown enum values are rejected rather than defaulted, and a rule with no
 * `rationale` or no `confirmWith` is refused — an unexplained threshold is not
 * an alert, it is folklore.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AlertRule,
  AlertRulesFile,
  AbsencePolicy,
  AlertSeverity,
  Comparator,
  RuleSource,
} from "./rules";

const VALID_COMPARATORS: readonly Comparator[] = ["GT", "GTE", "LT", "LTE", "EQ", "NEQ"];
const VALID_SEVERITIES: readonly AlertSeverity[] = ["INFO", "WARNING", "CRITICAL"];
const VALID_SOURCES: readonly RuleSource[] = ["SPECIFIED", "SITE_POLICY", "DERIVED", "INFERRED"];
const VALID_ABSENCE: readonly AbsencePolicy[] = ["ABSENT_IS_ZERO", "ABSENT_IS_UNKNOWN"];

export class AlertConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlertConfigError";
  }
}

/** Reject rather than default — see the module comment. */
function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  ruleId: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new AlertConfigError(
      `Alert rule "${ruleId}": ${field} must be one of ${allowed.join(" | ")}, got ` +
        `${JSON.stringify(value)}. It is NOT defaulted, because a rule that falls ` +
        `back to a permissive value is a monitor that is always green.`,
    );
  }
  return value as T;
}

function requireString(value: unknown, field: string, ruleId: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AlertConfigError(
      `Alert rule "${ruleId}": ${field} is required and must be a non-empty string.`,
    );
  }
  return value;
}

function validateRule(raw: unknown, index: number): AlertRule {
  if (typeof raw !== "object" || raw === null) {
    throw new AlertConfigError(`rules[${index}] is not an object.`);
  }
  const r = raw as Record<string, unknown>;
  const id = requireString(r.id, "id", `#${index}`);

  if (typeof r.threshold !== "number" || !Number.isFinite(r.threshold)) {
    throw new AlertConfigError(
      `Alert rule "${id}": threshold must be a finite number, got ${JSON.stringify(r.threshold)}.`,
    );
  }
  if (typeof r.requiresLiveData !== "boolean") {
    throw new AlertConfigError(
      `Alert rule "${id}": requiresLiveData must be an explicit boolean. It is not ` +
        `optional because it decides whether a silent pipeline can raise an alert, and ` +
        `guessing that would be the difference between a useful rule and a silent one.`,
    );
  }

  return {
    id,
    title: requireString(r.title, "title", id),
    description: typeof r.description === "string" ? r.description : "",
    severity: requireEnum(r.severity, VALID_SEVERITIES, "severity", id),
    metric: requireString(r.metric, "metric", id),
    labels: (r.labels as Record<string, string> | undefined) ?? {},
    comparator: requireEnum(r.comparator, VALID_COMPARATORS, "comparator", id),
    threshold: r.threshold,
    unit: typeof r.unit === "string" ? r.unit : "",
    absencePolicy: requireEnum(r.absencePolicy, VALID_ABSENCE, "absencePolicy", id),
    requiresLiveData: r.requiresLiveData,
    rationale: requireString(r.rationale, "rationale", id),
    confirmWith: requireString(r.confirmWith, "confirmWith", id),
    source: requireEnum(r.source, VALID_SOURCES, "source", id),
    sourceRef: typeof r.sourceRef === "string" ? r.sourceRef : undefined,
    confirmedBy: typeof r.confirmedBy === "string" ? r.confirmedBy : null,
    confirmedAt: typeof r.confirmedAt === "string" ? r.confirmedAt : null,
  };
}

/** Parse and validate a rules document. Pure, so it is directly testable. */
export function parseAlertRules(json: string): AlertRulesFile {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (err) {
    throw new AlertConfigError(
      `config/alerts.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof doc !== "object" || doc === null) {
    throw new AlertConfigError("config/alerts.json must contain an object.");
  }

  const d = doc as Record<string, unknown>;
  if (typeof d.version !== "number") {
    throw new AlertConfigError("config/alerts.json must declare a numeric `version`.");
  }
  if (!Array.isArray(d.rules) || d.rules.length === 0) {
    throw new AlertConfigError("config/alerts.json must declare a non-empty `rules` array.");
  }

  const rules = d.rules.map(validateRule);

  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) {
      throw new AlertConfigError(`Duplicate alert rule id "${r.id}".`);
    }
    seen.add(r.id);
  }

  return { version: d.version, rules };
}

/** Read and validate from disk. */
export function loadAlertRules(path?: string): AlertRulesFile {
  const file = path ?? join(process.cwd(), "config", "alerts.json");
  let text: string;
  try {
    // `turbopackIgnore` keeps the tracer from treating a runtime data path as
    // a module edge and pulling the whole repository into the standalone
    // output. The file is shipped explicitly via outputFileTracingIncludes.
    text = readFileSync(/* turbopackIgnore: true */ file, "utf8");
  } catch (err) {
    throw new AlertConfigError(
      `Could not read alert rules at ${file}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Alerting cannot evaluate without its rules, and it will NOT fall back to a built-in ` +
        `set — a monitor that silently uses different thresholds from the ones on disk is ` +
        `worse than one that reports it is broken.`,
    );
  }
  return parseAlertRules(text);
}