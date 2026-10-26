"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useFgmp } from "@/lib/fgmp/store";
import { canAccessApi } from "@/lib/fgmp/rbac-core";
import {
  shouldJoinInFlight,
  shouldReleaseInFlight,
  type InFlightEntry,
} from "@/lib/fgmp/in-flight";

interface UseApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Collapse variable-length caller deps into one stable effect dependency. */
function depKey(deps: unknown[] | undefined): string {
  if (!deps || deps.length === 0) return "";
  try {
    return `${deps.length}|${JSON.stringify(deps)}`;
  } catch {
    return `${deps.length}|${deps.map((d) => String(d)).join("|")}`;
  }
}

/**
 * Fetch JSON once and, optionally, reconcile it on a serialized timer.
 *
 * The old `setInterval()` ticked independently of request completion. A slow
 * database request therefore overlapped every later poll, multiplying both
 * HTTP work and Prisma pool demand until the database rejected requests. This
 * hook schedules the next timeout only AFTER the previous fetch settles,
 * coalesces manual refetches with an in-flight request, and pauses while the
 * tab is hidden.
 */
export function useApi<T>(
  url: string | null,
  opts?: { interval?: number; deps?: unknown[] },
): UseApiState<T> {
  const role = useFgmp((s) => s.me?.role ?? null);
  // Do not even issue a fetch for a view/API the effective role cannot read.
  // The server repeats this check before database access; this is a UX and
  // connection-pool guard, not a substitute for server authorization.
  const requestUrl = url && canAccessApi(role, url, "GET") ? url : null;
  const [data, setData] = useState<T | null>(null);
  const [loadingState, setLoadingState] = useState(false);
  const [errorState, setErrorState] = useState<string | null>(null);
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  const loadRef = useRef<() => Promise<void>>(async () => {});
  // The shared in-flight slot. `owner` is the AbortController of the effect
  // that created the request: a cleanup may only clear its own entry, and an
  // aborted entry may never be joined (see `in-flight.ts`).
  const inFlightRef = useRef<{
    entry: InFlightEntry;
    promise: Promise<void>;
  } | null>(null);
  const lastNonceRef = useRef(nonce);
  const urlDeps = depKey(opts?.deps);
  const interval = opts?.interval;
  const identity = `${requestUrl ?? "<disabled>"}|${urlDeps}`;

  useEffect(() => {
    if (!requestUrl) {
      loadRef.current = async () => {};
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      // One request per hook instance at a time, including interval and manual
      // refetch triggers. Return the active promise instead of starting a twin
      // — but only while it can still complete. Joining an aborted request
      // leaves the caller loading forever and suppresses the retry (D-27).
      const existing = inFlightRef.current;
      if (existing && shouldJoinInFlight(existing.entry, identity)) {
        return existing.promise;
      }
      const request = (async () => {
        try {
          setLoadingState(true);
          const res = await fetch(requestUrl, {
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
          });
          if (!res.ok) {
            if (!cancelled) {
              setErrorState(`HTTP ${res.status} · ${requestUrl}`);
              setLoadedIdentity(identity);
            }
            return;
          }
          const json = (await res.json()) as T;
          if (!cancelled) {
            setData(json);
            setErrorState(null);
            setLoadedIdentity(identity);
          }
        } catch (err) {
          if (!cancelled && (err as Error).name !== "AbortError") {
            setErrorState(String(err));
            setLoadedIdentity(identity);
          }
        } finally {
          if (!cancelled) setLoadingState(false);
        }
      })();
      const slot = {
        entry: { identity, owner: controller, isAborted: () => controller.signal.aborted },
        promise: request,
      };
      inFlightRef.current = slot;
      try {
        await request;
      } finally {
        if (inFlightRef.current === slot) inFlightRef.current = null;
      }
    };

    loadRef.current = load;
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      // Release our own slot. Without this, the next mount of the same hook
      // (React re-runs effects on mount in development) would find an aborted
      // entry, join it, and never issue the replacement request: the widget
      // stays in its loading state even though nothing is being fetched.
      const current = inFlightRef.current;
      if (current && shouldReleaseInFlight(current.entry, controller)) {
        inFlightRef.current = null;
      }
    };
  }, [requestUrl, identity]);

  // Serialized, visibility-aware polling: a poll never overlaps its prior
  // request, and hidden tabs stop consuming database capacity.
  useEffect(() => {
    if (!requestUrl || !interval || interval <= 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(() => void run(), interval);
    };
    const run = async () => {
      timer = null;
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        schedule();
        return;
      }
      await loadRef.current();
      schedule();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), 250);
    };

    schedule();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [requestUrl, identity, interval]);

  // Explicit refetch does not reset the polling cadence and coalesces with any
  // request already in flight.
  useEffect(() => {
    if (nonce === lastNonceRef.current) return;
    lastNonceRef.current = nonce;
    void loadRef.current();
  }, [nonce]);

  const enabled = requestUrl !== null;
  return {
    data: enabled ? data : null,
    loading: enabled && (loadingState || loadedIdentity !== identity),
    error: enabled ? errorState : null,
    refetch,
  };
}

type ApiMutationResult = { ok: boolean; data?: unknown; error?: string; status: number };

/**
 * Client-side mirror of the server's capability check.
 *
 * The server is the authority — it re-runs `canAccessApi` inside
 * `requireAuth(req)` — but a denied request that never leaves the tab is better
 * than a denied request that does: it costs no connection, leaks nothing about
 * whether the resource exists, and it stops a stale handler, a keyboard shortcut
 * or a re-enabled button from reaching a route the user is not entitled to.
 */
function localApiDenial(url: string, method: string): ApiMutationResult | null {
  const role = useFgmp.getState().me?.role;
  if (canAccessApi(role, url, method)) return null;
  return {
    ok: false,
    status: 403,
    error: "You do not have permission to perform this action.",
    data: { code: "INSUFFICIENT_CAPABILITY" },
  };
}

/**
 * One gated request path for every mutation.
 *
 * `apiPost` / `apiPatch` / `apiPut` / `apiDelete` were three copy-pasted bodies
 * with the same denial check, and nine call sites in the views bypassed all of
 * them with a raw `fetch()`. Collapsing them here means a caller cannot
 * accidentally choose the ungated path while still looking like it uses the
 * helpers — and the HTTP method is a parameter rather than a second
 * implementation.
 */
export async function apiRequest(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
): Promise<ApiMutationResult> {
  const denied = localApiDenial(url, method);
  if (denied) return denied;
  try {
    const res = await fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      credentials: "include",
    });
    const json = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      data: json,
      status: res.status,
      error: res.ok ? undefined : ((json as { error?: string }).error ?? `HTTP ${res.status}`),
    };
  } catch (e) {
    return { ok: false, error: String(e), status: 0 };
  }
}

export function apiPost(url: string, body: unknown): Promise<ApiMutationResult> {
  return apiRequest("POST", url, body);
}

export function apiPatch(url: string, body: unknown): Promise<ApiMutationResult> {
  return apiRequest("PATCH", url, body);
}

/** `PUT` — full replacement. `users/[id]` accepts PUT for profile updates. */
export function apiPut(url: string, body: unknown): Promise<ApiMutationResult> {
  return apiRequest("PUT", url, body);
}

/** DELETE a resource; same result envelope as the other verbs. */
export function apiDelete(url: string): Promise<ApiMutationResult> {
  return apiRequest("DELETE", url);
}
