import NextAuth from "next-auth";
import { NextResponse, type NextRequest } from "next/server";
import {
  authOptions,
  JWT_SECRET_CONFIGURED,
  assertAuthConfigured,
} from "@/lib/auth";

/**
 * NextAuth v4 route handler (Task 31-A).
 *
 * Mounts the credentials provider + JWT session strategy at
 * /api/auth/[...nextauth]. The catch-all segment handles every NextAuth
 * sub-route (/signin, /signout, /session, /csrf, /callback/*, …) so we don't
 * need to register each one separately.
 *
 * Fail-closed guard: if NEXTAUTH_SECRET is missing or too short, auth.ts falls
 * back to a build-time placeholder so the module graph can load during
 * `next build`. Serving real auth traffic with that placeholder would mint
 * tokens signed by a publicly-known string, so every request is refused with
 * 503 until the secret is configured.
 */
const handler = NextAuth(authOptions);

// Next.js 16 types the catch-all segment as a Promise on the route context.
// The context must be forwarded to the handler — next-auth reads the segment
// from `ctx.params.nextauth`, not from the URL.
type AuthContext = { params: Promise<{ nextauth: string[] }> };

function assertConfigured(): NextResponse | null {
  if (JWT_SECRET_CONFIGURED) return null;
  try {
    assertAuthConfigured();
  } catch (err) {
    return NextResponse.json(
      {
        error: "Auth not configured",
        code: "AUTH_MISCONFIGURED",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
  return null;
}

export async function GET(req: NextRequest, ctx: AuthContext) {
  const denied = assertConfigured();
  if (denied) return denied;
  return handler(req, ctx);
}

export async function POST(req: NextRequest, ctx: AuthContext) {
  const denied = assertConfigured();
  if (denied) return denied;
  return handler(req, ctx);
}
