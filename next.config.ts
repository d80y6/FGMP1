import type { NextConfig } from "next";

/**
 * Security headers applied to every route.
 *
 * These headers harden the FGMP platform against common web attacks:
 *   - X-Content-Type-Options: nosniff  → blocks MIME-type sniffing
 *   - Referrer-Policy                  → limits referrer leakage to cross-origin
 *   - Permissions-Policy               → disables camera/mic/geolocation APIs
 *   - X-DNS-Prefetch-Control: off      → prevents prefetch of attacker-controlled hosts
 *   - Strict-Transport-Security        → forces HTTPS for 1 year (production only)
 *   - Content-Security-Policy          → restricts resource origins + frame-ancestors
 *
 * FRAME EMBEDDING — a deliberate trade-off, kept here so the reasoning survives.
 *
 * `frame-ancestors 'self' https:` allows ANY https origin to frame the app.
 * That is weaker than `X-Frame-Options: SAMEORIGIN`, and it is intentional: the
 * platform is deployed inside a preview iframe whose hostname varies per
 * session, and SAMEORIGIN cannot express a wildcard-subdomain allow-list. The
 * deprecated X-Frame-Options header is therefore removed entirely rather than
 * left to contradict this.
 *
 * What makes it acceptable:
 *   (a) the app is behind NextAuth, so an embedded frame still requires a
 *       valid session;
 *   (b) https framing is still required, which blocks the plain-HTTP
 *       clickjacking this would otherwise permit;
 *   (c) an attacker who can frame us can already run script in their OWN origin
 *       — the residual risk is UI redressing, bounded by (a) and (b).
 *
 * If this is ever deployed somewhere that does NOT need iframe embedding,
 * tighten it to `'self'` and re-add X-Frame-Options: SAMEORIGIN. Removing the
 * comment is what makes that decision hard to revisit.
 *
 * The CSP is intentionally permissive about `'unsafe-inline'` for scripts
 * and styles because Next.js 16 + Tailwind 4 inject inline styles and the
 * dev server uses inline scripts for HMR. `connect-src` allows WebSocket
 * to localhost:* so the realtime service can connect during development.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // HSTS only in production — dev runs on http://localhost.
  ...(process.env.NODE_ENV === "production"
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000; includeSubDomains",
        },
      ]
    : []),
  {
    key: "Content-Security-Policy",
    // Development and production get DIFFERENT policies. The previous single
    // policy allowed 'unsafe-eval' and a wildcard `connect-src ws: wss:` in
    // production, where neither is needed: Next's dev server uses eval for HMR,
    // and the browser connects only to the app origin plus the hosted realtime
    // cluster. Shipping the dev policy to production widened the blast radius
    // of any XSS for the sake of a development convenience.
    value: (process.env.NODE_ENV === "production"
      ? [
          "default-src 'self'",
          // 'unsafe-inline' is required: the App Router emits inline bootstrap
          // scripts. A nonce-based policy needs middleware on every route and is
          // a larger change than this cleanup; 'unsafe-eval' is NOT required.
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: https:",
          "font-src 'self' data:",
          // Realtime is Apinator over TLS. No localhost, no bare ws:.
          "connect-src 'self' https://*.apinator.io wss://*.apinator.io",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          // See the FRAME EMBEDDING note above — deliberately permissive.
          "frame-ancestors 'self' https:",
        ]
      : [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: https:",
          "font-src 'self' data:",
          "connect-src 'self' ws: wss: http://localhost:*",
          "frame-ancestors 'self' https:",
        ]
    ).join("; "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // OpenNext must let workerd resolve Prisma's runtime-specific client and the
  // pg driver instead of bundling the native query-engine entry point.
  serverExternalPackages: [
    "@prisma/client",
    ".prisma/client",
    "@prisma/adapter-pg",
    "pg",
    // Needed for the workerd-specific Socket export used by pg.
    "pg-cloudflare",
  ],
  /* Next advertises itself with `X-Powered-By: Next.js`. There is no reason to
     tell a scanner which framework is behind the app. */
  poweredByHeader: false,
  /* `config/alerts.json` is read from disk at request time (alerting cannot
     invent thresholds). Standalone output traces only module imports, so a
     data file read through `fs` is NOT copied into the image by default —
     which would make `/api/fgmp/ops/alerts/preview` throw in production while
     working in dev. Declaring it here makes the file part of the traced
     output. */
  outputFileTracingIncludes: {
    "/api/fgmp/**": ["./config/**"],
    // Next's Node-condition trace misses the workerd-only entry selected for
    // pg-cloudflare by OpenNext's final bundle. Include both targets so the
    // require('pg-cloudflare') path in pg/lib/stream.js can resolve dist/index.js.
    "**/*": [
      "./node_modules/pg-cloudflare/dist/**",
      "./node_modules/pg-cloudflare/esm/**",
    ],
  },
  /* The type gate is now ON. `ignoreBuildErrors: true` shipped 157 type
     errors for years and is why a missing `ROLES.DISPENSER_CONTROL` key and a
     set of Prisma columns that don't exist went unnoticed until routes started
     throwing at runtime. `npx tsc --noEmit` reports 0 errors and CI enforces
     it (`npm run typecheck`). Do not re-enable this without adding the gate. */
  typescript: {
    ignoreBuildErrors: false,
  },
  /* StrictMode is re-enabled: it double-invokes effects in dev and is what
     surfaces the stale-closure and setState-in-render bugs that only showed up
     in production. */
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
