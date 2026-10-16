# RGB bias accumulation precision — #4667

The comparator now accumulates signed RGB residuals in float64 for the full
frame, ROI and tonal zones. Pixel normalization remains float32; reference
selection, resizing, perceptual metrics, pixel populations and budgets are
unchanged. This is a measurement correction, not a rendering change.

## Isolated PR qualification

This fix is extracted onto `main` at
`22f686ec07e2671912f48a2eca4c56d8aa6566c1`. Only the comparator, its regression
tests and this report change; the other color-repair commits are absent.
All **11 comparator tests**, **six primaries self-checks** and **nine
qualification-accounting tests** pass on this branch. Both new regressions
fail when run against that exact base's comparator. Ruff and file-budget
headroom checks pass. Regeneration with `tools/codegen.sh` changes no files.

The physical audit below records frozen candidates from the broader
investigation; its 99 failures are not a fresh rendering result for this PR
or a count for current `main`. This PR neither changes rendering code nor
claims that the remaining physical color failures are resolved.

## Reproduction

For candidate RGB 128 and reference RGB 127, the normalized float32 residual
is 0.003921598196029663 in each channel. Repeating that same residual should
not change its mean. The previous interleaved float32 reduction reports:

|     Pixels |    Previous bias |   Corrected bias |
| ---------: | ---------------: | ---------------: |
|          1 | 0.00392159819603 | 0.00392159819603 |
|  1,000,000 | 0.00390923069790 | 0.00392159819603 |
| 10,668,000 | 0.00390652986243 | 0.00392159819603 |

A second 512×512 test repeats two signed residuals in separate spatial
blocks. The previous sum reports 0.00098049768712 instead of the two-value
oracle's 0.00196078419685. Reversing the row order is also covered.

Both new image-based regressions fail against the original comparator and
pass after the precision change. The repetition test covers full-frame,
masked ROI and tonal-zone statistics. All 14 comparator tests, six primaries
self-checks and nine qualification-accounting tests pass. Ruff and the file
budget check pass; the two existing large Python files remain below the
570-line headroom limit.

## Physical controls

The complete comparator ran before and after the change against five frozen
v43 native candidate/reference pairs: four matched Lanczos reductions and
one full-resolution, 51,121,152-pixel Fuji case. All non-bias metrics are
bit-identical. A separate integer sum of the quantized RGB pixel differences
agrees with the new bias within 1.15e-8, the retained float32 normalization's
rounding error.

| Case                          | Previous RGB bias              | Corrected RGB bias             | Fixed limit | Result                             |
| ----------------------------- | ------------------------------ | ------------------------------ | ----------: | ---------------------------------- |
| test_0006 baseline            | +.015265 / +.016205 / +.029318 | +.015015 / +.015763 / +.028288 |       .0289 | False blue-bias breach clears      |
| test_0011 baseline            | +.040217 / +.033569 / +.030776 | +.040363 / +.033896 / +.031451 |       .0113 | Still fails all channels           |
| test_0002 wb_tungsten         | -.347829 / -.207601 / -.114309 | -.394626 / -.218589 / -.105976 |       .3882 | False pass becomes red-bias breach |
| test_0011 wb_tungsten         | +.044842 / -.007192 / +.034516 | +.045070 / -.007508 / +.034857 |       .0450 | False pass becomes red-bias breach |
| test_0012 nr_color_min (full) | +.106436 / +.072676 / +.032708 | +.142862 / +.068580 / +.033592 |       .1222 | False pass becomes red-bias breach |

Input, candidate and reference hashes are unchanged for these controls.
They do not establish a complete physical color-gate pass.

## Complete-corpus bias audit

All 806 frozen v43 comparisons were rescored for bias. Every old bias verdict
reproduced before the precision correction. The corrected count is **99
failures**, compared with the old count of 73: one false failure clears and
27 false passes become failures. All 2,954 original inputs and 796 candidate
files were hash-verified before and after the audit; none changed.

| Profile                | Comparisons | Previous failures | Corrected failures |
| ---------------------- | ----------: | ----------------: | -----------------: |
| Neutral                |         606 |                62 |                 63 |
| Auto                   |          20 |                 0 |                  0 |
| Full-resolution detail |         180 |                11 |                 36 |
| Total                  |         806 |                73 |                 99 |

The newly exposed failures are tungsten white balance on test_0002 and
test_0011, ten detail cases each on test_0005 and test_0012, and five detail
cases on test_0014. The cleared failure is test_0006 Neutral baseline.

This audit recomputes both bias reductions from identical frozen pixels and
retains the original non-bias verdicts. It is not a fresh render or a complete
perceptual rerun. The unmerged v46 camera-color candidate requires separate
full-corpus qualification with the corrected comparator. Budgets remain
unchanged, including limits that now expose previously hidden failures.

## Evidence

Archive: `/Volumes/Projects/maple-color-gate-20261015/bias-accumulation-audit/`.

- `constant-field-reproduction.json`: repeated-pixel numerical reproduction.
- `regressions-before.log`: both regressions fail the original comparator.
- `comparator-tests-formatted.log`, `primaries-self-test-formatted.log`,
  `accounting-tests.log`: successful corrected-source tests.
- `physical-paired-comparator.json`: both full comparator runs, independent
  integer-pixel oracle, unchanged perceptual metrics and input hashes.
- `physical-false-pass-comparator.json` and
  `physical-additional-false-passes-comparator.json`: three additional
  before/after controls, including the 51MP full-resolution case.
- `physical-paired.log`: first diagnostic attempt failed to locate the
  archived comparator's relative authoring validator; the corrected-path
  log records the completed run. No comparison result came from that failure.
- `full-v43-bias-rescore/`: identities and per-comparison audit records.

No RAW, sidecar, reference, budget or rendering output version was changed
for this correction. The unmerged camera-color candidate in the same checkout
is separate work under #4665 and #4661.
