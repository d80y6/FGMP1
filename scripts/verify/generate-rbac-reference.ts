import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ALL_ROLES,
  CAPABILITIES,
  ROLE_PERMISSIONS,
  SUPERADMIN_ONLY_CAPABILITIES,
  hasCapability,
} from "../../src/lib/fgmp/rbac-core";
import {
  PUBLIC_ENDPOINTS,
  analyzeRoutes,
  isAuthOnly,
} from "./route-inventory";

const output = join(process.cwd(), "docs/security/RBAC-REFERENCE-MATRIX.md");
const handlers = analyzeRoutes();
const platformOnly = new Set<string>(SUPERADMIN_ONLY_CAPABILITIES);
const escape = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");


const lines: string[] = [
  "# FGMP1 RBAC Reference Catalog and Effective Matrix",
  "",
  "> Generated from `ROLE_PERMISSIONS`, the canonical `CAPABILITIES` catalog, the actual App Router tree, and the route authorization policy. Regenerate with `bun run scripts/verify/generate-rbac-reference.ts`. Do not edit generated tables by hand.",
  "",
  `**Generated:** ${new Date().toISOString().slice(0, 10)} · **Roles:** ${ALL_ROLES.length} · **Capabilities:** ${CAPABILITIES.length} · **API handlers scanned:** ${handlers.length}`,
  "",
  "## Authorization semantics",
  "",
  "- `✓` means the role holds the capability in the canonical matrix. `—` means it does not. SUPERADMIN's explicit `*` wildcard resolves to all catalog capabilities; it does not bypass tenant RLS or resource scoping.",
  "- Capability grants are not standalone access to arbitrary records. Tenant roles are scoped to the tenant ID resolved from their revalidated session. Record reads and mutations must also use tenant-scoped queries / FORCE RLS. No user-to-site/region membership model exists in the current schema.",
  "- `SUPERADMIN_ONLY_CAPABILITIES` are platform-control-plane permissions. Tenant role assignments cannot grant these; customer operational data remains available to platform staff only through the controlled support-session flow (or narrowly specified tenant user-administration APIs).",
  "- There is no role inheritance. Roles are explicit allow-lists, except SUPERADMIN's platform wildcard. The `REGIONAL_MANAGER` role currently applies across its whole tenant; the schema does not model per-region memberships, so the role name is not a geographic row-level boundary.",
  "- Current permission IDs retain the established colon vocabulary (`view:<surface>` and `<domain>:<action>`) for backward compatibility. Scope is documented separately and always enforced at server/data boundaries.",
  "",
  "## Role catalog",
  "",
  "| Identifier | Name | Scope | Purpose and boundaries |",
  "|---|---|---|---|",
];

for (const role of ALL_ROLES) {
  const meta = ROLE_PERMISSIONS[role];
  let scope: string;
  let boundary: string;
  switch (role) {
    case "SUPERADMIN":
      scope = "Platform control plane; customer content only via named support access";
      boundary = "Tenant registry, platform audit/grants/support and global firmware. Ordinary tenant queries remain pinned to the platform tenant; support access is tenant-specific, time-boxed, and mode-gated.";
      break;
    case "ADMIN":
      scope = "One authenticated tenant";
      boundary = "Tenant user and role administration, configuration and business records within own tenant. Cannot create tenants, grant SUPERADMIN, or access platform control-plane data.";
      break;
    case "REGIONAL_MANAGER":
      scope = "One authenticated tenant (not a region boundary)";
      boundary = "Operations oversight, reports, delivery and maintenance actions. No user/membership or platform administration; per-region restriction is not represented by current schema.";
      break;
    case "NOC_OPERATOR":
      scope = "One authenticated tenant";
      boundary = "Monitoring, alarm actions, generator/dispenser control, notifications and simulation tick. No user, asset, platform, or configuration administration.";
      break;
    case "FIELD_ENGINEER":
      scope = "One authenticated tenant";
      boundary = "Field maintenance and delivery work plus hands-on dispenser control. No user/role administration, asset registry administration, platform control, or global setting changes.";
      break;
    case "EXECUTIVE":
      scope = "One authenticated tenant";
      boundary = "Read-only business and operational visibility; no control or administrative actions.";
      break;
    default:
      scope = "One authenticated tenant";
      boundary = "Read-only monitoring and audit visibility; no control or administrative actions.";
  }
  lines.push(`| \`${role}\` | ${escape(meta.label)} | ${escape(scope)} | ${escape(meta.description)} ${escape(boundary)} |`);
}

