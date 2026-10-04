/**
 * FGMP API error handling.
 *
 * Centralised error → NextResponse conversion so every route handler can
 * `throw new ApiError(404, "not found")` or `throw error` and rely on the
 * `errorResponse()` helper to produce a consistent JSON shape with the
 * correct HTTP status. Sensitive internals (stack traces, raw Prisma
 * messages) are never leaked to the client.
 *
 * Recognised error types:
 *   - ApiError         → use its `status` + `message`
 *   - ZodError         → 400 with `details` (flattened field errors)
 *   - Prisma P2002     → 409 Conflict (unique constraint)
 *   - Prisma P2025     → 404 Not Found (record not found)
 *   - Prisma P2003     → 409 Conflict (foreign key)
 *   - everything else  → 500 with generic message + console.error
 */

import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Convenience constructors for the most common cases. */
export const badRequest = (msg: string, details?: unknown) =>
  new ApiError(400, msg, details);
export const unauthorized = (msg = "unauthorized") => new ApiError(401, msg);
export const forbidden = (msg = "forbidden") => new ApiError(403, msg);
export const notFound = (msg = "not found") => new ApiError(404, msg);
export const conflict = (msg: string, details?: unknown) =>
  new ApiError(409, msg, details);
export const tooManyRequests = (msg = "Too many requests") =>
  new ApiError(429, msg);

/**
 * Convert any thrown error into a structured JSON NextResponse.
 *
 * Always logs the original error to the server console (in production this
 * would be forwarded to Sentry / Datadog). Only safe, generic messages
 * reach the wire for unknown error types.
 */
export function errorResponse(error: unknown): NextResponse {
  // ApiError — explicit, application-level error.
  if (error instanceof ApiError) {
    const body: Record<string, unknown> = { error: error.message };
    if (error.details !== undefined) body.details = error.details;
    return NextResponse.json(body, { status: error.status });
  }

  // ZodError — schema validation failure.
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: error.flatten(),
      },
      { status: 400 },
    );
  }

  // Prisma errors — identified by their `code` property.
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: string }).code;
    const prismaMessage = (error as { message?: string }).message ?? "";
    if (code === "P2002") {
      // Unique constraint violation
      return NextResponse.json(
        { error: "Resource already exists", code: "P2002" },
        { status: 409 },
      );
    }
    if (code === "P2025") {
      // Record not found
      return NextResponse.json(
        { error: "Resource not found", code: "P2025" },
        { status: 404 },
      );
    }
    if (code === "P2003") {
      // Foreign key constraint
      return NextResponse.json(
        { error: "Referenced resource not found", code: "P2003" },
        { status: 409 },
      );
    }
    // Other Prisma errors — log full detail server-side, return generic.
    console.error("[api-error] Prisma error:", code, prismaMessage);
    return NextResponse.json(
      { error: "Database error", code: code ?? "PRISMA" },
      { status: 500 },
    );
  }

  // Network / fetch errors thrown by upstream services.
  if (error instanceof Error && error.name === "TypeError") {
    console.error("[api-error] Network error:", error.message);
    return NextResponse.json(
      { error: "Upstream service unavailable" },
      { status: 502 },
    );
  }

  // Fallback: never leak internals.
  const msg = error instanceof Error ? error.message : String(error);
  console.error("[api-error] Unhandled error:", msg, error);
  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 },
  );
}

/**
 * Wrap an async route handler so any thrown error is converted to a JSON
 * response. Reduces per-route try/catch boilerplate.
 *
 * ```ts
 * export const POST = withErrorHandler(async (req) => { ... });
 * ```
 */
export function withErrorHandler<TArgs extends unknown[]>(
  fn: (...args: TArgs) => Promise<NextResponse>,
): (...args: TArgs) => Promise<NextResponse> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
