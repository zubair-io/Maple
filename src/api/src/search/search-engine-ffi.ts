/**
 * `bun:ffi` binding for the `maple_search_*` C ABI (#4462). Loaded only inside the search child:
 * the query embedding and the vector scan are tens of milliseconds of synchronous native work that
 * must never run on the API's event loop.
 */

import { findNativeLib } from 'maple';
import type * as BunFfi from 'bun:ffi';

const RC_NEED_LARGER_BUFFER = 100;
const INITIAL_RESULT_BYTES = 256 * 1024;

export interface SearchEngineConfig {
  index_dir: string;
  embedder?: {
    model_cache_dir: string;
    ort_dylib_path?: string;
    intra_threads?: number;
  };
}

export interface FusedSearchHit {
  id: string;
  score: number;
  vectorRank: number | null;
  textRank: number | null;
}

/** One open engine. Every method throws with the library's own error message on failure. */
export interface SearchEngine {
  loadVectors(vectors: Uint8Array, ids: readonly string[]): void;
  upsert(id: string, vector: Float32Array | null, text: string | null): void;
  delete(id: string): void;
  clearText(): void;
  commit(): void;
  counts(): { vectors: number; texts: number };
  query(query: string, k: number): FusedSearchHit[];
  close(): void;
}

interface WireHit {
  id: string;
  score: number;
  vector_rank: number | null;
  text_rank: number | null;
}

const cstr = (text: string) => Buffer.from(text + '\0', 'utf-8');

function openLibrary(libPath: string) {
  const { dlopen, FFIType } = require('bun:ffi') as typeof BunFfi;
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
    maple_search_upsert: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    maple_search_delete: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    maple_search_clear_text: { args: [FFIType.ptr], returns: FFIType.i32 },
    maple_search_commit: { args: [FFIType.ptr], returns: FFIType.i32 },
    maple_search_counts: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    maple_last_error: { args: [], returns: FFIType.cstring },
  });
}

/** Opens an engine on the native library `findNativeLib` resolves; throws when it has no search. */
export function openSearchEngine(config: SearchEngineConfig): SearchEngine {
  const libPath = findNativeLib();
  if (!libPath) throw new Error('search: no native library found');
  const { ptr } = require('bun:ffi') as typeof BunFfi;
  const { symbols } = openLibrary(libPath);
  const fail = (call: string, rc: number): never => {
    throw new Error(`${call} failed (rc ${rc}): ${String(symbols.maple_last_error())}`);
  };
  const check = (call: string, rc: number): void => {
    if (rc !== 0) fail(call, rc);
  };

  const handle = symbols.maple_search_open(ptr(cstr(JSON.stringify(config))));
  if (handle === null) throw new Error(`maple_search_open: ${String(symbols.maple_last_error())}`);

  let results = Buffer.alloc(INITIAL_RESULT_BYTES);
  const resultLength = new BigUint64Array(1);
  const runQuery = (query: Buffer, k: number): number =>
    symbols.maple_search_query(
      handle,
      ptr(query),
      k,
      ptr(results),
      results.length,
      ptr(resultLength),
    );

  return {
    loadVectors(vectors, ids) {
      const joined = Buffer.from(ids.join('\n'), 'utf-8');
      check(
        'maple_search_load_vectors',
        symbols.maple_search_load_vectors(
          handle,
          vectors.byteLength === 0 ? null : ptr(vectors),
          vectors.byteLength,
          joined.length === 0 ? null : ptr(joined),
          joined.length,
        ),
      );
    },
    upsert(id, vector, text) {
      check(
        'maple_search_upsert',
        symbols.maple_search_upsert(
          handle,
          ptr(cstr(id)),
          vector === null ? null : ptr(vector),
          vector?.length ?? 0,
          text === null ? null : ptr(cstr(text)),
        ),
      );
    },
    delete(id) {
      check('maple_search_delete', symbols.maple_search_delete(handle, ptr(cstr(id))));
    },
    clearText() {
      check('maple_search_clear_text', symbols.maple_search_clear_text(handle));
    },
    commit() {
      check('maple_search_commit', symbols.maple_search_commit(handle));
    },
    counts() {
      const out = new BigUint64Array(2);
      check('maple_search_counts', symbols.maple_search_counts(handle, ptr(out), ptr(out, 8)));
      return { vectors: Number(out[0]), texts: Number(out[1]) };
    },
    query(query, k) {
      const encoded = cstr(query);
      const first = runQuery(encoded, k);
      if (first === RC_NEED_LARGER_BUFFER) results = Buffer.alloc(Number(resultLength[0]));
      check('maple_search_query', first === RC_NEED_LARGER_BUFFER ? runQuery(encoded, k) : first);
      const hits = JSON.parse(
        results.subarray(0, Number(resultLength[0])).toString('utf-8'),
      ) as WireHit[];
      return hits.map((hit) => ({
        id: hit.id,
        score: hit.score,
        vectorRank: hit.vector_rank,
        textRank: hit.text_rank,
      }));
    },
    close() {
      symbols.maple_search_close(handle);
    },
  };
}
