import { z } from "zod";

/**
 * Correlation rule schemas (Phase 2, vertical 5).
 *
 * Rules are SERVER-EVALUATED. The browser authors them and displays the
 * results; it never decides whether a match fired. The schemas live here with
 * the rest of the house-style validators so `validateBody` and the route
 * files stay in step with every other resource.
 */

/** Scope of a rule: one site, a region, a governorate, or the whole tenant. */
export const ruleScopeSchema = z.enum(["SITE", "REGION", "GOVERNORATE", "NATIONAL"]);

/** Severity a firing rule escalates to. */
export const escalateToSchema = z.enum(["L1", "L2", "L3"]);

/**
 * The `__ALL__` bucket key used when a rule with national scope fires.
 *
 * It lives on CorrelationMatch, not on the rule: a rule states the SCOPE KIND
 * (SITE / REGION / GOVERNORATE / ALL) and the evaluator buckets each candidate
 * alarm by its site's real geography. So there is no scopeKey on a rule to
 * validate — accepting one would imply the author chooses the bucket, which is
 * not how matching works.
 */
export const ALL_SCOPE_KEY = "__ALL__";

const name = z.string().trim().min(3, "name must be at least 3 characters").max(120);
const description = z.string().trim().max(500).optional();
const alarmType = z
  .string()
  .trim()
  .min(3, "alarmType is required")
  .max(64)
  // Guard the interpolation into alarm keys. Values are persisted and later
  // read back into `encodeAlarmIds`, so keep them to a conservative charset.
  .regex(/^[A-Z][A-Z0-9_]*$/, "alarmType must be UPPER_SNAKE_CASE");
const threshold = z
  .number()
  .int("threshold must be a whole number of alarms")
  .min(1, "threshold must be at least 1")
  .max(1000, "threshold must not exceed 1000");
const windowMinutes = z
  .number()
  .int("windowMinutes must be a whole number of minutes")
  .min(1, "windowMinutes must be at least 1")
  .max(60 * 24 * 7, "windowMinutes must not exceed one week");

export const createCorrelationRuleSchema = z.object({
  name,
  description,
  alarmType,
  threshold,
  windowMinutes,
  scope: ruleScopeSchema,
  escalateTo: escalateToSchema,
});

/** Partial update — every field optional, but a non-empty body is required. */
export const updateCorrelationRuleSchema = z
  .object({
    name,
    description,
    enabled: z.boolean(),
    alarmType,
    threshold,
    windowMinutes,
    scope: ruleScopeSchema,
    escalateTo: escalateToSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "provide at least one field to update",
  });

export type CreateCorrelationRule = z.infer<typeof createCorrelationRuleSchema>;
export type UpdateCorrelationRule = z.infer<typeof updateCorrelationRuleSchema>;