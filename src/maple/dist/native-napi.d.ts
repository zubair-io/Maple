import type { NativeBinding } from './native';
export declare function getNapiLoadError(): Error | null;
/**
 * Resolves and loads the napi addon, caching the outcome — `null` (never
 * throws) when no addon is resolvable, ABI-compatible, or loadable, or when
 * explicitly disabled via `MAPLE_NAPI=0`. That env var is the napi-side
 * counterpart to `native.ts`'s `MAPLE_NATIVE_LIB`: an escape hatch to force
 * every `callNative` dispatch onto the `bun:ffi`/worker-pool backend even
 * when a napi addon IS present and working — needed both for a real
 * napi-specific production incident (skip straight to the known-good
 * fallback without an addon-uninstall step) and for tests that need to
 * exercise the worker pool's own machinery on a machine where a napi addon
 * happens to be built (see `worker-pool.test.ts`).
 */
export declare function tryLoadNapiBinding(): NativeBinding | null;
/** Test-only: drop the cached binding (and its remembered load error) so the
 *  next call re-resolves and re-loads the addon from scratch. */
export declare function _resetNapiBindingForTests(): void;
