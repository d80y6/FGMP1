/**
 * Server-side Apinator configuration + client singleton.
 * ─────────────────────────────────────────────────────────────────────────────
 * Apinator.io is a hosted, Pusher-style channel service. This module is the
 * ONE place that knows how the server reaches it: which env vars carry the
 * credentials, how a client is constructed, and how a tenant id maps onto a
 * channel name. The realtime emitter (realtime-emitter.ts), the channel-auth
 * route (api/fgmp/realtime/auth) and the health probe (api/fgmp/health) all
 * build on these exports rather than re-reading the env themselves.
 *
 * SERVER-ONLY. `@apinator/server` imports `node:crypto`, so this module must
 * never be pulled into a browser bundle. The browser uses `@apinator/client`
 * with its own NEXT_PUBLIC_* env vars (see use-realtime.ts) — the two sides
 * meet only through the channel-auth route, which is where the session cookie
 * is converted into a per-socket signature.
 *
 * ── WHY A SINGLETON RATHER THAN A CLIENT PER CALL SITE ──────────────────────
 * The client is stateless (every request is independently HMAC-signed), but
 * constructing one per emit would re-read and re-validate four env vars per
 * event. Memoizing one instance per Node.js process keeps the hot path down
 * to a pointer read; the null case (unconfigured) is deliberately NOT
 * memoized so a dev server that gains its env after boot picks it up without
 * a restart, at the cost of four env reads per call — irrelevant next to the
 * HTTP request that follows.
 *
 * ── WHY THERE IS NO DEV FALLBACK (read before "fixing") ─────────────────────
 * Project policy is fail-closed with no committed default secrets: the old
 * realtime mini-service shipped a committed dev secret that let any
 * deployment which forgot to configure it accept connections from anyone who
 * read the source. The same mistake must not be repeated for a hosted
 * service. Unset credentials mean realtime publishing is DISABLED — emits
 * are dropped, the app-shell's 5s poll keeps the UI live, and production
 * gets a single warning (not a log storm) pointing at the env vars.
 */

import { Apinator } from "@apinator/server";

/**
 * Everything the server needs to talk to one Apinator app.
 * `cluster` is validated against the known regions in apinatorServerConfig()
 * — the ws/REST hosts are derived from it, so an unknown value would produce
 * a client that fails on every request rather than at construction.
 */
export interface ApinatorServerConfig {
  appId: string;
  key: string;
  secret: string;
  cluster: string;
}

/**
 * ── WHY `private-tenant-` AND NOT A CACHE CHANNEL ───────────────────────────
 * Apinator private channels start with `private-`. Deliberately NOT a
 * `cache-` channel: a cache channel replays its last message to every
 * reconnecting subscriber, and the last message here may be a stale
 * `alarm:new` — re-toasting an acknowledged alarm after a network blip is
 * worse than the operator missing the push entirely, because the 5s poll
 * reconciles state anyway. Events on this channel carry intent ("something
 * changed, refresh now"), never data, so replay has no upside.
 */
export const TENANT_CHANNEL_PREFIX = "private-tenant-";

/**
 * The single channel per tenant. Events fan out tenant-wide (alarm,
 * command, delivery, telemetry, maintenance); per-site rooms died with the
 * socket.io mini-service — every subscriber refreshes from the API, which
 * reconciles only what that user can see.
 */
export function tenantChannel(tenantId: string): string {
  return `${TENANT_CHANNEL_PREFIX}${tenantId}`;
}

/**
 * The browser's websocket endpoint for a cluster. The REST host used by
 * trigger() is derived inside the SDK from the same cluster value
 * (`https://ws-${cluster}.apinator.io`), so these MUST stay in sync —
 * which is why the URL is a function of the cluster, not a second env var.
 */
export function apinatorWsUrl(cluster: string): string {
  return `wss://ws-${cluster}.apinator.io`;
}

/**
 * Clusters Apinator currently operates. The SDK docs describe cluster as an
 * open "region identifier (e.g. eu, us)", but the contract for this migration
 * froze it to these two; validating here means a typo ("eu1", "EU ", "prod")
 * disables realtime with one clear warning instead of producing a client that
 * fails on every publish with an opaque network error. When Apinator adds a
 * region, widening this set is the whole change.
 */
const VALID_CLUSTERS: ReadonlySet<string> = new Set(["eu", "us"]);

/** So a misconfigured deployment logs ONE warning, not one per emit. */
let warnedUnconfigured = false;

/**
 * Resolve the server-side Apinator credentials from the environment.
 *
 * Returns null unless ALL FOUR vars are set — a half-configured app would
 * otherwise construct a client that authenticates against an empty key and
 * fails on every request. Production warns once with the exact missing
 * names; development stays silent (realtime being off in a dev shell is
 * normal and expected, and NODE_ENV is often "development" precisely when
 * nothing is deployed yet).
 *
 * The cluster is trimmed and lowercased first ("EU" is not a different
 * region, just a typo waiting to be debugged at 3am).
 */
export function apinatorServerConfig(): ApinatorServerConfig | null {
  const appId = process.env.APINATOR_APP_ID?.trim() ?? "";
  const key = process.env.APINATOR_KEY?.trim() ?? "";
  const secret = process.env.APINATOR_SECRET?.trim() ?? "";
  const cluster = process.env.APINATOR_CLUSTER?.trim().toLowerCase() ?? "";

  const missing: string[] = [];
  if (!appId) missing.push("APINATOR_APP_ID");
  if (!key) missing.push("APINATOR_KEY");
  if (!secret) missing.push("APINATOR_SECRET");
  if (!cluster) missing.push("APINATOR_CLUSTER");

  const invalidCluster = cluster !== "" && !VALID_CLUSTERS.has(cluster);

  if (missing.length > 0 || invalidCluster) {
    if (process.env.NODE_ENV === "production" && !warnedUnconfigured) {
      warnedUnconfigured = true;
      if (missing.length > 0) {
        console.warn(
          `[apinator-server] ${missing.join(", ")} unset — server→browser realtime publishing is ` +
            "DISABLED. The app-shell poll keeps the UI live; set the APINATOR_* env vars to enable push.",
        );
      } else {
        console.warn(
          `[apinator-server] APINATOR_CLUSTER="${cluster}" is not one of ` +
            `${[...VALID_CLUSTERS].map((c) => `"${c}"`).join(" | ")} — server→browser realtime publishing is ` +
            "DISABLED. Fix the cluster value to enable push.",
        );
      }
    }
    return null;
  }

  return { appId, key, secret, cluster };
}

// Module-level singleton (one client per Node.js process).
let client: Apinator | null = null;

/**
 * The process-wide Apinator client, or null when the deployment is not
 * configured for realtime. Callers MUST treat null as "realtime disabled"
 * and degrade to polling — never retry, never throw.
 *
 * The happy path memoizes (construct once, return the same instance after);
 * the null path re-runs apinatorServerConfig() every call so a config that
 * appears later is picked up, and the warn-once flag inside it keeps that
 * from becoming a log flood.
 */
export function getApinatorServer(): Apinator | null {
  if (client) return client;
  const config = apinatorServerConfig();
  if (!config) return null;
  client = new Apinator({
    appId: config.appId,
    key: config.key,
    secret: config.secret,
    cluster: config.cluster,
  });
  return client;
}
