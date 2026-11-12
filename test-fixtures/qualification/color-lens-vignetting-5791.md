# Lens vignetting and the embedded-JPEG gate — #5791

## Finding

Maple's default lens correction applies the bundled Lensfun vignetting
calibration as a full flat-field gain (2.30× at the corners of test_0006 and
test_0007, 1.59× on test_0008, 1.69× on test_0012). The gain is correct, but
the embedded previews that Auto fits to and the gate compares against do not
all carry it. On main the fit develops at the full gain, so a preview without
it makes the fitted tail darken the whole frame to cancel the bright corners.
On test_0007 that leaves the centre too dark and the corners too bright, with
8 corner-tile breaches. With #5802's declared lossy-DNG transfer, test_0006
behaves the same way (9 breaches). Metadata cannot settle the question:
test_0007's maker notes say in-camera peripheral correction was on, yet its
Adobe-rendered preview carries none of it.

## Policy

This implements option (a) from the issue. #5791 asks the owner to choose
between options (a), (b) and (c); that decision is not recorded yet, so the PR
refers to the issue rather than closing it. Option (a) changes what the
embedded-JPEG gate measures: it no longer scores the default render, it scores
a render at the vignetting scale the renderer measures from each RAW's own
preview. The default render's own numbers are kept below as tracked evidence.

`view::auto_profile::preview_vignetting` measures how much of the bundled gain
each RAW's embedded preview carries. With `Y` the scene luminance a sensor
cell recorded and `g` the bundled gain there, a preview carrying share `s` is
`F(ln Y + ln(1 + s·(g − 1)))` for one tone response `F`. That is the linear
blend `lens_profile::apply` develops a share with, so the share is weighed the
way it is applied. The reading is the share, in steps of 0.05, under which
preview luma is most nearly a function of that sum. It is measured once, on
the preview as extracted: every fit entry measures before the GPU proxy fit
shrinks the preview, so the CPU render, the proxy fit, `maple-cli inspect` and
the gate flag read the same scale. It stays at the full correction unless another
share explains the preview at least 1% better (`DECISIVE`). Auto's fit develops
at the measured scale. The render still applies the user's scale (default
100), so lens correction is unchanged for the user. The embedded-JPEG gate
renders with `--preview-lens-vignetting`, at the renderer's own measured scale.
The gate chooses nothing per fixture, fits nothing, and changes no budget or
threshold.

## Readings (`maple-cli inspect`, candidate binary)

The first version of this change weighed `F(ln Y + s·ln g)`, a power law
`g^s` that agrees with the develop's linear blend only at `s = 0` and
`s = 1`. With the linear-blend key, test_0012 reads 30 instead of 35. The other
three read 0 or 5 as before. At those shares both keys order the cells almost
identically, so their scatters are unchanged to six digits.

| Fixture | Preview | Reading | Scatter at reading | Scatter at full gain | Margin |
| --- | --- | ---: | ---: | ---: | ---: |
| test_0006 | Adobe DNG Converter (LinearRaw) | 0 | 0.000400 | 0.000688 | 72% |
| test_0007 | Adobe DNG Converter | 5 | 0.000423 | 0.000739 | 75% |
| test_0008 | Fujifilm X-T3 camera JPEG | 0 | 0.002669 | 0.002759 | 3.4% |
| test_0012 | Fujifilm GFX 50R camera JPEG | 30 | 0.001793 | 0.001938 | 8.1% |

No other fixture has a bundled vignetting calibration, so none is read and
their renders are unchanged. The Python prototype read 0.05, 0.00 and 0.45 for
test_0007, test_0008 and test_0012; production agrees on the first two and
reads 0.30 on test_0012. The smallest production margin is 3.4%. The largest
spurious margin seen when the full gain was synthetically injected was 0.3%.
The 1% threshold sits between them and is kept.

### No real negative control

The "stays at 100" branch has no real witness: no available RAW has an
embedded preview that carries the full bundled gain over a gain spread wide
enough to weigh. `maple-cli inspect` was run on all 30 RAWs under
`test-fixtures/raws` (every top-level fixture, `_stray`, and the first frame of
each `pano_0N` set) and on the 17 RAWs stored locally (not iCloud
placeholders) under `~/Desktop/maple-color-tests` and `~/Desktop/Test` on the
qualification machine:

- Only test_0006, test_0007, test_0008 and test_0012 have a bundled vignetting
  calibration, and all four read decisively below the full gain.
- Three Nikon D810 NEFs with the AF-S Nikkor 50mm f/1.4G at f/8 have one and
  were shot with in-camera Vignette Control at Normal, so their camera JPEGs
  are the closest candidates. `inspect` prints no reading for them, so `read`
  found nothing to weigh: the gain spread at f/8 is under 5%, or too few cells
  are usable.
