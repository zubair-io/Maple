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

/** Marker key on a transferred-typed-array placeholder. The value names
 *  which constructor to rebuild on the other side. */
const TRANSFER_MARK = '__mapleTransfer__' as const;

type TransferKind = 'Buffer' | 'Uint8Array' | 'Float32Array';

interface TransferPlaceholder {
  [TRANSFER_MARK]: TransferKind;
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
}

function transferKindOf(value: Uint8Array | Float32Array): TransferKind {
  if (Buffer.isBuffer(value)) return 'Buffer';
  if (value instanceof Float32Array) return 'Float32Array';
  return 'Uint8Array';
}

function isTypedArray(value: unknown): value is Uint8Array | Float32Array {
  return value instanceof Uint8Array || value instanceof Float32Array;
}

function isTransferPlaceholder(value: unknown): value is TransferPlaceholder {
  return (
    typeof value === 'object' &&
    value !== null &&
    TRANSFER_MARK in (value as Record<string, unknown>)
  );
}

/**
 * Recursively walk a plain object/array/typed-array `value` (the shape every
 * `NativeBinding` reply actually takes: JSON-ish fields plus at most one or
 * two binary fields), replacing each typed array with a `TransferPlaceholder`
 * and collecting its backing `ArrayBuffer` into `transferList` for the
 * caller to pass to `postMessage(msg, transferList)`.
 */
export function prepareForTransfer(
  value: unknown,
  transferList: ArrayBuffer[] = [],
): { value: unknown; transferList: ArrayBuffer[] } {
  if (isTypedArray(value)) {
    // `.buffer` is typed `ArrayBufferLike` (`ArrayBuffer | SharedArrayBuffer`)
    // because that's the general TypedArray contract, but every typed array
    // this function ever sees comes from `Buffer.from`/`Buffer.alloc`/a
    // `new Uint8Array(...)`/`new Float32Array(...)` inside this package —
    // never a `SharedArrayBuffer` view — so the narrowing cast is safe.
    const buffer = value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer;
    transferList.push(buffer);
    const placeholder: TransferPlaceholder = {
      [TRANSFER_MARK]: transferKindOf(value),
      buffer,
      byteOffset: 0,
      byteLength: value.byteLength,
    };
    return { value: placeholder, transferList };
  }
  if (Array.isArray(value)) {
    return {
      value: value.map((entry) => prepareForTransfer(entry, transferList).value),
      transferList,
    };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = prepareForTransfer(entry, transferList).value;
    }
    return { value: out, transferList };
  }
  return { value, transferList };
}

/** Reverse of `prepareForTransfer`: rebuilds `Buffer`/`Float32Array`/
 *  `Uint8Array` instances from their placeholders. Safe to call on any
 *  value, including one with no placeholders at all (a no-op walk). */
export function restoreFromTransfer(value: unknown): unknown {
  if (isTransferPlaceholder(value)) {
    if (value[TRANSFER_MARK] === 'Buffer') {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value[TRANSFER_MARK] === 'Float32Array') {
      return new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
    }
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return value.map(restoreFromTransfer);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = restoreFromTransfer(entry);
    }
    return out;
  }
  return value;
}
