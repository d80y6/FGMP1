/**
 * Live per-role walk — real server, real session, real database.
 *
 * ── WHAT THIS IS ───────────────────────────────────────────────────────────
 * The unit suites prove the matrix, the nav table and the API policy agree with
 * each other. `authz-live.ts` proves the POLICY is enforced per endpoint. Neither
 * answers the question this script exists for, which is the one an operator asks:
 *
 *   "If I sign in as this role, what do I SEE, and what can I actually do?"
 *
 * So this walks the product the way a person would: it signs in, asks the
 * server who it is (`/api/fgmp/me`), works out the sidebar from the matrix the
 * shell uses (`navEntriesFor`), and then CALLS THE ENDPOINT BEHIND EVERY VIEW —
 * including the ones that role is not supposed to reach. For each role it
 * records four things, which is the whole acceptance criterion:
 *
 *   nav      — the entries the sidebar would render for that role
 *   link     — the API behind each entry: does it answer, or refuse?
 *   content  — a view that IS reachable must return data (2xx), not an empty
 *              200-shaped denial, and a view that is NOT reachable must return
 *              401/403 at the API — because that is what makes "no content"
 *              true even for a typed URL
 *   control  — every write control in the product, probed with the capability
 *              that gates it: a holder must not be refused, a non-holder must
 *
 * ── WHY IT IS NON-DESTRUCTIVE ──────────────────────────────────────────────
 * Same contract as `authz-live.ts`: ids are ghosts (`__walk_probe__`), bodies are
 * deliberately incomplete, and the one write this script DOES perform is the
 * creation of a READONLY account so the walk can cover that role at all —
 * idempotent, and skipped when the account exists.
 *
 * ── WHAT IT CANNOT PROVE ───────────────────────────────────────────────────
 * It is HTTP, not a browser: it proves the DATA a role can reach and the
 * CAPABILITIES its controls are gated on, not that a `div` renders. The mapping
 * from capability to rendered control is covered by `rbac-ui-gates.test.ts` and
 * `rbac-link-surfaces.test.ts`; this script closes the loop on the server side of
 * that mapping, against the live database. Say "not verified in a browser" out
 * loud rather than letting a green tick imply more than it means.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *   FGMP_BASE_URL=http://localhost:3000 bun run scripts/verify/rbac-live-walk.ts
 *   … --json docs/rbac-live-walk.json     # machine-readable evidence
 *   … --md docs/RBAC-LIVE-WALK-2026-10.md # the table this produces
 *
 * Passwords come from the seeded demo accounts; they are never printed.
 */

import { writeFileSync } from "node:fs";
import { ALL_ROLES, ROLE_PERMISSIONS, hasCapability } from "../../src/lib/fgmp/rbac-core";
import { navEntriesFor } from "../../src/lib/fgmp/navigation";
import type { ViewKey } from "../../src/lib/fgmp/store";
import { classifyWalkControl, isWalkProbeInconclusive, walkExitCode } from "./rbac-live-walk-logic";

const BASE = process.env.FGMP_BASE_URL ?? "http://localhost:3000";
if (!process.env.FGMP_BASE_URL) {
  console.error(
    "[walk] FGMP_BASE_URL is unset. A verification script that silently passes with " +
      "nothing to verify is worse than none — set it, e.g. " +
      "FGMP_BASE_URL=http://localhost:3000 bun run scripts/verify/rbac-live-walk.ts",
  );
  process.exit(2);
}

const argValue = (flag: string): string | null => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
};
const JSON_OUT = argValue("--json");
const MD_OUT = argValue("--md");

/** Seeded accounts. The READONLY one is created by `ensureReadonly()` below. */
const PASSWORD = process.env.FGMP_WALK_PASSWORD ?? "Admin@2026";
const CREDENTIALS: Record<string, { email: string; password: string }> = {
  SUPERADMIN: { email: "superadmin@fgmp.telecom", password: "Super@2026" },
  ADMIN: { email: "admin@fgmp.telecom", password: PASSWORD },
  NOC_OPERATOR: { email: "noc.operator@fgmp.telecom", password: PASSWORD },
  REGIONAL_MANAGER: { email: "regional.manager@fgmp.telecom", password: PASSWORD },
  FIELD_ENGINEER: { email: "field.engineer@fgmp.telecom", password: PASSWORD },
  EXECUTIVE: { email: "cto@fgmp.telecom", password: PASSWORD },
  READONLY: { email: "readonly.walk@fgmp.telecom", password: "Readonly@2026" },
};

