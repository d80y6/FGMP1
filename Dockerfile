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
# Emit the schema as plain SQL here, where the full Prisma CLI is available.
# The runtime applies it via scripts/docker-init-db.js using bun:sqlite — no
# CLI (and no ~1500-package `bunx` download) needed on every container start.
RUN bun ./node_modules/prisma/build/index.js migrate diff \
      --from-empty --to-schema-datamodel prisma/schema.prisma --script \
      > /app/prisma/schema.sql \
 && test -s /app/prisma/schema.sql
RUN bun run build

# ---- Runner ----
# NOTE: `oven/bun:1-slim` is Debian 13 (trixie) and ships WITHOUT the
# `adduser`/`addgroup` shims (only /usr/sbin/useradd + /usr/sbin/groupadd).
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
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# Schema bootstrap script — applies prisma/schema.sql with bun:sqlite.
COPY --from=builder /app/scripts/docker-init-db.js ./scripts/docker-init-db.js
# `.next/standalone` re-emits any `.env` it finds via output tracing, so one
# can land in the shipped image. Remove it — secrets come from the environment.
RUN rm -f /app/.env \
 && mkdir -p /app/db /app/backups \
 && chown -R nextjs:nodejs /app/db /app/backups
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# The unprivileged user has no home dir; Prisma needs a writable cache/temp.
ENV HOME=/tmp

# Apply the Prisma schema before serving. Without this a fresh named volume
# has no tables and the first request fails with "no such table". `db push` is
# idempotent, so running it on every boot is safe.
CMD ["sh", "-c", "bun ./scripts/docker-init-db.js && exec bun server.js"]
