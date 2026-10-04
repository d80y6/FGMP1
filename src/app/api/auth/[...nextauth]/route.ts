import NextAuth from "next-auth";
import { NextResponse, type NextRequest } from "next/server";
import {
  authOptions,
  JWT_SECRET_CONFIGURED,
  assertAuthConfigured,
} from "@/lib/auth";
import {
  rateLimitLogin,
  applyRateLimitHeaders,
} from "@/lib/fgmp/rate-limit";

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

/**
 * Brute-force throttle on the credential-submission path (Phase 0.7).
 *
 * next-auth v4's `signIn("credentials", …)` POSTs to
 * `/api/auth/callback/<provider>` — verified in next-auth's client, which
 * builds `${baseUrl}/callback/${provider}` for credentials providers. So the
 * path we must limit is the one whose segment after `callback` is a provider
 * id, i.e. the catch-all params are `["callback", provider]`.
 *
 * Only that path is limited. The other POST sub-paths (/session, /signout,
 * /csrf) are not credential submissions and must keep working — limiting them
 * would break session refresh for every signed-in operator.
 *
 * `AUTH_LIMIT` existed in rate-limit.ts and was documented as protecting auth
 * endpoints, but had zero call sites, so the advertised protection did not
 * exist. See rateLimitLogin() for why the unknown-IP case uses a looser shared
 * budget rather than locking every operator out at once.
 */
async function loginRateLimited(
  req: NextRequest,
  ctx: AuthContext,
): Promise<NextResponse | null> {
  let params: { nextauth: string[] };
  try {
    params = await ctx.params;
  } catch {
    return null; // params unavailable — never fail the request closed here
  }
  const segments = params.nextauth ?? [];
  if (segments[0] !== "callback") return null;

  const rl = rateLimitLogin(req);
  if (rl.success) return null;
  const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
  applyRateLimitHeaders(res.headers, rl);
  return res;
}

export async function GET(req: NextRequest, ctx: AuthContext) {
  const denied = assertConfigured();
  if (denied) return denied;
  return handler(req, ctx);
}

export async function POST(req: NextRequest, ctx: AuthContext) {
  const denied = assertConfigured();
  if (denied) return denied;
  const limited = await loginRateLimited(req, ctx);
  if (limited) return limited;
  return handler(req, ctx);
}
