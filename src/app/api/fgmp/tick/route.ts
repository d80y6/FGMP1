import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * Request-driven ticking is retired. The server-side scheduler owns global
 * simulation advancement; a browser/session must never mutate every tenant.
 */
function disabled() {
  return NextResponse.json(
    {
      error: "Request-driven simulation ticking is disabled; state is advanced by the server scheduler.",
      code: "TICK_ENDPOINT_DISABLED",
    },
    { status: 410 },
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  return disabled();
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  return disabled();
}
