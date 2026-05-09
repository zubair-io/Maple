/**
 * CircuitBreaker tests — pure logic, virtual clock.
 */

import { describe, it, expect } from "bun:test";
import { CircuitBreaker } from "./circuit-breaker.ts";

function makeBreaker(opts?: {
  threshold?: number;
  openMs?: number;
}): { breaker: CircuitBreaker; tick: (ms: number) => void; logs: string[] } {
  let virtualMs = 0;
  const logs: string[] = [];
  const breaker = new CircuitBreaker({
    failureThreshold: opts?.threshold ?? 3,
    openDurationMs: opts?.openMs ?? 1_000,
    now: () => virtualMs,
    log: (m) => logs.push(m),
  });
  return {
    breaker,
    tick: (ms: number) => { virtualMs += ms; },
    logs,
  };
}

describe("CircuitBreaker", () => {
  it("starts closed and lets calls through", () => {
    const { breaker } = makeBreaker();
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.snapshot().state).toBe("closed");
  });

  it("opens after the threshold of consecutive failures", () => {
    const { breaker, logs } = makeBreaker({ threshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe("closed");
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe("open");
    expect(breaker.allowRequest()).toBe(false);
    expect(logs.some((l) => l.includes("closed->open"))).toBe(true);
  });

  it("a success before the threshold resets the consecutive counter", () => {
    const { breaker } = makeBreaker({ threshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    // Only 2 consecutive failures since the success — still closed.
    expect(breaker.snapshot().state).toBe("closed");
    expect(breaker.snapshot().consecutiveFailures).toBe(2);
  });

  it("transitions open -> half-open after openDurationMs and allows the probe", () => {
    const { breaker, tick, logs } = makeBreaker({ threshold: 1, openMs: 1_000 });
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe("open");
    expect(breaker.allowRequest()).toBe(false);
    tick(999);
    expect(breaker.allowRequest()).toBe(false);
    tick(1);
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.snapshot().state).toBe("half-open");
    expect(logs.some((l) => l.includes("open->half-open"))).toBe(true);
  });

  it("a successful probe closes the breaker", () => {
    const { breaker, tick, logs } = makeBreaker({ threshold: 1, openMs: 1_000 });
    breaker.recordFailure();
    tick(1_000);
    breaker.allowRequest();
    expect(breaker.snapshot().state).toBe("half-open");
    breaker.recordSuccess();
    expect(breaker.snapshot().state).toBe("closed");
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
    expect(logs.some((l) => l.includes("half-open->closed"))).toBe(true);
  });

  it("a failed probe re-opens the breaker and restarts the cool-down", () => {
    const { breaker, tick, logs } = makeBreaker({ threshold: 1, openMs: 1_000 });
    breaker.recordFailure();
    tick(1_000);
    breaker.allowRequest(); // half-open
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe("open");
    // Cool-down restarts — at t=1000, allowRequest just opened; at t=1500
    // we should still be open.
    tick(500);
    expect(breaker.allowRequest()).toBe(false);
    tick(500);
    expect(breaker.allowRequest()).toBe(true);
    expect(logs.filter((l) => l.includes("half-open->open")).length).toBe(1);
  });
});
