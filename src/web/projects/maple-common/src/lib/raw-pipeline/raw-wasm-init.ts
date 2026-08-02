// T10 — raw-wasm bootstrapper.
//
// Called by `raw-pipeline.worker.ts` (inside the Web Worker). The thread pool
// is per-WebAssembly-instance, so it must be initialised from the same
// context that calls `render_bytes`.
//
// Threading (wasm-bindgen-rayon) requires cross-origin isolation. Chromium is
// deliberately kept serial by #2515 (restoration tracked in #2516): V8
// broadcasts shared-memory growth to other isolates asynchronously, so an idle
// Rayon worker can retain stale bounds and trap on a valid atomic load while a
// large RAW grows the heap.
// WebGPU remains available on Chromium; only the CPU Rayon pool is disabled.
//
// Required build-side support for threading on safe runtimes:
//   1. The page must set COOP: same-origin + COEP: require-corp.
//   2. `workerHelpers.js` must be emitted as a standalone asset.
//   3. `raw-wasm` must be built with `--features parallel`.

import init, { install_panic_hook } from './pkg/raw_wasm';
import * as wasm from './pkg/raw_wasm';
import { isChromiumV8Runtime } from './threading-runtime-policy';

export interface RawWasmInitResult {
  readonly threaded: boolean;
  readonly threads: number;
}

type InitThreadPoolFn = (numThreads: number) => Promise<void>;

function threadPoolInit(): InitThreadPoolFn | null {
  // Keep this lookup dynamic: GPU-only bundles legitimately omit the parallel
  // export, and a static named import would make those bundles fail to load.
  const fn = Reflect.get(wasm as object, 'initThreadPool');
  return typeof fn === 'function' ? (fn as InitThreadPoolFn) : null;
}

/** Initialize one module instance and avoid Rayon on the affected V8 runtimes. */
export async function initRawWasm(): Promise<RawWasmInitResult> {
  await init();
  try {
    install_panic_hook();
  } catch {
    // Older generated bundles may not contain the hook.
  }

  const initThreadPool = threadPoolInit();
  if (!initThreadPool) return { threaded: false, threads: 1 };

  const coi = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  const userAgentData = Reflect.get(navigator as object, 'userAgentData') as
    | { readonly brands?: readonly { readonly brand: string }[] }
    | undefined;
  if (!coi || isChromiumV8Runtime(navigator.userAgent, userAgentData?.brands)) {
    return { threaded: false, threads: 1 };
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
