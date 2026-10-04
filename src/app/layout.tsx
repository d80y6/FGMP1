import type { Metadata } from "next";
import { Geist, Geist_Mono, Cairo } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/fgmp/theme-provider";
import { AuthSessionProvider } from "@/components/providers/session-provider";
import { ErrorBoundary } from "@/components/providers/error-boundary";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "FGMP — Fuel & Generator Monitoring Platform",
  description:
    "National-scale fuel tank, generator, and battery monitoring platform with real-time telemetry, alarm management, remote control, analytics, and reporting for telecom site operations.",
  keywords: [
    "FGMP", "fuel monitoring", "generator monitoring", "IoT", "SCADA",
    "telecom sites", "alarm management", "predictive maintenance",
  ],
  authors: [{ name: "FGMP Platform" }],
  icons: { icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${cairo.variable} antialiased bg-background text-foreground`}
      >
        {/* ErrorBoundary sits OUTSIDE ThemeProvider so theme-switching errors
            (and any other provider-level render errors) are also caught. */}
        <ErrorBoundary>
          <ThemeProvider>
            {/* AuthSessionProvider must wrap the app tree so useSession() is
                available in AppShell + LoginDialog (Task 31-A). */}
            <AuthSessionProvider>
              {children}
              <Toaster />
              <SonnerToaster position="top-right" richColors closeButton />
            </AuthSessionProvider>
          </ThemeProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
