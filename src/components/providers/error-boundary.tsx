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
 * In production, the `componentDidCatch` hook would forward the error to
 * Sentry / Datadog — left as a TODO comment so the integration point is
 * explicit.
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
    // Always log to the browser console for developer diagnostics.
    console.error("[ErrorBoundary] Uncaught render error:", error, info);
    // TODO: forward to Sentry / Datadog in production.
    //   Sentry.captureException(error, { extra: { componentStack: info.componentStack, errorId: this.state.errorId } });
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
              aria-label="Error message"
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