- Every other RAW either has no bundled vignetting calibration, or carries
  embedded `OpcodeList3` corrections, which are never weighed.

Synthetic full-gain previews still read 100, including the X-Trans and rotated
cases (`preview_vignetting_tests.rs`).

## Embedded-JPEG gate, all fixtures

Base: main `13c4b98339`. Candidate: this branch at the review-fix commit
`ebdf9248fd` (`maple-cli` built with `--features stage-dump`, sha256
`f20c1232…6d455caa`), all twenty fixtures re-run in one
`MAPLE_CLI=<binary> src/scripts/test_color_pipeline.sh` pass. The first
commit's candidate (`17b4507955`) gave the same row on every fixture except
test_0012, which read 35 and scored 1.596 / 5.187 / 0.0128 / 0 / 0.0279. The
gate renders the candidate with `--preview-lens-vignetting`. The breach
columns are band / native / other.

| Fixture | Run | Status | mean ΔE00 | p95 ΔE00 | max channel MAE | tile breaches | worst tile MAE | band / native / other breaches |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| test_0000 | main | failed (ramps passed) | 4.204 | 10.752 | 0.0378 | 14 | 0.0582 | 0 / 0 / p95_absolute_channel_error:B, p95_absolute_channel_error:G, p95_absolute_channel_error:R, p95_delta_e_2000 |
| test_0000 | this change | failed (ramps passed) | 4.204 | 10.752 | 0.0378 | 14 | 0.0582 | 0 / 0 / p95_absolute_channel_error:B, p95_absolute_channel_error:G, p95_absolute_channel_error:R, p95_delta_e_2000 |
| test_0001 | main | no-preview | — | — | — | — | — | — |
| test_0001 | this change | no-preview | — | — | — | — | — | — |
| test_0002 | main | passed (ramps passed) | 0.508 | 1.675 | 0.0034 | 0 | 0.0185 | 0 / 0 / 0 |
| test_0002 | this change | passed (ramps passed) | 0.508 | 1.675 | 0.0034 | 0 | 0.0185 | 0 / 0 / 0 |
| test_0003 | main | passed (ramps passed) | 1.383 | 2.856 | 0.0101 | 0 | 0.0209 | 0 / 0 / 0 |
| test_0003 | this change | passed (ramps passed) | 1.383 | 2.856 | 0.0101 | 0 | 0.0209 | 0 / 0 / 0 |
| test_0004 | main | passed (ramps passed) | 1.716 | 5.959 | 0.0117 | 0 | 0.0354 | 0 / 0 / 0 |
| test_0004 | this change | passed (ramps passed) | 1.716 | 5.959 | 0.0117 | 0 | 0.0354 | 0 / 0 / 0 |
| test_0005 | main | failed (ramps passed) | 1.852 | 6.818 | 0.0158 | 6 | 0.0640 | 3 / 3 / 0 |
| test_0005 | this change | failed (ramps passed) | 1.852 | 6.818 | 0.0158 | 6 | 0.0640 | 3 / 3 / 0 |
| test_0006 | main | failed (ramps passed) | 2.396 | 5.918 | 0.0168 | 2 | 0.0607 | 0 / 0 / 0 |
| test_0006 | this change | passed (ramps passed) | 1.380 | 3.783 | 0.0101 | 0 | 0.0225 | 0 / 0 / 0 |
| test_0007 | main | failed (ramps passed) | 2.525 | 6.237 | 0.0253 | 8 | 0.0787 | 0 / 0 / 0 |
| test_0007 | this change | passed (ramps passed) | 1.352 | 3.676 | 0.0098 | 0 | 0.0219 | 0 / 0 / 0 |
| test_0008 | main | passed (ramps passed) | 1.506 | 5.212 | 0.0133 | 0 | 0.0438 | 0 / 0 / 0 |
| test_0008 | this change | passed (ramps passed) | 1.332 | 4.592 | 0.0111 | 0 | 0.0430 | 0 / 0 / 0 |
| test_0009 | main | passed (ramps passed) | 0.963 | 2.198 | 0.0059 | 0 | 0.0125 | 0 / 0 / 0 |
| test_0009 | this change | passed (ramps passed) | 0.963 | 2.198 | 0.0059 | 0 | 0.0125 | 0 / 0 / 0 |
| test_0010 | main | passed (ramps passed) | 1.730 | 4.325 | 0.0171 | 0 | 0.0421 | 0 / 0 / 0 |
| test_0010 | this change | passed (ramps passed) | 1.730 | 4.325 | 0.0171 | 0 | 0.0421 | 0 / 0 / 0 |
| test_0011 | main | passed (ramps passed) | 1.093 | 3.193 | 0.0063 | 0 | 0.0172 | 0 / 0 / 0 |
| test_0011 | this change | passed (ramps passed) | 1.093 | 3.193 | 0.0063 | 0 | 0.0172 | 0 / 0 / 0 |
| test_0012 | main | passed (ramps passed) | 1.948 | 5.357 | 0.0169 | 0 | 0.0349 | 0 / 0 / 0 |
| test_0012 | this change | passed (ramps passed) | 1.586 | 5.171 | 0.0128 | 0 | 0.0278 | 0 / 0 / 0 |
| test_0013 | main | passed (ramps passed) | 1.996 | 4.693 | 0.0208 | 0 | 0.0386 | 0 / 0 / 0 |
| test_0013 | this change | passed (ramps passed) | 1.996 | 4.693 | 0.0208 | 0 | 0.0386 | 0 / 0 / 0 |
| test_0014 | main | passed (ramps passed) | 1.112 | 2.596 | 0.0087 | 0 | 0.0168 | 0 / 0 / 0 |
| test_0014 | this change | passed (ramps passed) | 1.112 | 2.596 | 0.0087 | 0 | 0.0168 | 0 / 0 / 0 |
| test_0015 | main | failed (ramps passed) | 3.933 | 11.907 | 0.0381 | 76 | 0.0965 | 4 / 7 / p95_absolute_channel_error:B, p95_absolute_channel_error:G, p95_absolute_channel_error:R, p95_delta_e_2000 |
| test_0015 | this change | failed (ramps passed) | 3.933 | 11.907 | 0.0381 | 76 | 0.0965 | 4 / 7 / p95_absolute_channel_error:B, p95_absolute_channel_error:G, p95_absolute_channel_error:R, p95_delta_e_2000 |
| test_0017 | main | failed (ramps passed) | 2.392 | 6.392 | 0.0199 | 7 | 0.0735 | 0 / 0 / 0 |
| test_0017 | this change | failed (ramps passed) | 2.392 | 6.392 | 0.0199 | 7 | 0.0735 | 0 / 0 / 0 |
| test_0018 | main | no-preview | — | — | — | — | — | — |
| test_0018 | this change | no-preview | — | — | — | — | — | — |
| test_0019 | main | no-preview | — | — | — | — | — | — |
| test_0019 | this change | no-preview | — | — | — | — | — | — |
| test_0020 | main | no-preview | — | — | — | — | — | — |
| test_0020 | this change | no-preview | — | — | — | — | — | — |

