/**
 * Entry point run inside each Bun `Worker` thread spawned by `worker-pool.ts`
 * (#3508). Loads its own copy of the native binding (a separate `dlopen` per
 * thread — `bun:ffi` handles are not shared across Workers, which is exactly
 * what we want: each worker's FFI calls are isolated to that thread) and
 * answers `WorkerRequest`s by calling the named `NativeBinding` method.
 *
 * This thread shares the host process's address space with the main thread
 * and every other worker — a genuine native segfault here would still take
 * the whole process down. That is a DIFFERENT guarantee than this pool
 * provides: this pool keeps the *event loop* responsive (nothing here runs
 * on the caller's thread), it does not provide the process-level crash
 * isolation `src/api/src/ffi/ffi-pool.ts`'s child-process pool provides on
 * the server. See `src/maple/README.md` § "Execution model".
 */

import { loadNativeBinding, type NativeBinding } from './native';
import { prepareForTransfer, type WorkerRequest, type WorkerResponse } from './worker-protocol';

type AnyNativeMethod = (...args: unknown[]) => unknown;

let cachedNative: NativeBinding | null = null;

function native(): NativeBinding {
  if (!cachedNative) {
    cachedNative = loadNativeBinding();
  }
  return cachedNative;
}

/**
 * `self` is how a worker thread's own global scope is conventionally named,
 * but `bun-types` doesn't model that ambient binding (it types the SPAWNING
 * side's `new Worker(...)` surface, not the executed-inside-a-worker script's
 * own globals) — so this assigns through `globalThis` instead. `self` and
 * `globalThis` are the same object inside a worker thread; only the type
 * declaration differs, and `globalThis` is always available regardless of
 * the configured `lib`.
 */
(globalThis as { onmessage?: (event: MessageEvent<WorkerRequest>) => void }).onmessage = (
  event,
) => {
  const { id, method, args } = event.data;
  try {
    const fn = native()[method as keyof NativeBinding] as unknown as AnyNativeMethod | undefined;
    if (typeof fn !== 'function') {
      throw new Error(`Maple worker: unknown native method '${method}'`);
    }
    const result = fn.apply(native(), args);
    const { value, transferList } = prepareForTransfer(result);
    const response: WorkerResponse = { id, ok: true, result: value };
    postMessage(response, transferList);
  } catch (error) {
    const response: WorkerResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    postMessage(response);
  }
};
