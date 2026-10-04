# Task GAP-B — Backup & Restore admin module

**Agent:** full-stack-developer (Backup & Restore module)
**Task:** Build Backup & Restore admin module (1 lib + 5 API routes + 1 view replacement)

## What was built

### 1. Server-only helper lib — `src/lib/fgmp/backup.ts`

Exports:
- `BACKUP_DIR` — `path.resolve(process.cwd(), "backups")`. Created on-demand
  via `fs.mkdirSync({ recursive: true })` inside `createBackup`.
- `DB_PATH` — resolved from `process.env.DATABASE_URL` (strips the `file:`
  prefix; resolves relative paths against `process.cwd()`). Falls back to
  `<cwd>/db/custom.db`.
- `createBackup({ kind, note, tenantId, userId })` → `Promise<{ record,
  filepath }>`:
  - Filename format: `fgmp-backup-YYYY-MM-DD-HHMMSS.db` (UTC, padded).
  - `fs.copyFile(DB_PATH, filepath)` — safe under SQLite WAL mode with
    Prisma's open file descriptors (Linux overwrites the existing inode).
  - `sizeBytes = fs.statSync(filepath).size`.
  - `sha256` — hex digest computed by streaming the file through
    `crypto.createHash("sha256")` via `fs.createReadStream` (no whole-file
    buffering).
  - Inserts a `BackupRecord` row (status=COMPLETED, kind, note, tenantId,
    createdById).
  - On failure: still inserts a row with status=FAILED (best-effort,
    swallowed if it also fails), then rethrows.
  - Does NOT audit — callers audit (`BACKUP_CREATE` from the POST route,
    no audit when called internally from `restoreBackup` for the
    PRE_RESTORE snapshot).
- `restoreBackup(backupId, { tenantId, userId })` → `Promise<{ preRestoreBackupId }>`:
  1. Fetch the target record (must match tenantId; throws a P2025-tagged
     error which `errorResponse()` maps to 404).
  2. Take a PRE_RESTORE snapshot via `createBackup({ kind: "PRE_RESTORE",
     note: "Auto snapshot before restore", ... })` — gives the admin a
     rollback path.
  3. `fs.copyFile(backupFilepath, DB_PATH)` to overwrite the live DB.
  4. Delete the WAL + SHM sidecar files (`{DB_PATH}-wal`, `{DB_PATH}-shm`)
     so SQLite rehydrates from the restored .db file rather than replaying
     the old WAL. ENOENT is ignored.
  5. Update the original record: `status=RESTORED`, `restoredAt=now`,
     `restoredById=userId`.
  6. Audit `BACKUP_RESTORE` with `{ backupId, preRestoreBackupId }`.
  - Returns the pre-restore backup id so the route handler can surface it
    in the response payload.
- `deleteBackup(backupId, { tenantId, userId })` → `Promise<void>`:
  - Tenant-scoped fetch (404 if not found / cross-tenant).
  - `fs.unlink` the file (ignore ENOENT — row may exist without file).
  - Delete the DB row.
  - Audit `BACKUP_DELETE` with `{ filename, sizeBytes }`.
- `verifyBackup(backupId)` → `Promise<{ ok, expected, actual }>`:
  - Fetch the record, re-hash the file via streaming SHA-256, compare to
    the stored `sha256`. Returns `ok=false` if the file is missing or the
    digests differ.
- `formatBytes(n)` — human-readable formatter (`"512 B"`, `"1.4 MB"`,
  `"2.0 GB"`, etc.). Server-side only (the view has its own inline copy
  because this module uses `node:fs` / `node:crypto`).

Type import: `import type { BackupRecord } from "@prisma/client"`.

### 2. API routes (all ADMIN-only, tenant-scoped, rate-limited, audited)

- `src/app/api/fgmp/backups/route.ts`
  - `GET` — list 100 most recent `BackupRecord` rows for the tenant
    (`tenantId === me.tenantId`), include `createdBy` + `restoredBy` user
    relations, orderBy `createdAt desc`. Also returns DB stats:
    `{ backups, dbSizeBytes, dbPath, backupDir }` (dbSizeBytes from
    `fs.statSync(DB_PATH).size`, falls back to 0 if the file is missing).
    Rate-limited at `READ_LIMIT`.
  - `POST` — zod-validated body `{ note?: string }` (max 500 chars,
    optional, default null). Calls `createBackup({ kind: "MANUAL", ... })`.
    Audits `BACKUP_CREATE`. Re-fetches the row with user relations and
    returns 201. Rate-limited at `MUTATION_LIMIT`.

- `src/app/api/fgmp/backups/[id]/route.ts`
  - `GET` — single record (tenantId check, 404 if not found / cross-
    tenant). Includes createdBy + restoredBy. Rate-limited at `READ_LIMIT`.
  - `DELETE` — calls `deleteBackup(id, { tenantId, userId })`. The lib
    audits `BACKUP_DELETE`. Returns `{ ok, id }`. Rate-limited at
    `MUTATION_LIMIT`.