lines.push(
  "",
  "## Permission catalog",
  "",
  "This is the complete closed capability vocabulary. Related routes are derived from the actual route policy; parameter-sensitive exports/projections are additionally constrained in the handler. `SUPERADMIN_ONLY` is a flag for platform-only scope, not an extra grant over the explicit wildcard behavior.",
  "",
  "| Capability | Module / action | Scope | Description | Related API handlers |",
  "|---|---|---|---|---|",
);

for (const capability of CAPABILITIES) {
  const [module, action] = capability.split(":", 2);
  const related = handlers
    .filter((handler) => handler.requiredCapabilities?.includes(capability))
    .map((handler) => `${handler.method} ${handler.route.replaceAll("|", "\\|")}`);
  const scope = platformOnly.has(capability) ? "Platform-only" : "Tenant-scoped";
  const description = module === "view"
    ? `Read/use the ${action.replaceAll("-", " ")} application surface; mutations are separately authorized.`
    : `Allow the ${action.replaceAll("-", " ")} operation in the ${module.replaceAll("-", " ")} module; this does not imply other actions such as delete, export, or platform administration.`;
  lines.push(
    `| \`${capability}\` | ${module} / ${action} | ${scope} | ${description} | ${related.length ? related.map((route) => `\`${route}\``).join(", ") : "UI/secondary guard; see route-specific policy"} |`,
  );
}

lines.push(
  "",
  "## Complete role–permission matrix",
  "",
  "Every capability in the canonical catalog appears exactly once below. A grant is still conditional on the appropriate tenant, resource, platform, and workflow context described above.",
  "",
  `| Capability | Scope | ${ALL_ROLES.map((role) => `\`${role}\``).join(" | ")} |`,
  `|---|---|${ALL_ROLES.map(() => "---").join("|")}|`,
);
for (const capability of CAPABILITIES) {
  const marks = ALL_ROLES.map((role) => hasCapability(role, capability) ? "✓" : "—");
  lines.push(`| \`${capability}\` | ${platformOnly.has(capability) ? "Platform" : "Tenant"} | ${marks.join(" | ")} |`);
}

lines.push(
  "",
  "## Route and action inventory (actual App Router handlers)",
  "",
  "Every exported handler under `src/app/api/**/route.ts` is enumerated below. `Policy` is the server-side path/method capability requirement; `Handler guard` is the handler's additional allow-list or service-auth check. Data ownership and resource checks are enforced in the route/service and database RLS layer.",
  "",
  "| Method and path | Policy | Effective policy roles | Handler guard | Source |",
  "|---|---|---|---|---|",
);

for (const handler of handlers) {
  const policy = handler.requiredCapabilities === null
    ? isAuthOnly(handler.method, handler.matchPath)
      ? "Authenticated session (auth-only)"
      : handler.route in PUBLIC_ENDPOINTS
        ? "Public / external credential"
        : "Outside FGMP policy"
    : handler.requiredCapabilities.length === 0
      ? "No session role; independent service credential"
      : handler.requiredCapabilities.map((cap) => `\`${cap}\``).join(" OR ");
  const external = policy === "Public / external credential" || policy === "No session role; independent service credential";
  const roles = external ? "Not role-authorized" : handler.policyRoles.length ? handler.policyRoles.map((role) => `\`${role}\``).join(", ") : "—";
  lines.push(
    `| \`${handler.method} ${handler.route}\` | ${policy} | ${roles} | ${handler.guard}${handler.forwardsRequest || handler.guard === "service/api-key" ? "" : " (request not forwarded)"} | \`${handler.sourceFile}\` |`,
  );
}

lines.push(
  "",
  "## Interpretation and limitations",
  "",
  "- `effective policy roles` represents capability policy evaluation only. Handler allow-lists, platform `requireSuperAdmin`, per-action checks, role-revocation checks, support-session requirements, ownership checks and database RLS may narrow the effective result further; no later layer may widen it.",
  "- HTTP file downloads are not served from an independent public bucket in this source inventory; any future object-storage delivery must bind signed URLs to tenant ownership, short expiry and explicit export/file permission before returning them.",
  "- Background work and device ingress use their own service credentials and tenant context rather than end-user role grants. They are not user roles and must not acquire an ambient session identity.",
  "- This matrix describes code-level authorization, not production infrastructure evidence. Database role/RLS configuration, deployed environment variables, secrets, browser behavior and live cross-tenant tests are validated separately and must be recorded in the audit report.",
  "",
);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, lines.join("\n"), "utf8");
console.log(`Wrote ${output} (${handlers.length} handlers, ${CAPABILITIES.length} capabilities, ${ALL_ROLES.length} roles).`);
