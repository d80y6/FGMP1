-- A narrow, SECURITY DEFINER escape for resolving an MFA challenge token.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
-- A challenge token is presented by a caller that has no usable authority: a
-- PENDING MFA session deliberately carries no tenantId, so the tenant cannot
-- come from the session and must be discovered FROM the token.
--
-- The obvious implementation is a plain `db.mfaChallenge.findUnique({ where:
-- { tokenHash } })`. That does not work: MfaChallenge is FORCE-RLS protected, so
-- an unscoped read returns zero rows for EVERY token. The route then reports
-- CHALLENGE_INVALID for a token it issued correctly, and MFA verification can
-- never be completed. That is not a subtle degradation — it welds the second
-- factor shut. This function is what makes the door open.
--
-- ── WHY A SQL FUNCTION AND NOT A $queryRaw OVERRIDE ──────────────────────────
-- Because a bare `$queryRaw` still goes over the `fgmp_app` connection, where
-- RLS applies and no tenant context is set. It returns zero rows, always. An
-- earlier version of this fix did exactly that while a comment described
-- something else entirely — a comment claiming a fix the code did not implement
-- is worse than no comment, because it stops the next reader from looking.
--
-- SECURITY DEFINER runs with the OWNER's rights, so it bypasses FORCE RLS
-- deliberately and in one auditable place, rather than by accident in a query
-- string.
--
-- ── WHY IT IS NOT A TENANT ORACLE ───────────────────────────────────────────
-- Scope is deliberate and narrow:
--
--   * It reads exactly ONE column, `tokenHash`, which is the SHA-256 of a
--     128-bit CSPRNG token. It never reads or returns a secret, never returns
--     the token, and never returns the code.
--   * It returns ONLY rows that are LIVE: not used, not failed, not expired.
--     A spent or expired token is indistinguishable from an unknown one, so it
--     cannot be used to probe whether a challenge once existed.
--   * It returns only the routing columns: the tenant and user the token was
--     ISSUED for. The caller MUST then scope every subsequent query to that
--     tenant. Discover-by-token, then scope-after is the pairing that keeps
--     this from becoming a cross-tenant read primitive.
--   * No EXISTS/enumeration surface: one token in, at most one row out.

CREATE OR REPLACE FUNCTION fgmp_resolve_mfa_challenge(p_token_hash text)
RETURNS TABLE ("tenantId" text, "userId" text, "enrollmentId" text, "expiresAt" timestamptz)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT c."tenantId", c."userId", c."enrollmentId", c."expiresAt"
  FROM "MfaChallenge" c
  WHERE c."tokenHash" = p_token_hash
    AND c."usedAt" IS NULL
    AND c."failedAt" IS NULL
    AND c."attempts" < 1
    AND c."expiresAt" > now()
  LIMIT 1;
$$;

-- ── PERMISSIONS ──────────────────────────────────────────────────────────────
-- REPLACE the grant so a re-run is idempotent. Execution is granted to the app
-- role only; ownership stays with fgmp_migrate.
REVOKE ALL ON FUNCTION fgmp_resolve_mfa_challenge(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fgmp_resolve_mfa_challenge(text) TO fgmp_app;

-- ── VERIFICATION ─────────────────────────────────────────────────────────────
-- The function must be SECURITY DEFINER (pg_proc.prosecdef = TRUE) and owned by the
-- migrate role, which is what makes FORCE RLS not apply. If prosecdef were false,
-- it would run as the caller and return nothing, which is the exact defect above.
DO $$
DECLARE
  v_definer boolean;
  v_owner   name;
BEGIN
  SELECT p.prosecdef INTO v_definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'fgmp_resolve_mfa_challenge' AND n.nspname = 'public';

  IF v_definer IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'fgmp_resolve_mfa_challenge must be SECURITY DEFINER (prosecdef = true); got %',
      v_definer;
  END IF;

  SELECT rolname INTO v_owner
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.proname = 'fgmp_resolve_mfa_challenge' AND n.nspname = 'public';

  RAISE NOTICE 'fgmp_resolve_mfa_challenge: SECURITY DEFINER, owner=%', v_owner;
END $$;
