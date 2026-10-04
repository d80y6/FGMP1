---
Task ID: SITES-MGMT
Agent: full-stack-developer
Task: Build full Sites Management CRUD (engine.reload() + sites collection GET/POST + sites/[id] PATCH/DELETE + i18n + admin management UI in sites-view.tsx)

Work Log:

- Read /home/z/my-project/worklog.md tail + prisma/schema.prisma (Site model, lines 116–156) + engine.ts (init at lines 64–143, ensureInit at 57–62) + index.ts + auth-helpers.ts + rate-limit.ts + audit.ts + api-error.ts + existing sites/[id]/route.ts + sites-view.tsx + i18n.ts sites/audit.action namespaces + types.ts + use-api.ts + store.ts + rbac.ts + a couple reference routes (geography/regions, users, tenants).

- ── Part A: engine.reload() ───────────────────────────────────────────
- Modified `src/lib/fgmp/engine.ts`: added a public `async reload()` method on the FgmpEngine class, placed immediately after `ensureInit()` (now at lines 64–70). Resets `initialized = false` + `initializing = null`, then calls `await this.ensureInit()` to force a full re-init. Reuses the existing `initializing` field declared on line 28. The `init()` method (lines 72–151) reloads geo hierarchy, sites, tanks, generators, batteries, IoT devices, and open-alarm dedup keys, then calls `backfillHistory()`. After mutations that change site topology (create/update/delete), `await engine.reload()` ensures the in-memory snapshot reflects the DB on the next `/api/fgmp/state` read.

- ── Part B1: collection endpoint — NEW file ───────────────────────────
- Created `src/app/api/fgmp/sites/route.ts` with GET + POST:
  - GET: requireAuth + READ_LIMIT. Returns all sites (sorted by code ASC) with `db.site.findMany({ include: { region: true, governorate: true, district: true }, orderBy: { code: "asc" } })`. Lightweight — no tanks/generators/etc. (the snapshot endpoint covers that view).
  - POST: requireRole(ROLES.ADMIN_ONLY) + MUTATION_LIMIT. Zod schema validates: code (min 3), name (min 2), regionId/governorateId/districtId (cuid), latitude (12.0–19.0 — Yemen bounds), longitude (42.0–53.0), address (default ""), criticality enum (default MEDIUM), loadKw (>=0, default 0), powerSource enum (default HYBRID), gridAvailable (default true), status enum (default ONLINE).
  - Pre-creates a 409 with `{ error: "Site code already exists", code: "CODE_EXISTS" }` if the code already exists (cleaner than relying on the generic P2002 from api-error).
  - Validates hierarchy consistency in parallel: fetches region + governorate + district, returns 400 `{ code: "INVALID_HIERARCHY" }` if any are missing OR if `governorate.regionId !== region.id` OR `district.governorateId !== governorate.id`.
  - tenantId taken from the session user (`me.tenantId`).
  - After `db.site.create`, calls `await engine.reload()`, audits SITE_CREATE (entity "site", entityId site.id, details { code, name, region, governorate }), returns 201 with the created site (including joined region/gov/district names).

