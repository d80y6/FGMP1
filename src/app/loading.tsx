/**
 * Root loading UI.
 *
 * Shown while the server renders the shell. It is a structural skeleton rather
 * than a spinner on purpose: the dashboard's layout is stable, so reserving the
 * space avoids the layout shift that made the first paint feel like a reload.
 */
export default function Loading() {
  return (
    <div className="min-h-screen bg-background">
      <div className="h-14 border-b border-border" />
      <div className="mx-auto max-w-7xl space-y-4 p-6">
        <div className="h-6 w-56 animate-pulse rounded bg-muted" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl border border-border bg-card"
            />
          ))}
        </div>
        <div className="h-72 animate-pulse rounded-xl border border-border bg-card" />
      </div>
      <span className="sr-only">Loading FGMP…</span>
    </div>
  );
}
