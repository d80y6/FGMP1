# ---- Dependencies ----
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- Builder ----
FROM oven/bun:1 AS builder
WORKDIR /app
# NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time. In a
# Docker build the environment of the builder stage is not visible unless it is
# declared, so these ARGs are what make realtime work in a container at all.
# Passing them only as runtime env vars produces a build with an empty app key
# and realtime silently disabled (the UI falls back to the 5 s poll).
#   docker build --build-arg NEXT_PUBLIC_APINATOR_APP_KEY=… .
ARG NEXT_PUBLIC_APINATOR_APP_KEY=""
ARG NEXT_PUBLIC_APINATOR_CLUSTER="eu"
ENV NEXT_PUBLIC_APINATOR_APP_KEY=${NEXT_PUBLIC_APINATOR_APP_KEY}
ENV NEXT_PUBLIC_APINATOR_CLUSTER=${NEXT_PUBLIC_APINATOR_CLUSTER}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bunx prisma generate
# A client generated WITHOUT a query-engine binary still type-checks and still
# builds: it simply cannot talk to PostgreSQL, and the first query fails with
# "the URL must start with the protocol prisma://" — the signature of a client
# that only knows how to reach Prisma Accelerate. That happens whenever the
# engine download (binaries.prisma.sh) is blocked. Fail here, where the message
# names the cause, instead of at runtime in the first request.
RUN found=$(find node_modules/@prisma/engines node_modules/.prisma -name 'libquery_engine*' -o -name 'query_engine*' 2>/dev/null | head -1); \
    if [ -z "$found" ]; then \
      echo "FAIL: prisma generate produced no query engine binary."; \
      echo "The image would build and then be unable to reach PostgreSQL."; \
      echo "Check network access to binaries.prisma.sh during the build."; \
      exit 1; \
    fi; \
    echo "prisma query engine: $found"
# Compute the Prisma CLI's real dependency closure (see the script's header for
# why this is derived rather than hand-written) and stage it for the runner.
RUN bun ./scripts/collect-prisma-cli-deps.ts \
 && test -s /tmp/prisma-cli-deps/packages.txt
RUN bun run build:standalone

# ---- Runner ----
# NOTE: `oven/bun:1-slim` is Debian 13 (trixie) and ships WITHOUT the
# `adduser`/`addgroup` shims (only /usr/sbin/useradd and /usr/sbin/groupadd).
# The previous `addgroup --system && adduser --system` line exited 127 and
# broke the image build entirely.
FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs --no-create-home --shell /usr/sbin/nologin nextjs
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# The committed migrations are the schema authority (Phase 1). The runner
# needs prisma/migrations/ to deploy them, and the Prisma CLI + engines to run
# `migrate deploy`. Without these the container could only ever have used the
# old SQLite bootstrap, which hard-exits against PostgreSQL.
COPY --from=builder /app/prisma ./prisma
# Runtime data, not code: alerting reads its rule file from disk and refuses to
# fall back to built-in thresholds. Standalone output traces modules, not data
# files, so without this copy `/api/fgmp/ops/alerts/preview` throws in the image
# while working perfectly in dev. (outputFileTracingIncludes in next.config.ts
# covers the same file for non-Docker tracing; both are kept because they cover
# different builds.)
COPY --from=builder /app/config ./config
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma/engines ./node_modules/@prisma/engines
# `prisma migrate deploy` is driven through @prisma/config, which pulls in a
# deep dependency closure of its own. Copying node_modules/prisma alone is NOT
# sufficient — the CLI dies at import time. Both of these were found by BOOTING
# the image, not by reading this file:
#
#   error: Cannot find package 'effect'    from '@prisma/config/dist/index.js'
#   error: Cannot find package 'pure-rand' from 'fast-check/lib/check/runner/…'
#
# A hand-enumerated list is the wrong shape for this: the first attempt listed
# 7 packages and the CLI still failed, because fast-check's own dependency
# pure-rand was not among them. Any list written by hand rots the moment Prisma
# changes its graph, and the failure mode is an image that builds cleanly and
# then crash-loops on every deploy.
#
# So the list is computed from the installed tree at build time by walking
# `dependencies` out of node_modules/prisma and @prisma/config, and everything
# found is copied. It cannot drift, because it is derived from what is actually
# installed rather than from what someone believed was installed.
#
# The alternative — copying all 1.3 GB of node_modules — also works but pushes
# the image well past its current size for no benefit.
COPY --from=builder /tmp/prisma-cli-deps /tmp/prisma-cli-deps
RUN set -eu; \
    cd /app/node_modules; \
    while read -r pkg; do \
      [ -n "$pkg" ] || continue; \
      src="/tmp/prisma-cli-deps/node_modules/${pkg}"; \
      if [ -d "$src" ]; then \
        mkdir -p "$(dirname "./${pkg}")"; \
        cp -R "$src" "./${pkg}"; \
      fi; \
    done < /tmp/prisma-cli-deps/packages.txt; \
    rm -rf /tmp/prisma-cli-deps
# Entrypoint supports local migrate/seed/serve, a one-shot migration-only job,
# and the web-service skip-migrate + schema-preflight path.
COPY --from=builder /app/scripts/docker-entrypoint.mjs ./scripts/docker-entrypoint.mjs
# Schema preflight used when FGMP_SKIP_MIGRATE=1, so a mis-ordered deploy fails
# at container start instead of on the first request.
COPY --from=builder /app/scripts/db-preflight.mjs ./scripts/db-preflight.mjs
# `.next/standalone` re-emits any `.env` it finds via output tracing, so one
# can land in the shipped image. Remove it — secrets come from the environment.
COPY --from=builder /app/node_modules/bcryptjs ./node_modules/bcryptjs
COPY --from=builder /app/scripts ./scripts
RUN rm -f /app/.env \
 && mkdir -p /app/backups \
 && chown -R nextjs:nodejs /app/backups /app/prisma
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# The unprivileged user has no home dir; Prisma needs a writable cache/temp.
ENV HOME=/tmp

# Apply migrations (no-op when already current) and then serve. Failures exit
# non-zero rather than starting the server against an out-of-date schema.
#
# SECURITY: in a split deployment, migrations run as a SEPARATE one-shot job
# against FGMP_MIGRATE_DATABASE_URL (docker-compose, Render's fgmp-migrate job,
# or CI) with FGMP_MIGRATE_ONLY=1. The web service uses FGMP_SKIP_MIGRATE=1 so
# it never holds DDL rights. The app connects as fgmp_app, which cannot migrate;
# handing it an owner credential would make the RLS boundary decorative.
ENTRYPOINT ["bun", "./scripts/docker-entrypoint.mjs"]

# Liveness, not readiness: the process is up and serving HTTP. Uses the
# unauthenticated /api/health/live route — /api/fgmp/health is ADMIN-only, so an
# orchestrator probing it would see 401 and mark a healthy container unhealthy.
# `bun` is already the runtime, so no curl/wget has to be added to the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