const GHOST = "__walk_probe_does_not_exist__";

/**
 * Views that render from `/api/fgmp/state`, which is role-agnostic (every
 * authenticated role boots the same snapshot for ITS OWN tenant). For these the
 * API cannot distinguish "screen allowed" from "screen hidden", so the hidden
 * case is not evidence of a leak — the capability gate is the whole control and
 * it is asserted by `rbac-nav-single-source` and `store-identity`. The walk still
 * checks the SHOWN case (the screen must actually get data).
 */
const SNAPSHOT_BACKED = new Set<string>([
  "sites",
  "generators",
  "batteries",
  "roles",
  "fuel-forecast",
  "consumption-patterns",
]);

/**
 * The endpoint(s) each view loads, taken from the view source.
 *
 * This table is a copy and copies drift — which is why it is asserted: a view
 * key missing from here fails the run (`coverage` below), so adding a screen
 * without a probe is a visible gap rather than a silent omission.
 */
const VIEW_PROBES: Record<ViewKey, string[]> = {
  dashboard: ["/api/fgmp/state", "/api/fgmp/analytics?range=24h&projection=dashboard"],
  sites: ["/api/fgmp/state", "/api/fgmp/sites"],
  fuel: ["/api/fgmp/analytics?projection=fuel"],
  dispensers: ["/api/fgmp/dispensers", "/api/fgmp/dispensers/transactions"],
  "edge-firmware": ["/api/fgmp/dispensers", "/api/fgmp/iot", "/api/fgmp/edge/firmware"],
  generators: ["/api/fgmp/generators", "/api/fgmp/state"],
  batteries: ["/api/fgmp/batteries", "/api/fgmp/state"],
  alarms: ["/api/fgmp/alarms"],
  suppressions: ["/api/fgmp/suppressions"],
  "asset-registry": ["/api/fgmp/tanks", "/api/fgmp/generators", "/api/fgmp/batteries"],
  inventory: ["/api/fgmp/deliveries", "/api/fgmp/analytics?projection=inventory"],
  iot: ["/api/fgmp/iot"],
  maintenance: ["/api/fgmp/maintenance"],
  analytics: ["/api/fgmp/analytics?projection=analytics"],
  // Both compute from the snapshot in the browser; neither calls an endpoint of
  // its own. Probing them with `projection=analytics` (as this table did first)
  // reported a 403 for NOC_OPERATOR — correct for ANALYTICS, meaningless for
  // these screens.
  "fuel-forecast": ["/api/fgmp/state"],
  "consumption-patterns": ["/api/fgmp/state"],
  reports: ["/api/fgmp/reports?period=30d"],
  audit: ["/api/fgmp/audit?limit=50"],
  users: ["/api/fgmp/users"],
  tenants: ["/api/fgmp/tenants", "/api/fgmp/platform/grants", "/api/fgmp/platform/audit?limit=10"],
  geography: ["/api/fgmp/geography"],
  roles: ["/api/fgmp/state"],
  "system-settings": ["/api/fgmp/settings"],
  "api-keys": ["/api/fgmp/api-keys"],
  "system-health": ["/api/fgmp/health"],
  "tenant-isolation": ["/api/fgmp/admin/tenant-isolation-test"],
  preferences: ["/api/fgmp/preferences", "/api/fgmp/mfa/status"],
};

/**
 * Every write control in the product, with the capability that gates it.
 *
 * `expect: "cap"` means: the capability decides, and the status classes must
 * separate — holder gets anything but 401/403, non-holder gets 401/403. `allow`
 * lists the capabilities under which the probe is meaningful at all (a route
 * behind a coarse role set still answers 403 for a role outside it, which is a
 * pass for the capability but a different reason).
 */
interface ControlProbe {
  name: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  capability: string;
}

