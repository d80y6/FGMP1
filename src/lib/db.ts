import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Logging: only `warn` and `error` in dev, `error` only in prod.
// The previous `log: ['query']` setting flooded dev.log with every SQL
// statement (20K+ lines/min under the telemetry engine), which was a
// primary contributor to the recurring next-server OOM crashes in the
// 4 GB cgroup. Query-level logging is rarely useful in normal operation
// — enable it temporarily by setting DEBUG_PRISMA=1 if needed.
const logLevels = process.env.DEBUG_PRISMA === '1'
  ? [{ level: 'query' as const, emit: 'stdout' as const }, { level: 'warn' as const, emit: 'stdout' as const }, { level: 'error' as const, emit: 'stdout' as const }]
  : [{ level: 'warn' as const, emit: 'stdout' as const }, { level: 'error' as const, emit: 'stdout' as const }]

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: logLevels,
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
