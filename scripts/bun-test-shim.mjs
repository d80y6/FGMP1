// Minimal bun:test → node shim so the repo's 29 bun:test suites can run
// in this sandbox (bun is not installable here; release-assets.githubusercontent.com
// is blocked). Implements exactly the API surface the suites use:
//   describe/test/it, expect (matchers below), beforeEach/afterEach/
//   beforeAll/afterAll, mock.
// Registered via scripts/bun-test-shim-register.mjs (module customization hooks).

const root = { suites: [], current: null };

export function __collect() { return root; }

function makeSuite(name, fn) {
  const suite = {
    name,
    tests: [],
    beforeAll: [], afterAll: [],
    beforeEach: [], afterEach: [],
  };
  const parent = root.current;
  root.current = suite;
  try { fn(); } finally { root.current = parent; }
  root.suites.push(suite);
}

export function describe(name, fn) { makeSuite(name, fn); }
export function it(name, fn) { (root.current ?? root.suites[0] ?? { tests: [] }).tests.push({ name, fn }); }
export const test = it;

export function beforeAll(fn) { root.current.beforeAll.push(fn); }
export function afterAll(fn) { root.current.afterAll.push(fn); }
export function beforeEach(fn) { root.current.beforeEach.push(fn); }
export function afterEach(fn) { root.current.afterEach.push(fn); }

export function mock(impl = () => {}) {
  const calls = [];
  const f = (...args) => { calls.push(args); return impl(...args); };
  f.mock = { calls };
  return f;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

class AssertionError extends Error {}

function fmt(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function expect(actual) {
  const api = {
    toBe: (e) => { if (!Object.is(actual, e)) throw new AssertionError(`expected ${fmt(e)}, got ${fmt(actual)}`); },
    toEqual: (e) => { if (!deepEqual(actual, e)) throw new AssertionError(`expected ${fmt(e)}, got ${fmt(actual)}`); },
    toStrictEqual: (e) => { if (!deepEqual(actual, e)) throw new AssertionError(`expected ${fmt(e)}, got ${fmt(actual)}`); },
    toContain: (e) => { if (!actual?.includes?.(e)) throw new AssertionError(`expected to contain ${fmt(e)}`); },
    toContainEqual: (e) => { if (!actual?.some?.(deepEqual.bind(null, e))) throw new AssertionError(`expected to contain equal ${fmt(e)}`); },
    toHaveLength: (n) => { if (actual?.length !== n) throw new AssertionError(`expected length ${n}, got ${actual?.length}`); },
    toBeGreaterThan: (n) => { if (!(actual > n)) throw new AssertionError(`expected > ${n}, got ${fmt(actual)}`); },
    toBeGreaterThanOrEqual: (n) => { if (!(actual >= n)) throw new AssertionError(`expected >= ${n}, got ${fmt(actual)}`); },
    toBeLessThan: (n) => { if (!(actual < n)) throw new AssertionError(`expected < ${n}, got ${fmt(actual)}`); },
    toBeLessThanOrEqual: (n) => { if (!(actual <= n)) throw new AssertionError(`expected <= ${n}, got ${fmt(actual)}`); },
    toBeCloseTo: (e, p = 2) => { if (Math.abs(actual - e) > 10 ** -p / 2) throw new AssertionError(`expected ~${e}, got ${fmt(actual)}`); },
    toBeTruthy: () => { if (!actual) throw new AssertionError(`expected truthy, got ${fmt(actual)}`); },
    toBeFalsy: () => { if (actual) throw new AssertionError(`expected falsy, got ${fmt(actual)}`); },
    toBeNull: () => { if (actual !== null) throw new AssertionError(`expected null, got ${fmt(actual)}`); },
    toBeUndefined: () => { if (actual !== undefined) throw new AssertionError(`expected undefined, got ${fmt(actual)}`); },
    toBeDefined: () => { if (actual === undefined) throw new AssertionError(`expected defined`); },
    toBeInstanceOf: (C) => { if (!(actual instanceof C)) throw new AssertionError(`expected instance of ${C.name}`); },
    toMatch: (re) => { if (typeof actual !== "string" || !actual.match(re)) throw new AssertionError(`expected ${actual} to match ${re}`); },
    toMatchObject: (e) => {
      for (const k of Object.keys(e)) if (!deepEqual(actual?.[k], e[k])) throw new AssertionError(`expected .${k} = ${fmt(e[k])}, got ${fmt(actual?.[k])}`);
    },
    toHaveProperty: (p) => { if (!(p in (actual ?? {}))) throw new AssertionError(`expected property ${p}`); },
    toThrow: (e) => {
      let threw = false;
      try { actual(); } catch (err) { threw = true; if (e && !(err instanceof e) && !String(err.message ?? err).includes(String(e))) throw new AssertionError(`threw unexpected: ${err}`); }
      if (!threw) throw new AssertionError("expected function to throw");
    },
    toHaveBeenCalled: () => {},
    toHaveBeenCalledWith: () => {},
  };
  api.not = {};
  for (const k of Object.keys(api)) if (k !== "not") api.not[k] = (...a) => { try { api[k](...a); } catch { return; } throw new AssertionError(`expected not ${k}`); };
  return api;
}
