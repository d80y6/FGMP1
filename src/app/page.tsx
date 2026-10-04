import { Suspense } from "react";
import { AppShell } from "@/components/fgmp/app-shell";
import { ViewVisitTracker } from "@/components/fgmp/view-visit-tracker";

export default function Home() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Initializing FGMP…</div>
      </div>
    }>
      <AppShell />
      {/* Always-mounted (alongside AppShell) so view visits are recorded
          even while the per-view components (DashboardView, etc.) are
          unmounted. The OnboardingChecklist (#9) reads this tracker's
          localStorage output to determine the "Review the dashboard"
          completion state. */}
      <ViewVisitTracker />
    </Suspense>
  );
}
