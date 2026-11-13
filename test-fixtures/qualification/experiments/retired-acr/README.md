# ACR appearance comparisons retired by owner direction — #5000

Auto's appearance target is the camera embedded JPEG; Neutral retains AgX.
On2026-10-19 the owner requested removing Adobe comparisons from all CI and
color tests. This is a target-policy change, not a claim that105 old breaches
were repaired or expected. Historical PNG/XMP/RAW inputs, budgets and ledgers
are preserved unchanged.

- `test_color_pipeline.sh` now runs the independent embedded-JPEG gate.
- The former harness is manual `diagnose_acr_comparison.sh`; Exposure, Whites
  and tone-band Adobe comparisons are manual `diagnose_acr_*.sh` tools.
- ACR reference/comparator contract tests no longer run in CI. The existing
  contract tests for the archived harness remain manually available as
  `acr_comparison_diagnostic_test.py`.
- Rust ACR golden image tests and Apple baseline/slider ACR image matrices are
  preserved here as noncompiled text. Cargo's unused `golden` feature is removed.
- New writes through the obsolete `color_harness` recorder are rejected.
  Historical capability records are not current Auto JPEG qualification.
- Independent solver mathematics, synthetic image invariants, Maple UI goldens,
  sensor/decode tests, CPU/GPU parity and lens geometry tests remain active.

Current source37 embedded-JPEG result remains4pass,12fail,4no-preview. The
next processing work diagnoses those12 failures, without changing version37,
AgX, JPEG tolerances or original input bytes. This PR remains draft/unmerged.
