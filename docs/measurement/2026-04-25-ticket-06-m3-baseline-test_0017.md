# Ticket 06 M3 — early-downsample baseline + post-verification trace

Captured 2026-04-25 from this worktree (`claude/keen-gould-063563`) on a
single developer machine. The plan and brief reference test_0017.dng as the
"100 MP fixture" but in this worktree the actual 100 MP frame is
**test_0000.DNG** (Hasselblad L3D-100c, 12288×8192). The user's intended
"100 MP Mavic 3 Pro" fixture (`dji-mavic3pro-100mp.dng`) is gitignored and
absent locally; test_0000.DNG is the same camera (Hasselblad L3D-100c is the
DJI Mavic 3 Pro main sensor per `CLAUDE.md`) and the same pixel count, so
serves as the reference here.

test_0017.dng is a 5984×3992 (~24 MP) Leica M10 frame in this worktree, not
100 MP. We profile both — test_0017 for parity with the unit test and Apple
golden, test_0000 for the perf gate.

Numbers were captured via a temporary `m3_bench` example (gitignored, not
committed) calling
`raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality(raw, &model, RenderQuality::Preview, 1500)`
under `MAPLE_PROFILE=1`.

## Pre-M3 baseline (commit `abfe1a3`, before Tasks 2-4)

### test_0017.dng (5984×3992, Leica M10, ~24 MP)

```
[m3_bench] read_bytes:               3.288 ms
[m3_bench] decode_bytes:           173.003 ms
[m3_bench] raw dims: 5984×3992, cfa: Rggb
[raw-core] linearize                         13.10ms
[raw-core] demosaic                           6.68ms
[raw-core] baseline_exposure                  1.69ms
[raw-core] highlight_recovery               208.00ns
[raw-core] dcp::profile_for                   1.25µs
[raw-core] dcp::apply                         6.96ms
[raw-core] white_balance                      1.21µs
[raw-core] scene_tone_controls              708.00ns
[raw-core] vibrance                         458.00ns
[raw-core] saturation                       292.00ns
[raw-core] clarity                          125.00ns
[raw-core] texture                           83.00ns
[raw-core] dehaze                           208.00ns
[raw-core] sharpen                          250.00ns
[raw-core] nr_luminance                     250.00ns
[raw-core] nr_color                          55.88ms
[raw-core] downsample_area_f32                5.15ms
[raw-core] pack_rgba_f32_sized                2.94ms
[raw-core] apply_orientation_rgba_sized     366.08µs
[raw-core] pack_fp16_sized                   15.43ms
[m3_bench] render_scene_linear_sized:   108.651 ms (out 1500×1001, fp16 buf 12012000 bytes)
[m3_bench] TOTAL (read+decode+render):   285.138 ms
```

Post-demosaic stages (linearize-after-downsample slot to nr_color) on the
half-res Leica M10 buffer aggregate to ~70 ms. The brief's Step 1.4 hint
applies: `nr_color = 56 ms` is on the boundary of "post-demosaic stages
aggregate to less than 100 ms" — the speedup math is real but the absolute
gain on this fixture is modest. Test_0000 is the binding measurement.

### test_0000.DNG (12288×8192, Hasselblad L3D-100c, ~100 MP)

```
[m3_bench] read_bytes:              13.330 ms
[m3_bench] decode_bytes:           388.956 ms
[m3_bench] raw dims: 12288×8192, cfa: Rggb
[raw-core] linearize                         31.57ms
[raw-core] demosaic                          15.94ms
[raw-core] baseline_exposure                  8.78ms
[raw-core] highlight_recovery                 1.00µs
[raw-core] dcp::profile_for                   1.50µs
[raw-core] dcp::apply                        12.77ms
[raw-core] white_balance                      1.00µs
[raw-core] scene_tone_controls              166.00ns
[raw-core] vibrance                         917.00ns
[raw-core] saturation                       416.00ns
[raw-core] clarity                          208.00ns
[raw-core] texture                          375.00ns
[raw-core] dehaze                           333.00ns
[raw-core] sharpen                          166.00ns
[raw-core] nr_luminance                       1.12µs
[raw-core] nr_color                         340.40ms
[raw-core] downsample_area_f32               16.16ms
[raw-core] pack_rgba_f32_sized                4.20ms
[raw-core] apply_orientation_rgba_sized       1.62ms
[raw-core] pack_fp16_sized                   16.47ms
[m3_bench] render_scene_linear_sized:   448.340 ms (out 1500×1000, fp16 buf 12000000 bytes)
[m3_bench] TOTAL (read+decode+render):   850.765 ms
```

