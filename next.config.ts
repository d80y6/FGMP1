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
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss: http://localhost:*",
      // See the FRAME EMBEDDING note above — deliberately permissive.
      "frame-ancestors 'self' https:",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
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
