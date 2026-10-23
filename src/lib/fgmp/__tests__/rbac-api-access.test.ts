import { describe, expect, test } from "bun:test";
import { apiReadCapabilities, canAccessApi } from "../rbac-core";

describe("API read permissions follow view capabilities", () => {
  test("tenant administration endpoints are hidden and denied to tenant operators", () => {
    for (const role of ["NOC_OPERATOR", "REGIONAL_MANAGER", "FIELD_ENGINEER", "EXECUTIVE", "READONLY"]) {
      expect(canAccessApi(role, "/api/fgmp/users")).toBe(false);
      expect(canAccessApi(role, "/api/fgmp/tenants")).toBe(false);
    }
    expect(canAccessApi("ADMIN", "/api/fgmp/users")).toBe(true);
    expect(canAccessApi("SUPERADMIN", "/api/fgmp/tenants")).toBe(true);
  });

  test("read-only operators cannot query sensitive admin surfaces", () => {
    expect(canAccessApi("READONLY", "/api/fgmp/health")).toBe(false);
    expect(canAccessApi("READONLY", "/api/fgmp/settings?category=PLATFORM")).toBe(false);
    expect(canAccessApi("ADMIN", "/api/fgmp/health")).toBe(true);
  });

  test("shared dashboard APIs allow every role that can see the dashboard", () => {
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/analytics?projection=dashboard&range=24h")).toBe(true);
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/analytics?projection=fuel")).toBe(true);
    expect(canAccessApi("FIELD_ENGINEER", "/api/fgmp/analytics?projection=inventory")).toBe(true);
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/analytics?projection=analytics")).toBe(false);
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/analytics")).toBe(false);
    expect(canAccessApi("FIELD_ENGINEER", "/api/fgmp/fuel/runout-eta")).toBe(true);
    expect(canAccessApi("READONLY", "/api/fgmp/shift-handover?limit=20")).toBe(true);
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/reports?period=daily")).toBe(true);
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/reports")).toBe(true);
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/reports?period=30d")).toBe(false);
    expect(canAccessApi("FIELD_ENGINEER", "/api/fgmp/notifications")).toBe(true);
    expect(canAccessApi("READONLY", "/api/fgmp/platform/grants")).toBe(false);
  });

  test("exports are authorized by the data view they export", () => {
    expect(canAccessApi("FIELD_ENGINEER", "/api/fgmp/export?type=sites")).toBe(true);
    expect(canAccessApi("FIELD_ENGINEER", "/api/fgmp/export?type=batteries")).toBe(true);
    expect(canAccessApi("FIELD_ENGINEER", "/api/fgmp/export?type=users")).toBe(false);
  });

  test("nested resources inherit the correct view and action policies", () => {
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/dispensers/dsp-1/commands")).toBe(true);
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/maintenance/ticket-1")).toBe(true);
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/geography/regions")).toBe(false);
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/correlation/matches")).toBe(false);
    expect(canAccessApi("REGIONAL_MANAGER", "/api/fgmp/correlation/rules")).toBe(true);
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/correlation/rules", "POST")).toBe(false);
  });

  test("action endpoints are gated without making denied HTTP calls", () => {
    expect(canAccessApi("FIELD_ENGINEER", "/api/fgmp/dispensers/dsp-1/control", "POST")).toBe(true);
    expect(canAccessApi("FIELD_ENGINEER", "/api/fgmp/dispensers", "POST")).toBe(false);
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/notifications", "POST")).toBe(true);
    expect(canAccessApi("READONLY", "/api/fgmp/notifications", "POST")).toBe(false);
    expect(canAccessApi("READONLY", "/api/fgmp/me/preview-role", "POST")).toBe(false);
    expect(canAccessApi("READONLY", "/api/fgmp/me/preview-role", "DELETE")).toBe(true);
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/users", "POST")).toBe(false);
  });

  test("unmapped account/auth endpoints remain auth-only", () => {
    expect(apiReadCapabilities("/api/fgmp/me")).toBeNull();
    expect(canAccessApi("READONLY", "/api/fgmp/me")).toBe(true);
    expect(canAccessApi("READONLY", "/api/fgmp/preferences", "PUT")).toBe(true);
    expect(canAccessApi("READONLY", "/api/fgmp/mfa/status")).toBe(true);
    expect(canAccessApi("READONLY", "/api/fgmp/not-yet-reviewed")).toBe(false);
    expect(canAccessApi("READONLY", "/api/fgmp/realtime/snapshot")).toBe(false);
    expect(canAccessApi(null, "/api/fgmp/users")).toBe(false);
  });
});
