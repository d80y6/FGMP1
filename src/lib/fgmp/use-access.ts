"use client";

/**
 * Capability hooks for the client.
 * ────────────────────────────────────────────────────────────────────────────
 * `hasCapability(role, cap)` is the policy. These hooks are only the plumbing
 * that reads the *effective* role out of the store, so a component never has to
 * reach for the role itself and never has an excuse to restate the policy as a
 * role name.
 *
 * Why a hook and not a bare `hasCapability(me?.role, …)` at each call site: the
 * effective role is `null` until the session envelope arrives, and the three
 * ways that gets handled in the field — `me?.role ?? "READONLY"`,
 * `if (!me) return`, `me ? … : true` — disagree with each other. The first
 * silently grants nothing (READONLY holds no action capability, so a control
 * disappears), the third shows everything for one frame. Centralising the
 * fallback is how the UI stops disagreeing with itself about a moment that
 * lasts one render.
 *
 * The rule these hooks exist to serve (see docs/RBAC-REVIEW-2026-10.md §4):
 *
 *   A control, link or data section the current role cannot use must not be
 *   rendered at all. A 403 is the server's last word, never the interface's
 *   way of telling the operator "no".
 */

import { useCallback } from "react";
import { useFgmp } from "./store";
import { hasCapability } from "./rbac-core";
import type { Role } from "./types";

/** True when the effective role holds `capability`. False until the role is known. */
export function useCap(capability: string): boolean {
  const role = useFgmp((s) => s.me?.role ?? null);
  return role ? hasCapability(role, capability) : false;
}

/**
 * A predicate over capabilities: `can("alarm:ack")`. The plural form of
 * `useCap`, for a component that asks about several capabilities in one pass and
 * should not call a hook per row.
 */
export function useCan(): (capability: string) => boolean {
  const role = useFgmp((s) => s.me?.role ?? null);
  return useCallback(
    (capability: string) => (role ? hasCapability(role, capability) : false),
    [role],
  );
}

/**
 * A predicate over view keys: `canView("geography")` asks whether the current
 * role may open the Geography view (`view:geography`).
 *
 * Returned as a function rather than a per-key boolean so a component with
 * several links can ask about each one without a hook per key.
 */
export function useCanView(): (view: string) => boolean {
  const role = useFgmp((s) => s.me?.role ?? null);
  return useCallback(
    (view: string) => (role ? hasCapability(role, `view:${view}`) : false),
    [role],
  );
}

/**
 * The same predicate as a plain function, for the places that hold a role and
 * have no business subscribing to the store — route helpers, tests, and the
 * store's own `setView` guard.
 */
export function roleCanView(role: Role | string | null | undefined, view: string): boolean {
  return role ? hasCapability(role as Role, `view:${view}`) : false;
}
