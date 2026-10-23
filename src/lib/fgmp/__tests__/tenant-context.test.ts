/**
 * Unit tests for the tenant context helpers.
 *
 * These are pure and need no database — they cover the input validation that
 * stands between a caller and a security context. The DATABASE-dependent
 * properties (RLS isolation, fail-closed, no context leak) are proven by
 * scripts/verify/rls-regression.ts, which runs against a live PostgreSQL instance.
 *
 * Run with:  node --test --import tsx src/lib/fgmp/__tests__/
 * (or via the project test runner once one is configured)
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertTenantId,
  normalizeTenantId,
  TenantContextError,
  tenantContextSqlFragment,
  TENANT_SETTING,
  isUuid,
} from '../tenant-context'

describe('assertTenantId', () => {
  test('accepts a cuid-style tenant id (the seeded convention)', () => {
    assert.doesNotThrow(() => assertTenantId('t-default'))
    assert.doesNotThrow(() => assertTenantId('t-platform'))
    assert.doesNotThrow(() => assertTenantId('cmuuaan6f0006jx8y8sp2wgao'))
  })

  test('accepts a uuid (harmless if the PK type ever changes)', () => {
    assert.doesNotThrow(() =>
      assertTenantId('11111111-1111-1111-1111-111111111111'),
    )
  })

  test('trims surrounding whitespace', () => {
    assert.equal(normalizeTenantId('  t-default  '), 't-default')
  })

  test('rejects the empty string', () => {
    assert.throws(() => assertTenantId(''), TenantContextError)
    assert.throws(() => assertTenantId('   '), TenantContextError)
  })

  test('rejects non-strings, including null and undefined', () => {
    // These are deliberately-wrong types. `noImplicitAny` is off in this
    // project, so @ts-expect-error is not needed to silence the compiler —
    // the runtime assertion below is what proves the guard works.
    assert.throws(() => assertTenantId(null), TenantContextError)
    assert.throws(() => assertTenantId(undefined), TenantContextError)
    assert.throws(() => assertTenantId(42), TenantContextError)
    assert.throws(() => assertTenantId({}), TenantContextError)
  })

  test('rejects SQL metacharacters', () => {
    assert.throws(() => assertTenantId("t'; DROP TABLE \"Site\"; --"), TenantContextError)
    assert.throws(() => assertTenantId('t-default OR 1=1'), TenantContextError)
    assert.throws(() => assertTenantId('t alpha'), TenantContextError)
    assert.throws(() => assertTenantId('t\nalpha'), TenantContextError)
  })

  test('rejects an absurdly long id', () => {
    assert.throws(() => assertTenantId('t'.repeat(500)), TenantContextError)
  })

  test('the empty-id error explains the fail-closed consequence', () => {
    // The message matters: an empty context is safe but breaks every query in
    // the request, so the operator needs to know that is what happened.
    try {
      assertTenantId('')
      assert.fail('expected a throw')
    } catch (err) {
      assert.ok(err instanceof TenantContextError)
      assert.match(err.message, /fail closed|zero rows/i)
    }
  })
})

describe('tenantContextSqlFragment', () => {
  test('is transaction-local, never a pooled-global SET', () => {
    const sql = tenantContextSqlFragment()
    // A bare `SET app.tenant_id = ...` would persist for the life of the
    // connection and be inherited by the next tenant that borrows it from the
    // pool. The third set_config argument must stay `true`.
    assert.match(sql, /set_config\('app\.tenant_id', \$1, true\)/)
    assert.doesNotMatch(sql, /,\s*false\s*\)/)
    assert.doesNotMatch(sql, /^SET\s/i)
  })

  test('targets the GUC the RLS policies read', () => {
    assert.equal(TENANT_SETTING, 'app.tenant_id')
    assert.ok(tenantContextSqlFragment().includes(TENANT_SETTING))
  })

  test('passes the tenant id as a bound parameter, not interpolated SQL', () => {
    // `$1` means Prisma sends it as a real bind parameter, so a hostile tenant
    // id cannot alter the statement even if validation were bypassed. This
    // matters because PostgreSQL's SET grammar cannot take bind parameters at
    // all — `SET LOCAL app.tenant_id = $1` is a syntax error — so set_config
    // is the only bindable, transaction-local option.
    assert.ok(tenantContextSqlFragment().endsWith('$1, true)'))
  })
})

describe('isUuid', () => {
  test('this schema uses cuids, not uuids', () => {
    assert.equal(isUuid('t-default'), false)
    assert.equal(isUuid('t-platform'), false)
  })

  test('recognises a real uuid', () => {
    assert.equal(isUuid('11111111-1111-1111-1111-111111111111'), true)
  })

  test('rejects a cuid that merely contains dashes', () => {
    assert.equal(isUuid('t-alpha-12345'), false)
  })
})
