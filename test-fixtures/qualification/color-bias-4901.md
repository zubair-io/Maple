# Physical color gate count rise — #4901

The reported increase from 92 to 118 budget breaches is attributable to the
RGB-bias accumulator correction in `fff1e1a0c9` (#4667). That change computes
the mean of the same normalized pixel residuals with float64 accumulation
instead of float32. The 26 newly failing cases expose color differences that
the old reduction understated; reverting the correction or raising budgets
would conceal them. This is an attribution of the **count rise**, not a claim
that the physical color gate is green.

## Retained run comparison

The owner retained the complete before logs at
`~/Desktop/maple-color-tests/4685/color_pipeline_before.log` (base
`efa6f0dd9b`) and `~/Desktop/maple-color-tests/4730/color_pipeline_before.log`
(base `551dc505d7`). Both compare 806 rows. A read-only parse of every
`PASS`/`FAIL` row finds the same fixture, case and population in both runs.
Every printed mean, p95 and max ΔE2000 is identical; 26 verdicts switch from
PASS to FAIL and none switch back. The breakdown is:

| Pass | Before | After | Newly failing cases |
| --- | ---: | ---: | --- |
| Neutral | 76 | 77 | `test_0002/wb_tungsten` |
| Auto baseline | 0 | 0 | None |
| Full-resolution detail | 16 | 41 | 10 each in `test_0005` and `test_0012`; 5 in `test_0014` |
| Total | 92 | 118 | 26 |

The complete parsed comparison is retained at
`/tmp/maple-orchestration/logs-4901/retained-log-row-comparison.json` on the
validating machine. Its 26 case IDs are all among the previously hash-audited
new float64-bias breaches described below. The audit has one additional new
case, `test_0011/wb_tungsten`, which was already failing another limit in these
later runs. It also has one formerly false breach that cleared in the older
corpus; no verdict clears between these two retained logs.

In `efa6f0dd9b..551dc505d7`, the canonical gate's rendering code, CLI,
script, and budgets did not change. The comparator's only calculation change
is `fff1e1a0c9`: full-frame, ROI, and tonal-zone signed RGB residuals use
`mean(..., dtype=np.float64)`. The other commits in this interval change
Adobe reference-authoring helpers, platform code and API behavior, but do not
alter the canonical gate's Rust render or ΔE2000 calculation. Its untracked
physical reference files are outside that Git diff.

## Same-pixel causal control

The independent #4667 frozen v43 audit at
`/Volumes/Projects/maple-color-gate-20261015/bias-accumulation-audit/full-v43-bias-rescore/`
rescored **the same pixels** with the old float32 and corrected float64 bias
reductions. Its `identity.json` records 806 comparisons, 2,954 verified input
files, 796 verified candidate files, and `changed_inputs: []`. Its
`summary.json` records 73 old versus 99 corrected breaches: 27 newly exposed
failures and one false failure cleared. All 26 newly failing IDs in the two
retained logs are contained in those 27 independently rescored cases.

For this investigation, the archived SHA-256 digests were checked again for
all 26 relevant candidate and reference pairs: 52 files, 3,074,605,770 bytes,
zero mismatches. The archived `summary.json` SHA-256 is
`d2a3db5087dde44b5234445a93a3f5f687fb1800726f6feec5c00c2851d2762f`;
the `input-hashes.json` SHA-256 is
`29022fbe4a238fa284a1b56a54bb0e45821a061655aa2288546bead46c9c1ca0`.
The #4667 qualification also compares the corrected bias against an
independent integer-pixel residual sum, within 1.15e-8 for physical controls.

The original #4685 and #4730 candidate PNGs and their input hashes were not
retained. Thus their exact bytes cannot be cryptographically matched to each
other or to the frozen v43 audit. The 806 identical printed perceptual rows,
the 26 matching case IDs, the source interval, and the hash-verified
same-pixel counterfactual support the accumulator as the cause of the
**reported verdict increase** without asserting unrecorded input identity.

The float64 metric and existing one-way budgets remain in force. #4405
already tracks the broader physical color failures (scope widened from the
Sony baseline to the 92-breach gate); #2333 and #4665 cover related reference
and camera-color qualification. Those failures require separate pixel or
reference repair and a new full physical gate, not a budget increase here.
