import { db } from "@/lib/db";
import { engine } from "./engine";
import { seedIfNeeded } from "./seed";
import { getCurrentUser, getSystemUser } from "./rbac";

// Ensure DB is seeded + engine is initialized. Cheap after first call.
//
// SECURITY (Phase 0.3): the `user` returned here comes from getCurrentUser(),
// which FAILS CLOSED (throws) when there is no NextAuth session. Every route
// that calls bootstrap() has already passed requireAuth()/requireRole(), so a
// session is present and this returns the real authenticated user.
//
// Non-request contexts (seed/CLI jobs) that legitimately have no session must
// call getSystemUser() explicitly instead of relying on bootstrap().user.
export async function bootstrap() {
  await seedIfNeeded();
  await engine.ensureInit();
  const user = await getCurrentUser();
  return { user };
}

export { db, engine, getCurrentUser, getSystemUser };
