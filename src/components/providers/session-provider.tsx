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
  return <SessionProvider>{children}</SessionProvider>;
}
