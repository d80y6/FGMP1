import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    "react-hooks/exhaustive-deps": "warn",         // 27 known violations; was off
    "react-hooks/purity": "warn",                  // impure render calls (Math.random in render)
    "react/no-unescaped-entities": "warn",
    "@typescript-eslint/no-explicit-any": "warn",  // 76 known; was off
    "@typescript-eslint/no-unused-vars": "warn",
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
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills"]
}];

export default eslintConfig;
