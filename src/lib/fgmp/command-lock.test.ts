/**
 * Tests for per-generator command serialisation.
 *
 * The failure this guards against is a STRANDED LOCK: a generator that can
 * never be commanded again because an earlier command threw between acquire and
 * release. That is an outage, not a bug, so the throwing cases get as much
 * attention as the happy path.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  withGeneratorCommandLock,
  isGeneratorCommandLocked,
  resetCommandLocks,
} from "./command-lock";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => resetCommandLocks());

describe("mutual exclusion", () => {
  test("commands for the SAME generator never overlap", async () => {
    let active = 0;
    let maxConcurrent = 0;
    const body = async () => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      await tick(5);
      active--;
    };

    await Promise.all(
      Array.from({ length: 12 }, () => withGeneratorCommandLock("gen-1", body)),
    );
    expect(maxConcurrent).toBe(1);
  });

  test("commands for DIFFERENT generators DO run concurrently", async () => {
    // A fleet-wide lock would serialise the whole estate behind one generator.
    let concurrent = 0;
    let maxConcurrent = 0;
    const body = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await tick(10);
      concurrent--;
    };

    await Promise.all([
      withGeneratorCommandLock("gen-a", body),
      withGeneratorCommandLock("gen-b", body),
      withGeneratorCommandLock("gen-c", body),
    ]);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  test("execution order is FIFO within a generator", async () => {
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        withGeneratorCommandLock("gen-1", async () => {
          await tick(1);
          order.push(n);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });
});

describe("a throwing command must not strand the lock", () => {
  test("the next command still runs after a previous one throws", async () => {
    // THE outage case: if the lock leaked, gen-1 could never be commanded
    // again and nobody would know why.
    await expect(
      withGeneratorCommandLock("gen-1", async () => {
        throw new Error("dispatch failed");
      }),
    ).rejects.toThrow("dispatch failed");

    let ran = false;
    await withGeneratorCommandLock("gen-1", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("many consecutive failures never wedge the generator", async () => {
    for (let i = 0; i < 20; i++) {
      await expect(
        withGeneratorCommandLock("gen-hot", async () => {
          throw new Error(`fail ${i}`);
        }),
      ).rejects.toThrow();
    }
    expect(isGeneratorCommandLocked("gen-hot")).toBe(false);
    await withGeneratorCommandLock("gen-hot", async () => undefined);
  });

  test("a rejected predecessor does not poison later commands", async () => {
    const failing = withGeneratorCommandLock("gen-1", async () => {
      throw new Error("boom");
    });
    const following = withGeneratorCommandLock("gen-1", async () => "ok");

    await expect(failing).rejects.toThrow("boom");
    expect(await following).toBe("ok");
  });

  test("lock state is released after a successful command", async () => {
    await withGeneratorCommandLock("gen-1", async () => undefined);
    expect(isGeneratorCommandLocked("gen-1")).toBe(false);
  });
});

describe("return values propagate", () => {
  test("the callback's value is returned", async () => {
    expect(await withGeneratorCommandLock("gen-1", async () => 42)).toBe(42);
  });

  test("values are not mixed up between concurrent generators", async () => {
    const [a, b, c] = await Promise.all([
      withGeneratorCommandLock("gen-a", async () => "a"),
      withGeneratorCommandLock("gen-b", async () => "b"),
      withGeneratorCommandLock("gen-c", async () => "c"),
    ]);
    expect([a, b, c]).toEqual(["a", "b", "c"]);
  });
});
