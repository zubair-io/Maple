// maple-id-fallback-hasher.service.spec.ts
//
// This service's job is to read a `File` in bounded `File.slice()` chunks
// and stream them to the fallback-hashing Worker in file order — the actual
// cryptographic correctness of the streaming WASM `FallbackIdHasher` (that
// feeding it chunks of ANY size produces the same digest as hashing the
// whole buffer at once) is proven at the Rust level by
// `raw-wasm/src/id.rs`'s `matches_raw_core_across_chunk_boundaries` test
// (already passing — verified via `cargo test -p raw-wasm` against this
// exact `pkg` build). Real WASM cannot be loaded in this vitest environment
// (no browser `self`/`fetch`-for-file-URL — see `raw-pipeline.service.spec.ts`'s
// module doc for the same constraint on the decode worker), so this spec
// mocks the `Worker` constructor, matching that file's established pattern.
//
// What THIS spec proves instead — and the thing most likely to have an
// off-by-one bug in NEW code — is that the service's chunking/read loop
// reconstructs the file's exact bytes, in exact order, regardless of chunk
// size: the fake worker accumulates whatever chunks it receives and hashes
// the concatenation via this module's OWN `fallback()` (already proven at
// parity with the server in `maple-id.spec.ts`); if the chunker dropped,
// duplicated, or misordered a byte, the accumulated hash would not match
// `fallback()` run directly over the original bytes — which is exactly what
// each test below asserts, across several chunk sizes (including chunks
// that don't evenly divide the file, a single oversized chunk, and the
// zero-byte-file edge case where no `update` is ever sent).

import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fallback } from './maple-id';
import { MapleIdFallbackHasherService } from './maple-id-fallback-hasher.service';
import type {
  HashFallbackFinalizeRequest,
  HashFallbackRequest,
  HashFallbackUpdateRequest,
} from './maple-id-fallback.types';

// Return type pinned to `Uint8Array<ArrayBuffer>` (not the wider
// `ArrayBufferLike`, which also covers `SharedArrayBuffer`) so these bytes
// are directly usable as a `BlobPart` in `new File([bytes], ...)` below.
function bytesFromPattern(len: number, seedMul: number, seedAdd: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (i * seedMul + seedAdd) & 0xff;
  return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Fake worker that accumulates whatever `hash-fallback-update` chunks it
 * receives (per `id`, in arrival order) and, on `hash-fallback-finalize`,
 * hashes the concatenation via `fallback()` — see module doc above for why
 * this is the right thing to fake vs. a real WASM round-trip. */
class FakeFallbackWorker {
  private readonly chunksById = new Map<number, Uint8Array[]>();
  protected readonly listeners: Record<string, ((e: MessageEvent) => void)[]> = {
    message: [],
    error: [],
  };

  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== fn);
  }
  dispatchEvent(): boolean {
    return true;
  }
  terminate(): void {
    /* no-op */
  }

  postMessage(msg: HashFallbackRequest): void {
    if (msg.type === 'hash-fallback-update') {
      const update = msg as HashFallbackUpdateRequest;
      const arr = this.chunksById.get(update.id) ?? [];
      arr.push(new Uint8Array(update.chunk));
      this.chunksById.set(update.id, arr);
      return;
    }
    const finalize = msg as HashFallbackFinalizeRequest;
    const bytes = concatBytes(this.chunksById.get(finalize.id) ?? []);
    this.chunksById.delete(finalize.id);
    const id = fallback(bytes, finalize.filesize);
    queueMicrotask(() => {
      for (const fn of this.listeners['message'] ?? []) {
        fn({
          data: { id: finalize.id, type: 'hash-fallback-success', hex: id.hex },
        } as MessageEvent);
      }
    });
  }
}

describe('MapleIdFallbackHasherService', () => {
  let originalWorker: typeof Worker;

  beforeEach(() => {
    originalWorker = globalThis.Worker;
    class WorkerCtor {
      constructor(_url: URL, _opts?: WorkerOptions) {
        return new FakeFallbackWorker() as unknown as Worker;
      }
    }
    Object.defineProperty(globalThis, 'Worker', {
      value: WorkerCtor,
      writable: true,
      configurable: true,
    });
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'Worker', {
      value: originalWorker,
      writable: true,
      configurable: true,
    });
  });

  const cases: { label: string; len: number; chunkSize: number }[] = [
    { label: 'chunk size evenly divides file size', len: 300, chunkSize: 100 },
    { label: 'chunk size leaves a remainder', len: 250, chunkSize: 100 },
    { label: 'a single chunk bigger than the whole file', len: 50, chunkSize: 8 * 1024 * 1024 },
    { label: 'chunk size of exactly 1 byte', len: 17, chunkSize: 1 },
    { label: 'chunk size exactly equal to file size', len: 64, chunkSize: 64 },
  ];

  for (const { label, len, chunkSize } of cases) {
    it(`matches the non-streaming reference — ${label} (len=${len}, chunkSize=${chunkSize})`, async () => {
      const service = TestBed.inject(MapleIdFallbackHasherService);
      const bytes = bytesFromPattern(len, 41, 13);
      const file = new File([bytes], 'test.dng', { lastModified: 1_700_000_000_000 });

      const hex = await service.hashFallback(file, chunkSize);

      const expected = fallback(bytes, bytes.length).hex;
      expect(hex).toBe(expected);
    });
  }

  it('handles a zero-byte file (no update calls, finalize only)', async () => {
    const service = TestBed.inject(MapleIdFallbackHasherService);
    const file = new File([], 'empty.dng', { lastModified: 1_700_000_000_000 });

    const hex = await service.hashFallback(file, 1024);

    const expected = fallback(new Uint8Array(0), 0).hex;
    expect(hex).toBe(expected);
  });

  it('rejects when the worker posts a hash-fallback-error', async () => {
    class FailingWorker extends FakeFallbackWorker {
      override postMessage(msg: HashFallbackRequest): void {
        if (msg.type === 'hash-fallback-finalize') {
          queueMicrotask(() => {
            for (const fn of this.listeners['message'] ?? []) {
              fn({
                data: { id: msg.id, type: 'hash-fallback-error', message: 'boom' },
              } as MessageEvent);
            }
          });
          return;
        }
        super.postMessage(msg);
      }
    }
    class WorkerCtor {
      constructor(_url: URL, _opts?: WorkerOptions) {
        return new FailingWorker() as unknown as Worker;
      }
    }
    Object.defineProperty(globalThis, 'Worker', {
      value: WorkerCtor,
      writable: true,
      configurable: true,
    });

    const service = TestBed.inject(MapleIdFallbackHasherService);
    const file = new File([new Uint8Array([1, 2, 3])], 'test.dng');

    await expect(service.hashFallback(file, 1024)).rejects.toThrow('boom');
  });
});