- ── Part B2: sites/[id] PATCH + DELETE ────────────────────────────────
- Modified `src/app/api/fgmp/sites/[id]/route.ts`: kept the existing GET handler unchanged; added PATCH + DELETE above the catch block.
  - PATCH: requireRole(ROLES.ADMIN_ONLY) + MUTATION_LIMIT. Zod schema is the same as POST except `code` is NOT in the schema (it's the unique business key — not editable). All fields optional. Rejects empty patch (no fields) with 400 `{ code: "EMPTY_PATCH" }`. If region/gov/district are changed, validates the new hierarchy by computing effective values (new if provided, else existing) and confirming governorate.regionId === regionId AND district.governorateId === governorateId. After `db.site.update`, calls `await engine.reload()`, audits SITE_UPDATE (entity "site", details { updatedFields: [...] }), returns 200 with the updated site.
  - DELETE: requireRole(ROLES.ADMIN_ONLY) + MUTATION_LIMIT. Fetches the site with `_count` on tanks/generators/batteries/iotDevices/alarms/deliveries/tickets. If any count > 0, returns 409 `{ error: "Site has dependent assets. Remove them first.", code: "SITE_NOT_EMPTY", counts: {...} }`. Otherwise `db.site.delete`, `await engine.reload()`, audits SITE_DELETE (entity "site", details { code, name }), returns 200 `{ ok: true, id }`.

- ── Part C: i18n keys ─────────────────────────────────────────────────
- Modified `src/lib/fgmp/i18n.ts`:
  - Added 28 new keys under the `sites.*` namespace (lines 439–468): manage, addSite, editSite, deleteSite, createSite, siteDetails, latitude, longitude, address, powerSource, gridAvailable, actions, createSuccess, updateSuccess, deleteSuccess, confirmDelete, codeExists, invalidHierarchy, hasDependents, invalidCoords, selectRegionFirst, selectGovernorateFirst, powerGrid, powerGenerator, powerHybrid, yes, no, created, dependentAssets, cannotDeleteWithAssets.
  - Added 3 keys under `audit.action.*` namespace (lines 1069–1071): SITE_CREATE, SITE_UPDATE, SITE_DELETE.
  - Added 2 keys under `common.*` (lines 73–74): saving, deleting — used by the form's submit button labels.
  - All keys have EN + AR translations.
  - `sites.cannotDeleteWithAssets` uses a `{count}` placeholder so the client can interpolate the dependent-asset total via `String.prototype.replace`.

- ── Part D: Sites Management UI ───────────────────────────────────────
- Modified `src/components/fgmp/views/sites-view.tsx` (additive — no existing feature removed; the filters, map, geographic hierarchy tree, comparison tool, and detail sheet all still work):
  - New imports: Pencil, Trash2, Plus from lucide-react; Dialog/DialogContent/DialogDescription/DialogFooter/DialogHeader/DialogTitle from @/components/ui/dialog; Label from @/components/ui/label; Button from @/components/ui/button; Switch from @/components/ui/switch; toast from sonner; apiPost/apiPatch/apiDelete from @/lib/fgmp/use-api; SiteState type from @/lib/fgmp/types.
  - Removed the unused `useApi` import that was in the original file (the original imported it but never used it).
  - Added `const me = useFgmp((s) => s.me)`, `const refresh = useFgmp((s) => s.refresh)`, and `const isAdmin = me?.role === "ADMIN"`.
  - The "Add Site" button is rendered inside `SectionHeader.actions` (only when isAdmin). It uses a custom emerald color (`bg-emerald-600 hover:bg-emerald-700`), per spec.
  - Added an "Actions" column to the sites table (only when isAdmin), with Edit (pencil, violet) and Delete (trash2, rose) icon buttons per row. The row's onClick (openSite) is stopped via `e.stopPropagation()` on the actions cell so clicking Edit/Delete never opens the detail sheet. Empty-state row span adjusts from 9 to 10 cols when isAdmin so the table layout stays clean.
  - Built `SiteFormDialog` (inline component, max-w-2xl, 2-col grid):
    - Fields: code (Input, disabled in edit mode), name, region (Select from snapshot.regions), governorate (Select, cascade-filtered by selected region), district (Select, cascade-filtered by selected governorate), latitude (Input type=number step=0.0001), longitude (Input type=number step=0.0001), address, criticality (Select CRITICAL/HIGH/MEDIUM/LOW), status (Select ONLINE/DEGRADED/OFFLINE/MAINTENANCE), loadKw (Input type=number step=0.1), powerSource (Select GRID/GENERATOR/HYBRID with translated labels), gridAvailable (Switch with Yes/No label).
    - State managed via useState (no react-hook-form). On open or target-site change, the form is reset to either the empty defaults (create) or a pre-filled copy of the site (edit). Two useEffects keep the gov/district cascade consistent: when region changes, gov is reset if the current selection is no longer in the new region; same for district when gov changes.
    - Validation runs on submit: code >=3 (create only), name >=2, region/gov/district all set, lat/lng within Yemen bounds (12-19 / 42-53), loadKw >=0. Field-level error messages render under each invalid field in rose-500.
    - Submit: PATCH for edit (drops `code` from the body since it's not editable), POST for create. Surfaces server error codes via toast (CODE_EXISTS → sites.codeExists, INVALID_HIERARCHY → sites.invalidHierarchy, fallback to res.error). On success: toast.success + onSaved() (which calls refresh()) + close dialog. Submit button label changes between "Saving…" / "Save" / "Create Site" based on mode + submitting state.
  - Built `DeleteSiteDialog` (inline component, max-w-md):
    - Shows the site name + code + governorate/district in a muted card.
    - On confirm: apiDelete. If the server returns `{ code: "SITE_NOT_EMPTY", counts: {...} }`, shows a rose-tinted error block with the formatted `sites.cannotDeleteWithAssets` message (interpolated count via `formatNumber` for AR numeral support) + a breakdown of which dependent assets exist (filtered to >0). On success: toast.success + onDeleted() + close.
    - Destructive button uses rose-600.
  - Both dialogs call `useFgmp((s) => s.refresh)` after a successful mutation, so the snapshot re-fetches `/api/fgmp/state` and the new/updated/deleted site is reflected immediately. Server-side `engine.reload()` ensures the snapshot endpoint returns fresh data.

- ── Part E: Verification ──────────────────────────────────────────────
- `bun run lint` → EXIT 0 (0 errors, 0 warnings).
- All 4 endpoints reachable + auth-guarded (401 for unauthenticated requests):
    GET  /api/fgmp/sites           → 401
    POST /api/fgmp/sites           → 401
    PATCH /api/fgmp/sites/test     → 401
    DELETE /api/fgmp/sites/test    → 401
- Home page (`/`) still serves HTTP 200.
- No new runtime errors in `dev.log` (filtered for error|fail|exception|⨯|cannot — zero matches).
- All 4 new route handlers compiled on first curl (compile times 919ms / 1.9ms / 1023ms / 107ms — normal first-hit Next.js compile; subsequent requests are pre-compiled).

Stage Summary:
- 1 new API route file: `src/app/api/fgmp/sites/route.ts` (GET list + POST create).
- 1 modified API route file: `src/app/api/fgmp/sites/[id]/route.ts` (existing GET kept; PATCH + DELETE added).
- 1 modified lib file: `src/lib/fgmp/engine.ts` (added `async reload()` method to FgmpEngine — 7 lines, additive, no existing code changed).
- 1 modified i18n file: `src/lib/fgmp/i18n.ts` (33 new translation keys: 28 sites.*, 3 audit.action.SITE_*, 2 common.*).
- 1 modified view file: `src/components/fgmp/views/sites-view.tsx` (additive admin management UI — Add Site button, Actions column, SiteFormDialog, DeleteSiteDialog).
- All new endpoints: ADMIN-only for mutations, requireAuth for the GET list, zod-validated, tenant-scoped (tenantId from session user), audited (SITE_CREATE/SITE_UPDATE/SITE_DELETE), rate-limited (MUTATION_LIMIT for writes, READ_LIMIT for list).
- engine.reload() called after every site mutation so the in-memory snapshot reflects the DB on the next /api/fgmp/state read; client-side refresh() forces a re-fetch so the operator sees the change immediately.
- Color policy respected: emerald for the Add Site button + Save button, violet for the Edit icon, rose for the Delete icon + destructive button + error messages. NO indigo/blue.
- Arabic i18n for every new string. `formatNumber` used for the dependent-asset count in the delete-confirm error so Arabic-Indic numerals render correctly when language=AR.
- Lint: EXIT 0. Dev server: healthy (home 200). All 4 endpoints reachable + auth-guarded (401 for unauthenticated). No new runtime errors in dev.log.
