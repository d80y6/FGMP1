# Task 33-A — Notification Preferences Builder

Task: Add per-user notification preferences with Prisma model, API, and preferences view.

## Work Log

### Phase 1 — Prisma schema (`prisma/schema.prisma`)
- Added `NotificationPreference` model with fields: `id`, `userId` (unique),
  `inAppEnabled`, `emailEnabled`, `smsEnabled` (booleans with channel defaults),
  `inAppSeverities` ("L1,L2,L3"), `emailSeverities` ("L2,L3"),
  `smsSeverities` ("L3") comma-separated strings, `quietHoursStart` /
  `quietHoursEnd` (nullable Int 0-23), `emailOverride` / `phoneOverride`
  (nullable String), `updatedAt`.
- Added `notificationPreference NotificationPreference?` 1:1 relation to
  the `User` model.
- Relation: `user User @relation(fields: [userId], references: [id], onDelete: Cascade)`
  so deleting a user cascades to their prefs.
- Ran `bun run db:push` — schema applied successfully (Prisma v6.19.2,
  SQLite). Generated Prisma Client updated.

### Phase 2 — Zod schema (`src/lib/fgmp/schemas.ts`)
- Added `notificationPreferenceSchema` per spec: booleans for channel
  toggles, regex-validated severity strings (`/^[L1-3,]+$/`), nullable
  integers (0-23) for quiet hours, nullable/empty-string email+phone
  overrides.
- Exported `NotificationPreferenceInput` type alias for the form.

### Phase 3 — API endpoints
- `src/app/api/fgmp/preferences/route.ts` (NEW):
  - **GET**: returns the current user's notification preferences. Any
    authenticated user (`requireAuth`). If no row exists yet, upserts one
    with the Prisma defaults (so the first GET auto-creates the record).
    Rate-limited via `READ_LIMIT` (300/min per user), `X-RateLimit-*` headers.
  - **PUT**: updates the current user's preferences. Any authenticated
    user (users can only edit their own — `userId` is stamped from the
    session, not the body). Validates with `notificationPreferenceSchema`
    via `validateBody`. Server-side guards: empty-string overrides → null,
    both quiet-hours fields must be set or both null (no half-defined
    windows). Audits `PREFERENCES_UPDATE`. Rate-limited via `MUTATION_LIMIT`.
- `src/app/api/fgmp/preferences/[userId]/route.ts` (NEW, ADMIN-only):
  - **GET**: fetch any user's preferences. Tenant-scoped (admin can only
    manage users in their own tenant — 404 if userId not found or cross-
    tenant). Returns the prefs alongside the target user's profile (id,
    name, email, role) so the admin UI can render "Editing preferences
    for: <name>" without a second round-trip. Auto-upserts with defaults
    if no row exists.
  - **PUT**: update any user's preferences. userId is taken from the URL
    (not the body) so a client cannot overwrite another user's prefs by
    passing a different id in the JSON payload. Same validation +
    normalization as the self-service PUT. Audits `PREFERENCES_ADMIN_UPDATE`
    with `targetUserId` + `targetEmail` in the details for traceability.
- Both routes use `force-dynamic`, `errorResponse()` for error handling,
  and the standard FGMP auth/rate-limit/audit pattern (mirrors the
  existing suppressions routes).

### Phase 4 — i18n (`src/lib/fgmp/i18n.ts`)
- Added 38 keys under `preferences.*` namespace (76 strings total EN+AR):
  - Header: title, subtitle
  - Channels: inApp, email, sms, inAppFull, emailFull, smsFull, inAppDesc,
    emailDesc, smsDesc
  - Toggles: enable, disable, enabled, disabled
  - Severity: severityFilter, severityL1/L2/L3 (full + short labels)
  - Quiet hours: quietHours, quietHoursDesc, start, end, timezone,
    enableQuietHours, criticalAlarmsAlways, astTimezone, allDay
  - Overrides: emailOverride, phoneOverride, emailOverridePlaceholder,
    phoneOverridePlaceholder
  - Actions: save, saving, saved, reset, resetConfirm, resetDone
  - Errors: loading, fetchError, saveError, atLeastOneSeverity, invalidTimeRange
  - Summary: summary, summaryChannels, summaryQuietHours, noQuietHours
