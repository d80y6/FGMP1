/**
 * FGMP Metrics Middleware (Task 32-A)
 * ─────────────────────────────────────────────────────────────────────────
 * A higher-order function that wraps a Next.js App Router RouteHandler so
 * every invocation is automatically timed and counted by the in-memory
 * metrics tracker. Errors (status >= 400 or thrown exceptions) are also
 * pushed to the error ring buffer.
 *
 * Usage:
 *   ```ts
 *   import { withMetrics } from "@/lib/fgmp/with-metrics";
 *
 *   export const GET = withMetrics(async (req) => {
 *     // …existing handler body…
 *     return NextResponse.json({ ok: true });
 *   });
 *   ```
 *
 * Wrapping is opt-in per route (Task 32-A only wraps `/api/fgmp/state` and
 * `/api/fgmp/alarms` to keep the request overhead on the hottest endpoints
 * measurable without skewing slower routes).
 */

import type { NextRequest, NextResponse } from "next/server";
import { recordRequest, recordError } from "@/lib/fgmp/metrics";

/**
 * Generic route-handler signature that supports both no-arg handlers and
 * dynamic-route handlers (which receive a `params` context). The wrapper
 * passes through all arguments unchanged so existing handlers don't need
 * any signature adjustment.
 */
type AnyRouteHandler = (
  req: NextRequest,
  ctx: unknown,
) => Promise<NextResponse> | NextResponse;

export function withMetrics<T extends AnyRouteHandler>(handler: T): T {
  const wrapped = async (req: NextRequest, ctx: unknown): Promise<NextResponse> => {
    const start = Date.now();
    let path: string;
    try {
      path = new URL(req.url).pathname;
    } catch {
      path = req.url ?? "/unknown";
    }
    try {
      const res = await handler(req, ctx);
      const durationMs = Date.now() - start;
      recordRequest(req.method, path, res.status, durationMs);
      // 5xx responses warrant an explicit error record (with a clearer
      // message than the generic `HTTP 500` produced by recordRequest).
      if (res.status >= 500) {
        recordError(
          req.method,
          path,
          res.status,
          `Server error HTTP ${res.status}`,
        );
      }
      return res;
    } catch (err) {
      const durationMs = Date.now() - start;
      recordRequest(req.method, path, 500, durationMs);
      const message = err instanceof Error ? err.message : String(err);
      recordError(req.method, path, 500, message);
      // Re-throw so the upstream error handler (errorResponse) still runs
      // and produces the proper JSON error response for the client.
      throw err;
    }
  };
  // Preserve the original function reference for tooling / debug.
  // Cast through `unknown` because TS can't prove the variadic signature
  // matches `T` exactly — the runtime contract is satisfied.
  return wrapped as unknown as T;
}
