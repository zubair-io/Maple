/**
 * The `maple_search_*` C ABI (#4462) loads from the API's native library and
 * answers a round trip: open an engine, load vectors, index text, search with a
 * caller-supplied query vector, read the fused JSON back, and close.
 *
 * Only `scripts/build-raw-ffi.sh` builds the library with `--features search`,
 * so a library from any other build skips here rather than failing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { findNativeLib } from 'maple';
import type * as BunFfi from 'bun:ffi';

const DIM = 1024;
const RC_ENGINE_ERROR = 2;
const RC_NEED_LARGER_BUFFER = 100;

interface FusedHit {
  id: string;
  score: number;
  vector_rank: number | null;
  text_rank: number | null;
}

function openSearchLibrary() {
  const libPath = findNativeLib();
  if (!libPath) return null;
  const { dlopen, FFIType } = require('bun:ffi') as typeof BunFfi;
  try {
    return dlopen(libPath, {
      maple_search_open: { args: [FFIType.ptr], returns: FFIType.ptr },
      maple_search_close: { args: [FFIType.ptr], returns: FFIType.void },
      maple_search_load_vectors: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
        returns: FFIType.i32,
      },
      maple_search_query: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.ptr],
        returns: FFIType.i32,
      },
      maple_search_query_vector: {
        args: [
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u64,
          FFIType.u32,
          FFIType.ptr,
          FFIType.u64,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
      maple_search_upsert: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr],
        returns: FFIType.i32,
      },
      maple_search_delete: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      maple_search_commit: { args: [FFIType.ptr], returns: FFIType.i32 },
      maple_search_counts: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      maple_last_error: { args: [], returns: FFIType.cstring },
    });
  } catch (error) {
    console.warn(`search FFI: ${libPath} has no maple_search_* symbols, skipping (${error})`);
    return null;
  }
}

const lib = openSearchLibrary();
if (!lib) console.warn('search FFI: no native library built with --features search, skipping');

const cstr = (text: string) => Buffer.from(text + '\0', 'utf-8');

function basis(axis: number): Float32Array {
  const vector = new Float32Array(DIM);
  vector[axis] = 1;
  return vector;
}

describe.skipIf(!lib)('maple_search C ABI', () => {
  const { ptr } = require('bun:ffi') as typeof BunFfi;
  const symbols = lib!.symbols;
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'maple-search-ffi-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const lastError = () => String(symbols.maple_last_error());

  function counts(handle: BunFfi.Pointer): { vectors: bigint; texts: bigint } {
    const out = new BigUint64Array(2);
    expect(symbols.maple_search_counts(handle, ptr(out), ptr(out, 8))).toBe(0);
    return { vectors: out[0]!, texts: out[1]! };
  }

  function queryVector(handle: BunFfi.Pointer, query: string, vector: Float32Array, k: number) {
    const outLen = new BigUint64Array(1);
    const probe = symbols.maple_search_query_vector(
      handle,
      ptr(cstr(query)),
      ptr(vector),
      DIM,
      k,
      null,
      0,
      ptr(outLen),
    );
    expect(probe).toBe(RC_NEED_LARGER_BUFFER);
    const out = Buffer.alloc(Number(outLen[0]));
    const rc = symbols.maple_search_query_vector(
      handle,
      ptr(cstr(query)),
      ptr(vector),
      DIM,
      k,
      ptr(out),
      out.length,
      ptr(outLen),
    );
    expect(rc, lastError()).toBe(0);
    return JSON.parse(out.subarray(0, Number(outLen[0])).toString('utf-8')) as FusedHit[];
  }

  test('rejects a malformed config with a readable error', () => {
    expect(symbols.maple_search_open(ptr(cstr('{"index_dir": 1}')))).toBeNull();
    expect(lastError()).toContain('invalid config');
  });

  test('round-trips vectors, text and a fused query', () => {
    const config = JSON.stringify({ index_dir: path.join(dir, 'text') });
    const handle = symbols.maple_search_open(ptr(cstr(config)));
    if (handle === null) throw new Error(`maple_search_open failed: ${lastError()}`);
    try {
      const rows = [basis(0), basis(1), basis(2)];
      const vectors = new Float32Array(rows.length * DIM);
      rows.forEach((row, index) => vectors.set(row, index * DIM));
      const ids = Buffer.from(['harbour', 'kitchen', 'lantern'].join('\n'), 'utf-8');
      const loaded = symbols.maple_search_load_vectors(
        handle,
        ptr(vectors),
        vectors.byteLength,
        ptr(ids),
        ids.length,
      );
      expect(loaded, lastError()).toBe(0);

      const texts: Array<[string, string]> = [
        ['harbour', 'a quiet harbour at dawn'],
        ['kitchen', 'bread cooling on a kitchen counter'],
        ['lantern', 'paper lanterns over a narrow street'],
      ];
      for (const [id, text] of texts) {
        expect(symbols.maple_search_upsert(handle, ptr(cstr(id)), null, 0, ptr(cstr(text)))).toBe(
          0,
        );
      }
      expect(symbols.maple_search_commit(handle)).toBe(0);
      expect(counts(handle)).toEqual({ vectors: 3n, texts: 3n });

      const hits = queryVector(handle, 'lanterns', basis(2), 10);
      expect(hits[0]).toMatchObject({ id: 'lantern', vector_rank: 1, text_rank: 1 });
      expect(hits[0]!.score).toBeCloseTo(2 / 61, 6);
      expect(hits.map((hit) => hit.id).sort()).toEqual(['harbour', 'kitchen', 'lantern']);

      expect(symbols.maple_search_delete(handle, ptr(cstr('lantern')))).toBe(0);
      expect(symbols.maple_search_commit(handle)).toBe(0);
      expect(counts(handle)).toEqual({ vectors: 2n, texts: 2n });
      expect(queryVector(handle, 'lanterns', basis(2), 10).map((hit) => hit.id)).not.toContain(
        'lantern',
      );

      const outLen = new BigUint64Array(1);
      const noEmbedder = symbols.maple_search_query(
        handle,
        ptr(cstr('harbour')),
        10,
        null,
        0,
        ptr(outLen),
      );
      expect(noEmbedder).toBe(RC_ENGINE_ERROR);
      expect(lastError()).toContain('no query embedder');
    } finally {
      symbols.maple_search_close(handle);
    }
  });
});
