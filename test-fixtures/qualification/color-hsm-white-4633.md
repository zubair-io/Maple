# Selected-white HueSatMap qualification (#4633)

## Scope and status

This repair retains both dual-illuminant HSM tables and resolves their blend at
the same render-camera neutral as the ForwardMatrix. It preserves the slider
frame, original RAWs, sidecars, single-table behavior and exact As Shot table.
The GPU interpolates table nodes before lookup using the same circular hue math.
Both GPU table slots are prepared on the first render so entering or leaving
selected-white interpolation reuses the buffers and bind group.

Pipeline output version 47 invalidates affected derived pixels. Auto-fit version
14 is unchanged: its default As Shot preparation is identical. This is a local
repair checkpoint, not a passing full color gate or authorization to merge.
Persistent GPU session migration and absolute frame-time qualification remain
under #4629. The complete color-repair goal still requires every physical case,
review and fresh CI to pass.

## Regression and parity evidence

All runs used physical fixtures where declared, without raising budgets.

| Check                                                | Result                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Core library with GPU                                | 2,878 passed; 104 fixture-gated tests ignored in this broad invocation                                       |
| Explicit physical camera suite                       | 6 passed, 0 ignored; 11 cameras, 66 prefix comparisons and 275 calibration comparisons                       |
| Physical prefix / calibration maximum absolute error | 0.00001240 / 0.00001717; both below the existing 0.0001 ceiling                                              |
| GPU library                                          | 297 passed; 5 ignored; repeated after the table-slot repair                                                  |
| Native WASM binding library                          | 74 passed; 8 ignored                                                                                         |
| GPU-enabled FFI library                              | 301 passed; 6 ignored                                                                                        |
| Browser target                                       | wasm32 GPU/parallel/AVIF compilation passed                                                                  |
| Selected-white core regressions                      | 4 passed, including independent reciprocal-CCT predictions, single-table and As Shot identity                |
| Full / sized / tile route regression                 | 18 route/quality/white-point combinations pass against independently pinned expected tables                  |
| Physical C ABI                                       | 16 file/byte comparisons match core bits across two cameras, two WB settings and two qualities               |
| Physical Web CPU binding on native host              | 8 comparisons match core bits over the same cameras/settings/qualities; this is not browser WebGPU execution |

The route test fails when the old fixed-HSM behavior is restored (maximum scene
error 0.05222), then passes after restoring the repair. The GPU transition test
also fails before the slot repair: the first As Shot-to-selected-WB transition
raises allocation count from 3 to 6. The fixed test retains its initial count
through both transition directions and intermediate blend weights. That proves
resource reuse, not the outstanding absolute latency target.

## Matched physical comparisons

The control is the frozen version-46 CLI, SHA-256
`46877fbafa47f5cfcb15b4d6dc5c3cd91769284c8c1046ede6cba3c7290a8e11`.
The selected-white candidate, before the metadata-only version bump and the GPU
resource-only repair, is
`9d2349692ec4265343f077511f98073068f13ab1208adc171cf5dc21f3a8306e`.

The final version-47 release CLI is
`8f22131e7a45ca846e4951233fe6c5f62c78feda351d5c7812347ec7ab81545e`.
Its test_0006 / temperature_min PNG is byte-identical to the qualified
selected-white candidate; original inputs are unchanged. Build provenance and
that comparison are archived in `v47-build/` and `v47-output-identity/`.

The 36 comparisons cover test_0000, test_0006 and test_0007, each with Neutral and
Auto baselines plus all ten WB cases: temperature min/max, tint min/max, Auto,
Cloudy, Daylight, Flash, Shade and Tungsten. The initial 24-comparison group has
87 input files; the supplementary 12-comparison group has 51. All input hashes
are unchanged in both variants. All six baseline PNG pairs are byte-identical.

Both variants pass 34 and fail 2, with no missing comparisons or newly failing
cases. The existing failures remain:

| Case                        | Control                          | Selected-white candidate         | Unchanged budget                 |
| --------------------------- | -------------------------------- | -------------------------------- | -------------------------------- |
| test_0000 / temperature_min | Mean 17.53790; blue bias -0.3078 | Mean 17.57743; blue bias -0.3250 | Mean 10.00; absolute bias 0.2911 |
| test_0007 / tint_min        | Mean 4.498898; max 45.19         | Mean 4.498898; max 45.19         | Max 43.20                        |

The first case gets numerically worse; this repair does not resolve either
remaining failure. Its justification is the independently verified calibration
defect and shared CPU/GPU implementation, not a claim that this subset is green.

A resolved-profile audit of all 20 corpus cameras confirms dual HSM endpoints
only on test_0000, test_0006 and test_0007. The L3D profile is BundleConfident and
inherits the source DNG's HSM when the bundled record has no tables. An earlier
diagnostic rejected that source tier before checking its tables; that failure
was not evidence that the L3D render had no HSM.

## Reproduction and archived evidence

```bash
cd src/raw-pipeline
cargo test -p raw-core --features gpu --lib stages::wb_camera::hsm_tests -- --test-threads=1
cargo test -p raw-core --features gpu --lib gpu_host::colorimetry -- --include-ignored --test-threads=1
cargo test -p raw-gpu --lib dcp_colorimetry -- --test-threads=1
cargo test -p raw-ffi --features gpu --lib selected_hsm_physical -- --include-ignored --test-threads=1
cargo test -p raw-wasm --features gpu --lib selected_hsm_physical -- --include-ignored --test-threads=1
```

The physical corpus and archived output are machine-local under
`/Volumes/Projects/maple-color-gate-20261015/hsm-white-point-current-gpu/`:
`qualification-identity.json`, `route-bindings/identity.json`,
`stable-slots/identity.json`, `physical-paired-results.json`,
`baseline-byte-identity.json` and `resolved-profile-audit.tsv` contain the exact
commands, source snapshots, hashes and comparison rows. The complete 806-case
version-46 run is separate and remains in progress; this focused evidence does
not substitute for it.
