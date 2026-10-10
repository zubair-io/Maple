# maple-search

In-process hybrid search for the Self Hosted API — slice 2 of epic #4460
(#4462). One `SearchEngine` answers a query in four steps:

1. **Embed the query** with bge-m3 (fastembed on ONNX Runtime, 512-token
   limit, CLS pooling, L2-normalised). Measured 30 ms on the production box.
2. **Scan every document vector.** The library's vectors (N × 1024 f32,
   handed over as bytes by the caller) are scored by dot product in parallel
   and the best 100 kept, ties broken by id. Exact, not approximate: 35 ms at
   335k vectors, with none of the recall loss an ANN index brings at this size.
3. **Run the keyword leg** on a Tantivy 0.26 index (`en_stem`, BM25) built
   from the same text blobs the API's SQLite full-text search uses. The query
   is read by a port of the API's term parser
   (`src/api/src/db/repos/search.fts.ts`): bare words OR, quoted phrases are
   required, `-term` excludes, the 33 filler words drop unless nothing else is
   left, at most 24 terms. Its tests reuse that file's cases and expected
   strings. 1.5 ms for the top 100.
4. **Fuse** with reciprocal rank fusion (k = 60) over each leg's top 100,
   returning `(id, score, vector_rank, text_rank)` best first, ties by id.

A query with no positive term (`???`, `-boat`) finds nothing, exactly as the
SQLite path answers it, and is never embedded. A `-term` also removes vector
hits whose text contains it, so an exclusion means the same thing in both
legs.

## Where it is linked

Only into the API's bun:ffi dylib, through raw-ffi's `search` feature
(`raw-ffi/src/search.rs`, the `maple_search_*` symbols), which only
`src/api/scripts/build-raw-ffi.sh` enables. It is never linked into
raw-core, the Apple xcframework, the Windows DLL, the npm packages or WASM;
the header declares the symbols behind `#if defined(MAPLE_SEARCH)` and the
xcframework symbol guard requires them to be absent from every Apple slice.

The text index is a rebuildable cache: `clear_text`, `upsert` every row,
`commit`. Searches keep answering from the previous contents until the commit
lands. Vector upserts and deletes apply immediately.

## ONNX Runtime: one runtime, shared with maple-pano

The workspace pins `ort = "=2.0.0-rc.10"` for maple-pano, and `ort-sys`
declares `links = "onnxruntime"`, so Cargo allows exactly one `ort-sys` in the
whole workspace — two ORT versions cannot coexist, and shipping two runtimes
was never an option anyway.

Current fastembed (6.x–7.x) pins `ort =2.0.0-rc.13`. **fastembed 5.8.0 is the
newest release that pins `=2.0.0-rc.10`**, so this crate uses it and Cargo
unifies both consumers onto the single workspace `ort` (`cargo tree -i
ort-sys` shows one copy). bge-m3, `with_max_length` and the cache directory
option are all present in 5.8.0.

The one thing 5.8.0 lacks is a configurable intra-op thread count — it always
uses every available CPU, which a search process sharing the box with the
decode and face workers should not. That is added by a small in-tree patch,
`third_party/fastembed` (see its `MAPLE-PATCH.md`), resolved through the
workspace `[patch.crates-io]` exactly like the rav1d / zune-jpeg patches.
maple-pano's pin is untouched.

Like maple-pano's `ml` feature, `ort` runs with `load-dynamic`: the ONNX
Runtime dylib (1.23+) is loaded at run time from `ort_dylib_path` in the
config, or `ORT_DYLIB_PATH`. It is probed and version-checked first, because
`ort` panics on a missing or foreign dylib and a panic must not reach the C
boundary.

## Bench

`search-bench` replays a query file through every stage and prints median /
p95 / max per stage — the shape of the 2026-10-09 audit harness:

```bash
cargo run --release -p maple-search --features bench --bin search-bench -- \
  --vectors vectors.f32 --ids ids.txt --texts texts.tsv --queries queries.txt \
  --index-dir /tmp/maple-search-index --model-cache-dir ~/.cache/fastembed \
  --ort-dylib /path/to/libonnxruntime.dylib --intra-threads 8 [--out runs.json]
```

`texts.tsv` is `id<TAB>text` per line. The legs run one after the other here
so each can be timed; `SearchEngine::search` runs them concurrently.
