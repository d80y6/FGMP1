import { test } from "node:test";
import assert from "node:assert/strict";
import { PREVIEW_ROLES } from "./role-preview-constants";

test("role preview constants remain safe to import from Client Components", () => {
  assert.deepEqual(PREVIEW_ROLES, [
    "ADMIN",
    "NOC_OPERATOR",
    "REGIONAL_MANAGER",
    "FIELD_ENGINEER",
    "EXECUTIVE",
    "READONLY",
  ]);
  assert.equal(PREVIEW_ROLES.includes("SUPERADMIN"), false);
});
