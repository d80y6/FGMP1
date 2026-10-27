# FGMP1 RBAC Reference Catalog and Effective Matrix

> Generated from `ROLE_PERMISSIONS`, the canonical `CAPABILITIES` catalog, the actual App Router tree, and the route authorization policy. Regenerate with `bun run scripts/verify/generate-rbac-reference.ts`. Do not edit generated tables by hand.

**Generated:** 2026-10-27 · **Roles:** 7 · **Capabilities:** 52 · **API handlers scanned:** 171

## Authorization semantics

- `✓` means the role holds the capability in the canonical matrix. `—` means it does not. SUPERADMIN's explicit `*` wildcard resolves to all catalog capabilities; it does not bypass tenant RLS or resource scoping.
- Capability grants are not standalone access to arbitrary records. Tenant roles are scoped to the tenant ID resolved from their revalidated session. Record reads and mutations must also use tenant-scoped queries / FORCE RLS. No user-to-site/region membership model exists in the current schema.
- `SUPERADMIN_ONLY_CAPABILITIES` are platform-control-plane permissions. Tenant role assignments cannot grant these; customer operational data remains available to platform staff only through the controlled support-session flow (or narrowly specified tenant user-administration APIs).
- There is no role inheritance. Roles are explicit allow-lists, except SUPERADMIN's platform wildcard. The `REGIONAL_MANAGER` role currently applies across its whole tenant; the schema does not model per-region memberships, so the role name is not a geographic row-level boundary.
- Current permission IDs retain the established colon vocabulary (`view:<surface>` and `<domain>:<action>`) for backward compatibility. Scope is documented separately and always enforced at server/data boundaries.

## Role catalog

| Identifier | Name | Scope | Purpose and boundaries |
|---|---|---|---|
| `SUPERADMIN` | Platform Super-Admin | Platform control plane; customer content only via named support access | Cross-tenant platform owner. Creates tenants and tenant administrators, manages all platform data. Tenant registry, platform audit/grants/support and global firmware. Ordinary tenant queries remain pinned to the platform tenant; support access is tenant-specific, time-boxed, and mode-gated. |
| `ADMIN` | Tenant Administrator | One authenticated tenant | Manages users, sites, and configuration within their tenant. Cannot create tenants or super-admins. Tenant user and role administration, configuration and business records within own tenant. Cannot create tenants, grant SUPERADMIN, or access platform control-plane data. |
| `NOC_OPERATOR` | NOC Operator | One authenticated tenant | Monitor, acknowledge/resolve alarms, remote generator control. Monitoring, alarm actions, generator/dispenser control, notifications and simulation tick. No user, asset, platform, or configuration administration. |
| `REGIONAL_MANAGER` | Regional Manager | One authenticated tenant (not a region boundary) | Regional oversight, reports, deliveries, maintenance scheduling. Operations oversight, reports, delivery and maintenance actions. No user/membership or platform administration; per-region restriction is not represented by current schema. |
| `FIELD_ENGINEER` | Field Engineer | One authenticated tenant | Execute maintenance, verify deliveries, view telemetry. Field maintenance and delivery work plus hands-on dispenser control. No user/role administration, asset registry administration, platform control, or global setting changes. |
| `EXECUTIVE` | Executive | One authenticated tenant | KPIs, analytics, reports, national overview. Read-only business and operational visibility; no control or administrative actions. |
| `READONLY` | Read-Only | One authenticated tenant | View all monitoring data; no control actions. Read-only monitoring and audit visibility; no control or administrative actions. |

## Permission catalog

This is the complete closed capability vocabulary. Related routes are derived from the actual route policy; parameter-sensitive exports/projections are additionally constrained in the handler. `SUPERADMIN_ONLY` is a flag for platform-only scope, not an extra grant over the explicit wildcard behavior.

