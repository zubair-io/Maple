/**
 * Wire protocol between the main thread's worker pool (`worker-pool.ts`) and
 * the worker-thread entry (`native-worker-entry.ts`). A request names one
 * `NativeBinding` method by string and carries its arguments; the worker
 * dispatches with `native[method](...args)` and replies with the result or
 * an error. See `worker-pool.ts`'s module doc for why this is one generic
 * message shape rather than one bespoke pair per native method (#3508).
 *
 * `args` are left as plain structured-clone data (Bun's postMessage copies
 * any Uint8Array/Buffer in them) — the caller's own buffer stays valid after
 * the call returns. The **result** going the other way is different: nobody
 * but the worker holds a reference to a buffer it just allocated, so
 * `prepareForTransfer` below extracts every typed array in it onto
 * `postMessage`'s transfer list for a zero-copy handoff, and
 * `restoreFromTransfer` reconstructs the exact typed-array subclass
 * (`Buffer`, `Float32Array`, or plain `Uint8Array`) on the other side.
 */
export interface WorkerRequest {
    id: number;
    method: string;
    args: unknown[];
}
export interface WorkerResponse {
    id: number;
    ok: boolean;
    result?: unknown;
    error?: string;
}
/**
 * Recursively walk a plain object/array/typed-array `value` (the shape every
 * `NativeBinding` reply actually takes: JSON-ish fields plus at most one or
 * two binary fields), replacing each typed array with a `TransferPlaceholder`
 * and collecting its backing `ArrayBuffer` into `transferList` for the
 * caller to pass to `postMessage(msg, transferList)`.
 */
export declare function prepareForTransfer(value: unknown, transferList?: ArrayBuffer[]): {
    value: unknown;
    transferList: ArrayBuffer[];
};
/** Reverse of `prepareForTransfer`: rebuilds `Buffer`/`Float32Array`/
 *  `Uint8Array` instances from their placeholders. Safe to call on any
 *  value, including one with no placeholders at all (a no-op walk). */
export declare function restoreFromTransfer(value: unknown): unknown;
