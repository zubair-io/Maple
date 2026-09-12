# zune-jpeg 0.5.15 — Maple patch

This is an **in-tree copy of the upstream `zune-jpeg` 0.5.15 crate** (unpacked
from crates.io), carrying one Maple change to `src/mcu.rs` and nothing else.
**Two** manifests resolve it through a patch entry, because a `[patch]` only
applies to the workspace that declares it:

```toml
# src/raw-pipeline/Cargo.toml  — the Rust workspace
[patch.crates-io]
zune-jpeg = { path = "third_party/zune-jpeg" }

# src/windows/Cargo.toml  — the Windows host, its own workspace
[patch.crates-io]
zune-jpeg = { path = "../raw-pipeline/third_party/zune-jpeg" }
```

Between them every build uses it: the Linux API/server build, the Windows DLL
and native host, the WASM build, and the Apple offline xcframework build alike.
Keep the two entries in lockstep. It covers `image`'s JPEG decoding too —
`image` 0.25 decodes JPEG through this same crate.

## What changed

`src/mcu.rs`, `decode_mcu_ycbcr_baseline` and the two row-decoding functions
below it. Three things, all confined to the **non-interleaved multi-scan**
branch (`!all_components_in_first_scan`):

1. **Per-scan data-unit row count.** The row loop iterated the *interleaved*
   MCU row count for every scan. A non-interleaved scan (`Ns=1`) codes its
   component's own data units in raster order, so the count is
   `ceil(component height / 8)` — which for a 4:2:0 luma component is twice
   the interleaved MCU row count. Half the luma block rows were never decoded
   and the bitstream desynchronised at the end of the scan.
2. **One block row per data-unit row.** The write offset was
   `row * width_stride * 8 * vertical_sample`, the pitch of an interleaved MCU
   row. Each non-interleaved iteration writes exactly one block row, so the
   pitch is `row * width_stride * 8`. The old pitch left every other luma
   block row of a 4:2:0 image zeroed.
3. **A pending marker is not the end of a scan.** The bit reader runs up to 8
   bytes ahead of the coefficients it has handed out, so a short scan — a flat
   chroma channel, a small image, anything whose entropy data is under ~8 bytes
   per data-unit row — has the next scan's `SOS` (or the `DHT` libjpeg writes
   in front of it) sitting in `stream.marker` long before its own data units
   are used up. The decoder honoured it and ended the scan after its first
   row. Now `SOS`/`DHT`/`DQT`/`DRI`/`COM`/`APPn` stay pending while the scan
   still owes data-unit rows; `RST` and `EOI` are handled immediately as
   before, because restart intervals are part of the scan and an early `EOI`
   means the file really is truncated.

4. **A marker we cannot PARSE ends the image, it does not fail the decode.**
   A JPEG truncated inside a later scan header leaves a partial `SOS`
   segment — and a non-interleaved file has one scan header per component, so
   there are three places to be cut instead of one. `parse_marker_inner`'s
   error was propagated, throwing away every row that had already decoded. In
   non-strict mode it now terminates with what was decoded, the same
   recover-what-we-have view the sibling handling for a failed coefficient
   block already takes, and the same one this module's own doc states
   ("allows even corrupt images to render something ... matching browsers").
   Strict mode still returns the error.

Only (4) can be reached by an interleaved file, and only when it is truncated
inside a scan header — where the alternative is a hard failure. Otherwise
nothing outside the non-interleaved branch is touched. Interleaved files — every camera and
web JPEG, and everything sharp/libjpeg writes by default — take the
`all_components_in_first_scan` path, unchanged; progressive files are decoded
by `mcu_prog.rs`, unchanged.

## Why (#3596)

`jpeg-encoder`, which Maple's own JPEG encoder uses, routes to
`encode_image_sequential` whenever `optimize_huffman_table` is on — and that
writes a non-interleaved file, one `Ns=1` scan per component. Since
`optimiseCoding: true` is the default (sharp's default too), **Maple could not
read its own default `.jpeg()` output**: `toRaw()`/`stats()`/a chained recipe
got a repeating `0, 255, 0` green pattern, with no error raised, while
libjpeg-turbo read the same bytes correctly. The file is valid — `djpeg
-verbose` parses it and sharp decodes it; the decoder was wrong.

It is not only our own output. Non-interleaved baseline JPEGs are what
`cjpeg -scans` / `jpegtran -scans` produce, and Maple mis-read those too.

## Measured

A corpus of 224 `cjpeg` (libjpeg-turbo 3.2.0) files — 7 sizes including
non-MCU-aligned (1x1, 7x5, 17x9, 33x65, 64x64, 65x33, 128x96) x 4 content
classes (RGB noise, luma noise, flat chroma, solid) x 4 subsamplings (1x1,
2x1, 1x2, 2x2) x interleaved and non-interleaved — each decoded with `djpeg`
and with `raw_core::raster::decode_raster`, compared sample for sample:

| | files whose decode differs from libjpeg-turbo by > 8 codes |
| :-- | :-- |
| upstream 0.5.15 | **58 / 224** |
| with this patch | **0 / 224** |

All 58 were non-interleaved, at **every** subsampling including 4:4:4. After
the patch the worst disagreement across the whole corpus is 4 codes
(PSNR 50 dB), which is IDCT rounding, and every non-interleaved file matches
its interleaved twin exactly.

## Upstream

Worth reporting to https://github.com/etemesi254/zune-image. The fix is
deliberately shaped as three small, independently explicable changes rather
than a rewrite of the scan loop, so it should port cleanly.

## Re-applying

`scripts/re-apply-patches.sh` re-applies it idempotently from
`patches/zune-jpeg-0.5.15-noninterleaved-scan.patch`. Run it after any
`cargo vendor` refresh or crate upgrade. Like rav1d, `cargo vendor` no longer
emits `zune-jpeg` into `vendor/` at all — the `[patch.crates-io]` override
replaces it.
