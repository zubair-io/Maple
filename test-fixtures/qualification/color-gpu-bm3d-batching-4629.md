# BM3D reference-row batching — #4629

## Change and motivation

The full-stage checkpoint `653c09af5c7ff624d9f3c54f224fc92f42105ae9` passed
pixel parity but took 135.00ms at 512px in its release diagnostic. A phase probe
put approximately 125ms in GPU completion, 4ms in encoding, and 2ms in readback.
Reducing only CPU submission work would not address the measured cost.

This checkpoint matches and filters up to eight reference rows in one dispatch,
then aggregates that batch in the original row/column/member order. It reuses
the batch scratch before moving to the next rows. The final clamped reference
row and partial final batch retain their CPU positions. Storage-binding and
workgroup-dispatch limits can reduce the batch size. Scratch grows from one to
at most eight rows, rather than storing the full image's filtered patch set.

There are no float atomics, altered match thresholds, reordered sums, changed
CPU operations, new settings, or intermediate CPU readbacks. This remains a
staged prerequisite for #4629's persistent camera-prefix migration; shipping
hosts and output versions are unchanged.

## Pixel and resource qualification

- Two-, three- and eight-row batches are bit-identical to single-row hard and
  Wiener outputs over five image sizes: 248,208 compared channel bit patterns,
  including alpha. Cases cover a single patch, non-stride dimensions, complete
  batches and partial final batches.
- Storage and dispatch-limit tests require the corresponding 1/2/3/8-row
  selection. The existing warm two-pass and complete-RGB tests still observe
  changed inputs/strength, exact restoration and no new pooled allocations.
- 317 raw-gpu tests passed. Seven are ignored in the ordinary run: five existing
  exclusions and two timing diagnostics, which executed separately.
- All 28 core BM3D tests passed with zero ignored, including physical fixtures.
  The 1,865 ordered matching groups and earlier filter/aggregation comparisons
  remain covered.
- All 168 complete-RGB comparisons pass the unchanged `1e-4` ceiling. Maximum
  error remains 1.9073486e-6. The 18 Canon/Fuji comparisons cover 1,097,280 RGB
  channels with maximum error 1.4901161e-7, unchanged from the preceding stage.
- All 74 WGSL modules and three generator tests pass. Native WASM all-feature/
  all-target and FFI GPU compilation, regeneration and headroom checks pass.
- Source and both original RAW hashes remained unchanged during qualification.

## Timing evidence and remaining work

Apple M5 Max, macOS 27.0, Rust 1.98.1, Metal. Each row is the median of five
warm standalone stage runs after one warmup, at strength 25. Timing includes
encode, submission and final readback, on a shared host.

| Size      | Previous release | Batched release |
| --------- | ---------------: | --------------: |
| 64×64     |          16.64ms |          4.84ms |
| 128×128   |          33.21ms |          6.41ms |
| 256×256   |          66.37ms |         15.81ms |
| 512×512   |         135.00ms |         43.29ms |
| 1024×1024 |     Not measured |        161.92ms |
| 2048×2048 |     Not measured |        707.88ms |

The repeated 512px result is 3.12× faster. The batched phase probe reports
approximately 42ms in GPU completion and less than 1ms in encode/submit.
The larger probes establish that substantial GPU work remains; neither these
diagnostics nor the 512px timing qualify the live-frame 16ms/50ms contract.
Next work is to isolate matching versus filtering cost, reduce the measured
kernel cost while preserving pixel parity, and complete live-prefix integration.

## Evidence and reproduction

Archive: `/Volumes/Projects/maple-color-gate-20261015/gpu-bm3d-batching-4629/`.
It includes the original phase profile, initial batched results, final complete
qualification, source/input hashes and timing samples. The previous release
baseline is in `gpu-bm3d-rgb-4629/warm-timing-release.log` beside that archive.

```sh
cd src/raw-pipeline
cargo test -p raw-gpu -- --test-threads=1
cargo test -p raw-core --features gpu --lib stages::bm3d:: -- --include-ignored --nocapture --test-threads=1
cargo test --release -p raw-gpu bm3d::tests::full_stage_ -- --ignored --nocapture --test-threads=1
```

No additional ACR failures are claimed cleared. The full repair-snapshot result
remains 98 failures in 806 comparisons, not a fresh main result. Budgets and
references remain unchanged.
