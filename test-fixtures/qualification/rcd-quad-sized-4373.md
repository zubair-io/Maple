# RCD quads in the bounded sized develop — #4373

`develop_sized_camera` reconstructs the half-size buffer of a bounded
non-Preview Bayer develop with `demosaic::rcd_quad_half_cancellable`
instead of `half_res_cancellable`'s CFA binning.
`pipeline/develop/tests_sized_quad.rs` pins that wiring: reverting the
branch to `half_res_cancellable` fails it. `demosaic/rcd/tests_quad.rs` pins
the kernel bit for bit against full-frame RCD followed by the same quad
average.

All numbers below come from `raw-core/examples/rcd_quad_qualification.rs`,
built `--release` on one Mac (18 logical CPUs). "main" is that probe built
with the half-size branch on `half_res_cancellable`, which is the kernel
`main` (e21fc93511) runs there. "whole plane" is the first version of this
change (10a80e9db7), which flattened the whole CFA plane before the bands.
"band rows" is the current version, which flattens only the rows each band
reads.

## Peak memory on the 100 MP fixture

test_0000 (Hasselblad L3D-100c, 12288 × 8192). Process maximum RSS from
`/usr/bin/time -l`, median of three runs, all variants interleaved in one
session. The decoded RAW and the linearized `[f32; 3]` mosaic are resident in
every run. The six-thread rows use `RAYON_NUM_THREADS=6`, the CPU count of
current iPhones.

| Mode | Threads | main (`half_res`) | whole plane | band rows |
| --- | ---: | ---: | ---: | ---: |
| demosaic only | 18 | 2240 MB | 2955 MB | 2625 MB |
| demosaic only | 6 | 2240 MB | 2735 MB | 2374 MB |
| sized develop, `max_long_edge` 2560 | 18 | 2827 MB | 3053 MB | 2724 MB |
| sized develop, `max_long_edge` 2560 | 6 | 2806 MB | 3003 MB | 2925 MB |

Flattening per band removes the 403 MB full-frame CFA plane. What the kernel
still adds over `half_res` is per-worker band scratch: about 22 MB per worker
at this width (the 64-row RGB band, its CFA rows plus the 6-row border on each
side, and the band's green and chroma planes). That is the 385 MB left at 18
threads and 134 MB at 6. In the whole sized develop the peak is set by a later
stage. Against main it is 103 MB lower at 18 threads and 119 MB higher at 6.
The whole-plane version was 226 MB and 197 MB higher. iOS jetsam behaviour on
a device is not measured here.

## Sized preview against export

#4373's criterion is the viewport render against the export, mean ΔE00 ≤ 2.
Default model (Auto, with its own bounded fit), `RenderQuality::Full`.
`png 2048` gives the sized display render at a 2048 px long edge and the
unsized export. `src/scripts/compare_images.py EXPORT.png SIZED.png` resizes
the export to the sized render's dimensions with Lanczos and compares.

| Fixture | Export size | main mean / p95 / max ΔE00 | band rows mean / p95 / max ΔE00 |
| --- | --- | --- | --- |
| test_0003 (Canon 5DS R, CR2) | 5792 × 8688 | 0.746 / 1.678 / 22.07 | 0.671 / 1.519 / 12.83 |
| test_0011 (Sony ILCE-7RM4, ARW) | 9504 × 6336 | 0.712 / 2.266 / 15.71 | 0.644 / 2.014 / 12.29 |
| test_0014 (Nikon D850, NEF) | 8256 × 5504 | 1.139 / 3.225 / 19.07 | 1.016 / 2.603 / 16.46 |

The sized preview moves closer to the export on all three fixtures, on mean,
p95 and maximum. All are within the ≤ 2 mean budget before and after. The
export is the same in both columns: the unsized develop does not enter the
half-size branch.

## Not measured

- The Windows CPU/GPU/export qualification and the 16 ms interaction gate.
- WASM and the server thumb and preview stages.
- Device memory on iOS.