Only the four fixtures with a reading change. Every metric on the other
sixteen is identical. test_0006 and test_0007 now pass. test_0008 and test_0012
improve on mean and p95 ΔE2000, channel MAE and worst tile. The only figure
that rises is test_0008's signed band-bias maximum, 0.0121 → 0.0141 against a
0.05 limit, with no band breach.

## Stacked on #5802

#5802's head (`447d665319`, on `ba58e41de2`) with both of this branch's
commits cherry-picked on top (`maple-cli` sha256 `f41ed7c6…2678abd5`). Only
the fixtures #5802 touches were gated, after the review fix:

| Fixture | #5802 alone (from #5802) | #5802 + this change |
| --- | --- | --- |
| test_0006 | failed, 9 corner-tile breaches, mean ΔE 2.687, p95 6.407 | passed, 0 breaches, mean ΔE 1.369, p95 3.710 |
| test_0007 | failed, 8 corner-tile breaches, mean ΔE 2.532, p95 6.245 | passed, 0 breaches, mean ΔE 1.352, p95 3.676 |

The stacked readings are 0 for test_0006 (scatter 0.000421 against 0.000745
at the full gain) and 5 for test_0007, as before the review fix, so the
stacked rows did not move.

## The default render, scored without the gate flag

The default render keeps the full correction, so the gate flag is what makes
the four calibrated fixtures pass. Without it, the gate scores the render a
user gets by default, and that render is further from the preview than on
main. Same gate, same candidate binary, with `--preview-lens-vignetting`
removed from the runner's render command (main has no flag; its rows are the
base rows above):

