// T10 — raw-wasm bootstrapper.
//
// Called by `raw-pipeline.worker.ts` (inside the Web Worker). The thread pool
// is per-WebAssembly-instance, so it must be initialised from the same
// context that calls `render_bytes`.
//
// Threading (wasm-bindgen-rayon) is enabled when the page is
// crossOriginIsolated (COOP: same-origin + COEP: require-corp). Any host
// that fails either check falls through to single-threaded render — the
// WASM build uses the same `render_bytes` entry point in both modes, so
// degrading is transparent to callers.
//
// Required build-side support for threading to actually work at runtime:
//   1. The hosting page must set COOP: same-origin + COEP: require-corp so
//      SharedArrayBuffer is permitted. Dev server: add the headers via
//      `maple`'s proxy or a static-middleware shim. Production:
//      the Bun API (`src/api`) already serves the Angular bundle — extend
//      it to emit the two headers for HTML and JS responses.
//   2. The bundler must emit
//      `pkg/snippets/wasm-bindgen-rayon-*/src/workerHelpers.js` as a
//      standalone file so rayon's self-spawn
//      `new Worker(new URL('./workerHelpers.js', import.meta.url))` can
//      fetch it at runtime. `angular.json` copies it via the `assets` glob.
//   3. `raw-wasm` must be built with `--features parallel` — already the
//      default; `pkg/raw_wasm.d.ts` must export `initThreadPool`.
//
// If `initThreadPool` rejects or hangs (e.g. the workerHelpers asset 404s),
// we fall back to single-threaded rather than block every decode. The
// 5-second timeout is deliberately generous — cold WASM + worker spawn on
// low-end hardware can take a beat.

import init, { install_panic_hook } from './pkg/raw_wasm';
// Namespace access for `initThreadPool`: it is exported ONLY by the `parallel`
// (wasm-bindgen-rayon) build. The GPU build (`--features gpu`, RUSTFLAGS="") is
// single-threaded — wgpu and rayon's shared-memory atomics are mutually
// exclusive — so it OMITS `initThreadPool`. A static named import would break
// that bundle at resolution; reading it off the module object lets the gpu-only
// bundle load and simply stay single-threaded (epic #925, P4b-web / #1029).
import * as wasm from './pkg/raw_wasm';

export interface RawWasmInitResult {
  readonly threaded: boolean;
  readonly threads: number;
}

/** The rayon thread-pool initialiser — present only in the `parallel` build. */
type InitThreadPoolFn = (numThreads: number) => Promise<void>;

function threadPoolInit(): InitThreadPoolFn | null {
  // `Reflect.get` with a runtime key so the bundler does NOT statically resolve
  // the member against whichever pkg happens to be synced at build time (it would
  // emit an "always undefined" warning for the GPU bundle, which legitimately
  // omits `initThreadPool`). The lookup is genuinely runtime — the SAME built code
  // works against both the parallel bundle (has it) and the GPU bundle (omits it).
  const fn = Reflect.get(wasm as object, 'initThreadPool');
  return typeof fn === 'function' ? (fn as InitThreadPoolFn) : null;
}

/**
 * Initialise the raw-wasm module and, when the environment supports it,
 * spin up the rayon thread pool. Returns a summary describing whether
 * threading came online so the worker can forward the state to the UI
 * ("single-threaded mode" badge, etc).
 */
export async function initRawWasm(): Promise<RawWasmInitResult> {
  await init();
  // Surface Rust panics in DevTools instead of opaque WASM traps.
  try {
    install_panic_hook();
  } catch {
    // If the build is missing `install_panic_hook` (older pkg), carry on.
  }

  // The GPU build omits `initThreadPool` entirely (single-threaded by
  // construction) — stay single-threaded without touching SAB.
  const initThreadPool = threadPoolInit();
  if (!initThreadPool) return { threaded: false, threads: 1 };

  // `crossOriginIsolated` is the gate for SharedArrayBuffer. Without it
  // rayon's atomics would trap; without SAB the thread pool can't share
  // the WASM memory. Either missing ⇒ stay single-threaded.
  const coi = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  if (!coi) return { threaded: false, threads: 1 };

  // Cap at 8 threads — diminishing returns past that for RAW decode (the
  // dominant work is bandwidth-bound on the final stages).
  const threads = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 1));
  try {
    // Race against a timeout: if workerHelpers.js isn't served the spawn
    // hangs forever rather than rejecting. Timing out lets the decode
    // pipeline come up single-threaded instead of wedging the worker.
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error('initThreadPool timeout — workerHelpers.js may not be served')),
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
