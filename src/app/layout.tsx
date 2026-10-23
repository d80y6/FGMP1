import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./fonts.css";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/fgmp/theme-provider";
import { AuthSessionProvider } from "@/components/providers/session-provider";
import { ErrorBoundary } from "@/components/providers/error-boundary";

/* Fonts are self-hosted in `src/app/fonts/` and declared in `fonts.css`
   (see that file for why `next/font/google` was removed: the build must not
   download from fonts.googleapis.com). The CSS variables are defined there. */

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Matches the slate background in both themes, so the mobile browser chrome
  // does not flash white before the app paints.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0f14" },
  ],
};

export const metadata: Metadata = {
  title: "FGMP — Fuel & Generator Monitoring Platform",
  description:
    "National-scale fuel tank, generator, and battery monitoring platform with real-time telemetry, alarm management, remote control, analytics, and reporting for telecom site operations.",
  keywords: [
    "FGMP", "fuel monitoring", "generator monitoring", "IoT", "SCADA",
    "telecom sites", "alarm management", "predictive maintenance",
  ],
  authors: [{ name: "FGMP Platform" }],
  icons: { icon: "logo.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className="antialiased bg-background text-foreground"
      >
        {/* ErrorBoundary sits OUTSIDE ThemeProvider so theme-switching errors
            (and any other provider-level render errors) are also caught. */}
        <ErrorBoundary>
          <ThemeProvider>
            {/* AuthSessionProvider must wrap the app tree so useSession() is
                available in AppShell + LoginDialog (Task 31-A). */}
            <AuthSessionProvider>
              {children}
              <SonnerToaster position="top-right" richColors closeButton />
            </AuthSessionProvider>
          </ThemeProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
