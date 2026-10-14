import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as maple from "maple";
import { callNativeRetrying, isPoolOverload } from "./native-call";

let callNativeSpy: { mockRestore(): void } | null = null;
let priorMapleConcurrency: number | null = null;

afterEach(() => {
  callNativeSpy?.mockRestore();
  callNativeSpy = null;
  if (priorMapleConcurrency !== null)
    maple.setMapleConcurrency(priorMapleConcurrency);
  priorMapleConcurrency = null;
});

describe("isPoolOverload", () => {
  test("recognizes the maple worker pool overload signal", () => {
    const byCode = Object.assign(new Error("full"), {
      code: "MAPLE_WORKER_POOL_OVERLOADED",
    });
    const byName = new Error("full");
    byName.name = "MapleWorkerPoolOverloadedError";
    const byMessage = new Error(
      "Maple worker pool is full; await an outstanding call before submitting more work",
    );
    expect(isPoolOverload(byCode)).toBe(true);
    expect(isPoolOverload(byName)).toBe(true);
    expect(isPoolOverload(byMessage)).toBe(true);
    expect(isPoolOverload(new Error("Variant changed"))).toBe(false);
    expect(isPoolOverload(null)).toBe(false);
    expect(isPoolOverload("worker pool is full")).toBe(false);
  });
});

describe("callNativeRetrying", () => {
  test("admits queued retries concurrently up to the Maple worker pool size", async () => {
    priorMapleConcurrency = maple.getMapleConcurrency();
    maple.setMapleConcurrency(2);
    const attempts: string[] = [];
    let firstAttempts = 0;
    let releaseFirst = () => {};
    callNativeSpy = spyOn(maple, "callNative").mockImplementation((async (
      method: string,
    ) => {
      attempts.push(method);
      if (method === "first" && firstAttempts++ === 0) {
        throw Object.assign(new Error("worker pool is full"), {
          code: "MAPLE_WORKER_POOL_OVERLOADED",
        });
      }
      if (method === "first")
        return await new Promise<{ ok: true; value: string }>((resolve) => {
          releaseFirst = () => resolve({ ok: true, value: "first" });
        });
      return { ok: true, value: method };
    }) as never);

    const first = callNativeRetrying("first", []);
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (firstAttempts >= 2) return resolve();
        if (Date.now() - started > 1000)
          return reject(new Error("first retry did not start"));
        setTimeout(poll, 5);
      };
      poll();
    });
    const second = callNativeRetrying("second", []);

    await expect(second).resolves.toEqual({ ok: true, value: "second" });
    expect(attempts).toEqual(["first", "first", "second"]);
    releaseFirst();
    await expect(first).resolves.toEqual({ ok: true, value: "first" });
  });

  test("cancels a waiting retry when its request is aborted", async () => {
    callNativeSpy = spyOn(maple, "callNative").mockImplementation((async () => {
      throw Object.assign(new Error("worker pool is full"), {
        code: "MAPLE_WORKER_POOL_OVERLOADED",
      });
    }) as never);
    const controller = new AbortController();
    const waiting = callNativeRetrying("save", [], controller.signal);
    setTimeout(() => controller.abort(), 20);

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  test("bounds the number of retained retry requests", async () => {
    callNativeSpy = spyOn(maple, "callNative").mockImplementation((async () => {
      throw Object.assign(new Error("worker pool is full"), {
        code: "MAPLE_WORKER_POOL_OVERLOADED",
      });
    }) as never);
    const controller = new AbortController();
    const waiting = Array.from({ length: 40 }, (_, index) =>
      callNativeRetrying(`save-${index}`, [], controller.signal),
    );
    const settled = Promise.allSettled(waiting);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    const results = await settled;
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(40);
    expect(
      results.filter(
        (result) =>
          result.status === "rejected" && isPoolOverload(result.reason),
      ),
    ).toHaveLength(8);
  });
});
