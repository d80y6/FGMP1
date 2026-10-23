import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // ── GATE ──────────────────────────────────────────────────────────────
    // These were ALL "off", which made `eslint .` exit 0 without checking
    // anything at all — a false green that hid real bugs (a global keydown
    // listener re-registering every render, a Math.random() call in a render
    // body, an effect depending on its own state).
    //
    // Rules that are genuinely clean today are re-enabled as ERRORS and are
    // now enforced in CI. Rules with a known backlog are re-enabled as
    // WARNINGS so they surface new violations without blocking: each warning
    // is visible in CI output and ratcheting them to "error" is the plan as
    // the backlog is cleared.
    "react-hooks/rules-of-hooks": "error",        // was off — now clean, enforced
    "react-hooks/exhaustive-deps": "error",        // was off; backlog cleared, now enforced
    "react-hooks/purity": "error",                 // was off; wall-clock randers now use useNow()
    "react/no-unescaped-entities": "warn",
    "@typescript-eslint/no-explicit-any": "warn",  // 77 known; was off
    // A leading underscore is the project's way of saying "deliberately
    // unused" — a callback's positional argument that a signature requires, or
    // an interface kept for compatibility. Without these patterns the rule
    // reports those AND real dead code identically, which is how a list of 120
    // warnings becomes noise nobody reads. Real dead code is still reported.
    "@typescript-eslint/no-unused-vars": ["warn", {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      destructuredArrayIgnorePattern: "^_",
    }],
    "@typescript-eslint/no-non-null-assertion": "warn",
    "no-debugger": "error",
    "no-fallthrough": "warn",
    "no-unreachable": "warn",

    // Still off: silencing TypeScript is how the type gate was bypassed.
    // `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` are banned outright —
    // `tsc --noEmit` is the type gate, and commenting around it defeats it.
    "@typescript-eslint/ban-ts-comment": "error",

    // Deliberately off (project style, not correctness):
    "@typescript-eslint/prefer-as-const": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",
    "@next/next/no-img-element": "off",
    "@next/next/no-html-link-for-pages": "off",
    "prefer-const": "off",
    "no-unused-vars": "off",          // base rule; the TS-aware one above applies
    "no-console": "off",
    "no-empty": "off",
    "no-undef": "off",                // TypeScript resolves identifiers
    "no-redeclare": "off",
    "no-irregular-whitespace": "off",
    "no-case-declarations": "off",
    "no-mixed-spaces-and-tabs": "off",
    "no-useless-escape": "off",
  },
}, {
  // ── PHASE 2: tenant-scoped database access in route handlers ────────────
  //
  // Phase 1 enabled FORCE Row Level Security on all 24 tenant tables. Any
  // `db.*` call made without a tenant context in scope does not ERROR — it
  // returns ZERO rows. Measured against the live database:
  //
  //     db.site.count()                                      -> 0
  //     db.site.count({ where: { tenantId: "t-default" } })  -> 0   ← a WHERE
  //     withTenant("t-default", tx => tx.site.count())       -> 52     does NOT help
  //
  // The second line is the important one. The application-level tenant defences
  // built in Phase 0 (`tenantWhere()`, `assertTenantOwned()`) are POST-FETCH
  // in-memory filters: they cannot filter rows the database refuses to return.
  // So those defences are intact AND completely inert, and every route relying
  // on them is serving empty data while returning HTTP 200.
  //
  // Failing closed is right for a DATABASE and disastrous for an APPLICATION,
  // because an empty result is indistinguishable from real business data.
  //
  // This rule is the durable fix: it is compile-time, covers 100% of imports,
  // costs nothing at runtime, and makes the NEXT route fail the build rather
  // than the next deployment.
  //
  // Route handlers must reach the database through `withTenant()` from
  // src/lib/fgmp/tenant-context.ts, or through the explicit owner-path modules
  // that document WHY they are cross-tenant (auth-identity, audit fallback,
  // the scheduler). Those modules live under src/lib/** and are deliberately
  // NOT covered by this rule.
  files: ["src/app/**"],
  rules: {
    "no-restricted-imports": ["error", {
      paths: [
        {
          // The BARREL is the dominant import path, not "@/lib/db": 77 route
          // files import `db` from "@/lib/fgmp", which re-exports it from
          // "@/lib/db". Banning only the direct path would have flagged 2 files
          // and left 77 broken ones passing — a false green, which is worse
          // than no rule at all.
          name: "@/lib/fgmp",
          importNames: ["db"],
          message:
            "Route handlers must not use the raw `db` client: under FORCE RLS it " +
            "silently returns zero rows without a tenant context. Wrap the query in " +
            "withTenant(tenantId, …) from '@/lib/fgmp/tenant-context' and run it on the " +
            "transaction client it provides. A `where: { tenantId }` clause does NOT " +
            "satisfy RLS. If this read is genuinely cross-tenant by design, use one of " +
            "the documented owner-path modules instead (auth-identity, audit, scheduler) " +
            "rather than re-priming the app to the owner role.",
        },
        {
          name: "@/lib/db",
          importNames: ["db"],
          message:
            "Route handlers must not use the raw `db` client: under FORCE RLS it " +
            "silently returns zero rows without a tenant context. Use " +
            "withTenant(tenantId, …) from '@/lib/fgmp/tenant-context'.",
        },
      ],
      patterns: [
        {
          group: ["**/lib/db"],
          message:
            "Route handlers must not reach the Prisma client directly. Use " +
            "withTenant(tenantId, …) from '@/lib/fgmp/tenant-context'.",
        },
      ],
      // ── Tenant-context backstop (step 3) ──────────────────────────────
      // asTenant() takes the AUTHENTICATED USER, so a request body / query
      // param / path param cannot reach the tenant context: those values do
      // not have a type that satisfies the parameter. That is the guarantee.
      //
      // What the type does NOT catch is an in-code mistake — passing a row, or
      // a hand-built { tenantId }. This rule is a BACKSTOP for the common
      // textual form of that mistake, not the control itself, and it is known
      // to produce false negatives for any new alias name. Treat a hit as
      // "look here", not as exhaustive.
      //
      // It deliberately does NOT forbid a client-supplied tenantId reaching
      // asTenantForAnotherTenant, because that IS legitimate there — a
      // super-admin provisioning for another tenant supplies it by design, and
      // the helper asserts SUPERADMIN at runtime.
    }],
    // ── Backstop: asTenant() must be given the USER, not a tenant id ───────
    // The real control is the TYPE: asTenant takes Pick<SessionUser,"tenantId">,
    // so `asTenant(parsed.data.tenantId, …)` cannot compile. This rule is a
    // backstop for the textual form of the mistake that the type ALSO rejects
    // but which a careless find-and-replace can reintroduce — `asTenant(u.tenantId, …)`
    // compiles fine, because any object with a tenantId satisfies the type.
    //
    // It is deliberately narrow, and deliberately NOT presented as exhaustive:
    // it catches the common alias shapes, and a new alias name will slip past
    // it. Treat a hit as "look here", never as proof the code is correct.
    //
    // It does NOT forbid a client-supplied tenantId reaching
    // asTenantForAnotherTenant, because that is legitimate there by design — a
    // super-admin provisioning for another tenant supplies one, and the helper
    // asserts SUPERADMIN at runtime.
    "no-restricted-syntax": ["error", {
      selector:
        // The `.` is the DESCENDANT combinator: the first argument of an
        // asTenant() call is a `<name>.tenantId` MemberExpression. The previous
        // selector used `>` (direct child of the CallExpression) plus a sibling
        // MemberExpression, which matches nothing — verified by reintroducing
        // the bug and confirming the rule stayed silent, then corrected here.
        "CallExpression[callee.name=/^asTenant$/] > MemberExpression[property.name='tenantId']",
      message:
        "asTenant() takes the AUTHENTICATED USER, not a tenant id. Pass the user " +
        "object (asTenant(user, …)) so the tenant cannot come from a body, query " +
        "or path parameter. Cross-tenant work belongs in " +
        "asTenantForAnotherTenant(user, targetTenantId, fn), which asserts " +
        "SUPERADMIN at runtime. See src/lib/fgmp/route-tenant.ts.",
    }],
  },
}, {
  // ── Test + verification harnesses ────────────────────────────────────────
  // A non-null assertion in a test is an assertion about a *fixture*: `row.id!`
  // after the test has proved the row exists, or `map.get(k)!` for a key the
  // test just inserted. Removing them would trade a one-character statement of
  // intent for either a redundant if-branch per line or a cast, and a wrong
  // assertion fails the test anyway — which is the point of a test.
  //
  // The exemptions do NOT extend to `no-explicit-any` or to the React rules:
  // a fixture typed `any` can hide a contract break just as easily in a test.
  files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**/*.ts", "**/__tests__/**/*.tsx", "scripts/verify/**/*.ts"],
  rules: {
    "@typescript-eslint/no-non-null-assertion": "off",
  },
}, {
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills"]
}];

export default eslintConfig;
