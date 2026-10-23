"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";

/**
 * Client-side wrapper around next-auth/react's <SessionProvider>.
 *
 * Mounted once near the root (src/app/layout.tsx) so every client component
 * in the tree can read the session via useSession() without re-initializing
 * the underlying fetcher.
 */
export function AuthSessionProvider({ children }: { children: ReactNode }) {
  // The session is a signed JWT and its role/tenant are server-derived. The
  // app already refreshes protected data as needed; polling /api/auth/session
  // on every window focus added DB/auth work and used to re-trigger /api/fgmp/me.
  return (
    <SessionProvider refetchOnWindowFocus={false} refetchInterval={0}>
      {children}
    </SessionProvider>
  );
}