| Capability | Module / action | Scope | Description | Related API handlers |
|---|---|---|---|---|
| `alarm:ack` | alarm / ack | Tenant-scoped | Allow the ack operation in the alarm module; this does not imply other actions such as delete, export, or platform administration. | `POST /api/fgmp/alarms`, `GET /api/fgmp/metrics`, `GET /api/fgmp/ops/alerts/preview`, `PATCH /api/fgmp/shift-handover/[id]`, `POST /api/fgmp/shift-handover` |
| `alarm:configure` | alarm / configure | Tenant-scoped | Allow the configure operation in the alarm module; this does not imply other actions such as delete, export, or platform administration. | `POST /api/fgmp/correlation/evaluate`, `GET /api/fgmp/correlation/matches`, `PATCH /api/fgmp/correlation/rules/[id]`, `DELETE /api/fgmp/correlation/rules/[id]`, `GET /api/fgmp/correlation/rules`, `POST /api/fgmp/correlation/rules` |
| `alarm:resolve` | alarm / resolve | Tenant-scoped | Allow the resolve operation in the alarm module; this does not imply other actions such as delete, export, or platform administration. | `POST /api/fgmp/alarms` |
| `alarm:suppress` | alarm / suppress | Tenant-scoped | Allow the suppress operation in the alarm module; this does not imply other actions such as delete, export, or platform administration. | `PATCH /api/fgmp/suppressions/[id]`, `POST /api/fgmp/suppressions` |
| `api-key:manage` | api-key / manage | Tenant-scoped | Allow the manage operation in the api key module; this does not imply other actions such as delete, export, or platform administration. | `PATCH /api/fgmp/api-keys/[id]`, `POST /api/fgmp/api-keys` |
| `asset:manage` | asset / manage | Tenant-scoped | Allow the manage operation in the asset module; this does not imply other actions such as delete, export, or platform administration. | `PATCH /api/fgmp/batteries/[id]`, `DELETE /api/fgmp/batteries/[id]`, `POST /api/fgmp/batteries`, `PATCH /api/fgmp/dispensers/[id]`, `DELETE /api/fgmp/dispensers/[id]`, `POST /api/fgmp/dispensers`, `POST /api/fgmp/generators/[id]/control`, `PATCH /api/fgmp/generators/[id]`, `DELETE /api/fgmp/generators/[id]`, `POST /api/fgmp/generators`, `POST /api/fgmp/seed`, `PATCH /api/fgmp/sites/[id]`, `DELETE /api/fgmp/sites/[id]`, `POST /api/fgmp/sites`, `PATCH /api/fgmp/solar-arrays/[id]`, `DELETE /api/fgmp/solar-arrays/[id]`, `POST /api/fgmp/solar-arrays`, `PATCH /api/fgmp/solar-sites/[id]`, `DELETE /api/fgmp/solar-sites/[id]`, `POST /api/fgmp/solar-sites`, `PATCH /api/fgmp/tanks/[id]`, `DELETE /api/fgmp/tanks/[id]`, `POST /api/fgmp/tanks` |
| `delivery:approve` | delivery / approve | Tenant-scoped | Allow the approve operation in the delivery module; this does not imply other actions such as delete, export, or platform administration. | UI/secondary guard; see route-specific policy |
| `delivery:manage` | delivery / manage | Tenant-scoped | Allow the manage operation in the delivery module; this does not imply other actions such as delete, export, or platform administration. | `POST /api/fgmp/deliveries/[id]/cancel`, `POST /api/fgmp/deliveries/[id]/deliver`, `POST /api/fgmp/deliveries`, `PATCH /api/fgmp/shift-handover/[id]`, `POST /api/fgmp/shift-handover` |
| `delivery:verify` | delivery / verify | Tenant-scoped | Allow the verify operation in the delivery module; this does not imply other actions such as delete, export, or platform administration. | UI/secondary guard; see route-specific policy |
| `dispenser:control` | dispenser / control | Tenant-scoped | Allow the control operation in the dispenser module; this does not imply other actions such as delete, export, or platform administration. | `POST /api/fgmp/dispensers/[id]/control`, `POST /api/fgmp/edge/esp/[dispenserId]/reboot`, `POST /api/fgmp/edge/firmware/deploy` |
| `edge:manage` | edge / manage | Tenant-scoped | Allow the manage operation in the edge module; this does not imply other actions such as delete, export, or platform administration. | `POST /api/fgmp/edge/gateways/[id]`, `PATCH /api/fgmp/edge/gateways/[id]`, `DELETE /api/fgmp/edge/gateways/[id]`, `POST /api/fgmp/iot`, `PATCH /api/fgmp/iot` |
| `gen:control` | gen / control | Tenant-scoped | Allow the control operation in the gen module; this does not imply other actions such as delete, export, or platform administration. | `GET /api/fgmp/generators/[id]/control/[commandId]`, `POST /api/fgmp/generators/[id]/control` |
| `geography:manage` | geography / manage | Tenant-scoped | Allow the manage operation in the geography module; this does not imply other actions such as delete, export, or platform administration. | `PATCH /api/fgmp/geography/districts/[id]`, `DELETE /api/fgmp/geography/districts/[id]`, `POST /api/fgmp/geography/districts`, `PATCH /api/fgmp/geography/governorates/[id]`, `DELETE /api/fgmp/geography/governorates/[id]`, `POST /api/fgmp/geography/governorates`, `PATCH /api/fgmp/geography/regions/[id]`, `DELETE /api/fgmp/geography/regions/[id]`, `POST /api/fgmp/geography/regions` |
| `notification:manage` | notification / manage | Tenant-scoped | Allow the manage operation in the notification module; this does not imply other actions such as delete, export, or platform administration. | `POST /api/fgmp/notifications` |
| `role:preview` | role / preview | Tenant-scoped | Allow the preview operation in the role module; this does not imply other actions such as delete, export, or platform administration. | `POST /api/fgmp/me/preview-role` |
| `settings:manage` | settings / manage | Tenant-scoped | Allow the manage operation in the settings module; this does not imply other actions such as delete, export, or platform administration. | `PATCH /api/fgmp/interlocks/thresholds/[id]`, `DELETE /api/fgmp/interlocks/thresholds/[id]`, `POST /api/fgmp/interlocks/thresholds`, `PATCH /api/fgmp/settings`, `DELETE /api/fgmp/shift-handover/[id]`, `DELETE /api/fgmp/suppressions/[id]` |
| `simul:tick` | simul / tick | Tenant-scoped | Allow the tick operation in the simul module; this does not imply other actions such as delete, export, or platform administration. | `GET /api/fgmp/tick`, `POST /api/fgmp/tick` |
| `ticket:assign` | ticket / assign | Tenant-scoped | Allow the assign operation in the ticket module; this does not imply other actions such as delete, export, or platform administration. | UI/secondary guard; see route-specific policy |
| `ticket:complete` | ticket / complete | Tenant-scoped | Allow the complete operation in the ticket module; this does not imply other actions such as delete, export, or platform administration. | UI/secondary guard; see route-specific policy |
| `ticket:create` | ticket / create | Tenant-scoped | Allow the create operation in the ticket module; this does not imply other actions such as delete, export, or platform administration. | UI/secondary guard; see route-specific policy |
| `ticket:manage` | ticket / manage | Tenant-scoped | Allow the manage operation in the ticket module; this does not imply other actions such as delete, export, or platform administration. | `POST /api/fgmp/maintenance/[id]/assign`, `POST /api/fgmp/maintenance/[id]/progress`, `POST /api/fgmp/maintenance`, `PATCH /api/fgmp/shift-handover/[id]`, `POST /api/fgmp/shift-handover` |
| `user:manage` | user / manage | Tenant-scoped | Allow the manage operation in the user module; this does not imply other actions such as delete, export, or platform administration. | `POST /api/fgmp/mfa/reset`, `PUT /api/fgmp/preferences/[userId]`, `POST /api/fgmp/users/[id]/reset-password`, `PUT /api/fgmp/users/[id]`, `PATCH /api/fgmp/users/[id]`, `DELETE /api/fgmp/users/[id]`, `POST /api/fgmp/users` |
| `view:alarms` | view / alarms | Tenant-scoped | Read/use the alarms application surface; mutations are separately authorized. | `GET /api/fgmp/alarms/[id]`, `GET /api/fgmp/alarms` |
| `view:analytics` | view / analytics | Tenant-scoped | Read/use the analytics application surface; mutations are separately authorized. | `GET /api/fgmp/analytics` |
| `view:api-keys` | view / api-keys | Tenant-scoped | Read/use the api keys application surface; mutations are separately authorized. | `GET /api/fgmp/api-keys/[id]`, `GET /api/fgmp/api-keys`, `GET /api/fgmp/api-keys/stats` |
| `view:asset-registry` | view / asset-registry | Tenant-scoped | Read/use the asset registry application surface; mutations are separately authorized. | `GET /api/fgmp/history/[entityId]`, `GET /api/fgmp/solar-arrays/[id]`, `GET /api/fgmp/solar-arrays`, `GET /api/fgmp/solar-sites/[id]`, `GET /api/fgmp/solar-sites` |
| `view:audit` | view / audit | Tenant-scoped | Read/use the audit application surface; mutations are separately authorized. | `GET /api/fgmp/audit` |
| `view:batteries` | view / batteries | Tenant-scoped | Read/use the batteries application surface; mutations are separately authorized. | `GET /api/fgmp/batteries/[id]`, `GET /api/fgmp/batteries`, `GET /api/fgmp/history/[entityId]` |
| `view:consumption-patterns` | view / consumption-patterns | Tenant-scoped | Read/use the consumption patterns application surface; mutations are separately authorized. | `GET /api/fgmp/patterns` |
| `view:dashboard` | view / dashboard | Tenant-scoped | Read/use the dashboard application surface; mutations are separately authorized. | `GET /api/fgmp/fuel/runout-eta`, `GET /api/fgmp/notifications`, `GET /api/fgmp/shift-handover/[id]`, `GET /api/fgmp/shift-handover`, `GET /api/fgmp/state` |
| `view:dispensers` | view / dispensers | Tenant-scoped | Read/use the dispensers application surface; mutations are separately authorized. | `GET /api/fgmp/dispensers/[id]/commands`, `GET /api/fgmp/dispensers/[id]`, `GET /api/fgmp/dispensers/reports`, `GET /api/fgmp/dispensers`, `GET /api/fgmp/dispensers/transactions` |
| `view:edge-firmware` | view / edge-firmware | Tenant-scoped | Read/use the edge firmware application surface; mutations are separately authorized. | `GET /api/fgmp/edge/firmware/deployments`, `GET /api/fgmp/edge/firmware`, `GET /api/fgmp/edge/gateways`, `GET /api/fgmp/edge/rs485` |
| `view:fuel` | view / fuel | Tenant-scoped | Read/use the fuel application surface; mutations are separately authorized. | `GET /api/fgmp/history/[entityId]`, `GET /api/fgmp/tanks/[id]`, `GET /api/fgmp/tanks` |
| `view:fuel-forecast` | view / fuel-forecast | Tenant-scoped | Read/use the fuel forecast application surface; mutations are separately authorized. | `GET /api/fgmp/forecast`, `GET /api/fgmp/fuel/runout-eta` |
| `view:generators` | view / generators | Tenant-scoped | Read/use the generators application surface; mutations are separately authorized. | `GET /api/fgmp/generators/[id]`, `GET /api/fgmp/generators`, `GET /api/fgmp/history/[entityId]`, `GET /api/fgmp/reports` |
| `view:geography` | view / geography | Tenant-scoped | Read/use the geography application surface; mutations are separately authorized. | `GET /api/fgmp/geography` |
| `view:inventory` | view / inventory | Tenant-scoped | Read/use the inventory application surface; mutations are separately authorized. | `GET /api/fgmp/deliveries/[id]`, `GET /api/fgmp/deliveries`, `GET /api/fgmp/tanks/[id]`, `GET /api/fgmp/tanks` |
| `view:iot` | view / iot | Tenant-scoped | Read/use the iot application surface; mutations are separately authorized. | `GET /api/fgmp/iot/[id]/ota-status`, `GET /api/fgmp/iot` |
| `view:maintenance` | view / maintenance | Tenant-scoped | Read/use the maintenance application surface; mutations are separately authorized. | `GET /api/fgmp/maintenance/[id]`, `GET /api/fgmp/maintenance` |
| `view:preferences` | view / preferences | Tenant-scoped | Read/use the preferences application surface; mutations are separately authorized. | UI/secondary guard; see route-specific policy |
| `view:reports` | view / reports | Tenant-scoped | Read/use the reports application surface; mutations are separately authorized. | `GET /api/fgmp/export`, `GET /api/fgmp/reports` |
| `view:roles` | view / roles | Tenant-scoped | Read/use the roles application surface; mutations are separately authorized. | UI/secondary guard; see route-specific policy |
| `view:sites` | view / sites | Tenant-scoped | Read/use the sites application surface; mutations are separately authorized. | `GET /api/fgmp/export`, `GET /api/fgmp/history/[entityId]`, `GET /api/fgmp/sites/[id]`, `GET /api/fgmp/sites`, `GET /api/fgmp/solar-arrays/[id]`, `GET /api/fgmp/solar-arrays`, `GET /api/fgmp/solar-sites/[id]`, `GET /api/fgmp/solar-sites` |
| `view:suppressions` | view / suppressions | Tenant-scoped | Read/use the suppressions application surface; mutations are separately authorized. | `GET /api/fgmp/suppressions` |
| `view:system-health` | view / system-health | Tenant-scoped | Read/use the system health application surface; mutations are separately authorized. | `GET /api/fgmp/health` |
| `view:system-settings` | view / system-settings | Tenant-scoped | Read/use the system settings application surface; mutations are separately authorized. | `GET /api/fgmp/interlocks/thresholds/[id]`, `GET /api/fgmp/interlocks/thresholds`, `GET /api/fgmp/settings` |
| `view:users` | view / users | Tenant-scoped | Read/use the users application surface; mutations are separately authorized. | `GET /api/fgmp/preferences/[userId]`, `GET /api/fgmp/users/[id]`, `GET /api/fgmp/users` |
| `platform:firmware` | platform / firmware | Platform-only | Allow the firmware operation in the platform module; this does not imply other actions such as delete, export, or platform administration. | `DELETE /api/fgmp/edge/firmware/[id]`, `POST /api/fgmp/edge/firmware` |
| `tenant:manage` | tenant / manage | Platform-only | Allow the manage operation in the tenant module; this does not imply other actions such as delete, export, or platform administration. | `DELETE /api/fgmp/platform/support-sessions/[id]`, `DELETE /api/fgmp/platform/support-sessions/current`, `POST /api/fgmp/platform/support-sessions`, `DELETE /api/fgmp/platform/support-sessions`, `POST /api/fgmp/platform/support/[tenant]/summary`, `PATCH /api/fgmp/tenants/[id]`, `DELETE /api/fgmp/tenants/[id]`, `POST /api/fgmp/tenants` |
| `user:grant-superadmin` | user / grant-superadmin | Platform-only | Allow the grant superadmin operation in the user module; this does not imply other actions such as delete, export, or platform administration. | UI/secondary guard; see route-specific policy |
| `view:tenants` | view / tenants | Platform-only | Read/use the tenants application surface; mutations are separately authorized. | `GET /api/fgmp/platform/audit`, `GET /api/fgmp/platform/grants`, `GET /api/fgmp/platform/support-sessions/[id]`, `GET /api/fgmp/platform/support-sessions/current`, `GET /api/fgmp/platform/support-sessions`, `GET /api/fgmp/platform/support/[tenant]/summary`, `GET /api/fgmp/tenants/[id]`, `GET /api/fgmp/tenants` |
| `view:tenant-isolation` | view / tenant-isolation | Platform-only | Read/use the tenant isolation application surface; mutations are separately authorized. | `GET /api/fgmp/admin/tenant-isolation-test` |

