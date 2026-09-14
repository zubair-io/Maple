// src/maple/test/event-loop-stall.test.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { maple, setMapleExecutionMode } from '../src/index';

const repoRoot = path.resolve(__dirname, '../../..');
// Same reference RAW named in CLAUDE.md's "Build & test — Rust core" section
// (100MP Hasselblad L3D-100c) — the largest fixture this repo already
// commits to using for exactly this kind of perf claim. Gitignored, so this
// test skip-passes when it's absent, mirroring every other fixture-gated
// gate in this repo (`test_color_pipeline.sh`'s "no fixtures, skipping").
const bigRaw = path.join(repoRoot, 'test-fixtures/raws/dji-mavic3pro-100mp.dng');
const hasFixture = fs.existsSync(bigRaw);

// A full-quality JPEG develop of the 100MP reference RAW through this
// binding's `exportDevelopedToFile` path (native CPU-managed develop, no
// GPU chain active in this headless context) measured 7.4-10.4s wall-clock
// across a dozen real runs — far past `bun:test`'s 5000ms default per-test
// timeout, and far past the raw-core-only 220ms budget CLAUDE.md documents
// for the GPU-accelerated interactive pipeline (a different code path).
// This test's own timeout is stated explicitly, at roughly 3x the slowest
// observed develop, rather than relying on the runner default.
const DEVELOP_TEST_TIMEOUT_MS = 30_000;

/**
 * Runs a `setImmediate` heartbeat loop for exactly as long as `work` takes
 * to settle (rather than a fixed guessed duration — real develop time on
 * real hardware varies too much for a hardcoded window to be trustworthy)
 * and reports how responsive the caller's event loop stayed while it ran.
 *
 * Both reported figures are deliberately RATIOS rather than absolute
 * millisecond counts, because the absolute numbers are set by how contended
 * the machine happens to be and not by anything this package controls (see
 * the long comment on the worker-mode test below for the measurements that
 * forced this). A ratio answers the question the ticket actually asks —
 * "did this call occupy the calling thread?" — identically on an idle laptop
 * and a loaded CI box:
 *
 * - `blockedFraction`: the single longest stall as a fraction of the
 *   operation's own wall-clock duration. ~1.0 means the thread was frozen
 *   for essentially the whole operation (what a synchronous FFI call does);
 *   ~0.0 means it stayed free.
 * - `ticksPerSecond`: how often the loop actually got to run. This is the
 *   positive half of the proof, and it is what catches a loop that was
 *   nibbled to death by many medium stalls rather than one long one —
 *   something `blockedFraction` alone cannot see.
 */
async function measureResponsivenessDuring<T>(work: Promise<T>): Promise<{
  result: T;
  blockedFraction: number;
  ticksPerSecond: number;
}> {
  let maxGap = 0;
  let tickCount = 0;
  const started = performance.now();
  let last = started;
  let stop = false;
  const tick = () => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    tickCount += 1;
    last = now;
    if (!stop) setImmediate(tick);
  };
  setImmediate(tick);
  const result = await work;
  stop = true;
  const elapsed = performance.now() - started;
  return {
    result,
    blockedFraction: maxGap / elapsed,
    ticksPerSecond: tickCount / (elapsed / 1000),
  };
}

describe.skipIf(!hasFixture)('main-thread responsiveness during a real develop (#3508)', () => {
  it(
    'never synchronously blocks the main thread while toBuffer() runs in worker mode',
    async () => {
      setMapleExecutionMode('worker');
      const { blockedFraction, ticksPerSecond } = await measureResponsivenessDuring(
        maple(bigRaw).format('jpeg').quality(80).toBuffer(),
      );
      // The ticket's bar is "no main-thread stall > 1ms per call", which is
      // really the claim "the call does not occupy the calling thread".
      //
      // That claim CANNOT be checked with an absolute millisecond ceiling on
      // the worst single tick gap, and it is worth recording why, because the
      // obvious version of this test is subtly broken. A full-quality develop
      // of a 100MP RAW saturates every core (raw-core is internally parallel),
      // and macOS then delays an unrelated thread's `setImmediate` callback by
      // tens of milliseconds purely as a scheduling artifact. Measured on one
      // 18-core machine across five runs, worker-mode worst-gap came out at
      // 17, 42, 45, 66 and 101ms — a 6x spread driven by how busy the box was,
      // not by this package. A fixed ceiling anywhere in that range is a coin
      // flip. (Control experiment: 18 plain JS Workers spinning on arithmetic,
      // with no Maple, FFI or native code involved at all, reproduce the same
      // 48ms worst gap and the same scatter of small ones, so this is generic
      // OS scheduling under load, not the worker pool. The pool's own overhead
      // is nil: 2000 trivial round trips through it show the same ~3ms worst
      // gap as an idle event loop doing nothing.)
      //
      // So assert on the load-invariant shape of the result instead. A call
      // that runs off-thread leaves the loop free for ~all of the operation;
      // a call that blocks freezes it for ~all of the operation. Measured,
      // that separation is about a hundredfold and it is stable on both
      // sides: worker mode blocked for 0.22-0.97% of the develop, sync mode
      // for 99.96% (next test). 5% sits an order of magnitude clear of the
      // worst honest worker-mode number and twenty times below sync mode's,
      // so it cannot flake, and a regression that put the FFI call back on
      // this thread lands at ~100% and fails instantly.
      expect(blockedFraction).toBeLessThan(0.05);
      // And the loop must have stayed responsive THROUGHOUT, not merely
      // avoided one long freeze: many medium stalls would pass the check
      // above while still making the thread useless. Measured: ~1.7 million
      // ticks/sec in worker mode against ~500/sec in sync mode, where the
      // only ticks are the handful either side of the block. 10k is 170x
      // below the real worker-mode figure and 20x above the blocked one.
      //
      // (A raw tick COUNT cannot do this job: sync mode still racks up ~3,800
      // ticks around the edges of a total freeze, so any absolute count floor
      // low enough to be safe is also low enough to pass while blocked.)
      expect(ticksPerSecond).toBeGreaterThan(10_000);
    },
    DEVELOP_TEST_TIMEOUT_MS,
  );

  it(
    "demonstrates the contrast: sync mode DOES stall the main thread for the develop's duration",
    async () => {
      setMapleExecutionMode('sync');
      try {
        const { blockedFraction } = await measureResponsivenessDuring(
          maple(bigRaw).format('jpeg').quality(80).toBuffer(),
        );
        // Sync mode calls straight into the blocking FFI call on this same
        // thread, so the heartbeat cannot tick again until the whole develop
        // returns: one gap swallowing the entire operation. Measured 99.96%
        // on both runs (a ~7.4-7.6s stall inside a ~7.4-7.6s call).
        //
        // This is the control for the test above, and it is what gives that
        // one's 5% ceiling its meaning — without it, a worker-mode number
        // near zero could just mean the develop was trivially fast rather
        // than genuinely off-thread. Half is a deliberately loose floor: the
        // real value is ~1.0, and anything below 0.5 would mean the sync
        // escape hatch had stopped being synchronous.
        expect(blockedFraction).toBeGreaterThan(0.5);
      } finally {
        setMapleExecutionMode('worker');
      }
    },
    DEVELOP_TEST_TIMEOUT_MS,
  );
});

describe.skipIf(hasFixture)('main-thread responsiveness (fixture-gated)', () => {
  it('skips — test-fixtures/raws/dji-mavic3pro-100mp.dng not present in this checkout', () => {
    expect(true).toBe(true);
  });
});
