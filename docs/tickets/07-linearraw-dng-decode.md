# Support LinearRaw DNG decode

## Context

Two fixtures in the color-parity harness — `test_0006.DNG` (Adobe DNG Converter
9.8 from a Canon CR2) and `test_0013.DNG` (iOS 14.3 HDR DNG from an iPhone
12 Pro) — produce catastrophically wrong output: a uniform magenta wash with
+0.69 `bias_B` on test_0006 and +0.29 `bias_R` on test_0013, mean ΔE₀₀ around
50 and 37 respectively. Every other DNG fixture in the suite renders within
the structural-mismatch budget (mean ΔE 8–15).

The investigation in
[`docs/measurement/2026-04-25-color-harness-catastrophic-bias-investigation.md`](../measurement/2026-04-25-color-harness-catastrophic-bias-investigation.md)
(commit `6b83865`) isolates the bug to the LinearRaw decode path. Both
catastrophic fixtures have `PhotometricInterpretation = LinearRaw (34892)` and
`SamplesPerPixel = 3` — i.e. the file already carries demosaiced,
white-balanced, interleaved RGB samples. Every other top-level fixture is
`PhotometricInterpretation = ColorFilterArray (32803)` (genuine Bayer mosaic,
1 SPP).

The same scene through the same camera (test_0006 LinearRaw vs. test_0007 CFA,
both converted from `5G4A9394.CR2`) renders correctly through the CFA path
(mean ΔE 9.5) and is unrenderable through the LinearRaw path (mean ΔE 50.3).
That isolates the bias to the photometric branch — not AgX, not the DCP
matrices, not metadata oddities elsewhere.

The mechanism is two compounding mistakes inside the current decode path:

1. **Wrong CFA fallback.** `decode.rs:130-136` matches `LinearRaw` and silently
   chooses `CfaPattern::Rggb`. A LinearRaw image has no Bayer pattern — the
   data is already in three planes.
2. **Wrong indexing downstream.** `linearize::sensor_linearize`
   (`linearize.rs:8-30`) reads `raw_data[y*w..y*w+w]` (one sample per pixel)
   over an interleaved `[R₀ G₀ B₀ R₁ G₁ B₁ …]` scanline of length `3·w`. It
   reads only the first `w` samples per row, treats them as Bayer, and
   CFA-routes them through the fake RGGB pattern. Every other column lands a
   blue sample in the red channel and a red sample in the green channel.
   Two-thirds of the source rows are never read at all.
3. **Double white balance.** Even if the indexing were correct, `dcp::apply`
   re-applies `AsShotNeutral` on top of a file whose WB was already baked in
   by the converter. The two warm-WB corrections compound and push the blue
   channel sky-high.

The product impact is that any user who imports a LinearRaw DNG into Maple —
which includes Adobe DNG Converter "linear DNG" output and iOS HDR DNGs —
sees their image as a magenta blob. Today the workaround is "don't import
LinearRaw"; the harness gate masked the issue because the budgets are tuned
for structural mismatch, not catastrophic colorimetric failure.

## Proposal

Route LinearRaw photometric-interpretation through a dedicated decode branch
that:

1. **Bypasses demosaic.** The data is already 3-plane RGB. There is no Bayer
   pattern to recover. `linearize` and `bilinear` should not run on this data.
2. **Reshapes interleaved RGB into the working `Image` directly.** For each
   pixel, copy `raw_data[3·k + 0]`, `[3·k + 1]`, `[3·k + 2]` into the R, G, B
   channels of `Image::pixels[k]` after black/white-level normalization.