## Complete role–permission matrix

Every capability in the canonical catalog appears exactly once below. A grant is still conditional on the appropriate tenant, resource, platform, and workflow context described above.

| Capability | Scope | `SUPERADMIN` | `ADMIN` | `NOC_OPERATOR` | `REGIONAL_MANAGER` | `FIELD_ENGINEER` | `EXECUTIVE` | `READONLY` |
|---|---|---|---|---|---|---|---|---|
| `alarm:ack` | Tenant | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `alarm:configure` | Tenant | ✓ | ✓ | — | ✓ | — | — | — |
| `alarm:resolve` | Tenant | ✓ | ✓ | ✓ | — | — | — | — |
| `alarm:suppress` | Tenant | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `api-key:manage` | Tenant | ✓ | ✓ | — | — | — | — | — |
| `asset:manage` | Tenant | ✓ | ✓ | — | — | — | — | — |
| `delivery:approve` | Tenant | ✓ | ✓ | — | ✓ | ✓ | — | — |
| `delivery:manage` | Tenant | ✓ | ✓ | — | ✓ | ✓ | — | — |
| `delivery:verify` | Tenant | ✓ | ✓ | — | — | ✓ | — | — |
| `dispenser:control` | Tenant | ✓ | ✓ | ✓ | — | ✓ | — | — |
| `edge:manage` | Tenant | ✓ | ✓ | — | — | — | — | — |
| `gen:control` | Tenant | ✓ | ✓ | ✓ | — | — | — | — |
| `geography:manage` | Tenant | ✓ | ✓ | — | — | — | — | — |
| `notification:manage` | Tenant | ✓ | ✓ | ✓ | — | — | — | — |
| `role:preview` | Tenant | ✓ | ✓ | — | — | — | — | — |
| `settings:manage` | Tenant | ✓ | ✓ | — | — | — | — | — |
| `simul:tick` | Tenant | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `ticket:assign` | Tenant | ✓ | ✓ | — | ✓ | — | — | — |
| `ticket:complete` | Tenant | ✓ | ✓ | — | ✓ | ✓ | — | — |
| `ticket:create` | Tenant | ✓ | ✓ | — | ✓ | ✓ | — | — |
| `ticket:manage` | Tenant | ✓ | ✓ | — | ✓ | ✓ | — | — |
| `user:manage` | Tenant | ✓ | ✓ | — | — | — | — | — |
| `view:alarms` | Tenant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `view:analytics` | Tenant | ✓ | ✓ | — | ✓ | — | ✓ | ✓ |
| `view:api-keys` | Tenant | ✓ | ✓ | — | — | — | — | — |
| `view:asset-registry` | Tenant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `view:audit` | Tenant | ✓ | ✓ | ✓ | ✓ | — | — | ✓ |
| `view:batteries` | Tenant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `view:consumption-patterns` | Tenant | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| `view:dashboard` | Tenant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `view:dispensers` | Tenant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `view:edge-firmware` | Tenant | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `view:fuel` | Tenant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `view:fuel-forecast` | Tenant | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| `view:generators` | Tenant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `view:geography` | Tenant | ✓ | ✓ | — | — | — | — | — |
| `view:inventory` | Tenant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `view:iot` | Tenant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `view:maintenance` | Tenant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `view:preferences` | Tenant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `view:reports` | Tenant | ✓ | ✓ | — | ✓ | — | ✓ | ✓ |
| `view:roles` | Tenant | ✓ | ✓ | — | — | — | — | — |
| `view:sites` | Tenant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `view:suppressions` | Tenant | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `view:system-health` | Tenant | ✓ | ✓ | — | — | — | — | — |
| `view:system-settings` | Tenant | ✓ | ✓ | — | — | — | — | — |
| `view:users` | Tenant | ✓ | ✓ | — | — | — | — | — |
| `platform:firmware` | Platform | ✓ | — | — | — | — | — | — |
| `tenant:manage` | Platform | ✓ | — | — | — | — | — | — |
| `user:grant-superadmin` | Platform | ✓ | — | — | — | — | — | — |
| `view:tenants` | Platform | ✓ | — | — | — | — | — | — |
| `view:tenant-isolation` | Platform | ✓ | — | — | — | — | — | — |

