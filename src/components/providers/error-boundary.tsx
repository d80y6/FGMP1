"use client";

/**
 * FGMP top-level React error boundary.
 *
 * Wraps the entire client tree (outside ThemeProvider so theme errors are
 * also caught) and renders a friendly fallback Card when an uncaught
 * exception propagates from any descendant. The error is logged to the
 * console with a stable error id so support staff can correlate reports
 * with server logs.
 *
 * ── ERROR REPORTING ─────────────────────────────────────────────────────────
 * This package ships no vendor SDK (Sentry, Datadog, Rollbar …): which one a
 * deployment uses is an operator decision, and bundling one would add a global
 * agent and a DSN to every page for a feature that may be switched off. What it
 * DOES do is make the integration point real instead of a TODO:
 *
 *   1. every caught error is logged as one structured JSON line carrying the
 *      same `errorId` the operator sees on screen;
 *   2. `window.__fgmpReportError` is called with the full report when a
 *      deployment has installed it (see docs/OPERATIONS.md §7);
 *   3. a `fgmp:client-error` CustomEvent is dispatched, so a host page or a
 *      wrapper script can forward it without changing this file.
 *
 * All three are best-effort: a failing reporter must never mask the original
 * error or break the fallback UI.
 */

import { Component, type ErrorInfo, type ReactNode, useState } from "react";
import { AlertTriangle, RefreshCw, Copy, Check, Home } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/fgmp/use-language";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorId: string;
}

/** Generate a short, human-readable error id for support correlation. */
function genErrorId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().slice(0, 8);
    }
  } catch {
    /* ignore */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The payload handed to a deployment's error reporter. */
export interface ClientErrorReport {
  errorId: string;
  name: string;
  message: string;
  stack?: string;
  componentStack?: string;
  url: string;
  userAgent: string;
  occurredAt: string;
}

function buildErrorReport(
  error: Error,
  info: ErrorInfo,
  errorId: string,
): ClientErrorReport {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return {
    errorId,
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack,
    componentStack: info?.componentStack ?? undefined,
    url: typeof window === "undefined" ? "" : window.location.href,
    userAgent: nav?.userAgent ?? "",
    occurredAt: new Date().toISOString(),
  };
}

/**
 * Hand the report to whatever the deployment installed.
 *
 * Deliberately swallow every failure: reporting is diagnostics, and an
 * exception thrown inside an error reporter is how a user ends up staring at a
 * blank page instead of the fallback.
 */
function forwardToDeploymentReporter(report: ClientErrorReport): void {
  if (typeof window === "undefined") return;
  try {
    const hook = window.__fgmpReportError;
    if (typeof hook === "function") hook(report);
  } catch {
    /* a broken reporter must not break the boundary */
  }
  try {
    window.dispatchEvent(new CustomEvent("fgmp:client-error", { detail: report }));
  } catch {
    /* older browsers / non-DOM contexts */
  }
}

/**
 * Reload the current page — used by the fallback "Reload" button. We force
 * a server re-render (not just a soft reset) to clear any corrupted
 * client-side state that may have caused the error.
 */
function reloadPage() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorId: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorId: genErrorId() };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const report = buildErrorReport(error, info, this.state.errorId);

    // Structured, greppable, and value-redacted by construction: only the
    // message, the stack and the component stack are included, never form
    // state or anything else the error object happens to carry.
    console.error("[ErrorBoundary]", JSON.stringify(report));

    forwardToDeploymentReporter(report);
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return <ErrorFallback error={this.state.error} errorId={this.state.errorId} />;
  }
}

/**
 * Stateless fallback UI. Separated from the class so it can use the
 * `useT()` hook (class components cannot use hooks).
 */
function ErrorFallback({ error, errorId }: { error: Error | null; errorId: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const copyDetails = async () => {
    const details = `FGMP Error Report
Error ID: ${errorId}
Message: ${error?.message ?? "Unknown"}
Stack: ${error?.stack ?? "N/A"}
URL: ${typeof window !== "undefined" ? window.location.href : "N/A"}
Time: ${new Date().toISOString()}
`;
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API may be unavailable
    }
  };

  const goHome = () => {
    if (typeof window === "undefined") return;
    // Full document navigation on purpose: this component renders when React
    // itself has failed, so the router and its state cannot be trusted to
    // recover. `replace` (not `assign`) so the broken page is not left in
    // history for the Back button to return to.
    window.location.replace("/?view=dashboard");
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex min-h-screen items-center justify-center bg-background p-4"
    >
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="size-5" aria-hidden="true" />
            </div>
            <div>
              <CardTitle className="text-lg">{t("error.boundary.title")}</CardTitle>
              <CardDescription className="mt-1 text-sm text-muted-foreground">
                {t("error.boundary.description")}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error?.message ? (
            <pre
              className="max-h-32 overflow-auto rounded-md bg-muted p-3 text-xs text-muted-foreground"
              aria-label={t("common.errorMessage")}
            >
              {error.message}
            </pre>
          ) : null}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                {t("error.boundary.errorId")}: <code className="font-mono">{errorId}</code>
              </span>
              <Button onClick={copyDetails} variant="outline" size="sm" aria-label={t("error.boundary.copyDetails")}>
                {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                <span className="ml-1.5">{copied ? t("error.boundary.copied") : t("error.boundary.copyDetails")}</span>
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("error.boundary.contactHint")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={reloadPage} size="sm" className="flex-1">
              <RefreshCw className="size-4" aria-hidden="true" />
              {t("error.boundary.reload")}
            </Button>
            <Button onClick={goHome} variant="outline" size="sm" className="flex-1" aria-label={t("error.boundary.goHome")}>
              <Home className="size-4" aria-hidden="true" />
              {t("error.boundary.goHome")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

declare global {
  interface Window {
    /**
     * Optional deployment hook: set by a script that has already loaded an
     * error-reporting SDK, e.g.
     *
     *   window.__fgmpReportError = (report) => {
     *     Sentry.captureException(report);   // or Datadog RUM, etc.
     *   };
     *
     * The app never loads a vendor SDK itself — see the header of this file.
     */
    __fgmpReportError?: (report: ClientErrorReport) => void;
  }
}
