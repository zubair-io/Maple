// T10 — raw-wasm bootstrapper.
//
// Called by `raw-pipeline.worker.ts` (inside the Web Worker). The thread pool
// is per-WebAssembly-instance, so it must be initialised from the same
// context that calls `render_bytes`.
//
// Threading (wasm-bindgen-rayon) requires cross-origin isolation.
//
// #2516 (restoring what #2515 disabled): Chromium/V8 updates the isolate
// that requested shared-memory growth synchronously, but broadcasts the new
// bounds to OTHER isolates (each Rayon worker is a separate V8 isolate)
// asynchronously. Maple's allocator calls `memory.grow` repeatedly while
// decoding a large RAW, so with eight Rayon workers idle-parked between
// jobs, one can resume on a stale bound and trap on an otherwise-valid
// atomic load (`crossbeam_epoch::Global::try_advance`, retained in #2515).
//
// The fix is to make growth and worker-pool lifetime disjoint in time: on
// Chromium, `prepareThreadedHeap` (see `shared_heap.rs`) grows the shared
// WASM memory ONCE — through the global allocator (dlmalloc), never a raw
// `memory.grow` intrinsic; see that file's module doc for why the
// distinction is load-bearing — to a size that comfortably covers a
// full-resolution decode/develop/refine of a large RAW, strictly BEFORE
// `initThreadPool` spawns any worker isolate. No worker isolate exists yet
// when this runs, so there is nothing to desync. If that reservation can't
// be satisfied (would exceed the linked `--max-memory` ceiling), threading
// stays off rather than risk the race for headroom that doesn't exist.
// Non-Chromium engines were never subject to this V8-specific race and skip
// the pre-grow — it would only add an unnecessary reservation.
//
// WebGPU remains available regardless of the CPU Rayon path.
//
// Required build-side support for threading on safe runtimes:
//   1. The page must set COOP: same-origin + COEP: require-corp.
//   2. `workerHelpers.js` must be emitted as a standalone asset.
//   3. `raw-wasm` must be built with `--features parallel`.

import init, { install_panic_hook } from './pkg/raw_wasm';
import * as wasm from './pkg/raw_wasm';
import { isChromiumV8Runtime, planThreading } from './threading-runtime-policy';

export interface RawWasmInitResult {
  readonly threaded: boolean;
  readonly threads: number;
}

// #2516 evidence (see PR description): a SINGLE-THREADED, full-native-
// resolution `render_bytes` of the 22 MP reference fixture (5760×3840,
// test_0006.DNG) peaks at 1875 MiB; the 41 MP fixture (7304×5478,
// test_0004.fff) peaks at 3096 MiB (per-fixture peaks scale with pixel count
// — demosaic + DCP + tone + dehaze + sharpen + NR each retain a
// full-resolution f32 buffer in sequence, see raw-wasm/.cargo/config.toml).
//
// Those single-threaded numbers are NOT the right target, though: 8-way
// parallel execution runs more of the pipeline's per-tile work concurrently,
// so it needs MORE peak memory than the same decode serialized on one
// thread — measured at 3481 MiB for the SAME 41 MP fixture under 8 real
// Rayon workers (a real, one-time grow past an under-provisioned reservation
// — harmless in this measurement only because no idle worker happened to
// race it; the fix's whole point is not to depend on that luck). 3712 MiB
// covers the measured 41 MP THREADED peak with ~7% margin, confirmed stable
// (no further growth) across repeated reload cycles of both fixtures, while
// staying comfortably under the wasm32 4 GiB hard ceiling
// (`--max-memory=4294967296`) `prepare_threaded_heap` reserves into.
//
// The 100 MP reference fixture (12288×8192, dji-mavic3pro-100mp.dng) is NOT
// covered here: a full-native-resolution `render_bytes` of it already
// exceeds the 4 GiB ceiling and hard-aborts (`handle_alloc_error`) on EVERY
// runtime, including single-threaded, before this change and after it — a
// pre-existing memory-budget defect independent of the #2515/#2516 threading
// race, tracked separately. It does not affect the WebGPU-live editing path
// (viewport-sized, not full native resolution) that most sessions use.
//
// REVALIDATE WHEN #2677 LANDS: #2677 (still open) clamps large-sensor CPU
// develops to `min(sensor_long_edge / 2, 4096)` instead of letting them OOM,
// so once it merges the 100 MP fixture will develop clamped rather than
// abort — bringing it into this ceiling's scope for the first time. #2677's
// own single-threaded clamped-100MP measurement is ~3.42 GiB; applying this
// file's measured ~1.12x threaded/serial multiplier (3481 / 3096 MiB for the
// 41 MP fixture) projects a threaded clamped-100MP peak of roughly 3845 MiB
// — ABOVE the current 3712 MiB target. Do not resize this constant until
// that's measured directly (not projected) post-#2677; it will very likely
// need to go up.
//
// Ratchet this down only with fresh THREADED measurement — it is not a
// theoretical maximum, it is today's measured peak plus margin.
const THREADED_HEAP_TARGET_MIB = 3712;

