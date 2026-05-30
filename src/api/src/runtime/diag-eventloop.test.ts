import { afterEach, describe, expect, it } from 'bun:test';
import { startEventLoopLagMonitor, stopEventLoopLagMonitor } from './diag-eventloop.ts';

// Helper: block the main thread synchronously for `ms` so the drift-based
// probe observes a stall on its next tick.
function blockFor(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait — this is exactly the kind of synchronous CPU stall the probe
    // is built to catch.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('diag-eventloop', () => {
  afterEach(() => {
    stopEventLoopLagMonitor();
  });

  it('is a strict no-op when MAPLE_DIAG_EVENTLOOP is unset', () => {
    delete process.env.MAPLE_DIAG_EVENTLOOP;
    const stalls: number[] = [];
    const handle = startEventLoopLagMonitor({
      thresholdMs: 5,
      sampleIntervalMs: 5,
      onStall: (lagMs) => stalls.push(lagMs),
    });
    // No handle (never started) and no stalls even after a long block.
    expect(handle).toBeNull();
    blockFor(40);
    expect(stalls.length).toBe(0);
  });

  it('logs a stall when enabled and the loop blocks past the threshold', async () => {
    process.env.MAPLE_DIAG_EVENTLOOP = '1';
    const stalls: number[] = [];
    const handle = startEventLoopLagMonitor({
      thresholdMs: 20,
      sampleIntervalMs: 10,
      summaryIntervalMs: 0, // disable the rolling summary for the test
      onStall: (lagMs) => stalls.push(lagMs),
    });
    expect(handle).not.toBeNull();

    // Let the probe schedule its first tick, then block past the threshold so
    // the drift on the following tick exceeds it.
    await sleep(15);
    blockFor(60);
    await sleep(30);

    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(stalls[0]!).toBeGreaterThanOrEqual(20);

    delete process.env.MAPLE_DIAG_EVENTLOOP;
  });

  it('start is idempotent — a second call while running returns null', () => {
    process.env.MAPLE_DIAG_EVENTLOOP = '1';
    const first = startEventLoopLagMonitor({ sampleIntervalMs: 50, summaryIntervalMs: 0 });
    expect(first).not.toBeNull();
    const second = startEventLoopLagMonitor({ sampleIntervalMs: 50, summaryIntervalMs: 0 });
    expect(second).toBeNull();
    delete process.env.MAPLE_DIAG_EVENTLOOP;
  });

  it('stop is idempotent — safe to call when not running', () => {
    expect(() => {
      stopEventLoopLagMonitor();
      stopEventLoopLagMonitor();
    }).not.toThrow();
  });
});
