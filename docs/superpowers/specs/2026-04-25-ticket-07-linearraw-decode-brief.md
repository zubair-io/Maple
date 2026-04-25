# Ticket #07 — LinearRaw DNG decode (brainstorm brief)

> Source ticket: [`docs/tickets/07-linearraw-dng-decode.md`](../../tickets/07-linearraw-dng-decode.md).
> Investigation: [`docs/measurement/2026-04-25-color-harness-catastrophic-bias-investigation.md`](../../measurement/2026-04-25-color-harness-catastrophic-bias-investigation.md).

## 1. Detect path

Detection lives in the rawler-bridge layer. `decode_bytes`
([`decode.rs:126-140`](../../../src/raw-pipeline/raw-core/src/decode.rs))
pattern-matches `raw.photometric`; the `LinearRaw` arm currently silently
substitutes `CfaPattern::Rggb`. That arm IS the cleanest detection point —
it's the only place rawler's typed photometric enum is visible.

Cleanest carrier into downstream code: a new `image::CfaPattern::LinearRgb`
variant rather than a parallel `bool`. The enum is 4-variant today
(`Rggb`/`Bggr`/`Grbg`/`Gbrg`); a 5th variant turns every `match` on it
into a compile error until handled — exactly the linter we want, given
the bug was a silent fallthrough. `cfa.color_at(x, y)` becomes
unreachable for `LinearRgb`; mark it `unreachable!()` for crash-loud safety.

## 2. Develop chain shape for LinearRaw

`develop_scene_linear_from_raw_with_quality`
([`pipeline.rs:77-134`](../../../src/raw-pipeline/raw-core/src/pipeline.rs))
opens with `linearize::sensor_linearize` + `demosaic::{bilinear,
hamilton_adams, half_res}`. Both are wrong for LinearRaw — the data is
already 3-plane RGB. New branch at the top of the function:
`match raw.cfa { LinearRgb => linearize::linearraw_to_camera_rgb(raw), _
=> existing-path }`. The new helper produces a `CameraNativeLinearRgb`
`Image` directly — skipping the mosaic — by reading interleaved
`[R₀ G₀ B₀ R₁ G₁ B₁ …]` `raw_data` (length `3 · w · h`) and copying triples
into `Image::pixels[k] = [R, G, B]` after black/white-level normalization.
The rest of the chain (`baseline_exposure` onward) runs unchanged because
its input contract is "post-demosaic camera-native RGB" — exactly what the
new helper produces.

## 3. WB handling

Investigation § 4 confirms LinearRaw's `camera_rgb` is already roughly
neutral on a gray patch — the converter baked AsShotNeutral in. `dcp::apply`
then re-applies it through `inv(CM) · AsShotNeutral` Bradford math, which
produces the magenta wash.

Fix: a `DcpProfile::wb_already_baked: bool` flag set during `profile_for`
when `raw.cfa == LinearRgb`. `interpolated_profile` and the single-CM
fallback both compute `scene_white_xyz = inv(CM) · (1, 1, 1)` instead of
`inv(CM) · as_shot_neutral` when the flag is set. `apply` itself doesn't
need to branch — it already consumes `scene_white_xyz`. Setting
`as_shot_neutral` to identity at the decoder boundary also works but
loses metadata; the flag preserves it for XMP round-tripping.

## 4. Color profile

`ColorMatrix1`/`ColorMatrix2` and (when present) `ForwardMatrix1`/
`ForwardMatrix2` populate the same `raw.color_matrices` HashMap regardless
of photometric interpretation; `dcp::profile_for` and `dcp::apply` already
handle dual-illuminant interpolation correctly. Once §3's
`wb_already_baked` flag plumbs through, both the forward-matrix path
([`dcp.rs:96-99`](../../../src/raw-pipeline/raw-core/src/color/dcp.rs))
and the no-FM Bradford path ([`dcp.rs:101-115`](../../../src/raw-pipeline/raw-core/src/color/dcp.rs))
compose identically — only the "neutral camera reading" changes from
`as_shot_neutral` to `(1, 1, 1)`.

## 5. Test fixtures

`test_0006.DNG` (Adobe linear DNG of CR2) and `test_0007.DNG` (CFA DNG of
the same CR2) are the natural control pair — same scene, same body, same
AsShotNeutral. test_0007 currently passes at mean ΔE 9.5; test_0006
should land near the same number when LinearRaw decode is correct.
test_0013 (iPhone HDR DNG, 12-bit, with a `LinearizationTable` rawler
applies during decode) is the second target. No new fixtures needed.

## 6. Acceptance criteria

`BUDGET=25 src/scripts/test_color_pipeline.sh` passes both LinearRaw
fixtures, with all four metrics under budget (mean ≤ 25, p95 ≤ 50, max ≤
100, abs bias ≤ 0.05). The 25 budget — looser than the Bayer 15 — accounts
for (a) test_0013's `ProfileGainTableMap` we don't implement (deferred
per ticket § Notes) and (b) test_0006's 8-bit-per-channel quantization
giving the converter latitude in the bake-in. **No regression** on the
five Bayer fixtures at the existing BUDGET=15. A milestone-gate ratchet
(retighten LinearRaw to 20, then 15) lands as a follow-up once the
ProfileGainTableMap support exists.

## 7. Out of scope

- **16-bit-per-channel LinearRaw** (rare archival DNGs). Code path likely
  works but not exercised by current fixtures.
- **Non-RGB color spaces in LinearRaw** (e.g. CMYK-interpreted DNG). Reject
  with `Error::UnsupportedCfa`.
- **DNG enhanced color encoding** (`PhotometricInterpretation = 51177`).
  Separate ticket.
- **`ProfileGainTableMap`** (test_0013 carries one). Reject loudly per
  ticket § 6 OR accept the residual ΔE — pick "accept" for a v1 land,
  reject in a follow-up that gives us implementation parity with Apple.
- **Monochrome `BlackIsZero`** — already rejected, unchanged.

Plan: [`2026-04-25-ticket-07-linearraw-decode.md`](../plans/2026-04-25-ticket-07-linearraw-decode.md).