The user's reported 100 MP trace shows nr_color = 1.93 s, total ~5.25 s on
their machine. On this developer machine the same pre-M3 path measures
nr_color = 340 ms, total = 851 ms — about 6× faster than the user's machine
(likely an M-series Mac with strong vectorized scalar perf vs. a slower
machine). The brief's expected speedup ratios still apply; absolute numbers
scale.

## Post-M3 verification (commit `bbf8ff5`, after Tasks 2-5)

### test_0000.DNG (12288×8192, Hasselblad L3D-100c, ~100 MP)

```
[m3_bench] read_bytes:              13.984 ms
[m3_bench] decode_bytes:           336.353 ms
[m3_bench] raw dims: 12288×8192, cfa: Rggb
[raw-core] sized_linearize                   29.25ms
[raw-core] sized_demosaic                    16.79ms
[raw-core] sized_downsample_area_f32         18.24ms
[raw-core] sized_baseline_exposure          437.46µs
[raw-core] sized_highlight_recovery         166.00ns
[raw-core] sized_dcp_profile_for              2.33µs
[raw-core] sized_dcp_apply                    1.93ms
[raw-core] sized_white_balance              209.00ns
[raw-core] sized_scene_tone_controls        125.00ns
[raw-core] sized_vibrance                   208.00ns
[raw-core] sized_saturation                   4.92µs
[raw-core] sized_clarity                    125.00ns
[raw-core] sized_texture                    708.00ns
[raw-core] sized_dehaze                     292.00ns
[raw-core] sized_sharpen                    166.00ns
[raw-core] sized_nr_luminance               250.00ns
[raw-core] sized_nr_color                    20.09ms
[raw-core] pack_rgba_f32_sized                4.15ms
[raw-core] apply_orientation_rgba_sized       1.65ms
[raw-core] pack_fp16_sized                   15.92ms
[m3_bench] render_scene_linear_sized:   108.825 ms (out 1500×1000, fp16 buf 12000000 bytes)
[m3_bench] TOTAL (read+decode+render):   459.268 ms
```

## Per-stage comparison (test_0000.DNG, 100 MP)

| Stage                            | Pre-M3       | Post-M3      | Speedup    |
| -------------------------------- | -----------: | -----------: | ---------: |
| sized_linearize                  |   31.57 ms   |   29.25 ms   |   1.08x    |
| sized_demosaic                   |   15.94 ms   |   16.79 ms   |   0.95x    |
| sized_downsample_area_f32        |   16.16 ms*  |   18.24 ms** | (relocated)|
| sized_baseline_exposure          |    8.78 ms   |    0.44 ms   |  20x       |
| sized_dcp_apply                  |   12.77 ms   |    1.93 ms   |   6.6x     |
| sized_nr_color                   |  340.40 ms   |   20.09 ms   |  17x       |
| pack_fp16_sized                  |   16.47 ms   |   15.92 ms   |   1.0x     |
| **render_scene_linear_sized**    |  **448 ms**  |  **109 ms**  |  **4.1x**  |
| **TOTAL (read+decode+render)**   |  **851 ms**  |  **459 ms**  |  **1.85x** |

\* Pre-M3 the downsample ran at the END of the chain on the (already nr_color'd)
half-res buffer.
\** Post-M3 the downsample runs immediately after demosaic on the half-res
camera-RGB buffer.

## Gate evaluation

- **Target:** total Rust FFI <= 3.0 s. **Measured: 459 ms total, 109 ms render-only.** PASS.
- **Hard limit:** total Rust FFI <= 3.5 s. PASS.
- **Per-stage speedup expectation:** post-demosaic stages drop ~8x. Measured:
  baseline_exposure 20x, dcp_apply 6.6x, nr_color 17x. The buffer ratio is
  6144x4096 (half-res 100 MP) -> 1500x1000 = 16.8x pixel reduction, which is
  what nr_color tracks. baseline_exposure had a larger relative drop because it
  also exited cache effects from the upstream pipeline.
- **Decode floor:** the user's `ffi_rawler_decode = 2.34 s` is the rawler decode
  floor — separate ticket
  (`docs/superpowers/plans/2026-04-24-sub-second-raw-decode.md`). On this
  machine `decode_bytes = 388 ms` so it's not the binding floor here.