- `src/app/api/fgmp/backups/[id]/download/route.ts`
  - `GET` — tenant check, then stream the file to the client via
    `NextResponse` wrapping a `ReadableStream` backed by
    `fs.createReadStream`. Headers: `Content-Type: application/octet-stream`,
    `Content-Disposition: attachment; filename="<filename>"`,
    `Content-Length`, `Cache-Control: no-store`. 404 if the record is
    missing/cross-tenant OR the file is gone from disk
    (`code: "FILE_MISSING"`). Rate-limited at `READ_LIMIT`.

- `src/app/api/fgmp/backups/[id]/restore/route.ts`
  - `POST` — tenant check (early exit before consuming a PRE_RESTORE
    snapshot), then calls `restoreBackup(id, { tenantId, userId })`. The
    lib audits `BACKUP_RESTORE` (single source of truth — the route does
    NOT re-audit). Returns 200 with `{ ok, backupId, preRestoreBackupId,
    warning }`. The `warning` field reminds the operator that long-lived
    Prisma client connections may serve cached data until the server
    process is restarted. Rate-limited at `MUTATION_LIMIT`.

- `src/app/api/fgmp/backups/[id]/verify/route.ts`
  - `GET` — tenant check, then calls `verifyBackup(id)`. Returns
    `{ ok, expected, actual }`. Rate-limited at `READ_LIMIT`.

### 3. View — `src/components/fgmp/views/backups-view.tsx` (replaced stub)

Mirrors `tenants-view.tsx` / `api-keys-view.tsx` structure. Key elements:

- **SectionHeader**: title `t("nav.backups")`, description `t("desc.backups")`,
  icon `<DatabaseBackup />`, tone `primary`.
- **Warning Card** (amber-bordered `Alert`): `t("backups.restoreWarning")`
  text + `<ShieldAlert />` icon, placed between the section header and the
  KPI strip.
- **KPI strip** (5 cards): Total Backups, Last Backup (relative time via
  `timeAgo`), Total Size (formatted via inline `formatBytes`), Database
  Size (from API `dbSizeBytes`), Restored count. Tones: default, good,
  warn, default, good. Numbers via `formatNumber(n, numLang)`; byte sizes
  use latin units ("B", "KB", "MB") per spec.
- **DB paths strip**: small muted info line showing `dbPath` +
  `backupDir` from the API response, in `<code>` mono.
- **Main table card**: header with filtered count + search Input (filters
  by filename + note + createdBy.name) + outline-style "Create Backup
  Now" button.
- **Table columns** (8):
  1. Filename (mono + optional note line)
  2. Size (formatted bytes)
  3. Type / kind (badge: Manual=emerald, Scheduled=violet, Pre-restore=amber)
  4. SHA-256 (truncated `prefix…suffix` mono + Copy icon button with
     Check feedback)
  5. Created (relative `timeAgo` + absolute `fmtDateTime`)
  6. Created By (name; if restored, show "Restored: {name}" below)
  7. Status (badge: COMPLETED=emerald+CircleCheck, RESTORED=violet+RotateCcw,
     FAILED=rose)
  8. Actions (DropdownMenu: Download, Verify, Restore, Delete)
- **Scroll container**: `max-h-[600px] overflow-y-auto` with sticky header
  (`sticky top-0 z-10 bg-card`).
- **Loading state**: `KpiCardSkeleton × 5` + `TableSkeleton(rows=6, cols=8)`
  during initial load.
- **Empty state**: `EmptyState` component (icon=DatabaseBackup, title=
  `t("backups.empty")`, action=Create button) when no backups exist.
- **Create dialog**: optional note Input (max 500 chars). Submit button
  shows `<Loader2 animate-spin />` + `t("backups.creating")` during the
  POST. On success → toast `t("backups.created")` + refetch + close.
- **Restore confirmation** (`AlertDialog`): `t("backups.restoreConfirm")`
  message + the target filename/size/relative-time in an amber-tinted box.
  Confirm button shows `<Loader2 animate-spin />` +
  `t("backups.restoring")` during the call. On success → toast
  `t("backups.restoredOk")` + a separate `toast.info(warning)` surfacing
  the server-side restart caveat from the response payload.
- **Delete confirmation** (`AlertDialog`): `t("backups.deleteConfirm")`
  message + the target filename/size/relative-time in a rose-tinted box.
  Confirm button shows a spinner during the call. On success → toast
  `t("backups.deleted")`.
- **Verify** (inline in row): calls GET `/api/fgmp/backups/[id]/verify`.
  On `ok: true` → `toast.success(t("backups.verified"))`. On false →
  `toast.error(t("backups.verifyFailed"))`. Shows a spinner on the menu
  item while the request is in flight.
- **Download**: triggers a programmatic `<a download>` click
  (`triggerDownload(id, filename)` helper) — same-origin so the NextAuth
  cookie is sent automatically. No navigation away from the page.