3. **Skips a second AsShotNeutral application.** When the input is already
   white-balanced, `dcp::profile_for` should treat the input as scene-white
   neutral (or the converter's effective `CalibrationIlluminant`), not as
   raw camera-native space awaiting WB. The cleanest path is a separate
   "developed-RGB" code branch in `dcp` that applies only the forward matrix
   and tone curve, not `AsShotNeutral`.
4. **Honors `LinearizationTable`.** test_0013 ships a 12-bit linearization
   LUT that rawler does apply during decode; verify the post-rawler
   `raw_data` is already linearized and skip the per-pixel linearization in
   `sensor_linearize`. The 8-bit test_0006 case has no LUT.
5. **Honors `Orientation`.** test_0013 has `Orientation: Rotate 90 CW`. The
   existing `apply_orientation` stage runs at the end of the pipeline; verify
   it still receives a correct image dimension after the new branch.
6. **Rejects (loudly) `ProfileGainTableMap`.** test_0013 carries a
   `ProfileGainTableMap` that we do not implement. Returning a clear
   `Error::UnsupportedFeature` is preferable to silently rendering with the
   table ignored. test_0006 does not carry one.

A first cut should land the indexing fix and the AsShotNeutral skip; the
LinearizationTable / ProfileGainTableMap cases can land in follow-ups gated by
the new fixtures.

Implementation sketch:

- Plumb `cpp` (channels-per-pixel) through `RawImage` so `sensor_linearize`
  can branch on `cpp == 1` (Bayer, current behavior) vs. `cpp == 3`
  (LinearRaw, new behavior). Today `cpp` is implicit in the data layout and
  ignored.
- In `decode.rs:130-136`, on `RawPhotometricInterpretation::LinearRaw`,
  attach a new `CfaPattern::None` (or `LinearRgb`) variant and carry it
  through. `bilinear::demosaic` short-circuits on this variant and copies
  channel-major into `Image::pixels`.
- In `dcp::apply`, branch on the same flag: skip the `AsShotNeutral`
  step but keep forward matrix + tone curve.
- Add a new `decode-linearraw` example next to `dump_pixel` for diagnostics.

## Acceptance criteria

- `test_0006.DNG` and `test_0013.DNG` pass `BUDGET=15
  src/scripts/test_color_pipeline.sh` after re-enabling them in the harness
  (the skip added by ticket #07's harness patch is removed).
- The mean ΔE₀₀ for both fixtures is in the same range as the structural
  mismatches in the rest of the suite (≤ 15), and per-channel bias is within
  ±0.05 — the existing default `BUDGET_BIAS`.
- All existing Bayer fixtures (`test_0000`, `_0002`, `_0007`, `_0015`,
  `_0017`) remain green at the current budget. **No budget regression.**
- New unit tests in `raw-core` cover:
  - `decode::open` on a synthetic 3-SPP LinearRaw fixture lays the data into
    `Image::pixels` channel-major (no off-by-one between scanlines).
  - `dcp::apply` with the LinearRaw flag does not multiply through
    `AsShotNeutral` (compare against a hand-computed forward-matrix output
    on a single neutral pixel).
  - `linearize` short-circuits on `cpp == 3` (the function never reads
    `raw_data` past the per-pixel triple).
- `test_0013` rotated output matches the embedded preview's orientation
  (the existing `apply_orientation` stage handles the rotation correctly
  once decode produces a valid image).
- The harness skip (`INCLUDE_LINEARRAW=1`-gated) is removed from
  `src/scripts/test_color_pipeline.sh` in the same commit that lands the
  fix, and the gate documentation in this ticket is updated to "obsolete —
  LinearRaw fixtures now run by default."

## Pointers

- `src/raw-pipeline/raw-core/src/decode.rs:126-140` — current
  `LinearRaw` fallback (the TODO).
- `src/raw-pipeline/raw-core/src/linearize.rs:8-30` — `sensor_linearize`
  loop that assumes 1 SPP scanline width.
- `src/raw-pipeline/raw-core/src/stages/bilinear.rs` — bilinear demosaic
  that should be skipped for LinearRaw.
- `src/raw-pipeline/raw-core/src/dcp.rs` — `profile_for` and `apply`;
  needs the "skip AsShotNeutral" branch.
- `src/raw-pipeline/raw-core/src/raw_image.rs` — `RawImage` struct (where
  `cpp` should be plumbed in).
- `src/scripts/test_color_pipeline.sh` — current LinearRaw skip with the
  `INCLUDE_LINEARRAW=1` override.
- Investigation report:
  `docs/measurement/2026-04-25-color-harness-catastrophic-bias-investigation.md`.

## Notes / risks

- `cpp` plumbing touches `RawImage`, `linearize`, `bilinear`, and `decode`.
  All callers must compile-error on the change so no Bayer code accidentally
  reads 3-SPP data as 1-SPP.
- The "skip AsShotNeutral" branch in `dcp` is subtle. The forward matrix
  expects scene-white-corrected input; a LinearRaw file's "scene white" is
  whatever the converter targeted (D50 for Adobe DNG Converter, often D65 for
  iOS). Confirm the matrix interpolation between calibration illuminants is
  applied with the correct effective input white before the harness budget
  is reasonable.
- iOS HDR DNGs (`test_0013` family) carry semantic-segmentation auxiliary
  channels and `ProfileGainTableMap`. Without the gain-table map we will
  not match Apple's preview pixel-for-pixel; a structural-only ΔE 12–15 is
  the realistic ceiling for this fixture, not 5. That is acceptable as long
  as the magenta cast is gone.
- Adding LinearRaw support also opens the door to importing 16-bit
  scene-linear EXR/HDR sources written via the DNG container (rare but real
  in archival workflows). Those should be tested separately when the
  fixture set grows.
- `RawPhotometricInterpretation::BlackIsZero` (monochrome) remains rejected
  with `Error::UnsupportedCfa`. That is out of scope for this ticket.

## Estimated impact

- Two fixtures (test_0006, test_0013) move from catastrophic-failure to
  inside the standard parity budget. Returns the harness to full coverage
  without recalibrating budgets.
- Unblocks any user importing Adobe DNG Converter "linear DNG" output (a
  common archival format) or iOS HDR DNGs (a common consumer format) into
  Maple.
- Modest code surface: ~150–250 lines across `decode.rs`, `linearize.rs`,
  `dcp.rs`, `raw_image.rs`, plus tests. No public-API change.
- No expected slider-tick performance impact: the LinearRaw branch is
  cheaper than Bayer (no demosaic). Existing CFA performance is unchanged
  because the new branch is only taken for `cpp == 3` inputs.
