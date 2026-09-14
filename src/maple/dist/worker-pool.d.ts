/**
 * In-package async execution for `@justmaple/maple`'s native calls (#3508).
 *
 * `callNative(method, args)` is the single entry point every builder/export
 * code path in this package uses instead of calling `loadNativeBinding()`
 * directly. By default it posts the call to a lazily-spawned pool of Bun
 * `Worker` threads (`native-worker-entry.ts` runs inside each one) so the
 * actual synchronous `bun:ffi` call never touches the CALLER's event loop.
 * `setMapleExecutionMode('sync')` is the documented escape hatch: it makes
 * `callNative` call straight through to `loadNativeBinding()` on the
 * caller's own thread, exactly as this package did before #3508, for
 * callers who have their own off-thread strategy (or who are fine
 * blocking — e.g. a one-shot CLI invocation with nothing else running).
 *
 * This pool provides EVENT-LOOP RESPONSIVENESS, not crash isolation — see
 * `native-worker-entry.ts`'s module doc and `README.md` § "Execution model".
 * The API server's own `src/api/src/ffi/` child-PROCESS pool is unrelated
 * and unaffected by anything in this file.
 */
import { type NativeBinding } from './native';
export type MapleExecutionMode = 'worker' | 'sync';
/** Switch every future `callNative` call between the default worker-pool
 *  dispatch and the pre-#3508 same-thread synchronous call. */
export declare function setMapleExecutionMode(mode: MapleExecutionMode): void;
export declare function getMapleExecutionMode(): MapleExecutionMode;
/** Set the worker pool's target size. Takes effect the next time a worker
 *  needs to be spawned (existing idle workers above the new target are not
 *  forcibly killed) — same lazy-spawn philosophy as the API's own
 *  `ffi-pool-slots.ts`. */
export declare function setMapleConcurrency(n: number): void;
export declare function getMapleConcurrency(): number;
/**
 * Call one `NativeBinding` method by name. In the default `'worker'`
 * execution mode this posts to the worker pool and never touches the
 * caller's event loop; in `'sync'` mode it calls straight through to
 * `loadNativeBinding()` on the caller's own thread (the escape hatch).
 */
export declare function callNative<K extends keyof NativeBinding>(method: K, args: Parameters<NativeBinding[K]>): Promise<ReturnType<NativeBinding[K]>>;
/** Terminate every spawned worker and stop accepting new calls. Callers that
 *  want a script to exit the instant Maple work is done (rather than relying
 *  on idle workers' own `unref()`) can call this explicitly; it is also
 *  exposed so the CLI (`bin/maple.js`) and tests can force a clean exit. */
export declare function shutdownMaplePool(): void;
/** Test-only: drop the pool/config singletons so the next call rebuilds them
 *  (e.g. to pick up a just-changed `MAPLE_WORKER_CONCURRENCY`). */
export declare function _resetMaplePoolForTests(): void;