- **i18n**: all visible strings via `t("...")`. Reused existing keys
  (`mgmt.*`, `common.cancel`, `common.close`, `tenants.createdAt`,
  `users.accessDeniedDescription`, `nav.backups`, `desc.backups`) in
  addition to the `backups.*` namespace the orchestrator already added.
  Zero modifications to `i18n.ts`.
- **Arabic-Indic numerals** via `formatNumber(n, numLang)` when
  `useArabicNumerals()` is true (counts + relative time). Byte sizes keep
  latin units per spec.
- **Color palette**: emerald (Create button, COMPLETED, good KPIs), rose
  (FAILED, delete confirmation), amber (warning card, Pre-restore badge,
  restore confirmation accent), violet (RESTORED badge, Scheduled badge),
  slate (muted paths, sha256 text). NO indigo or blue Tailwind classes.
- **Toast feedback** via sonner for create / restore / delete / verify
  success + all error paths.

### 4. .gitignore

Added `/backups/` entry so DB snapshot files don't get committed (the
`backups/` dir is created on-demand at runtime by `createBackup`).

## Quality gates

- `bun run lint` → **EXIT 0** (0 errors, 0 warnings).
- All 7 endpoints verified reachable via `curl`:
    GET    /api/fgmp/backups                    → 401
    POST   /api/fgmp/backups                    → 401
    GET    /api/fgmp/backups/some-id            → 401
    DELETE /api/fgmp/backups/some-id            → 401
    GET    /api/fgmp/backups/some-id/download   → 401
    POST   /api/fgmp/backups/some-id/restore    → 401
    GET    /api/fgmp/backups/some-id/verify     → 401
  All return 401 for unauthenticated requests, proving the route files
  compile + the `requireRole(ROLES.ADMIN_ONLY)` guard fires correctly.
- Home page (`/`) still returns HTTP 200 — the app-shell import of
  `BackupsView` now resolves cleanly (the previous "Module not found:
  '@/components/fgmp/views/backups-view'" errors in the dev log are gone).
- Zero modifications to shared/owned files (`schema.prisma`, `store.ts`,
  `app-shell.tsx`, `rbac.ts`, `i18n.ts`, any existing API route).

## Design notes / deviations from spec

- **`restoreBackup` return type**: spec says `Promise<void>`, but the
  route contract requires returning `{ preRestoreBackupId }` in the
  response payload. The only clean way to surface that id is to have the
  lib function return it. So `restoreBackup` returns
  `Promise<{ preRestoreBackupId: string }>`. The route handler simply
  forwards the value. No behavioral change to the restore flow itself.
- **Audit ownership**: the spec mentions auditing for both the lib
  functions AND the route handlers (which would double-audit). To avoid
  duplicate `AuditLog` rows, the audit happens exactly once per action:
  - `BACKUP_CREATE` — audited in the POST `/backups` route (createBackup
    itself does not audit, so the PRE_RESTORE snapshot taken inside
    `restoreBackup` doesn't generate a spurious BACKUP_CREATE entry).
  - `BACKUP_RESTORE` — audited inside `restoreBackup` (route does not
    re-audit).
  - `BACKUP_DELETE` — audited inside `deleteBackup` (route does not
    re-audit).
- **WAL/SHM cleanup on restore**: spec says "fs.copyFile(backupFilepath,
  DB_PATH) to overwrite the live DB" and notes "SQLite WAL mode handles
  this" for the backup direction. For the RESTORE direction, however,
  SQLite would still replay the old WAL on next access and undo the
  restore. To make the restore actually take effect, `restoreBackup`
  also `fs.unlink`s `{DB_PATH}-wal` and `{DB_PATH}-shm` (ignoring
  ENOENT). This is the standard SQLite practice for swapping the .db
  file under a live connection and is consistent with the spec's intent
  ("overwrite the live DB").
- **DB stats in API response**: spec says "return DB stats in a header
  or a separate field". Implemented as a wrapper JSON object
  `{ backups, dbSizeBytes, dbPath, backupDir }` — cleaner than custom
  response headers and lets the view consume it via a single `useApi`
  call. The view adapts its `useApi<BackupsResponse>` type accordingly.
- **Format bytes duplication**: the lib exports `formatBytes` (server-
  only, per spec), but the view also needs to format bytes client-side.
  Rather than refactor `src/lib/fgmp/format.ts` (a shared file) or
  create a new shared util, the view defines its own inline `formatBytes`
  helper with identical behavior. ~10 lines of duplication, no shared-
  file modifications.

## Files produced

- `src/lib/fgmp/backup.ts` (new, server-only)
- `src/app/api/fgmp/backups/route.ts` (new)
- `src/app/api/fgmp/backups/[id]/route.ts` (new)
- `src/app/api/fgmp/backups/[id]/download/route.ts` (new)
- `src/app/api/fgmp/backups/[id]/restore/route.ts` (new)
- `src/app/api/fgmp/backups/[id]/verify/route.ts` (new)
- `src/components/fgmp/views/backups-view.tsx` (replaced stub)
- `.gitignore` (added `/backups/` entry — only change to a shared file,
  and explicitly allowed by the task spec)
