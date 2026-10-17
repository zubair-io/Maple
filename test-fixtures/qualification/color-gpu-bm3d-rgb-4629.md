# Complete resident GPU BM3D stage — #4629

## Scope

The staged `Bm3dPass` now implements the complete CPU `bm3d::apply` operation:
RGB-to-opponent conversion, median-derived noise parameters, hard-threshold and
Wiener passes, high-frequency reinjection and RGB reconstruction. Both filtering
passes and all intermediate buffers remain on the GPU. Shipping live hosts still
use their existing prefix; performance repair and integration remain required.

The median uses every eighth luma sample and selects the upper middle element,
matching the CPU's `f32::total_cmp` ordering. Four byte-wise radix rounds retain
the exact selected key. Noise, luma and Gaussian constants come from the CPU via
codegen. CPU arithmetic, reference images, budgets and output versions are
unchanged. Disabled strengths and images smaller than one patch copy exactly.

## Pixel qualification

Executed on Apple M5 Max, macOS 27.0, Rust 1.98.1, Metal. The source parent is
`c733699f1b0129a4e0976f38e23b26ec7972db57`, based on main
`efa6f0dd9b398fb316731dae9c60b340280015b3`.

| Direct comparison with CPU `bm3d::apply`                    | Outputs | RGB channels | Maximum absolute error |
| ----------------------------------------------------------- | ------: | -----------: | ---------------------: |
| Uniform, gradient, noisy, HDR edge, tiny and disabled cases |     120 |      153,720 |           1.9073486e-6 |
| Black, negative, near-black and bright noise anchors        |      30 |       39,330 |           4.7683716e-7 |
| Actual Canon `test_0006.DNG` and Fuji `test_0005.RAF`       |      18 |    1,097,280 |           1.4901161e-7 |

All 168 comparisons pass the existing `1e-4` ceiling. Physical images cover
64, 128 and 256px long edges at strengths 1, 25 and 100. Synthetic tests also
cover the activation boundary and values above 100. Uniform fields and alpha
are exact; source buffers and original RAW bytes remain unchanged.

The median test separately verifies exact ranks for duplicates, adjacent f32
values and negative values across four dimensions. Its largest case exceeds the
128-workgroup histogram cap and exercises the strided tail. Warm stage tests
change source pixels and strength, restore both, require repeatable results and
observe no additional pooled buffer/bind-group allocations. Only the final RGB
result is read back. Disabled/tiny cases allocate no stage scratch.

Full qualification:

- 315 raw-gpu tests passed; five existing ignored tests plus the new timing
  diagnostic are excluded from the regular run. The diagnostic executed
  separately in debug and release builds.
- 28 core BM3D tests passed, zero ignored, including all physical cases and the
  previously qualified exact matching/filtering/aggregation tests.
- Three BM3D generator tests passed; all 74 assembled WGSL modules validate.
- Native WASM all-feature/all-target and FFI GPU compilation passed.
- Code generation repeated without source drift; file headroom passed.

The first full run contained 27 core BM3D tests. The black/negative-anchor test
was added afterward, then all 28 core tests were rerun. Runtime, shader and GPU
test source hashes stayed unchanged. CI step names now describe the complete
stage; their commands are unchanged.

## Performance remains unresolved

Five warm standalone runs per size, after one warmup, at strength 25:

| Square image | Debug median | Release median |
| ------------ | -----------: | -------------: |
| 64px         |      18.69ms |        16.64ms |
| 128px        |      35.53ms |        33.21ms |
| 256px        |      74.15ms |        66.37ms |
| 512px        |     151.07ms |       135.00ms |

These timings include encoding, submission and final CPU readback, on a shared
host. They are diagnostics, not live-frame qualification. In particular, the
512px result does not satisfy the 16ms target or 50ms hard limit. The next step
is to profile and reduce the reference-row dispatch cost while preserving the
ordered CPU accumulation, then qualify the live prefix and platform bindings.
The stage is not enabled in shipping hosts by this checkpoint.

## Evidence and reproduction

Archive: `/Volumes/Projects/maple-color-gate-20261015/gpu-bm3d-rgb-4629/`.
It contains source/input hashes, every command log, initial/final core results,
post-qualification test additions, timing samples and host details. The two RAW
hashes were rechecked after all physical comparisons.

```sh
cd src/raw-pipeline
cargo test -p raw-gpu -- --test-threads=1
cargo test -p raw-core --features gpu --lib stages::bm3d:: -- --include-ignored --nocapture --test-threads=1
cargo test -p codegen bm3d
cargo test --release -p raw-gpu bm3d::tests::full_stage_warm_timing -- --ignored --nocapture --test-threads=1
```

No ACR failures are claimed cleared by this unconnected stage. The latest full
repair-snapshot gate remains 98 failures in 806 comparisons; that is not a fresh
measurement of main. Budgets were not loosened.
