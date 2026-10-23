"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary.
 *
 * Without this file Next renders its built-in error page, which is a bare
 * "Application error: a client-side exception has occurred" with no way back —
 * indistinguishable from a network failure, and with no route context in the
 * logs. This one does three things the default does not:
 *
 *   1. tells the operator what to do (retry, then reload);
 *   2. logs the digest, which is the only identifier that ties this render to a
 *      server-side stack trace;
 *   3. keeps the layout (theme, fonts, direction) so a failure inside a view
 *      does not look like a different application.
 *
 * `reset()` re-renders the segment; it does not reload the page, so a transient
 * render error clears without losing the session.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // `digest` is the server-side correlation id. The message is logged too,
    // but it is the digest that can be matched to the server log line.
    console.error("[route-error]", error.digest ?? "(no digest)", error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-sm">
        <div
          aria-hidden
          className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10 text-destructive"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-5 w-5"
          >
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        </div>

        <h1 className="text-lg font-semibold text-foreground">
          Something went wrong
        </h1>
        <p className="mt-1 text-sm text-muted-foreground" dir="rtl">
          حدث خطأ غير متوقع في هذه الشاشة.
        </p>

        <p className="mt-4 text-sm text-muted-foreground">
          The rest of the platform is still running. Try again; if it keeps
          failing, give the reference below to an administrator.
        </p>

        {error.digest ? (
          <p className="mt-3 rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            ref: {error.digest}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-2">
          <button
            onClick={reset}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
