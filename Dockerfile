# ---- Dependencies ----
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- Builder ----
FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run db:generate
RUN bun run build

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
# The 16 committed migrations are the schema authority (Phase 1). The runner
# needs prisma/migrations/ to deploy them, and the Prisma CLI + engines to run
# `migrate deploy`. Without these the container could only ever have used the
# old SQLite bootstrap, which hard-exits against PostgreSQL.
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma/engines ./node_modules/@prisma/engines
# `prisma migrate deploy` is driven through @prisma/config, which has its own
# dependency closure. Copying node_modules/prisma alone is NOT sufficient: the
# CLI dies at import time with
#     error: Cannot find package 'effect' from '@prisma/config/dist/index.js'
# which was found by actually booting the image, not by reading this file.
#
# Rather than hand-enumerate packages (which silently rots every time Prisma
# changes its graph), copy the closure the CLI genuinely resolves. Verified:
# 9 packages resolve with nothing further missing.
#
# The alternative — copying all 1.3 GB of node_modules — would work but would
# push the image well past its current ~212 MB for no benefit.
COPY --from=builder /app/node_modules/@prisma/config ./node_modules/@prisma/config
COPY --from=builder /app/node_modules/effect ./node_modules/effect
COPY --from=builder /app/node_modules/fast-check ./node_modules/fast-check
COPY --from=builder /app/node_modules/@standard-schema ./node_modules/@standard-schema
COPY --from=builder /app/node_modules/c12 ./node_modules/c12
COPY --from=builder /app/node_modules/deepmerge-ts ./node_modules/deepmerge-ts
COPY --from=builder /app/node_modules/empathic ./node_modules/empathic
# Entrypoint: applies pending migrations, then execs the standalone server.
COPY --from=builder /app/scripts/docker-entrypoint.mjs ./scripts/docker-entrypoint.mjs
# Schema preflight used when FGMP_SKIP_MIGRATE=1, so a mis-ordered deploy fails
# at container start instead of on the first request.
COPY --from=builder /app/scripts/db-preflight.mjs ./scripts/db-preflight.mjs
# `.next/standalone` re-emits any `.env` it finds via output tracing, so one
# can land in the shipped image. Remove it — secrets come from the environment.
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
# SECURITY: in any real deployment these run as a SEPARATE one-shot job against
# FGMP_MIGRATE_DATABASE_URL (docker-compose's `migrate` service, or CI), and the
# app is started with FGMP_SKIP_MIGRATE=1 so this container never holds DDL
# rights. The app connects as fgmp_app, which cannot migrate; handing it an
# owner credential would make the RLS boundary decorative.
ENTRYPOINT ["bun", "./scripts/docker-entrypoint.mjs"]