## Route and action inventory (actual App Router handlers)

Every exported handler under `src/app/api/**/route.ts` is enumerated below. `Policy` is the server-side path/method capability requirement; `Handler guard` is the handler's additional allow-list or service-auth check. Data ownership and resource checks are enforced in the route/service and database RLS layer.

| Method and path | Policy | Effective policy roles | Handler guard | Source |
|---|---|---|---|---|
| `GET /api/auth/[...nextauth]` | Public / external credential | Not role-authorized | none (request not forwarded) | `src/app/api/auth/[...nextauth]/route.ts` |
| `POST /api/auth/[...nextauth]` | Public / external credential | Not role-authorized | none (request not forwarded) | `src/app/api/auth/[...nextauth]/route.ts` |
| `GET /api/fgmp/admin/tenant-isolation-test` | `view:tenant-isolation` | `SUPERADMIN` | requireAuth | `src/app/api/fgmp/admin/tenant-isolation-test/route.ts` |
| `GET /api/fgmp/alarms/[id]` | `view:alarms` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/alarms/[id]/route.ts` |
| `GET /api/fgmp/alarms` | `view:alarms` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/alarms/route.ts` |
| `POST /api/fgmp/alarms` | `alarm:ack` OR `alarm:resolve` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER` | requireRole | `src/app/api/fgmp/alarms/route.ts` |
| `GET /api/fgmp/analytics` | `view:analytics` | `SUPERADMIN`, `ADMIN`, `REGIONAL_MANAGER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/analytics/route.ts` |
| `GET /api/fgmp/api-keys/[id]` | `view:api-keys` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/api-keys/[id]/route.ts` |
| `PATCH /api/fgmp/api-keys/[id]` | `api-key:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/api-keys/[id]/route.ts` |
| `GET /api/fgmp/api-keys` | `view:api-keys` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/api-keys/route.ts` |
| `POST /api/fgmp/api-keys` | `api-key:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/api-keys/route.ts` |
| `GET /api/fgmp/api-keys/stats` | `view:api-keys` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/api-keys/stats/route.ts` |
| `GET /api/fgmp/audit` | `view:audit` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `READONLY` | requireAuth | `src/app/api/fgmp/audit/route.ts` |
| `GET /api/fgmp/batteries/[id]` | `view:batteries` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/batteries/[id]/route.ts` |
| `PATCH /api/fgmp/batteries/[id]` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/batteries/[id]/route.ts` |
| `DELETE /api/fgmp/batteries/[id]` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/batteries/[id]/route.ts` |
| `GET /api/fgmp/batteries` | `view:batteries` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/batteries/route.ts` |
| `POST /api/fgmp/batteries` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/batteries/route.ts` |
| `POST /api/fgmp/correlation/evaluate` | `alarm:configure` | `SUPERADMIN`, `ADMIN`, `REGIONAL_MANAGER` | requireRole | `src/app/api/fgmp/correlation/evaluate/route.ts` |
| `GET /api/fgmp/correlation/matches` | `alarm:configure` | `SUPERADMIN`, `ADMIN`, `REGIONAL_MANAGER` | requireAuth | `src/app/api/fgmp/correlation/matches/route.ts` |
| `PATCH /api/fgmp/correlation/rules/[id]` | `alarm:configure` | `SUPERADMIN`, `ADMIN`, `REGIONAL_MANAGER` | requireRole | `src/app/api/fgmp/correlation/rules/[id]/route.ts` |
| `DELETE /api/fgmp/correlation/rules/[id]` | `alarm:configure` | `SUPERADMIN`, `ADMIN`, `REGIONAL_MANAGER` | requireRole | `src/app/api/fgmp/correlation/rules/[id]/route.ts` |
| `GET /api/fgmp/correlation/rules` | `alarm:configure` | `SUPERADMIN`, `ADMIN`, `REGIONAL_MANAGER` | requireAuth | `src/app/api/fgmp/correlation/rules/route.ts` |
| `POST /api/fgmp/correlation/rules` | `alarm:configure` | `SUPERADMIN`, `ADMIN`, `REGIONAL_MANAGER` | requireRole | `src/app/api/fgmp/correlation/rules/route.ts` |
| `POST /api/fgmp/deliveries/[id]/cancel` | `delivery:manage` | `SUPERADMIN`, `ADMIN`, `REGIONAL_MANAGER`, `FIELD_ENGINEER` | requireRole | `src/app/api/fgmp/deliveries/[id]/cancel/route.ts` |
| `POST /api/fgmp/deliveries/[id]/deliver` | `delivery:manage` | `SUPERADMIN`, `ADMIN`, `REGIONAL_MANAGER`, `FIELD_ENGINEER` | requireRole | `src/app/api/fgmp/deliveries/[id]/deliver/route.ts` |
| `GET /api/fgmp/deliveries/[id]` | `view:inventory` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/deliveries/[id]/route.ts` |
| `GET /api/fgmp/deliveries` | `view:inventory` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/deliveries/route.ts` |
| `POST /api/fgmp/deliveries` | `delivery:manage` | `SUPERADMIN`, `ADMIN`, `REGIONAL_MANAGER`, `FIELD_ENGINEER` | requireRole | `src/app/api/fgmp/deliveries/route.ts` |
| `GET /api/fgmp/dispensers/[id]/commands` | `view:dispensers` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/dispensers/[id]/commands/route.ts` |
| `POST /api/fgmp/dispensers/[id]/control` | `dispenser:control` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `FIELD_ENGINEER` | requireRole | `src/app/api/fgmp/dispensers/[id]/control/route.ts` |
| `GET /api/fgmp/dispensers/[id]` | `view:dispensers` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/dispensers/[id]/route.ts` |
| `PATCH /api/fgmp/dispensers/[id]` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/dispensers/[id]/route.ts` |
| `DELETE /api/fgmp/dispensers/[id]` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/dispensers/[id]/route.ts` |
| `GET /api/fgmp/dispensers/reports` | `view:dispensers` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/dispensers/reports/route.ts` |
| `GET /api/fgmp/dispensers` | `view:dispensers` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/dispensers/route.ts` |
| `POST /api/fgmp/dispensers` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/dispensers/route.ts` |
| `GET /api/fgmp/dispensers/transactions` | `view:dispensers` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/dispensers/transactions/route.ts` |
| `POST /api/fgmp/edge/esp/[dispenserId]/reboot` | `dispenser:control` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `FIELD_ENGINEER` | requireRole | `src/app/api/fgmp/edge/esp/[dispenserId]/reboot/route.ts` |
| `DELETE /api/fgmp/edge/firmware/[id]` | `platform:firmware` | `SUPERADMIN` | requireRole | `src/app/api/fgmp/edge/firmware/[id]/route.ts` |
| `POST /api/fgmp/edge/firmware/deploy` | `dispenser:control` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `FIELD_ENGINEER` | requireRole | `src/app/api/fgmp/edge/firmware/deploy/route.ts` |
| `GET /api/fgmp/edge/firmware/deployments` | `view:edge-firmware` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `READONLY` | requireAuth | `src/app/api/fgmp/edge/firmware/deployments/route.ts` |
| `GET /api/fgmp/edge/firmware` | `view:edge-firmware` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `READONLY` | requireAuth | `src/app/api/fgmp/edge/firmware/route.ts` |
| `POST /api/fgmp/edge/firmware` | `platform:firmware` | `SUPERADMIN` | requireRole | `src/app/api/fgmp/edge/firmware/route.ts` |
| `POST /api/fgmp/edge/gateways/[id]` | `edge:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/edge/gateways/[id]/route.ts` |
| `PATCH /api/fgmp/edge/gateways/[id]` | `edge:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/edge/gateways/[id]/route.ts` |
| `DELETE /api/fgmp/edge/gateways/[id]` | `edge:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/edge/gateways/[id]/route.ts` |
| `GET /api/fgmp/edge/gateways` | `view:edge-firmware` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `READONLY` | requireAuth | `src/app/api/fgmp/edge/gateways/route.ts` |
| `GET /api/fgmp/edge/rs485` | `view:edge-firmware` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `READONLY` | requireAuth | `src/app/api/fgmp/edge/rs485/route.ts` |
| `GET /api/fgmp/export` | `view:sites` OR `view:reports` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/export/route.ts` |
| `GET /api/fgmp/forecast` | `view:fuel-forecast` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/forecast/route.ts` |
| `GET /api/fgmp/fuel/runout-eta` | `view:dashboard` OR `view:fuel-forecast` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/fuel/runout-eta/route.ts` |
| `GET /api/fgmp/generators/[id]/control/[commandId]` | `gen:control` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR` | requireRole | `src/app/api/fgmp/generators/[id]/control/[commandId]/route.ts` |
| `POST /api/fgmp/generators/[id]/control` | `gen:control` OR `asset:manage` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR` | requireRole | `src/app/api/fgmp/generators/[id]/control/route.ts` |
| `GET /api/fgmp/generators/[id]` | `view:generators` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/generators/[id]/route.ts` |
| `PATCH /api/fgmp/generators/[id]` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/generators/[id]/route.ts` |
| `DELETE /api/fgmp/generators/[id]` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/generators/[id]/route.ts` |
| `GET /api/fgmp/generators` | `view:generators` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/generators/route.ts` |
| `POST /api/fgmp/generators` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/generators/route.ts` |
| `PATCH /api/fgmp/geography/districts/[id]` | `geography:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/geography/districts/[id]/route.ts` |
| `DELETE /api/fgmp/geography/districts/[id]` | `geography:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/geography/districts/[id]/route.ts` |
| `POST /api/fgmp/geography/districts` | `geography:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/geography/districts/route.ts` |
| `PATCH /api/fgmp/geography/governorates/[id]` | `geography:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/geography/governorates/[id]/route.ts` |
| `DELETE /api/fgmp/geography/governorates/[id]` | `geography:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/geography/governorates/[id]/route.ts` |
| `POST /api/fgmp/geography/governorates` | `geography:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/geography/governorates/route.ts` |
| `PATCH /api/fgmp/geography/regions/[id]` | `geography:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/geography/regions/[id]/route.ts` |
| `DELETE /api/fgmp/geography/regions/[id]` | `geography:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/geography/regions/[id]/route.ts` |
| `POST /api/fgmp/geography/regions` | `geography:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/geography/regions/route.ts` |
| `GET /api/fgmp/geography` | `view:geography` | `SUPERADMIN`, `ADMIN` | requireAuth | `src/app/api/fgmp/geography/route.ts` |
| `GET /api/fgmp/health` | `view:system-health` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/health/route.ts` |
| `GET /api/fgmp/history/[entityId]` | `view:sites` OR `view:fuel` OR `view:generators` OR `view:batteries` OR `view:asset-registry` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/history/[entityId]/route.ts` |
| `GET /api/fgmp/interlocks/thresholds/[id]` | `view:system-settings` | `SUPERADMIN`, `ADMIN` | requireAuth | `src/app/api/fgmp/interlocks/thresholds/[id]/route.ts` |
| `PATCH /api/fgmp/interlocks/thresholds/[id]` | `settings:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/interlocks/thresholds/[id]/route.ts` |
| `DELETE /api/fgmp/interlocks/thresholds/[id]` | `settings:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/interlocks/thresholds/[id]/route.ts` |
| `GET /api/fgmp/interlocks/thresholds` | `view:system-settings` | `SUPERADMIN`, `ADMIN` | requireAuth | `src/app/api/fgmp/interlocks/thresholds/route.ts` |
| `POST /api/fgmp/interlocks/thresholds` | `settings:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/interlocks/thresholds/route.ts` |
| `GET /api/fgmp/iot/[id]/ota-status` | `view:iot` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/iot/[id]/ota-status/route.ts` |
| `GET /api/fgmp/iot/ingest` | No session role; independent service credential | Not role-authorized | none (request not forwarded) | `src/app/api/fgmp/iot/ingest/route.ts` |
| `POST /api/fgmp/iot/ingest` | No session role; independent service credential | Not role-authorized | service/api-key | `src/app/api/fgmp/iot/ingest/route.ts` |
| `GET /api/fgmp/iot` | `view:iot` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/iot/route.ts` |
| `POST /api/fgmp/iot` | `edge:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/iot/route.ts` |
| `PATCH /api/fgmp/iot` | `edge:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/iot/route.ts` |
| `POST /api/fgmp/maintenance/[id]/assign` | `ticket:manage` | `SUPERADMIN`, `ADMIN`, `REGIONAL_MANAGER`, `FIELD_ENGINEER` | requireRole | `src/app/api/fgmp/maintenance/[id]/assign/route.ts` |
| `POST /api/fgmp/maintenance/[id]/progress` | `ticket:manage` | `SUPERADMIN`, `ADMIN`, `REGIONAL_MANAGER`, `FIELD_ENGINEER` | requireRole | `src/app/api/fgmp/maintenance/[id]/progress/route.ts` |
| `GET /api/fgmp/maintenance/[id]` | `view:maintenance` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/maintenance/[id]/route.ts` |
| `GET /api/fgmp/maintenance` | `view:maintenance` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/maintenance/route.ts` |
| `POST /api/fgmp/maintenance` | `ticket:manage` | `SUPERADMIN`, `ADMIN`, `REGIONAL_MANAGER`, `FIELD_ENGINEER` | requireRole | `src/app/api/fgmp/maintenance/route.ts` |
| `POST /api/fgmp/me/preview-role` | `role:preview` | `SUPERADMIN`, `ADMIN` | requireAuth | `src/app/api/fgmp/me/preview-role/route.ts` |
| `DELETE /api/fgmp/me/preview-role` | Authenticated session (auth-only) | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/me/preview-role/route.ts` |
| `GET /api/fgmp/me` | Authenticated session (auth-only) | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireRole | `src/app/api/fgmp/me/route.ts` |
| `GET /api/fgmp/metrics` | `alarm:ack` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER` | requireRole | `src/app/api/fgmp/metrics/route.ts` |
| `POST /api/fgmp/mfa/challenge-request` | Authenticated session (auth-only) | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/mfa/challenge-request/route.ts` |
| `POST /api/fgmp/mfa/challenge` | Authenticated session (auth-only) | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | none (request not forwarded) | `src/app/api/fgmp/mfa/challenge/route.ts` |
| `POST /api/fgmp/mfa/disable` | Authenticated session (auth-only) | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/mfa/disable/route.ts` |
| `POST /api/fgmp/mfa/enrol` | Authenticated session (auth-only) | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/mfa/enrol/route.ts` |
| `POST /api/fgmp/mfa/reset` | `user:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/mfa/reset/route.ts` |
| `GET /api/fgmp/mfa/status` | Authenticated session (auth-only) | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/mfa/status/route.ts` |
| `POST /api/fgmp/mfa/verify-enrol` | Authenticated session (auth-only) | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/mfa/verify-enrol/route.ts` |
| `GET /api/fgmp/notifications` | `view:dashboard` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/notifications/route.ts` |
| `POST /api/fgmp/notifications` | `notification:manage` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR` | requireRole | `src/app/api/fgmp/notifications/route.ts` |
| `GET /api/fgmp/ops/alerts/preview` | `alarm:ack` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER` | requireRole | `src/app/api/fgmp/ops/alerts/preview/route.ts` |
| `GET /api/fgmp/patterns` | `view:consumption-patterns` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/patterns/route.ts` |
| `GET /api/fgmp/platform/audit` | `view:tenants` | `SUPERADMIN` | requireSuperAdmin | `src/app/api/fgmp/platform/audit/route.ts` |
| `GET /api/fgmp/platform/grants` | `view:tenants` | `SUPERADMIN` | requireSuperAdmin | `src/app/api/fgmp/platform/grants/route.ts` |
| `GET /api/fgmp/platform/support-sessions/[id]` | `view:tenants` | `SUPERADMIN` | requireSuperAdmin | `src/app/api/fgmp/platform/support-sessions/[id]/route.ts` |
| `DELETE /api/fgmp/platform/support-sessions/[id]` | `tenant:manage` | `SUPERADMIN` | requireSuperAdmin | `src/app/api/fgmp/platform/support-sessions/[id]/route.ts` |
| `GET /api/fgmp/platform/support-sessions/current` | `view:tenants` | `SUPERADMIN` | requireSuperAdmin | `src/app/api/fgmp/platform/support-sessions/current/route.ts` |
| `DELETE /api/fgmp/platform/support-sessions/current` | `tenant:manage` | `SUPERADMIN` | requireSuperAdmin | `src/app/api/fgmp/platform/support-sessions/current/route.ts` |
| `GET /api/fgmp/platform/support-sessions` | `view:tenants` | `SUPERADMIN` | requireSuperAdmin | `src/app/api/fgmp/platform/support-sessions/route.ts` |
| `POST /api/fgmp/platform/support-sessions` | `tenant:manage` | `SUPERADMIN` | requireSuperAdmin | `src/app/api/fgmp/platform/support-sessions/route.ts` |
| `DELETE /api/fgmp/platform/support-sessions` | `tenant:manage` | `SUPERADMIN` | requireSuperAdmin | `src/app/api/fgmp/platform/support-sessions/route.ts` |
| `GET /api/fgmp/platform/support/[tenant]/summary` | `view:tenants` | `SUPERADMIN` | requireSuperAdmin | `src/app/api/fgmp/platform/support/[tenant]/summary/route.ts` |
| `POST /api/fgmp/platform/support/[tenant]/summary` | `tenant:manage` | `SUPERADMIN` | requireSuperAdmin | `src/app/api/fgmp/platform/support/[tenant]/summary/route.ts` |
| `GET /api/fgmp/preferences/[userId]` | `view:users` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/preferences/[userId]/route.ts` |
| `PUT /api/fgmp/preferences/[userId]` | `user:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/preferences/[userId]/route.ts` |
| `GET /api/fgmp/preferences` | Authenticated session (auth-only) | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/preferences/route.ts` |
| `PUT /api/fgmp/preferences` | Authenticated session (auth-only) | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/preferences/route.ts` |
| `GET /api/fgmp/proposal` | Authenticated session (auth-only) | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/proposal/route.ts` |
| `POST /api/fgmp/realtime/auth` | Authenticated session (auth-only) | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/realtime/auth/route.ts` |
| `GET /api/fgmp/realtime/channel` | Authenticated session (auth-only) | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/realtime/channel/route.ts` |
| `GET /api/fgmp/realtime/snapshot` | No session role; independent service credential | Not role-authorized | service/api-key | `src/app/api/fgmp/realtime/snapshot/route.ts` |
| `GET /api/fgmp/reports` | `view:reports` OR `view:generators` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/reports/route.ts` |
| `POST /api/fgmp/seed` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/seed/route.ts` |
| `GET /api/fgmp/settings` | `view:system-settings` | `SUPERADMIN`, `ADMIN` | requireAuth | `src/app/api/fgmp/settings/route.ts` |
| `PATCH /api/fgmp/settings` | `settings:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/settings/route.ts` |
| `GET /api/fgmp/shift-handover/[id]` | `view:dashboard` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/shift-handover/[id]/route.ts` |
| `PATCH /api/fgmp/shift-handover/[id]` | `alarm:ack` OR `delivery:manage` OR `ticket:manage` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER` | requireRole | `src/app/api/fgmp/shift-handover/[id]/route.ts` |
| `DELETE /api/fgmp/shift-handover/[id]` | `settings:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/shift-handover/[id]/route.ts` |
| `GET /api/fgmp/shift-handover` | `view:dashboard` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/shift-handover/route.ts` |
| `POST /api/fgmp/shift-handover` | `alarm:ack` OR `delivery:manage` OR `ticket:manage` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER` | requireRole | `src/app/api/fgmp/shift-handover/route.ts` |
| `GET /api/fgmp/sites/[id]` | `view:sites` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/sites/[id]/route.ts` |
| `PATCH /api/fgmp/sites/[id]` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/sites/[id]/route.ts` |
| `DELETE /api/fgmp/sites/[id]` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/sites/[id]/route.ts` |
| `GET /api/fgmp/sites` | `view:sites` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/sites/route.ts` |
| `POST /api/fgmp/sites` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/sites/route.ts` |
| `GET /api/fgmp/solar-arrays/[id]` | `view:sites` OR `view:asset-registry` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/solar-arrays/[id]/route.ts` |
| `PATCH /api/fgmp/solar-arrays/[id]` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/solar-arrays/[id]/route.ts` |
| `DELETE /api/fgmp/solar-arrays/[id]` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/solar-arrays/[id]/route.ts` |
| `GET /api/fgmp/solar-arrays` | `view:sites` OR `view:asset-registry` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/solar-arrays/route.ts` |
| `POST /api/fgmp/solar-arrays` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/solar-arrays/route.ts` |
| `GET /api/fgmp/solar-sites/[id]` | `view:sites` OR `view:asset-registry` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/solar-sites/[id]/route.ts` |
| `PATCH /api/fgmp/solar-sites/[id]` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/solar-sites/[id]/route.ts` |
| `DELETE /api/fgmp/solar-sites/[id]` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/solar-sites/[id]/route.ts` |
| `GET /api/fgmp/solar-sites` | `view:sites` OR `view:asset-registry` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/solar-sites/route.ts` |
| `POST /api/fgmp/solar-sites` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/solar-sites/route.ts` |
| `GET /api/fgmp/state` | `view:dashboard` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/state/route.ts` |
| `PATCH /api/fgmp/suppressions/[id]` | `alarm:suppress` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER` | requireRole | `src/app/api/fgmp/suppressions/[id]/route.ts` |
| `DELETE /api/fgmp/suppressions/[id]` | `settings:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/suppressions/[id]/route.ts` |
| `GET /api/fgmp/suppressions` | `view:suppressions` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `READONLY` | requireAuth | `src/app/api/fgmp/suppressions/route.ts` |
| `POST /api/fgmp/suppressions` | `alarm:suppress` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER` | requireRole | `src/app/api/fgmp/suppressions/route.ts` |
| `GET /api/fgmp/tanks/[id]` | `view:fuel` OR `view:inventory` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/tanks/[id]/route.ts` |
| `PATCH /api/fgmp/tanks/[id]` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/tanks/[id]/route.ts` |
| `DELETE /api/fgmp/tanks/[id]` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/tanks/[id]/route.ts` |
| `GET /api/fgmp/tanks` | `view:fuel` OR `view:inventory` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | requireAuth | `src/app/api/fgmp/tanks/route.ts` |
| `POST /api/fgmp/tanks` | `asset:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/tanks/route.ts` |
| `GET /api/fgmp/tenants/[id]` | `view:tenants` | `SUPERADMIN` | requireAuth | `src/app/api/fgmp/tenants/[id]/route.ts` |
| `PATCH /api/fgmp/tenants/[id]` | `tenant:manage` | `SUPERADMIN` | requireRole | `src/app/api/fgmp/tenants/[id]/route.ts` |
| `DELETE /api/fgmp/tenants/[id]` | `tenant:manage` | `SUPERADMIN` | requireRole | `src/app/api/fgmp/tenants/[id]/route.ts` |
| `GET /api/fgmp/tenants` | `view:tenants` | `SUPERADMIN` | requireAuth | `src/app/api/fgmp/tenants/route.ts` |
| `POST /api/fgmp/tenants` | `tenant:manage` | `SUPERADMIN` | requireRole | `src/app/api/fgmp/tenants/route.ts` |
| `GET /api/fgmp/tick` | `simul:tick` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER` | requireAuth | `src/app/api/fgmp/tick/route.ts` |
| `POST /api/fgmp/tick` | `simul:tick` | `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER` | requireAuth | `src/app/api/fgmp/tick/route.ts` |
| `POST /api/fgmp/users/[id]/reset-password` | `user:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/users/[id]/reset-password/route.ts` |
| `GET /api/fgmp/users/[id]` | `view:users` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/users/[id]/route.ts` |
| `PUT /api/fgmp/users/[id]` | `user:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/users/[id]/route.ts` |
| `PATCH /api/fgmp/users/[id]` | `user:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/users/[id]/route.ts` |
| `DELETE /api/fgmp/users/[id]` | `user:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/users/[id]/route.ts` |
| `GET /api/fgmp/users` | `view:users` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/users/route.ts` |
| `POST /api/fgmp/users` | `user:manage` | `SUPERADMIN`, `ADMIN` | requireRole | `src/app/api/fgmp/users/route.ts` |
| `GET /api/health/live` | Public / external credential | Not role-authorized | none (request not forwarded) | `src/app/api/health/live/route.ts` |
| `GET /api/health/ready` | Public / external credential | Not role-authorized | none (request not forwarded) | `src/app/api/health/ready/route.ts` |

## Interpretation and limitations

- `effective policy roles` represents capability policy evaluation only. Handler allow-lists, platform `requireSuperAdmin`, per-action checks, role-revocation checks, support-session requirements, ownership checks and database RLS may narrow the effective result further; no later layer may widen it.
- HTTP file downloads are not served from an independent public bucket in this source inventory; any future object-storage delivery must bind signed URLs to tenant ownership, short expiry and explicit export/file permission before returning them.
- Background work and device ingress use their own service credentials and tenant context rather than end-user role grants. They are not user roles and must not acquire an ambient session identity.
- This matrix describes code-level authorization, not production infrastructure evidence. Database role/RLS configuration, deployed environment variables, secrets, browser behavior and live cross-tenant tests are validated separately and must be recorded in the audit report.
