# Task GAP-A — API Keys & Tokens admin module

**Agent:** full-stack-developer (API Keys module)
**Task:** Build API Keys & Tokens admin module (3 API routes + 1 view replacement)

## What was built

### 1. API routes (all ADMIN-only, rate-limited, audited, tenant-scoped)

- `src/app/api/fgmp/api-keys/route.ts`
  - `GET` — list all keys for the current tenant (NEVER selects `keyHash`),
    includes `createdBy: { id, name, email, role }`, orderBy `createdAt desc`,
    take 200. Rate-limited at `READ_LIMIT`.
  - `POST` — zod-validated `{ name: 2-80, scopes: string ≤200, expiresInDays:
    int 1-3650 | null }`. Generates plaintext = `fgmp_` + 32 random hex bytes
    (`crypto.randomBytes(32).toString("hex")`, 70 chars total). Computes
    `keyHash = sha256(plaintext)` via `crypto.createHash("sha256")`,
    `prefix = plaintext.slice(0, 12)`, `expiresAt = now + days*86400000` or
    null. Persists row with `tenantId: me.tenantId`, `createdById: me.id`.
    Audits `APIKEY_CREATE`. Returns **201 with the plaintext token in the body
    `{ ...safeFields, token }`** — the only time it ever leaves the server.
    Rate-limited at `MUTATION_LIMIT`.

- `src/app/api/fgmp/api-keys/[id]/route.ts`
  - `GET` — single key by id (must match `tenantId === me.tenantId`); never
    returns `keyHash`. 404 if not found / cross-tenant.
  - `PATCH` — zod-validated optional `name` + `scopes`. Cannot mutate
    `keyHash`, `prefix`, `expiresAt`, `revokedAt`. 404 / 403 for cross-tenant.
    Audits `APIKEY_UPDATE` with `{ before, after }` details. No-op patch
    returns current row.
  - `DELETE` — SOFT delete (revoke). Sets `revokedAt = new Date()`. 404 / 403
    for cross-tenant, 409 if already revoked. Audits `APIKEY_REVOKE`.
    Rate-limited at `MUTATION_LIMIT`.

- `src/app/api/fgmp/api-keys/stats/route.ts`
  - `GET` — returns `{ total, active, revoked, expired, expiringSoon }` for
    the current tenant, computed via 5 parallel `db.apiKey.count()` queries.
    `active` = revokedAt null AND (expiresAt null OR > now). `expired` =
    revokedAt null AND expiresAt ≤ now. `expiringSoon` = revokedAt null AND
    expiresAt > now AND ≤ now+7d.

### 2. View: `src/components/fgmp/views/api-keys-view.tsx` (replaced stub)

Mirrors `tenants-view.tsx` structure. Key elements:

- **SectionHeader** with title `t("nav.apiKeys")`, description
  `t("desc.apiKeys")`, icon `<KeyRound />`, tone `violet`.
- **KPI strip** (5 cards): Total Keys, Active, Revoked, Expired, Expiring
  ≤7d. Pulled from `useApi("/api/fgmp/api-keys/stats")` (20s poll).
  Tone: active=good, revoked=danger, expired=warn, expiringSoon=warn.
  All numbers localized via `formatNumber(n, numLang)`.
- **Main table card** with header (title + filtered count + search Input +
  "Generate New Key" Button). Search filters by `name + prefix +
  createdBy.name`.
- **Table columns**: Label (name + prefix mono), Scopes (badges),
  Created By (name + role badge via `role.{ROLE}`), Created (relative +
  absolute via `timeAgo`/`fmtDateTime`), Last Used (relative or "Never
  used"), Expires (relative or "Never", red if expired), Status
  (Active/Revoked/Expired pill), Actions (Edit + Revoke dropdown).
- **Scroll container**: `max-h-[600px] overflow-y-auto` with sticky header
  (`sticky top-0 z-10 bg-card`).
- **Loading state**: `KpiCardSkeleton × 5` + `TableSkeleton(rows=6, cols=7)`
  while initial load.
- **Empty state**: `EmptyState` component with `KeyRound` icon, the
  `apiKeys.empty` message, and a "Generate New Key" action button when no
  keys exist at all.
- **Create dialog**: name Input (2-80 chars), scopes Input (with hint text),
  expiry Select (7/30/90 days / Never). On POST success → switches to
  **one-time token reveal** mode: read-only Input with the plaintext + Copy
  button (uses `navigator.clipboard.writeText` with input-select fallback) +
  warning text `t("apiKeys.tokenReveal")` + usage hint. The dialog CANNOT be
  dismissed (overlay click, ESC, X button all blocked via
  `onPointerDownOutside` / `onInteractOutside` / `onEscapeKeyDown`
  `e.preventDefault()` while `revealToken` is set). Only the explicit "I've
  copied it" button (`common.close`) closes it — bypassing the block by
  calling `onOpenChange(false)` + `onDone()` directly.
- **Edit dialog**: name + scopes only (no expiry edit). Shows the immutable
  prefix in a muted info box for context.
- **Revoke confirmation**: `AlertDialog` with `t("apiKeys.revokeConfirm")`
  message + the key name + prefix in a rose-tinted box. Calls DELETE; on 409
  (already revoked) shows a friendly toast.
- **i18n**: all visible strings via `t("...")`. No hardcoded English. Reused
  existing keys (`mgmt.*`, `common.close`, `tenants.createdAt`, `role.*`,
  `users.accessDenied*`) in addition to the `apiKeys.*` namespace the
  orchestrator already added. Zero modifications to `i18n.ts`.
- **Arabic-Indic numerals** via `formatNumber(n, numLang)` when
  `useArabicNumerals()` is true.
- **Color palette**: emerald (active/good), rose (revoked/danger), amber
  (expiring/warn), slate (muted scopes), violet (role badges, section accent).
  NO indigo or blue anywhere.
- **Toast feedback** via sonner for create / update / revoke success + all
  error paths.

## Quality gates

- `bun run lint` → **EXIT 0** (0 errors, 0 warnings).
- All 3 API routes verified reachable via `curl` (return 401 for
  unauthenticated requests, proving the route files compile + the
  `requireRole(ROLES.ADMIN_ONLY)` guard fires correctly).
- Home page (`/`) still returns HTTP 200 — the app-shell import of
  `ApiKeysView` now resolves cleanly.
- Zero modifications to shared/owned files (`schema.prisma`, `store.ts`,
  `app-shell.tsx`, `rbac.ts`, `i18n.ts`, other API routes).

## Files produced

- `src/app/api/fgmp/api-keys/route.ts` (new)
- `src/app/api/fgmp/api-keys/[id]/route.ts` (new)
- `src/app/api/fgmp/api-keys/stats/route.ts` (new)
- `src/components/fgmp/views/api-keys-view.tsx` (replaced stub)
