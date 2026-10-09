import { db } from "@/lib/db";
import { engine } from "./engine";
import { getCurrentUser, getSystemUser } from "./rbac";

// Prepare the in-process engine and resolve the acting user.
//
// Phase 1 step 6 REMOVED seedIfNeeded() from this function. It used to run here,
// which meant:
//
//   1. Every one of the ~86 callers paid for existence checks and upserts
//      across five tables on every single request, before doing any work.
//   2. Seeding spans tenants and creates the tenants themselves, so it cannot
//      run inside withTenant() and needs the OWNER role — which is why the web
//      app container had to be given a superuser connection just to serve a
//      request. That credential contradicted the whole point of the RLS
//      backstop: one injection bug would have defeated tenant isolation.
//
// Seeding is now a DEPLOY-TIME step (`bun run db:seed`, or POST /api/fgmp/seed
// for an authenticated admin). The web app never holds the owner credential.
//
// SECURITY (Phase 0.3): the `user` returned here comes from getCurrentUser(),
// which FAILS CLOSED (throws) when there is no NextAuth session. Every route
// that calls bootstrap() has already passed requireAuth()/requireRole(), so a
// session is present and this returns the real authenticated user.
//
// Non-request contexts (seed/CLI jobs) that legitimately have no session must
// call getSystemUser() explicitly instead of relying on bootstrap().user.
export async function bootstrap() {
  // Bootstrap has no session and no tenant — it is explicitly the non-request
  // path, so all tenants is the honest scope. Named rather than ambient.
  await engine.ensureAllTenants();
  const user = await getCurrentUser();
  return { user };
}

export { db, engine, getCurrentUser, getSystemUser };