const CONTROL_PROBES: ControlProbe[] = [
  {
    name: "delivery.dispatch",
    method: "POST",
    path: "/api/fgmp/deliveries",
    body: { action: "dispatch", deliveryId: GHOST },
    capability: "delivery:approve",
  },
  {
    name: "delivery.verify",
    method: "POST",
    path: "/api/fgmp/deliveries",
    body: { action: "verify", deliveryId: GHOST, volumeDelivered: 1 },
    capability: "delivery:verify",
  },
  {
    name: "ticket.create",
    method: "POST",
    path: "/api/fgmp/maintenance",
    body: {
      action: "create",
      siteId: GHOST,
      assetKind: "GENERATOR",
      assetId: GHOST,
      type: "CORRECTIVE",
      priority: "MEDIUM",
      title: "walk probe",
      description: "walk probe",
    },
    capability: "ticket:create",
  },
  {
    name: "ticket.complete",
    method: "POST",
    path: "/api/fgmp/maintenance",
    body: { action: "complete", ticketId: GHOST },
    capability: "ticket:complete",
  },
  {
    name: "ticket.assign",
    method: "POST",
    path: `/api/fgmp/maintenance/${GHOST}/assign`,
    body: { assigneeId: GHOST },
    capability: "ticket:assign",
  },
  {
    name: "alarm.ack",
    method: "POST",
    path: "/api/fgmp/alarms",
    body: { action: "ack", alarmId: GHOST },
    capability: "alarm:ack",
  },
  {
    name: "support.open",
    method: "POST",
    path: "/api/fgmp/platform/support-sessions",
    body: { tenantId: GHOST, reason: "walk probe reason", mode: "READ" },
    capability: "tenant:manage",
  },
  {
    name: "firmware.publish",
    method: "POST",
    path: "/api/fgmp/edge/firmware",
    body: {},
    capability: "platform:firmware",
  },
  {
    name: "firmware.delete",
    method: "DELETE",
    path: `/api/fgmp/edge/firmware/${GHOST}`,
    capability: "platform:firmware",
  },
  {
    name: "apiKey.create",
    method: "POST",
    path: "/api/fgmp/api-keys",
    body: {},
    capability: "api-key:manage",
  },
  {
    name: "settings.save",
    method: "PATCH",
    path: "/api/fgmp/settings",
    body: {},
    capability: "settings:manage",
  },
  {
    name: "user.create",
    method: "POST",
    path: "/api/fgmp/users",
    body: {},
    capability: "user:manage",
  },
  {
    name: "gen.control",
    method: "POST",
    path: `/api/fgmp/generators/${GHOST}/control`,
    body: { command: "START", reason: "walk probe" },
    capability: "gen:control",
  },
  {
    name: "mfa.disable",
    // Role-agnostic by design (AUTH_ONLY_API_RULES): everyone may turn off their
    // OWN second factor, given a valid code. An empty body is a 400 for every
    // role, and a 403 for none — which is the property being recorded.
    method: "POST",
    path: "/api/fgmp/mfa/disable",
    body: {},
    capability: "*",
  },
];

/* ── HTTP plumbing ───────────────────────────────────────────────────────── */

type Cookies = Map<string, string>;

