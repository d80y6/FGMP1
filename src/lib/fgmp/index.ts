import { db } from "@/lib/db";
import { engine } from "./engine";
import { seedIfNeeded } from "./seed";
import { getCurrentUser } from "./rbac";

// Ensure DB is seeded + engine is initialized. Cheap after first call.
export async function bootstrap() {
  await seedIfNeeded();
  await engine.ensureInit();
  const user = await getCurrentUser();
  return { user };
}

export { db, engine, getCurrentUser };
