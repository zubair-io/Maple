# Camera-balanced AMaZE checkpoint — #4627

## Isolated correction

AMaZE's cross-channel interpolation now receives sensor samples balanced by
the camera's AsShotNeutral. Reconstruction returns to camera-native RGB
before the ordinary develop stages, and every measured CFA sample is restored
bit-for-bit. The highlight fallback threshold follows that working scale;
the correction does not clip scene range.

The balanced path also bounds positive false-color blends using local
measured channel-to-green ratios, retaining the original hue estimate in the
permitted interval. This bound applies only to the balanced path. Identity
and invalid balance retain the existing unbalanced kernel; unrelated
demosaic choices and tiny-frame fallbacks retain their existing dispatch.

Full-image, sized-image, tile and dual-AMaZE preparation use the same camera
entry. CPU and GPU hosts consume these shared Rust preparation functions;
there is no separate WGSL AMaZE implementation. Panorama feature work is
outside this change.

## Saved algorithm evidence

The frozen algorithm revision is
`92de5ac272171996646e67392e613780da05d236`, based on main
`676c40a7db1121179b5fe08dd2332e7da8a1834a`.

- All **27 AMaZE tests** pass on the final balanced-only implementation.
  These cover all four Bayer patterns, analytic neutral and color edges,
  texture, exact sampled-value preservation, invalid calibration, tiny
  frames, scene values above one, determinism and dispatch/cancellation.
- The **full/sized/tile integration test** passes for every Bayer pattern
  and both AMaZE selectors. The interior tile uses a padded full-frame
  reconstruction and matches the corresponding scene-linear image within
  the existing `1e-4` parity ceiling. Cancelled full/sized requests return
  cancellation.
- The release CLI is built and frozen with source and binary hashes.
  Source hashes remained unchanged through every completed qualification.
- The physical cohort is running **82 comparisons**: 52 Neutral comparisons,
  20 Auto baselines and ten native-detail comparisons. It includes every
  camera baseline and all 43 cases from `test_0000`. Original inputs are
  hashed before and after; no reference or budget is changed.

| Broader check | Passed | Ignored |
| --- | ---: | ---: |
| Debug core with GPU/test-support | 2,812 | 100 |
| Metal GPU library parity | 287 | 4 |
| FFI library with GPU bindings | 301 | 6 |
| Native-host WASM library with GPU bindings | 74 | 7 |

Native-host WASM tests do not establish browser-WebGPU execution.

Two early completed physical outputs improve against the same references:

| Case | Main mean / p95 / max ΔE2000 | Balanced AMaZE mean / p95 / max |
| --- | --- | --- |
| `test_0000/baseline` | 5.745425 / 9.419729 / 35.753290 | 5.686716 / 9.284647 / 30.987473 |
| `test_0000/blacks_min` | 10.465620 / 21.865708 / 37.487601 | 10.435178 / 21.845582 / 31.868900 |

Both cases remain within every unchanged budget, including RGB bias. Each
comparison covers 10,668,000 pixels, and every source/reference/candidate hash
remains unchanged after comparison. These are passing controls, so this
two-case diagnostic clears zero previously failing cases. It does not replace
the complete cohort or whole-corpus qualification.

The control renderer matches the current main Rust source tree. Comparisons
use the same frozen float64/native-pair protocol and budgets as the ongoing
806-comparison main run. This protocol is being landed separately through
#4787/#4789; this is not an unmodified-main-harness result.

## Integration still required

The follow-up Pixel control in #4647 finds one new failure from AMaZE alone:
`test_0015/dehaze_max` blue bias is -0.073930924 against the unchanged absolute
ceiling 0.0734; frozen main passes at -0.068169846. Applying the required Bayer
GainMaps changes that bias to -0.040073069 and passes every metric. This
interaction requires qualification of the two changes together against main.
The AMaZE-only branch is not ready to land. Exact three-way metrics and input
hashes are in `pixel-gainmaps-isolated/dehaze_max-three-way.json` under the
evidence root; the 806-comparison combined run is in progress.

This checkpoint preserves implementation and evidence before a ready PR.
Physical results, the complete 806-comparison regression check, performance,
remaining platform qualification and fresh CI/review are not yet complete.
No cleared failure or passing complete color gate is claimed here.

Before merging, increment the then-current pipeline output version and Auto
fit-model version, since balanced demosaicing changes both developed pixels
and the pinned Auto fit input. Regenerate platform mirrors and evidence on
the actual integration revision. The frozen algorithm currently retains
output version 25 and fit-model version 2; it is not the merge revision.

Full logs, replay commands and immutable-input identities are under
`/Volumes/Projects/maple-color-gate-20261015/balanced-amaze-current-main/`.
