/**
 * Regression tests for the single-flight rule used by `useApi` (D-27).
 *
 * The defect these pin: a fetch that was aborted (React re-runs effects on
 * mount, and every identity change aborts the previous request) used to stay in
 * the shared slot, so the replacement request joined a promise that could never
 * deliver data. The observable symptom was a dashboard widget frozen in its
 * loading state while the endpoint answered 200 to a direct fetch: `/fuel/runout-eta`
 * and `/analytics?projection=dashboard` both did it.
 *
 * These are pure rules, so the test needs no DOM — which is the point: the
 * behaviour must hold in any renderer, not only in the one a browser test
 * happens to exercise.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  shouldJoinInFlight,
  shouldReleaseInFlight,
  type InFlightEntry,
} from "../in-flight";

function entry(
  identity: string,
  opts?: { owner?: unknown; aborted?: boolean },
): InFlightEntry {
  return {
    identity,
    owner: opts?.owner ?? { id: "owner" },
    isAborted: () => opts?.aborted ?? false,
  };
}

describe("useApi single-flight rule", () => {
  test("joins a live request with the same identity", () => {
    assert.equal(shouldJoinInFlight(entry("/api/fgmp/alarms|[]"), "/api/fgmp/alarms|[]"), true);
  });

  test("does not join when nothing is in flight", () => {
    assert.equal(shouldJoinInFlight(null, "/api/fgmp/alarms|[]"), false);
    assert.equal(shouldJoinInFlight(undefined, "/api/fgmp/alarms|[]"), false);
  });

  test("does not join a different identity (URL or deps changed)", () => {
    assert.equal(shouldJoinInFlight(entry("/api/fgmp/alarms|[]"), "/api/fgmp/alarms|[24]"), false);
  });

  test("does not join an aborted request — this is the D-27 defect", () => {
    const aborted = entry("/api/fgmp/fuel/runout-eta|[]", { aborted: true });
    assert.equal(shouldJoinInFlight(aborted, "/api/fgmp/fuel/runout-eta|[]"), false);
  });

  test("a release only clears the slot it owns", () => {
    const mine = { id: "effect-1" };
    const other = { id: "effect-2" };
    assert.equal(shouldReleaseInFlight(entry("/a|[]", { owner: mine }), mine), true);
    assert.equal(shouldReleaseInFlight(entry("/a|[]", { owner: other }), mine), false);
    assert.equal(shouldReleaseInFlight(null, mine), false);
  });
});
