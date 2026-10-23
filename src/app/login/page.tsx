import { redirect } from "next/navigation";

/**
 * `/login` — an alias for the application root.
 *
 * ── WHY THIS PAGE EXISTS AT ALL ────────────────────────────────────────────
 * This application has no separate sign-in route: `/` renders the app shell and
 * a `LoginDialog` when there is no session (see `src/components/fgmp/app-shell.tsx`).
 * That is a deliberate design, and `/signin` genuinely does not exist.
 *
 * But `/login` is the URL every human types, every bookmark bar has, and every
 * password manager autofills. It returned a 404, and a 404 on the one page a
 * locked-out operator needs is indistinguishable from "the deployment is
 * broken". Users then file "the site is down" tickets during exactly the
 * incident when nobody has time for them.
 *
 * The fix is an alias, not a second login implementation: a redirect to the one
 * place that can actually authenticate. Anything that duplicated the sign-in
 * form here would be a second surface to keep in step with NextAuth, MFA,
 * lockout and the demo-credential policy.
 *
 * A `callbackUrl` is preserved when it is a same-origin path, so a bookmark like
 * `/login?callbackUrl=/sites` still lands where the user was going. Absolute
 * URLs are dropped rather than forwarded: an open redirect on a login page is a
 * phishing primitive.
 */
export default async function LoginAliasPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.callbackUrl) ? params.callbackUrl[0] : params.callbackUrl;

  // Same-origin absolute paths only. `//evil.example` is rejected explicitly:
  // browsers treat it as protocol-relative and it would leave the site.
  const target = raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";

  redirect(target);
}
