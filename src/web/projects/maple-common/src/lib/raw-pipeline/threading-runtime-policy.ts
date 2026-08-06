/**
 * V8 propagates shared WebAssembly memory growth to other isolates
 * asynchronously, so a Rayon worker isolate can resume on a stale bound and
 * trap on an otherwise-valid atomic load if the heap grows while workers are
 * alive (#2515). #2516 restores Rayon on Chromium by making growth and
 * worker-pool lifetime disjoint in time (`prepare_threaded_heap`,
 * `raw-wasm-init.ts`): this predicate identifies which runtimes need that
 * pre-grow guard before starting the thread pool. Non-Chromium engines were
 * never subject to the race and skip it.
 */
export interface UserAgentBrand {
  readonly brand: string;
}

export function isChromiumV8Runtime(
  userAgent: string,
  brands: readonly UserAgentBrand[] = [],
): boolean {
  if (
    brands.some(({ brand }) => /Chromium|Google Chrome|Microsoft Edge|Opera|Brave/i.test(brand))
  ) {
    return true;
  }
  return /(?:Chrome|Chromium|Edg|OPR)\//.test(userAgent);
}

/** What the runtime advertises, independent of any WASM call outcome. */
export interface ThreadingCapabilities {
  readonly crossOriginIsolated: boolean;
  readonly isChromiumV8: boolean;
  /** `wasm.initThreadPool` exists — false on a GPU-only bundle. */
  readonly hasThreadPool: boolean;
  /** `wasm.prepare_threaded_heap` exists — false on a pre-#2516 bundle. */
  readonly hasHeapGuard: boolean;
}

export type ThreadingPlan =
  | { readonly kind: 'serial' }
  | { readonly kind: 'threaded'; readonly heapGuardTargetMib: number | null };

/**
 * Pure decision core for `initRawWasm` (raw-wasm-init.ts), split out so the
 * #2516 gating logic is testable without mocking the generated `pkg/raw_wasm`
 * module. Threading requires cross-origin isolation and a bundle that
 * exports `initThreadPool`. On a Chromium/V8 runtime it additionally
 * requires the `prepare_threaded_heap` pre-grow guard to be available — an
 * older bundle without it stays on #2515's known-safe serial mode rather
 * than risk the growth race with no guard. Non-Chromium engines were never
 * subject to that race and thread without the guard, unchanged from before
 * #2516.
 *
 * Does NOT decide whether the guard actually reserved enough headroom — the
 * caller runs `prepare_threaded_heap` and compares its result against
 * `heapGuardTargetMib` itself, since that's a runtime outcome, not a static
 * capability.
 */
export function planThreading(
  caps: ThreadingCapabilities,
  heapGuardTargetMib: number,
): ThreadingPlan {
  if (!caps.hasThreadPool || !caps.crossOriginIsolated) return { kind: 'serial' };
  if (!caps.isChromiumV8) return { kind: 'threaded', heapGuardTargetMib: null };
  if (!caps.hasHeapGuard) return { kind: 'serial' };
  return { kind: 'threaded', heapGuardTargetMib };
}