function cookieHeader(jar: Cookies): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorb(jar: Cookies, res: Response): void {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function login(
  email: string,
  password: string,
): Promise<{ jar: Cookies; ok: boolean; detail: string; status: number }> {
  const jar: Cookies = new Map();
  let csrfRes: Response;
  try {
    csrfRes = await fetch(`${BASE}/api/auth/csrf`, { headers: { cookie: cookieHeader(jar) } });
  } catch {
    return { jar, ok: false, detail: "unavailable (CSRF request failed)", status: 0 };
  }
  absorb(jar, csrfRes);
  if (!csrfRes.ok || isWalkProbeInconclusive(csrfRes.status)) {
    return { jar, ok: false, detail: `HTTP ${csrfRes.status}`, status: csrfRes.status };
  }
  let csrfToken: string;
  try {
    ({ csrfToken } = (await csrfRes.json()) as { csrfToken: string });
  } catch {
    return { jar, ok: false, detail: "unavailable (invalid CSRF response)", status: 0 };
  }
  if (!csrfToken) {
    return { jar, ok: false, detail: "unavailable (missing CSRF token)", status: 0 };
  }

  const body = new URLSearchParams({ csrfToken, email, password, callbackUrl: BASE, json: "true" });
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(jar) },
      body,
      redirect: "manual",
    });
  } catch {
    return { jar, ok: false, detail: "unavailable (credentials request failed)", status: 0 };
  }
  absorb(jar, res);

  // NextAuth answers 200 with a URL on success and 401 on bad credentials; a
  // redirect (302) is also a success signal in the non-JSON form flow.
  const hasSession =
    [...jar.keys()].some((k) => k.includes("session-token")) || jar.has("__Secure-next-auth.session-token");
  return {
    jar,
    ok: (res.status === 200 || res.status === 302) && hasSession,
    detail: `HTTP ${res.status}`,
    status: res.status,
  };
}

interface ProbeResult {
  status: number;
  body: unknown;
}

async function call(
  jar: Cookies,
  method: string,
  path: string,
  body?: unknown,
): Promise<ProbeResult> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        cookie: cookieHeader(jar),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON — an HTML error page, usually; keep the text */
    }
    return { status: res.status, body: parsed };
  } catch (error) {
    return { status: 0, body: error instanceof Error ? error.message : String(error) };
  }
}

const denied = (status: number) => status === 401 || status === 403;

/* ── The walk ────────────────────────────────────────────────────────────── */

interface RoleReport {
  role: string;
  identity: string;
  login: string;
  nav: string[];
  /** view key → worst status across its probes */
  views: { key: string; shown: boolean; status: number; detail?: string }[];
  controls: {
    name: string;
    capability: string;
    holds: boolean;
    status: number;
    verdict: "ok" | "wrong" | "unknown";
  }[];
  /** Probes that were blocked by rate limits or unavailable responses; these are not passes. */
  inconclusive: string[];
  problems: string[];
}

/** Create the READONLY account the walk needs, using the ADMIN session. */
async function ensureReadonly(adminJar: Cookies): Promise<string> {
  const existing = await call(adminJar, "GET", "/api/fgmp/users");
  const rows = Array.isArray(existing.body) ? (existing.body as { email?: string }[]) : [];
  if (rows.some((u) => u.email === CREDENTIALS.READONLY.email)) return "already existed";

  const created = await call(adminJar, "POST", "/api/fgmp/users", {
    email: CREDENTIALS.READONLY.email,
    name: "Readonly Walk",
    role: "READONLY",
    password: CREDENTIALS.READONLY.password,
  });
  if (created.status >= 200 && created.status < 300) return "created";
  return `could not create (HTTP ${created.status}): ${JSON.stringify(created.body).slice(0, 200)}`;
}

