import { describe, expect, test } from "bun:test";
import { toCurrentFgmpUser, toFgmpUser } from "../session-principal";

describe("toFgmpUser", () => {
  const base = {
    id: "user-1",
    name: "A. Operator",
    email: "operator@example.test",
    role: "ADMIN",
    tenantId: "tenant-a",
  };

  test("uses the already-authorized role and tenant, including a role preview", () => {
    expect(toFgmpUser({ ...base, role: "FIELD_ENGINEER" })).toEqual({
      ...base,
      role: "FIELD_ENGINEER",
    });
  });

  test("fails closed for a pending session without a role or tenant", () => {
    expect(() => toFgmpUser({ ...base, role: undefined, tenantId: undefined })).toThrow(/recognized role/i);
  });

  test("fails closed for an invalid persisted role", () => {
    expect(() => toFgmpUser({ ...base, role: "PLATFORM_ROOT" })).toThrow(/recognized role/i);
  });

  test("fails closed for a missing tenant", () => {
    expect(() => toFgmpUser({ ...base, tenantId: " " })).toThrow(/tenant/i);
  });
});

describe("toCurrentFgmpUser", () => {
  const tokenUser = {
    id: "user-1",
    name: "A. Operator",
    email: "operator@example.test",
    role: "ADMIN",
    tenantId: "old-tenant",
    sessionEpoch: 4,
  };
  const currentState = {
    role: "READONLY",
    tenantId: "current-tenant",
    active: true,
    sessionEpoch: 4,
  };

  test("uses the live database role and tenant instead of stale token claims", () => {
    expect(toCurrentFgmpUser(tokenUser, currentState)).toEqual({
      id: "user-1",
      name: "A. Operator",
      email: "operator@example.test",
      role: "READONLY",
      tenantId: "current-tenant",
    });
  });

  test("fails closed when the user no longer exists or is disabled", () => {
    expect(() => toCurrentFgmpUser(tokenUser, null)).toThrow(/current/i);
    expect(() => toCurrentFgmpUser(tokenUser, { ...currentState, active: false })).toThrow(/current/i);
  });

  test("fails closed when the session epoch was revoked", () => {
    expect(() => toCurrentFgmpUser(tokenUser, { ...currentState, sessionEpoch: 5 })).toThrow(/current/i);
  });

  test("fails closed for pending MFA and invalid current roles", () => {
    expect(() => toCurrentFgmpUser({ ...tokenUser, mfaPending: true }, currentState)).toThrow(/current/i);
    expect(() => toCurrentFgmpUser(tokenUser, { ...currentState, role: "PLATFORM_ROOT" })).toThrow(/recognized role/i);
  });
});
