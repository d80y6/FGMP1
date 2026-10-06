# Phase 2 — working agreement (added by Lead)

All four verticals run **concurrently in one shared working tree**. Git branches do
NOT isolate a working directory, so the write scopes below are the only thing
keeping this safe. They are advisory to the filesystem but binding as a contract.

## Write scopes (disjoint by construction)

| Agent | Owns |
|---|---|
| `p2-telemetry` | `src/lib/fgmp/engine.ts` tick/simulation boundary, `/api/fgmp/tick`, ingest buffering (`src/app/api/fgmp/iot/ingest/**`) |
| `p2-protocol` | `src/lib/fgmp/protocol/**`, `/api/fgmp/edge/rs485`, `mini-services/iot-bridge/**`, new migration `20261006000000_*` |
| `p2-interlocks` | generator control routes, `src/lib/fgmp/interlocks/**`, new migration `20261006001000_*` |
| `p2-cron` | scheduler, server-side correlation (`src/lib/fgmp/correlation/**`), `20261006002000_*` |

`prisma/schema.prisma` is shared and additive-only. If two agents add models at
the same time, the later edit wins and may silently drop the other's block. That
is the one real collision risk — see "Schema edits" below.

## Rules

1. **No branch operations.** The Lead owns every `git checkout`, `merge`, `rebase`
   and `stash`. A branch switch rewrites files other agents are actively editing.
2. **`git add <explicit paths>` only.** Never `git add -A`, never `git add .`.
3. **Before editing any file outside your scope, send the Lead a message and wait
   for a reply.** Do not assume it is free.
4. **If you need something from another agent's scope**, message the Lead with the
   exact accessor or shape you need. Do not reach into their files.

## Schema edits

`prisma/schema.prisma` is the one genuinely shared file. To avoid losing work:

- Add models/fields **append-only at the end of the file**, and do not reformat
  or reorder anything above your addition.
- Do not run `prisma format` or `prisma generate` against another agent's
  in-progress edit without telling the Lead — it will rewrite the whole file.
- If your change is rejected by `prisma validate` because of someone else's
  partial edit, **stop and report it** rather than "fixing" their model.

## Migration naming

Prisma orders migrations **lexicographically by directory name**, not by
creation time. Every new migration must sort after `20261005000300_enable_rls`.
Getting this wrong breaks replay-from-empty; it bit us three times in Phase 1.

Enum defaults are **unquoted**: `@default(OPEN)`, never `@default("OPEN")`.

## RLS

Enforced with `FORCE` on all 24 tenant tables. Any write outside a
`withTenant(tenantId, …)` context fails with "new row violates row-level security
policy". New tenant-carrying tables need `ENABLE` + `FORCE` + a `tenant_isolation`
policy, copied from `prisma/migrations/20261005000300_enable_rls/migration.sql`.

## Gates every agent must leave green

```
npx tsc --noEmit                    # 0 errors
npx eslint .                        # 0 errors
npx prisma validate                 # valid
bun run scripts/rls-regression.ts   # exit 0
bun run scripts/smoke-postgres.ts   # PASS
bun run db:seed                     # siteCount 52
```

with:

```
DATABASE_URL=postgresql://fgmp_app:testapp123@127.0.0.1:5433/fgmp?schema=public
FGMP_MIGRATE_DATABASE_URL=postgresql://fgmp_migrate:testmigrate123@127.0.0.1:5433/fgmp?schema=public
```

## The bar this phase has to clear

The user set the precondition explicitly: **do not claim production-ready until
Phase 1's RLS regression suite passes and Phase 2's simulated telemetry is gone.**

Phase 1's suite passes today. Phase 2's job is to make the second half true —
and to prove it rather than assert it. A green test run is not evidence on its
own; Phase 1's own review suite turned out to be unable to detect a missing
`FORCE`, which was only found by deliberately breaking things and watching it
fail. **Mutation-test your own work before you claim it works.**
## Scratch files outside the repo are shared state

An agent's authoritative work list was kept at `/tmp/myfiles.txt`. Another agent
overwrote it with a repo-wide list, and the first agent lost its own scope
silently — no error, just a batch that no longer matched what it was doing.

`/tmp` is not private between agents on this machine. Anything another agent
could reasonably need must live in the repo, or be reconstructible from the
tools.

**The rule that resolves this cleanly: derive the work queue from the gate's own
output.** The ESLint rule `no-restricted-imports` reports exactly which files still
violate, which is the queue by definition. A hand-maintained list is a cache of
that, and caches drift.

## Signature discipline

`asTenant` takes the authenticated user, not a tenant id:

```ts
asTenant(user, …)                        // the caller's own tenant
asTenantForAnotherTenant(user, tenantId, …)  // throws unless SUPERADMIN
```

`asTenant(user.tenantId, …)` is wrong and will not typecheck — which is the point.
The guarantee is narrow and worth stating precisely: a client-supplied value
cannot reach the tenant context, because a request body has no type that satisfies
it. An **in-code** mistake can still compile — a row has a `tenantId` field too,
and one mechanical pass did exactly that before review caught it.
