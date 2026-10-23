#!/usr/bin/env bash
# Phase 5 — the four boot verifications against the built image.
# Read-only against the live database: it creates nothing and mutates nothing
# except the throwaway probe database, which already exists and is dropped by
# the preflight path's own guard.
set -u

IMAGE="${1:-fgmp:boot}"
NET="fgmp1_default"
CNAME="fgmp-boot-verify"

APP_URL="postgresql://fgmp_app:testapp123@fgmp-db:5432/fgmp?schema=public&connection_limit=10"
MIG_URL="postgresql://fgmp_migrate:testmigrate123@fgmp-db:5432/fgmp?schema=public"
EMPTY_URL="postgresql://fgmp_app:testapp123@fgmp-db:5432/fgmp_empty_bootprobe?schema=public"

COMMON_ENV=(
  -e FGMP_REQUIRE_RLS=1
  -e NEXTAUTH_SECRET="bootverify-secret-abcdefghijklmnopqrstuv"
  -e NEXTAUTH_URL="http://localhost:3199"
  -e IOT_API_KEY="boot-iot-key-abcdefghijklmnopqrstuvwxyz01"
  # REALTIME_SERVER_SECRET / REALTIME_TOKEN_SECRET are gone with the retired
  # self-hosted realtime service. The APINATOR_* fakes mirror the compose
  # required markers so the boot exercises the same env surface; the health
  # probe's channels call will simply fail its 800ms race and report
  # realtime connected=false, which is the correct degraded reading.
  -e APINATOR_APP_ID="boot-app-id"
  -e APINATOR_KEY="boot-key-abcdefghijklmnop"
  -e APINATOR_SECRET="boot-apinator-secret-abcdefghijklmnopqrstuvwxyz0123456789"
  -e APINATOR_CLUSTER="eu"
  # Stays: the iot-bridge authenticates /api/fgmp/realtime/snapshot with it.
  -e REALTIME_SERVICE_TOKEN="boot-svc-abcdefghijklmnop"
)

hr() { printf '\n=========== %s ===========\n' "$1"; }

cleanup() { docker rm -f "$CNAME" >/dev/null 2>&1; }

# ── 1. migrations ENABLED ────────────────────────────────────────────────────
hr "1. BOOT WITH MIGRATIONS ENABLED"
cleanup
docker run -d --name "$CNAME" --network "$NET" -p 3199:3000 \
  -e DATABASE_URL="$APP_URL" -e FGMP_MIGRATE_DATABASE_URL="$MIG_URL" \
  "${COMMON_ENV[@]}" "$IMAGE" >/dev/null
sleep 45
echo "--- container state ---"
docker ps -a --filter "name=$CNAME" --format '{{.Status}}'
echo "--- entrypoint log ---"
docker logs "$CNAME" 2>&1 | head -25

# ── 2. health endpoint ───────────────────────────────────────────────────────
hr "2. /api/fgmp/health THROUGH THE CONTAINER (401 expected)"
echo "--- HTTP status ---"
curl -s -o /tmp/health.body -w 'status=%{http_code}\n' http://127.0.0.1:3199/api/fgmp/health
echo "--- body ---"
head -c 400 /tmp/health.body; echo
echo "--- unauthenticated root also checked (routing alive) ---"
curl -s -o /dev/null -w 'root status=%{http_code}\n' http://127.0.0.1:3199/

# ── 3. least privilege, proved NEGATIVELY ───────────────────────────────────
hr "3. LEAST PRIVILEGE — proved by attempting it"
echo "--- 3a. who does the app actually connect as? (via the app's own env) ---"
docker exec "$CNAME" sh -c 'echo "$DATABASE_URL" | sed -E "s#//([^:]*):[^@]*@#//\1:***@#"' 2>&1
echo "--- 3b. is the OWNER credential present in the app container? ---"
docker exec "$CNAME" sh -c 'if [ -n "$FGMP_MIGRATE_DATABASE_URL" ]; then echo "FGMP_MIGRATE_DATABASE_URL IS SET (unexpected)"; else echo "FGMP_MIGRATE_DATABASE_URL: absent (good)"; fi' 2>&1
echo "--- 3c. ATTEMPT DDL as the app role. Must be REFUSED. ---"
docker exec "$CNAME" bun -e '
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  try {
    const r = await db.$queryRawUnsafe("SELECT current_user AS u, session_user AS s");
    console.log("current_user :", JSON.stringify(r));
  } catch (e) { console.log("identity query failed:", String(e.message).split("\n")[0]); }
  try {
    await db.$executeRawUnsafe("CREATE TABLE p5_ddl_probe (id int)");
    console.log("!!! DDL SUCCEEDED — the boundary is BROKEN");
  } catch (e) {
    console.log("DDL REFUSED (correct):", String(e.message).split("\n").filter(Boolean).slice(0,2).join(" | "));
  }
  try {
    await db.$executeRawUnsafe("CREATE INDEX p5_idx_probe ON \"Site\" (\"code\")");
    console.log("!!! INDEX CREATED — the boundary is BROKEN");
  } catch (e) {
    console.log("DDL (index) REFUSED (correct):", String(e.message).split("\n").filter(Boolean).slice(0,1).join(" | "));
  }
  try {
    await db.$executeRawUnsafe("ALTER TABLE \"Alarm\" DISABLE ROW LEVEL SECURITY");
    console.log("!!! RLS DISABLED — catastrophic");
  } catch (e) {
    console.log("RLS tamper REFUSED (correct):", String(e.message).split("\n").filter(Boolean).slice(0,1).join(" | "));
  }
  await db.$disconnect();
})();
' 2>&1 | tail -12

cleanup

# ── 4. FGMP_SKIP_MIGRATE against an EMPTY database ──────────────────────────
hr "4. FGMP_SKIP_MIGRATE=1 AGAINST AN EMPTY DATABASE (must refuse)"
docker rm -f fgmp-boot-empty >/dev/null 2>&1
docker run --name fgmp-boot-empty --network "$NET" \
  -e DATABASE_URL="$EMPTY_URL" -e FGMP_MIGRATE_DATABASE_URL="$MIG_URL" \
  -e FGMP_SKIP_MIGRATE=1 "${COMMON_ENV[@]}" "$IMAGE" 2>&1 | tail -12
echo "exit=$?"
docker rm -f fgmp-boot-empty >/dev/null 2>&1

hr "DONE"
