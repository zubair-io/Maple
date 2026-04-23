// T10 — raw-wasm bootstrapper with cross-origin-isolated thread pool.
//
// Called by `raw-pipeline.worker.ts` (inside the Web Worker). The thread pool
// is per-WebAssembly-instance, so it must be initialised from the same
// context that calls `render_bytes`.
//
// Threading only activates when:
//   1. The WASM build exports `initThreadPool` (present in the current build).
//   2. `crossOriginIsolated === true` — i.e. the host served
//      Cross-Origin-Opener-Policy: same-origin
//      Cross-Origin-Embedder-Policy: require-corp
//
// Without those headers (Safari / Firefox / any host without COOP+COEP),
// `initThreadPool` is skipped and the decode path continues to work
// single-threaded — just slower on large RAWs.

import init, { initThreadPool, install_panic_hook } from './pkg/raw_wasm';

export interface RawWasmInitResult {
  readonly threaded: boolean;
  readonly threads: number;
}

/** Initialise the raw-wasm module and (when possible) its rayon thread pool. */
export async function initRawWasm(): Promise<RawWasmInitResult> {
  await init();
  // Surface Rust panics in DevTools instead of opaque WASM traps.
  try {
    install_panic_hook();
  } catch {
    // If the build is missing `install_panic_hook` (older pkg), carry on.
  }

  // `crossOriginIsolated` is a global defined in both Window and
  // WorkerGlobalScope; guard for older TS lib defs.
  const isIsolated =
    typeof (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ===
      'boolean' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

  if (!isIsolated) {
    return { threaded: false, threads: 1 };
  }

  const hc =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
  const threads = Math.max(2, hc);

  try {
    await initThreadPool(threads);
    return { threaded: true, threads };
  } catch (err) {
    // If the pool fails to spin up (e.g. strict CSP on worker-src), degrade
    // to single-threaded rather than failing the entire decode.
    console.warn('[raw-wasm] initThreadPool failed — falling back to single-threaded:', err);
    return { threaded: false, threads: 1 };
  }
}