async function walkRole(role: string): Promise<RoleReport> {
  const creds = CREDENTIALS[role];
  const problems: string[] = [];
  const report: RoleReport = {
    role,
    identity: "",
    login: "",
    nav: [],
    views: [],
    controls: [],
    inconclusive: [],
    problems,
  };

  if (!creds) {
    problems.push("no credentials configured for this role");
    return report;
  }

  const { jar, ok, detail, status: loginStatus } = await login(creds.email, creds.password);
  report.login = ok ? "ok" : `FAILED (${detail})`;
  if (!ok) {
    if (isWalkProbeInconclusive(loginStatus)) {
      report.inconclusive.push(`login probe was inconclusive (${detail})`);
    } else {
      problems.push(`login failed for ${creds.email}: ${detail}`);
    }
    return report;
  }

  const me = await call(jar, "GET", "/api/fgmp/me");
  const meBody = me.body !== null && typeof me.body === "object" ? (me.body as { role?: string; email?: string }) : {};
  report.identity = `${meBody.email ?? creds.email} · ${meBody.role ?? "?"}`;
  if (isWalkProbeInconclusive(me.status)) {
    report.inconclusive.push(`/api/fgmp/me probe was inconclusive (HTTP ${me.status})`);
    if (me.status === 0) return report;
  } else if (meBody.role !== role) {
    problems.push(`/api/fgmp/me reports role ${meBody.role ?? "?"}, expected ${role}`);
  }

  // ── nav: exactly what the sidebar would render, from the same function ──
  const entries = navEntriesFor((cap) => hasCapability(role as never, cap));
  report.nav = entries.map((e) => e.key);

  const shown = new Set(report.nav);
  for (const key of Object.keys(VIEW_PROBES) as ViewKey[]) {
    const probes = VIEW_PROBES[key];
    let worst = 0;
    let detailText: string | undefined;
    const inconclusiveDetails: string[] = [];
    for (const path of probes) {
      const r = await call(jar, "GET", path);
      worst = Math.max(worst, r.status);
      if (isWalkProbeInconclusive(r.status)) {
        inconclusiveDetails.push(`${path} → HTTP ${r.status}`);
      }
      if (r.status >= 400 && !detailText) {
        detailText = `${path} → ${r.status}`;
      }
    }
    report.views.push({ key, shown: shown.has(key), status: worst, detail: detailText });
    if (inconclusiveDetails.length) {
      report.inconclusive.push(`view "${key}" probe(s) inconclusive: ${inconclusiveDetails.join(", ")}`);
    }
  }

  // A view the role CAN open must answer. Rate limits and server/network
  // failures do not establish authorization either way.
  for (const v of report.views) {
    if (v.shown && v.status >= 400 && !isWalkProbeInconclusive(v.status)) {
      problems.push(`nav shows "${v.key}" but its API answered ${v.status} (${v.detail ?? ""})`);
    }
    if (
      !v.shown &&
      !SNAPSHOT_BACKED.has(v.key) &&
      !denied(v.status) &&
      !isWalkProbeInconclusive(v.status)
    ) {
      // Not reaching a 401/403 here means the endpoint is reachable without the
      // nav capability — which is exactly the "typed URL shows content" defect.
      problems.push(`nav hides "${v.key}" but its API answered ${v.status} (${v.detail ?? ""})`);
    }
  }

  // ── controls ───────────────────────────────────────────────────────────
  for (const p of CONTROL_PROBES) {
    const holds = p.capability === "*" ? true : hasCapability(role as never, p.capability);
    const r = await call(jar, p.method, p.path, p.body);
    const verdict = classifyWalkControl(holds, r.status);
    if (verdict === "unknown") {
      report.inconclusive.push(`control "${p.name}" was inconclusive (HTTP ${r.status})`);
    } else if (verdict === "wrong" && holds) {
      // A holder may still be outside the route's coarse role set (e.g. a route
      // gated on ROLES.MAINTENANCE). That is a 403 for a different reason, and
      // `capability-reachability` + the role sets are what keep the two aligned;
      // here we only flag a route that refuses a holder it admits.
      problems.push(`control "${p.name}" REFUSED a ${role} that holds ${p.capability} (HTTP ${r.status})`);
    } else if (verdict === "wrong") {
      problems.push(`control "${p.name}" ACCEPTED a ${role} that does NOT hold ${p.capability} (HTTP ${r.status})`);
    }
    report.controls.push({ name: p.name, capability: p.capability, holds, status: r.status, verdict });
  }

  return report;
}

