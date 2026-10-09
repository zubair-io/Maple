# fastembed 5.8.0 — Maple patch

An in-tree copy of the upstream `fastembed` 5.8.0 crate (unpacked from
crates.io, `src/`, `Cargo.toml` and `LICENSE` only — the upstream tests and
their `[[test]]` entries are dropped), resolved through the workspace patch:

```toml
# src/raw-pipeline/Cargo.toml
[patch.crates-io]
fastembed = { path = "third_party/fastembed" }
```

Its only consumer is `maple-search` (#4462), which is linked only into the
API's bun:ffi dylib.

## Why 5.8.0

It is the newest release that pins `ort =2.0.0-rc.10`, the version the
workspace pins for maple-pano. `ort-sys` declares `links = "onnxruntime"`, so a
workspace can hold exactly one ORT; every fastembed from 5.9 on pins rc.11 or
later and cannot resolve alongside maple-pano. See `maple-search/README.md`.

## What changed

One option, threaded through the three `InitOptionsWithLength` consumers:

- `src/init.rs` — `InitOptionsWithLength` gains `pub intra_threads:
  Option<usize>` (default `None`) and a `with_intra_threads(usize)` builder.
- `src/text_embedding/impl.rs`, `src/sparse_text_embedding/impl.rs`,
  `src/reranking/impl.rs` — `try_new` uses that count for the ONNX Runtime
  session's intra-op threads, falling back to `available_parallelism()` (the
  upstream behaviour) when it is `None`.

Upstream added the same knob in a later release; drop this patch when the
workspace `ort` pin moves to a version a current fastembed accepts.

## Upgrading

Unpack the new release over this directory, delete `tests/` and the
`[[test]]` entries from `Cargo.toml`, re-apply the change above, and run
`cargo test -p maple-search`.
