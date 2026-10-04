"use client";

import { useEffect, useState, useCallback, useRef } from "react";

interface UseApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Collapse a caller-supplied dep list into a single scalar key.
 *
 * The effect previously depended on `[url, nonce, ...(opts?.deps ?? [])]`.
 * If any caller ever passed an array whose length changed between renders,
 * React throws "The final argument passed to useEffect changed size between
 * renders". Serialising to one value makes the dep array a fixed length
 * regardless of what callers pass.
 */
function depKey(deps: unknown[] | undefined): string {
  if (!deps || deps.length === 0) return "";
  try {
    return `${deps.length}|${JSON.stringify(deps)}`;
  } catch {
    // Circular / non-serialisable value — fall back to per-element coercion.
    // The length prefix keeps different arities in different key spaces.
    return `${deps.length}|${deps.map((d) => String(d)).join("|")}`;
  }
}

export function useApi<T>(url: string | null, opts?: { interval?: number; deps?: unknown[] }): UseApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  // The loader is held in a ref so the polling timer can be mounted
  // independently of it. Previously `nonce` sat in the polling effect's dep
  // array, so every refetch() tore down and restarted the interval — refetch
  // more often than the interval and the timer never reached its deadline, so
  // polling stopped silently.
  const loadRef = useRef<() => Promise<void>>(async () => {});

  const urlDeps = depKey(opts?.deps);
  const interval = opts?.interval;

  // Define the loader + perform the initial fetch whenever the request identity
  // changes. Deliberately does NOT depend on `nonce`.
  useEffect(() => {
    if (!url) { setLoading(false); return; }
    let cancelled = false;
    loadRef.current = async () => {
      try {
        setLoading(true);
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) {
          // Include the endpoint so a failure names WHICH request died —
          // `HTTP 500` alone is unactionable when a view fires several.
          if (!cancelled) { setError(`HTTP ${res.status} · ${url}`); setLoading(false); }
          return;
        }
        const json = await res.json();
        if (!cancelled) { setData(json); setError(null); }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadRef.current();
    return () => { cancelled = true; };
  }, [url, urlDeps]);

  // Polling timer. Independent of `nonce`, so refetch() cannot reset it.
  useEffect(() => {
    if (!url || !interval || interval <= 0) return;
    const i = setInterval(() => { void loadRef.current(); }, interval);
    return () => clearInterval(i);
  }, [url, urlDeps, interval]);

  // Manual refetch: a one-shot reload that leaves the polling timer running.
  const skipFirstNonce = useRef(true);
  useEffect(() => {
    if (skipFirstNonce.current) { skipFirstNonce.current = false; return; }
    void loadRef.current();
  }, [nonce]);

  return { data, loading, error, refetch };
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

/**
 * DELETE a resource. Returns the same envelope shape as apiPost/apiPatch so
 * callers can use a uniform success/error handling pattern. The server returns
 * either `{ ok: true, id }` on success or `{ error }` on failure.
 */
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
