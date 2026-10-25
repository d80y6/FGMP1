/**
 * D-09: a role change must be announced, once, and only when it is a change.
 *
 * The interesting cases are the boundaries, not the happy path: announcing the
 * initial role (talking over the sign-in the user just performed), announcing
 * an unchanged role (a poll returning the same value, every 5 seconds), and
 * treating a transient `null` (store reset between refetches) as a change back
 * to a role the user never left.
 *
 * Run: bun test src/lib/fgmp/__tests__/role-announcement.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { nextRoleAnnouncement } from "@/lib/fgmp/role-announcement";

describe("role-change announcement", () => {
  test("the first resolved role is a sign-in, not a change", () => {
    assert.equal(nextRoleAnnouncement(null, "ADMIN").changed, false);
  });

  test("the same role seen repeatedly never announces", () => {
    let state = nextRoleAnnouncement(null, "NOC_OPERATOR");
    for (let i = 0; i < 5; i++) {
      state = nextRoleAnnouncement(state.previous, "NOC_OPERATOR");
      assert.equal(state.changed, false, `poll ${i + 1} re-announced an unchanged role`);
    }
  });

  test("a real change announces exactly once", () => {
    let state = nextRoleAnnouncement(null, "FIELD_ENGINEER");
    state = nextRoleAnnouncement(state.previous, "ADMIN");
    assert.equal(state.changed, true);
    // The next poll with the new role is not a second change.
    assert.equal(nextRoleAnnouncement(state.previous, "ADMIN").changed, false);
  });

  test("a transient null is not a change, and does not erase the previous role", () => {
    const signedIn = nextRoleAnnouncement(null, "SUPERADMIN");
    const duringRefetch = nextRoleAnnouncement(signedIn.previous, null);
    assert.equal(duringRefetch.changed, false);
    // Crucially the previous role survives: otherwise coming back from null
    // would be announced as "your role is now SUPERADMIN" to a user who never
    // lost it.
    assert.equal(duringRefetch.previous, "SUPERADMIN");
    const after = nextRoleAnnouncement(duringRefetch.previous, "SUPERADMIN");
    assert.equal(after.changed, false);
  });

  test("a change that happens while the store is empty is still announced", () => {
    let state = nextRoleAnnouncement(null, "READONLY");
    state = nextRoleAnnouncement(state.previous, null); // signed out mid-flight
    state = nextRoleAnnouncement(state.previous, "ADMIN"); // re-signed in, promoted
    assert.equal(state.changed, true);
  });

  test("undefined is handled the same as null", () => {
    const state = nextRoleAnnouncement("ADMIN", undefined);
    assert.deepEqual(state, { previous: "ADMIN", changed: false });
  });
});
