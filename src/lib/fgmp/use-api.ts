"use client";

import { useEffect, useState, useCallback, useRef } from "react";

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
  const [data, setData] = useState<T | null>(null);
  const [loadingState, setLoadingState] = useState(false);
  const [errorState, setErrorState] = useState<string | null>(null);
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const inFlightRef = useRef<{ identity: string; promise: Promise<void> } | null>(null);
  const lastNonceRef = useRef(nonce);
  const urlDeps = depKey(opts?.deps);
  const interval = opts?.interval;
  const identity = `${url ?? "<disabled>"}|${urlDeps}`;

  useEffect(() => {
    if (!url) {
      loadRef.current = async () => {};
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      // One request per hook instance at a time, including interval and manual
      // refetch triggers. Return the active promise instead of starting a twin.
      if (inFlightRef.current?.identity === identity) {
        return inFlightRef.current.promise;
      }
      const request = (async () => {
        try {
          setLoadingState(true);
          const res = await fetch(url, {
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
          });
          if (!res.ok) {
            if (!cancelled) {
              setErrorState(`HTTP ${res.status} · ${url}`);
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
      const entry = { identity, promise: request };
      inFlightRef.current = entry;
      try {
        await request;
      } finally {
        if (inFlightRef.current === entry) inFlightRef.current = null;
      }
    };

    loadRef.current = load;
    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, identity]);

  // Serialized, visibility-aware polling: a poll never overlaps its prior
  // request, and hidden tabs stop consuming database capacity.
  useEffect(() => {
    if (!url || !interval || interval <= 0) return;
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
  }, [url, identity, interval]);

  // Explicit refetch does not reset the polling cadence and coalesces with any
  // request already in flight.
  useEffect(() => {
    if (nonce === lastNonceRef.current) return;
    lastNonceRef.current = nonce;
    void loadRef.current();
  }, [nonce]);

  const enabled = url !== null;
  return {
    data: enabled ? data : null,
    loading: enabled && (loadingState || loadedIdentity !== identity),
    error: enabled ? errorState : null,
    refetch,
  };
}

export async function apiPost(url: string, body: unknown): Promise<{ ok: boolean; data?: unknown; error?: string; status: number }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, data: json, status: res.status, error: res.ok ? undefined : (json.error ?? `HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, error: String(e), status: 0 };
  }
}

export async function apiPatch(url: string, body: unknown) {
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, data: json, status: res.status, error: res.ok ? undefined : (json.error ?? `HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, error: String(e), status: 0 };
  }
}

/** DELETE a resource; returns the same result envelope as apiPost/apiPatch. */
export async function apiDelete(url: string): Promise<{ ok: boolean; data?: unknown; error?: string; status: number }> {
  try {
    const res = await fetch(url, {
      method: "DELETE",
      credentials: "include",
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, data: json, status: res.status, error: res.ok ? undefined : (json.error ?? `HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, error: String(e), status: 0 };
  }
}
