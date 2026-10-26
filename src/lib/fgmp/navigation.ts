import type { ViewKey } from "./store";

/**
 * The one navigation table.
 *
 * WHY THIS FILE EXISTS. The sidebar (`app-shell.tsx`) and the command palette
 * (`command-palette.tsx`) each carried their own list of views, and the two had
 * drifted: the shell listed 28 entries, the palette 22. Six views — suppressions,
 * users, system-health, tenant-isolation, preferences, and the tenants/roles
 * group ordering — existed in one surface and not the other, so the same role
 * saw a different product depending on which affordance it used. Neither list
 * was wrong about capability gating; they were just two copies, and a copy is
 * how a gate gets added to one surface and forgotten on the other.
 *
 * Every entry therefore names its own `cap`. A surface renders an entry only
 * when `hasCapability(role, entry.cap)` says so, and `store.setView()` refuses
 * the target regardless of what any surface rendered — the list is a filter, not
 * the enforcement.
 *
 * This module is deliberately data-only: no React, no icons. Icons are a
 * presentation choice and live in the components (`NAV_ICONS` in app-shell);
 * keeping this file free of them lets the policy table be imported by tests and
 * by anything that needs to reason about which view a capability opens.
 */

/** Display group. Order here is the order the sidebar renders groups in. */
export const NAV_GROUPS = [
  { id: "operations", tKey: "nav.group.operations" },
  { id: "monitoring", tKey: "nav.group.monitoring" },
  { id: "logistics", tKey: "nav.group.logistics" },
  { id: "insights", tKey: "nav.group.insights" },
  { id: "administration", tKey: "nav.group.administration" },
  { id: "account", tKey: "nav.group.account" },
] as const;

export type NavGroupId = (typeof NAV_GROUPS)[number]["id"];

export interface NavEntry {
  /** The view this entry opens. Must be a `ViewKey`. */
  key: ViewKey;
  /** i18n key for the label. Rendered as `t(tKey)`. */
  tKey: string;
  /** Capability that must be held for this entry to exist for a role. */
  cap: string;
  group: NavGroupId;
  /** Command-palette keyboard shortcut (also shown in the help dialog). */
  shortcut?: string;
}

export const NAV_ENTRIES: readonly NavEntry[] = [
  { key: "dashboard", tKey: "nav.dashboard", cap: "view:dashboard", group: "operations", shortcut: "G D" },
  { key: "sites", tKey: "nav.sites", cap: "view:sites", group: "operations", shortcut: "G S" },

  { key: "fuel", tKey: "nav.fuel", cap: "view:fuel", group: "monitoring", shortcut: "G F" },
  { key: "dispensers", tKey: "nav.dispensers", cap: "view:dispensers", group: "monitoring", shortcut: "G P" },
  { key: "edge-firmware", tKey: "nav.edge-firmware", cap: "view:edge-firmware", group: "monitoring", shortcut: "G E" },
  { key: "generators", tKey: "nav.generators", cap: "view:generators", group: "monitoring", shortcut: "G G" },
  { key: "batteries", tKey: "nav.batteries", cap: "view:batteries", group: "monitoring", shortcut: "G B" },
  { key: "alarms", tKey: "nav.alarms", cap: "view:alarms", group: "monitoring", shortcut: "G A" },
  { key: "suppressions", tKey: "nav.suppressions", cap: "view:suppressions", group: "monitoring" },

  { key: "asset-registry", tKey: "nav.asset-registry", cap: "view:asset-registry", group: "logistics" },
  { key: "inventory", tKey: "nav.inventory", cap: "view:inventory", group: "logistics", shortcut: "G I" },
  { key: "iot", tKey: "nav.iot", cap: "view:iot", group: "logistics", shortcut: "G O" },
  { key: "maintenance", tKey: "nav.maintenance", cap: "view:maintenance", group: "logistics", shortcut: "G M" },

  { key: "analytics", tKey: "nav.analytics", cap: "view:analytics", group: "insights", shortcut: "G N" },
  { key: "fuel-forecast", tKey: "nav.fuel-forecast", cap: "view:fuel-forecast", group: "insights", shortcut: "G C" },
  { key: "consumption-patterns", tKey: "nav.consumption-patterns", cap: "view:consumption-patterns", group: "insights", shortcut: "G X" },
  { key: "reports", tKey: "nav.reports", cap: "view:reports", group: "insights", shortcut: "G R" },
  { key: "audit", tKey: "nav.audit", cap: "view:audit", group: "insights", shortcut: "G U" },

  { key: "users", tKey: "nav.users", cap: "view:users", group: "administration" },
  { key: "tenants", tKey: "nav.tenants", cap: "view:tenants", group: "administration", shortcut: "G T" },
  { key: "geography", tKey: "nav.geography", cap: "view:geography", group: "administration", shortcut: "G Y" },
  { key: "roles", tKey: "nav.roles", cap: "view:roles", group: "administration", shortcut: "G L" },
  { key: "system-settings", tKey: "nav.system-settings", cap: "view:system-settings", group: "administration" },
  { key: "api-keys", tKey: "nav.api-keys", cap: "view:api-keys", group: "administration", shortcut: "G K" },
  { key: "system-health", tKey: "nav.systemHealth", cap: "view:system-health", group: "administration" },
  // Tenant Isolation testing — SUPERADMIN-only via the `*` wildcard.
  { key: "tenant-isolation", tKey: "nav.tenantIsolation", cap: "view:tenant-isolation", group: "administration" },

  // Account — personal settings, granted to every authenticated role.
  { key: "preferences", tKey: "nav.preferences", cap: "view:preferences", group: "account" },
];

/** Entries a role may see, in render order. */
export function navEntriesFor(hasCapability: (cap: string) => boolean): NavEntry[] {
  return NAV_ENTRIES.filter((e) => hasCapability(e.cap));
}

/** The cap that opens a given view, or undefined for a key that is not a nav entry. */
export function navCapability(view: ViewKey): string | undefined {
  return NAV_ENTRIES.find((e) => e.key === view)?.cap;
}
