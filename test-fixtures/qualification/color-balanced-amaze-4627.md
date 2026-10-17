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
  Broader core, Metal and binding suites are still running. Their runner
  rejects any source change during qualification.
- The physical cohort is running **82 comparisons**: 52 Neutral comparisons,
  20 Auto baselines and ten native-detail comparisons. It includes every
  camera baseline and all 43 cases from `test_0000`. Original inputs are
  hashed before and after; no reference or budget is changed.

The control renderer matches the current main Rust source tree. Comparisons
use the same frozen float64/native-pair protocol and budgets as the ongoing
806-comparison main run. This protocol is being landed separately through
#4787/#4789; this is not an unmodified-main-harness result.

## Integration still required

This checkpoint preserves implementation and evidence before a ready PR.
Physical results, the complete 806-comparison regression check, performance,
remaining platform qualification and fresh CI/review are not yet complete.
No cleared failure or passing complete color gate is claimed here.

Before merging, increment the then-current pipeline output version and Auto
fit-model version, since balanced demosaicing changes both developed pixels
and the pinned Auto fit input. Regenerate platform mirrors and evidence on
the actual integration revision. The frozen algorithm currently retains
output version 25 and fit-model version 2; it is not the merge revision.

The session exception permits documented failures already present on main.
It does not permit new regressions, raised budgets or omitted comparisons.
Full logs, replay commands and immutable-input identities are under
`/Volumes/Projects/maple-color-gate-20261015/balanced-amaze-current-main/`.
