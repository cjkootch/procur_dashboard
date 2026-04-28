/**
 * Tiny vitest → node:test adapter. Lets us run vex's `calculator.test.ts`
 * verbatim under node's built-in test runner so the file stays a clean
 * upstream copy (easier to re-sync if vex evolves the calculator).
 *
 * Only implements the matchers the calculator tests actually use.
 */
import { describe as nodeDescribe, it as nodeIt } from 'node:test';
import assert from 'node:assert/strict';

export const describe = nodeDescribe;
export const it = nodeIt;

type Matchers = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeCloseTo(expected: number, digits?: number): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toHaveLength(n: number): void;
  toContain(needle: unknown): void;
};

type Expectation = Matchers & { not: Matchers };

function buildMatchers(actual: unknown, negate: boolean): Matchers {
  const ok = (cond: boolean, msg: string): void => {
    if (negate ? cond : !cond) {
      throw new assert.AssertionError({ message: msg, actual, expected: msg });
    }
  };
  return {
    toBe(expected) {
      ok(Object.is(actual, expected), `expected ${String(actual)} ${negate ? 'not ' : ''}to be ${String(expected)}`);
    },
    toEqual(expected) {
      let equal = true;
      try {
        assert.deepStrictEqual(actual, expected);
      } catch {
        equal = false;
      }
      ok(equal, `expected deep equality`);
    },
    toBeCloseTo(expected, digits = 2) {
      const diff = Math.abs((actual as number) - expected);
      const tolerance = Math.pow(10, -digits) / 2;
      ok(diff < tolerance, `expected ${actual} ${negate ? 'not ' : ''}to be close to ${expected} (±${tolerance})`);
    },
    toBeNull() {
      ok(actual === null, `expected null`);
    },
    toBeUndefined() {
      ok(actual === undefined, `expected undefined`);
    },
    toBeDefined() {
      ok(actual !== undefined, `expected defined`);
    },
    toBeGreaterThan(n) {
      ok((actual as number) > n, `expected > ${n}`);
    },
    toBeGreaterThanOrEqual(n) {
      ok((actual as number) >= n, `expected >= ${n}`);
    },
    toBeLessThan(n) {
      ok((actual as number) < n, `expected < ${n}`);
    },
    toBeLessThanOrEqual(n) {
      ok((actual as number) <= n, `expected <= ${n}`);
    },
    toHaveLength(n) {
      ok((actual as { length: number }).length === n, `expected length ${n}`);
    },
    toContain(needle) {
      const has = Array.isArray(actual)
        ? (actual as unknown[]).includes(needle)
        : typeof actual === 'string' && (actual as string).includes(needle as string);
      ok(has, `expected to contain ${String(needle)}`);
    },
  };
}

export function expect(actual: unknown): Expectation {
  return {
    ...buildMatchers(actual, false),
    not: buildMatchers(actual, true),
  };
}
