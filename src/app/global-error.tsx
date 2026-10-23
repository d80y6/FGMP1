"use client";

/**
 * Root-layout error boundary.
 *
 * `error.tsx` renders INSIDE the root layout. When the layout itself throws —
 * a bad provider, a theme crash during hydration — there is no layout to render
 * into, so Next requires this file and it must supply its own <html>/<body>.
 *
 * It is deliberately style-minimal and dependency-free: importing the app's
 * design system here risks re-triggering the same failure that got us here.
 * Inline styles are used for that reason, not out of neglect.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          background: "#0b0f14",
          color: "#e6edf3",
        }}
      >
        <main style={{ maxWidth: 480, padding: 24 }}>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>
            FGMP could not start
          </h1>
          <p style={{ color: "#9aa7b4", fontSize: 14, lineHeight: 1.6 }}>
            The application shell failed to load. This is a server-side problem,
            not something you did. Reload to try again; if it persists, contact
            an administrator with the reference below.
          </p>
          {error.digest ? (
            <p
              style={{
                marginTop: 16,
                padding: "8px 12px",
                borderRadius: 6,
                background: "#161b22",
                fontFamily: "ui-monospace, monospace",
                fontSize: 12,
                color: "#9aa7b4",
              }}
            >
              ref: {error.digest}
            </p>
          ) : null}
          <button
            onClick={reset}
            style={{
              marginTop: 24,
              padding: "10px 18px",
              borderRadius: 6,
              border: "1px solid #2f81f7",
              background: "#1f6feb",
              color: "#fff",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
