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
export {};