- Also added `nav.preferences` + `nav.group.account` keys.
- Arabic translations follow MSA enterprise register (e.g.
  "تفضيلات الإشعارات", "خصّص الإنذارات التي تتلقاها وكيفية استلامها",
  "داخل التطبيق", "البريد الإلكتروني", "الرسائل النصية", "ساعات الهدوء",
  "سيتم كتم الإشعارات داخل التطبيق خلال هذه الساعات (توقيت AST).
  الإنذارات الحرجة L3 تظل تطلق تنبيهات مسموعة.").

### Phase 5 — View (`src/components/fgmp/views/preferences-view.tsx`, NEW)
- `'use client'` view component, ~800 lines.
- **Header** (SectionHeader): title + subtitle + AST timezone chip.
- **Channel cards** (3-col grid on lg, 1-col on mobile) via reusable
  `ChannelCard` component:
  - **In-App** (Bell icon, emerald tone): toggle + 3 severity checkboxes
    (L1 amber / L2 orange / L3 rose, matching StatusBadge convention) +
    a quiet-hours status pill showing the current window (or "off").
  - **Email** (Mail icon, violet tone): toggle + severity checkboxes +
    email override input (placeholder shows current user email from
    `me.email`).
  - **SMS** (MessageSquare icon, amber tone): toggle + severity checkboxes
    + phone override input.
  - All three cards dim to `opacity-50` when their channel is disabled.
- **Quiet Hours card** (Moon icon, violet tone): toggle + two Selects
  (start/end with 24h options 00:00 → 23:00) + a 24-segment visual
  timeline bar showing the quiet period highlighted in violet (handles
  wrap-past-midnight windows like 22→6 correctly) + helper text +
  AST timezone label + critical-alarms-still-audible note.
- **Summary card**: shows enabled channel count + quiet hours window
  (or "off") + dirty indicator.
- **Sticky bottom action bar**: Save (primary, with check icon when
  clean, disabled when not dirty or saving) + Reset to defaults (ghost
  secondary, with confirmation dialog).
- Auto-loads preferences on mount via GET, normalizes nulls to "" for
  form input values, resets the form with loaded data.
- Form managed by `react-hook-form` + `zodResolver` using the shared
  `notificationPreferenceSchema`. Submit handler validates, PUTs to the
  API, toasts success/error.
- Client-side integrity checks beyond Zod: each enabled channel must
  have ≥1 severity selected; quiet hours start ≠ end (when enabled).
- Loading state (skeleton cards), error state (destructive Alert with
  raw error message), full EN/AR i18n with `useT()` and `formatNumber()`.
- RTL-aware: every text container sets `dir={dir === "rtl" ? "rtl" : undefined}`;
  the 24h timeline bar is forced LTR (dir="ltr") so it always reads
  left-to-right regardless of UI language.
- shadcn/ui components used: Card, CardHeader, CardTitle, CardDescription,
  CardContent, Switch, Checkbox, Badge, Button, Input, Label, Separator,
  Skeleton, Alert, AlertTitle, AlertDescription, Select, SelectContent,
  SelectItem, SelectTrigger, SelectValue.
- Lucide icons: Bell, Mail, MessageSquare, Moon, Volume2, VolumeX, Save,
  RotateCcw, Clock, Check, AlertCircle, Loader2.

### Phase 6 — Navigation (`src/components/fgmp/app-shell.tsx`)
- Imported `Bell` icon + `PreferencesView` component.
- Added nav item: `key: "preferences"`, `tKey: "nav.preferences"`,
  `icon: Bell`, `cap: "view:preferences"`, `group: "Account"`,
  `groupTKey: "nav.group.account"`. Placed at the END of the NAV array
  so the Account section appears last in the sidebar (after Administration).
- Added `preferences: PreferencesView` to the `VIEW_COMPONENTS` map.

### Phase 7 — RBAC (`src/lib/fgmp/rbac.ts`)
- Added `view:preferences` capability to every non-ADMIN role's capability
  list: NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY.
  ADMIN already has the wildcard `*` capability so the item is visible to
  them automatically.
- This makes the Preferences nav item visible to ALL authenticated users
  (per spec: "Visible to ALL authenticated users (not just admin)").

### Phase 8 — Store (`src/lib/fgmp/store.ts`)
- Added `"preferences"` to the `ViewKey` union so `setView("preferences")`
  type-checks and the URL `?view=preferences` round-trips through the
  app-shell's URL-sync effect.

### Phase 9 — Verification
- `bun run db:push` → schema applied successfully.
- `bun run lint` → 0 errors, 0 warnings.
- Dev server compiles cleanly (`✓ Compiled in 502ms`).
- `GET /api/fgmp/preferences` without session → 401 (auth enforced correctly).
- `GET /api/fgmp/preferences/some-user-id` without session → 401 (auth enforced).
- `GET /` → 200 (app shell still renders).
- No runtime errors in dev.log related to my code.

## Stage Summary

NEW FILES (3):
  ✓ src/app/api/fgmp/preferences/route.ts (GET + PUT self)
  ✓ src/app/api/fgmp/preferences/[userId]/route.ts (GET + PUT admin)
  ✓ src/components/fgmp/views/preferences-view.tsx (full UI)
  ✓ agent-ctx/33-A-notification-preferences.md (this work record, mirrored)

MODIFIED FILES (5):
  ✓ prisma/schema.prisma (NotificationPreference model + User relation)
  ✓ src/lib/fgmp/schemas.ts (notificationPreferenceSchema + type)
  ✓ src/lib/fgmp/i18n.ts (+38 preferences.* keys + 2 nav keys = 80 strings EN+AR)
  ✓ src/lib/fgmp/rbac.ts (view:preferences capability on all roles)
  ✓ src/lib/fgmp/store.ts (ViewKey += "preferences")
  ✓ src/components/fgmp/app-shell.tsx (nav item + view registration + Bell icon import)

LINT: 0 errors
DEV SERVER: healthy (compiles cleanly, GET / → 200, /api/fgmp/preferences → 401 unauth'd)
RUNTIME: no errors in dev.log related to my code

DELIVERABLES:
  ✓ Prisma NotificationPreference model (1:1 with User, cascade delete)
  ✓ /api/fgmp/preferences (GET self + PUT self) — any authenticated user
  ✓ /api/fgmp/preferences/[userId] (GET any + PUT any) — ADMIN-only,
    tenant-scoped
  ✓ Zod notificationPreferenceSchema with regex severity validation
  ✓ preferences-view.tsx — channel cards (In-App/Email/SMS), quiet hours
    with 24h timeline bar, sticky Save + Reset, react-hook-form + zod
  ✓ 38 i18n keys × 2 = 76 strings (EN + AR MSA enterprise register)
  ✓ Nav item in new "Account" section, visible to all authenticated users
  ✓ Full EN/AR bilingual support with RTL + Arabic-Indic numerals
  ✓ Audited mutations (PREFERENCES_UPDATE, PREFERENCES_ADMIN_UPDATE)
  ✓ Rate-limited endpoints (READ_LIMIT on GET, MUTATION_LIMIT on PUT)
