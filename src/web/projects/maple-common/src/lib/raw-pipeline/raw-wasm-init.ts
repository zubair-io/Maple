// T10 — raw-wasm bootstrapper.
//
// Called by `raw-pipeline.worker.ts` (inside the Web Worker). The thread pool
// is per-WebAssembly-instance, so it must be initialised from the same
// context that calls `render_bytes`.
//
// Threading (wasm-bindgen-rayon) is currently DISABLED everywhere. The
// `ng serve` / Angular-build bundler doesn't publish the rayon
// `workerHelpers.js?worker_file&type=module` child-worker script, so the
// workers spawn but their HTTP requests hang forever and `initThreadPool(N)`
// never resolves — blocking every decode. Single-threaded render takes
// ~20–40 s on a 22 MP RAW in release WASM, which is acceptable for now;
// re-enable threading when we wire up an Angular-native build integration
// for wasm-bindgen-rayon (tracked separately).

import init, { install_panic_hook } from './pkg/raw_wasm';

export interface RawWasmInitResult {
  readonly threaded: boolean;
  readonly threads: number;
}

/** Initialise the raw-wasm module. Does NOT spin up the rayon pool today. */
export async function initRawWasm(): Promise<RawWasmInitResult> {
  await init();
  // Surface Rust panics in DevTools instead of opaque WASM traps.
  try {
    install_panic_hook();
  } catch {
    // If the build is missing `install_panic_hook` (older pkg), carry on.
  }
  return { threaded: false, threads: 1 };
}
