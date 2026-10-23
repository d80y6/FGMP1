import Link from "next/link";

/**
 * 404 page.
 *
 * The app is a single-page shell at `/`, so a 404 usually means a stale
 * bookmark or a mistyped API path, not a removed screen. It therefore points
 * back to the dashboard rather than listing every view.
 *
 * Server component: no client JS, no providers, so it renders even when the
 * app shell is the thing that failed.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          404
        </p>
        <h1 className="mt-2 text-lg font-semibold text-foreground">
          This page does not exist
        </h1>
        <p className="mt-1 text-sm text-muted-foreground" dir="rtl">
          الصفحة غير موجودة.
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          Every screen in FGMP lives inside the dashboard; there is no separate
          sign-in URL either. Use the link below.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Back to the dashboard
        </Link>
      </div>
    </div>
  );
}