type InitThreadPoolFn = (numThreads: number) => Promise<void>;
type PrepareThreadedHeapFn = (targetMib: number) => number;

function threadPoolInit(): InitThreadPoolFn | null {
  // Keep this lookup dynamic: GPU-only bundles legitimately omit the parallel
  // export, and a static named import would make those bundles fail to load.
  const fn = Reflect.get(wasm as object, 'initThreadPool');
  return typeof fn === 'function' ? (fn as InitThreadPoolFn) : null;
}

function prepareThreadedHeapFn(): PrepareThreadedHeapFn | null {
  const fn = Reflect.get(wasm as object, 'prepare_threaded_heap');
  return typeof fn === 'function' ? (fn as PrepareThreadedHeapFn) : null;
}

/** Initialize one module instance and avoid Rayon where the runtime can't safely run it. */
export async function initRawWasm(): Promise<RawWasmInitResult> {
  await init();
  try {
    install_panic_hook();
  } catch {
    // Older generated bundles may not contain the hook.
  }

  const initThreadPool = threadPoolInit();
  const prepareThreadedHeap = prepareThreadedHeapFn();
  const userAgentData = Reflect.get(navigator as object, 'userAgentData') as
    | { readonly brands?: readonly { readonly brand: string }[] }
    | undefined;
  const plan = planThreading(
    {
      crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated,
      isChromiumV8: isChromiumV8Runtime(navigator.userAgent, userAgentData?.brands),
      hasThreadPool: initThreadPool !== null,
      hasHeapGuard: prepareThreadedHeap !== null,
    },
    THREADED_HEAP_TARGET_MIB,
  );
  if (plan.kind === 'serial' || !initThreadPool) return { threaded: false, threads: 1 };

  if (plan.heapGuardTargetMib !== null) {
    // Guarded by `plan.kind === 'threaded' && isChromiumV8`, so `planThreading`
    // guarantees `prepareThreadedHeap` is non-null here.
    const achievedMib = prepareThreadedHeap!(plan.heapGuardTargetMib);
    if (achievedMib < plan.heapGuardTargetMib) {
      console.warn(
        `[raw-wasm-init] could not reserve ${plan.heapGuardTargetMib} MiB before starting ` +
          `Rayon workers (got ${achievedMib} MiB) — staying serial to avoid the #2515 growth race`,
      );
      return { threaded: false, threads: 1 };
    }
  }

  const threads = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 1));
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('initThreadPool timeout — workerHelpers.js may not be served')),
        5000,
      ),
    );
    await Promise.race([initThreadPool(threads), timeout]);
    return { threaded: true, threads };
  } catch (err) {
    console.warn('[raw-wasm-init] threading unavailable, falling back:', err);
    return { threaded: false, threads: 1 };
  }
}
