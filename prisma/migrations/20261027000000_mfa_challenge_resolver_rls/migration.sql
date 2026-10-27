-- Make the MFA challenge resolver actually resolve.
--
-- ── THE BUG THIS FIXES ───────────────────────────────────────────────────────
-- `20261014000000_mfa_challenge_resolver` created `fgmp_resolve_mfa_challenge` as
-- SECURITY DEFINER and its own header claims that is what makes the read work:
--
--     "SECURITY DEFINER runs with the OWNER's rights, so it bypasses FORCE RLS"
--
-- That claim is false, and the migration's verification block was written to
-- accept it. `MfaChallenge` is `FORCE ROW LEVEL SECURITY`, and FORCE means the
-- table OWNER is subject to the policy too. The function is owned by
-- `fgmp_migrate`, which is not a superuser and does not hold BYPASSRLS, so the
-- inner SELECT ran with `app.tenant_id` unset and the `tenant_isolation` policy
-- filtered the row out. The function returned zero rows for EVERY token —
-- including tokens it had just issued.
--
-- The consequence was not subtle: `POST /api/fgmp/mfa/challenge` could never
-- verify a code, so an account with MFA enabled could never finish signing in.
-- The second factor was a one-way door. It passed review because the function is
-- SECURITY DEFINER (true) and because a unit test asserted the SQL STRING
-- contained the right WHERE clause; only a test that inserts a live challenge and
-- reads it back through the function — `mfa-status-rls.test.ts`, on a database
-- where the table owner is not a superuser — can see the difference.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────────
-- Give the function's owner a SELECT policy on this one table, so the definer
-- context can see a row it is being asked to resolve. This is deliberately NOT
-- "make fgmp_migrate BYPASSRLS": that would switch tenant isolation off for the
-- whole schema-owning role. It is one policy, on one table, whose only column
-- that is not routing metadata is a SHA-256 of a 128-bit CSPRNG token.
--
-- Policies are permissive and OR'd, so this ADDS visibility for `fgmp_migrate`
-- and changes nothing for `fgmp_app` (the application role): a request without a
-- tenant context still sees zero rows. The narrow surface is preserved by the
-- function, not by the policy — it returns only live rows, only routing columns,
-- and at most one per token.
CREATE POLICY mfa_challenge_resolver ON "MfaChallenge"
  FOR SELECT
  TO fgmp_migrate
  USING (true);

-- ── VERIFICATION ─────────────────────────────────────────────────────────────
-- The previous migration checked `prosecdef` — which was true, and irrelevant.
-- This one checks the property that was actually missing: that the definer role
-- has a policy that admits the row it needs. It cannot insert a test row (a
-- migration that writes customer-shaped data is worse than no check), so it
-- asserts the policy and the role attributes that make the two independent
-- escape hatches distinguishable.
DO $$
DECLARE
  v_policy int;
  v_bypass boolean;
BEGIN
  SELECT count(*) INTO v_policy
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_roles r ON r.oid = ANY (p.polroles)
  WHERE c.relname = 'MfaChallenge'
    AND p.polname = 'mfa_challenge_resolver'
    AND r.rolname = 'fgmp_migrate';

  IF v_policy = 0 THEN
    RAISE EXCEPTION
      'mfa_challenge_resolver policy missing or not granted to fgmp_migrate; '
      'the SECURITY DEFINER resolver will return zero rows under FORCE RLS';
  END IF;

  SELECT rolbypassrls INTO v_bypass FROM pg_roles WHERE rolname = 'fgmp_migrate';
  IF v_bypass IS TRUE THEN
    RAISE WARNING
      'fgmp_migrate holds BYPASSRLS; tenant isolation for the schema owner is off. '
      'The resolver does not need this — see the policy above.';
  END IF;

  RAISE NOTICE 'fgmp_resolve_mfa_challenge: FORCE-RLS escape present via policy';
END $$;
