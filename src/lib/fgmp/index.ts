import { db } from "@/lib/db";
import { engine } from "./engine";
import { getCurrentUser, getSystemUser } from "./rbac";
import type { SessionUser } from "@/lib/auth";
import { toFgmpUser } from "./session-principal";

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
// SECURITY: request handlers must pass the exact principal returned by
// requireAuth()/requireRole(). Resolving getServerSession() a second time here
// would trust stale JWT role/tenant claims and could ignore a role-preview
// overlay. Non-request contexts (seed/CLI jobs) must use getSystemUser().
export async function bootstrap(sessionUser: SessionUser) {
  // The route must pass the principal returned by requireAuth()/requireRole().
  // Resolving getServerSession() again here would re-read the signed JWT, whose
  // role and tenant may be stale (and whose role may ignore the request's role
  // preview). Authorization and data scope must use the exact same principal.
  const user = toFgmpUser(sessionUser);
  await engine.ensureAllTenants();
  return { user };
}

export { db, engine, getCurrentUser, getSystemUser };