| Fixture | Run | Status | mean ΔE00 | p95 ΔE00 | max channel MAE | tile breaches | worst tile MAE | band / native / other breaches |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| test_0006 | main | failed (ramps passed) | 2.396 | 5.918 | 0.0168 | 2 | 0.0607 | 0 / 0 / 0 |
| test_0006 | this change, no flag | failed (ramps passed) | 5.027 | 11.156 | 0.0558 | 66 | 0.1376 | 0 / 3 / mean_absolute_channel_error:R, mean_delta_e_2000, p95_absolute_channel_error:G, p95_absolute_channel_error:R, p95_delta_e_2000 |
| test_0007 | main | failed (ramps passed) | 2.525 | 6.237 | 0.0253 | 8 | 0.0787 | 0 / 0 / 0 |
| test_0007 | this change, no flag | failed (ramps passed) | 4.768 | 10.722 | 0.0558 | 79 | 0.1344 | 0 / 4 / mean_absolute_channel_error:R, p95_absolute_channel_error:G, p95_absolute_channel_error:R, p95_delta_e_2000 |
| test_0008 | main | passed (ramps passed) | 1.506 | 5.212 | 0.0133 | 0 | 0.0438 | 0 / 0 / 0 |
| test_0008 | this change, no flag | failed (ramps passed) | 2.138 | 6.269 | 0.0226 | 8 | 0.0612 | 0 / 0 / 0 |
| test_0012 | main | passed (ramps passed) | 1.948 | 5.357 | 0.0169 | 0 | 0.0349 | 0 / 0 / 0 |
| test_0012 | this change, no flag | failed (ramps passed) | 3.292 | 6.962 | 0.0334 | 33 | 0.0792 | 0 / 0 / 0 |

On main the fit darkens the whole frame to cancel a gain the preview lacks,
which leaves the centre too dark and the corners only partly too bright. With
this change the centre matches the preview and the whole bundled gain shows
in the corners. Whether the gate should score this render or the render at
the preview's own vignetting is the policy decision #5791 leaves to the
owner.

Signed display-luma error (candidate − preview) from `diag.py` on the first
commit, default Auto output without the gate flag:

| Fixture | main, centre → corner | this change, centre → corner |
| --- | --- | --- |
| test_0006 | −0.017 → +0.043 | +0.003 → +0.119 |
| test_0007 | −0.023 → +0.072 | +0.003 → +0.133 |
| test_0008 | −0.010 → +0.039 | +0.002 → +0.062 |
| test_0012 | −0.009 → +0.020 | +0.002 → +0.056 |

On main, the error at the centre is the fit cancelling a gain the preview never
had. The brighter corners after this change are that gain itself: the default
lens correction, which the previews carry 0–30% of.

## CPU/GPU parity

No WGSL changed. The lens gain stays in the shared CPU decode prefix, and the
GPU hosts take the fit from the same raw-core entries, which now develop at
the measured scale. Fixture-gated runs on test_0007, re-run on the review-fix
commit `ebdf9248fd` with the same results:

- `cargo test --release -p raw-wasm --features gpu --lib -- --include-ignored live_matches_refine_within_one_step_on_test_0007 auto_fit_status amaze_fit_matches_cpu_export`:
  5 passed. `amaze_fit_matches_cpu_export_and_discriminates_full` checks the
  GPU fit against the CPU export, and `live_matches_refine_within_one_step_on_test_0007`
  checks the live GPU render against refine.
- `cargo test --release -p raw-core --lib -- --include-ignored cpu_preview_film_tests auto_fit_status_tests preview_vignetting auto_fit_model`:
  13 passed (10 on the first commit; the review fix added three), including
  `actual_auto_status_active_physical_4096` on test_0007.
- `cargo test --release -p raw-core --features test-support --lib -- --include-ignored cpu_preview::film_tests`:
  `inactive_film_metadata_matches_deselected_look_and_retained_ticks`
  (test_0007) passes. `real_default_auto_film_hot_repeat_matches_first_render`
  (test_0017, which has no vignetting calibration) fails at
  `cpu_preview_film_tests.rs:132` both here and on the unchanged base
  `13c4b98339`, so this change did not cause it.

## Cost

Measured as process CPU time (user + sys) for a cold full-resolution
`maple-cli render --profile auto`, median of three runs, base and candidate
interleaved in one session:

| Fixture | main | this change |
| --- | ---: | ---: |
| test_0007 (reading 5) | 30.14 s | 52.91 s |
| test_0003 (no vignetting calibration) | 60.24 s | 60.46 s |

When the measured scale differs from the render's scale, the render buffer is
no longer the fit buffer. A cold CPU render of such a RAW therefore fits from a
second pinned develop. This is the same route an edited model already takes,
and it is sized like the render that asked. RAWs without a bundled vignetting
calibration take no new work. Warm renders hit the RAW-keyed fit cache: the
preview is not extracted and nothing is measured, so slider ticks are
unaffected. GPU hosts already fit from a separate pinned develop, so they pay
only the measurement.