function mdTable(reports: RoleReport[]): string {
  const lines: string[] = [];
  lines.push("# Live RBAC walk — per role, against a running server and database", "");
  lines.push(
    "Generated by `scripts/verify/rbac-live-walk.ts`. Every row is a real HTTP request made ",
    "with a real NextAuth session for that role, against a seeded PostgreSQL database. ",
    "`nav` is `navEntriesFor(hasCapability(role, …))` — the exact function the sidebar and ",
    "the command palette call.",
    "",
  );

  for (const r of reports) {
    lines.push(`## ${r.role}`, "");
    lines.push(`Identity: \`${r.identity}\` · login: ${r.login}`, "");
    lines.push(`Nav (${r.nav.length}): ${r.nav.map((k) => `\`${k}\``).join(", ") || "—"}`, "");
    lines.push("| view | in nav | API | verdict |", "|---|---|---|---|");
    for (const v of r.views) {
      const good = v.shown
        ? v.status < 400 || v.status === 429
        : SNAPSHOT_BACKED.has(v.key) || v.status === 401 || v.status === 403 || v.status === 429;
      const verdict = isWalkProbeInconclusive(v.status)
        ? "**INCONCLUSIVE**"
        : SNAPSHOT_BACKED.has(v.key) && !v.shown
          ? "snapshot (n/a)"
          : good
            ? "ok"
            : "**MISMATCH**";
      lines.push(
        `| ${v.key} | ${v.shown ? "yes" : "no"} | ${v.status}${v.detail ? ` (${v.detail})` : ""} | ${verdict} |`,
      );
    }
    lines.push("", "| control | capability | holds | HTTP | verdict |", "|---|---|---|---|---|");
    for (const c of r.controls) {
      lines.push(
        `| ${c.name} | \`${c.capability}\` | ${c.holds ? "yes" : "no"} | ${c.status} | ${c.verdict === "ok" ? "ok" : c.verdict === "unknown" ? "**INCONCLUSIVE**" : "**MISMATCH**"} |`,
      );
    }
    lines.push("");
    if (r.problems.length) {
      lines.push("**Problems:**", "", ...r.problems.map((p) => `- ${p}`), "");
    }
    if (r.inconclusive.length) {
      lines.push("**Inconclusive probes (not passes):**", "", ...r.inconclusive.map((p) => `- ${p}`), "");
    }
    if (!r.problems.length && !r.inconclusive.length) {
      lines.push("No mismatches; every probe produced an authorization-observable result.", "");
    }
  }
  return lines.join("\n");
}

async function main() {
  // Coverage first: a view with no probe is a hole in the walk, not a pass.
  const missing = (Object.keys(ROLE_PERMISSIONS) as string[]).length ? [] : [];
  void missing;
  const probeKeys = new Set(Object.keys(VIEW_PROBES));
  const allViews: string[] = [];
  for (const role of ALL_ROLES) {
    for (const e of navEntriesFor((cap) => hasCapability(role, cap))) {
      if (!allViews.includes(e.key)) allViews.push(e.key);
    }
  }
  const uncovered = allViews.filter((k) => !probeKeys.has(k));
  if (uncovered.length) {
    console.error(`[walk] no endpoint probe for view(s): ${uncovered.join(", ")}`);
    process.exit(2);
  }

  // The READONLY account is created through the product, as an admin would.
  const admin = await login(CREDENTIALS.ADMIN.email, CREDENTIALS.ADMIN.password);
  if (admin.ok) {
    const outcome = await ensureReadonly(admin.jar);
    console.log(`[walk] READONLY account: ${outcome}`);
  } else {
    console.error("[walk] admin login failed — cannot prepare the READONLY account");
  }

  const reports: RoleReport[] = [];
  for (const role of ALL_ROLES) {
    console.log(`[walk] ${role} …`);
    reports.push(await walkRole(role));
  }

  const md = mdTable(reports);
  if (MD_OUT) {
    writeFileSync(MD_OUT, md);
    console.log(`[walk] wrote ${MD_OUT}`);
  }
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, generatedAt: new Date().toISOString(), reports }, null, 2));
    console.log(`[walk] wrote ${JSON_OUT}`);
  }

  console.log("\n" + md + "\n");

  const failing = reports.filter((r) => r.problems.length > 0);
  const inconclusive = reports.filter((r) => r.inconclusive.length > 0);
  const exitCode = walkExitCode(failing.length > 0, inconclusive.length > 0);
  if (exitCode === 1) {
    console.error(`[walk] ${failing.length} role(s) with authorization mismatches: ${failing.map((r) => r.role).join(", ")}`);
    process.exitCode = exitCode;
    return;
  }
  if (exitCode === 2) {
    console.error(
      `[walk] INCONCLUSIVE: ${inconclusive.length} role(s) had rate-limited or unavailable probes: ${inconclusive.map((r) => r.role).join(", ")}`,
    );
    process.exitCode = exitCode;
    return;
  }
  console.log(`[walk] all ${reports.length} roles consistent; every probe produced an authorization-observable result`);
}

await main();
