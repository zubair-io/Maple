# Auto curve continuity and residual regularization — #4636

## Defect and correction

The unchanged physical banding gate failed the legacy Auto1 neutral ramp:
maximum second difference 0.00474838 against a 0.004007 ceiling. An instrumented
control localized a slope discontinuity at a 32-anchor piecewise-linear curve
knot. The residual LUT amplified that discontinuity. Default Auto2 and the other
89 comparisons passed.

The shared CPU, GPU reference and WGSL curve evaluators now use monotone cubic
Hermite interpolation with harmonic-mean knot tangents. The fitted anchors,
endpoints, monotonicity and 220-float serialized layout are retained. Curve
interpolation alone reduced the measured spike to 0.00412771, still over budget.

Auto1 fitting also regularizes its residual field while conserving the weighted
correction. Effective confidence follows
the existing sample-count damping, masked smoothing and gamut feather. Dividing
by that confidence recovers an unchanged value for a uniform observed residual.
Adjacent supported cells exchange equal-and-opposite correction mass with the
existing quarter weights. This preserves the sample-weighted correction, retains
the established fade for uniform observations, and leaves empty cells at identity.
Independent analytic tests cover conservation, varying counts/confidence, thin
support, constant corrections and component bounds.

The additional work runs during cached fitting. Runtime LUT sampling remains
tetrahedral; the Auto2 fitter and Auto default are unchanged. Pipeline output
version **34** and Auto-fit model version **6** invalidate earlier artifacts.

## Rejected alternatives

- Cubic runtime LUT sampling passed banding but introduced default Auto2 color
  failures and added GPU work.
- Ordinary post-feather smoothing passed banding but introduced three per-band
  preview-bias breaches across two fixtures.
- Count-conservative smoothing passed photo controls but increased the existing
  synthetic boundary spike to 0.0884006, above its 0.0843 limit.
- Accounting for gamut confidence alone reduced that spike to 0.08596611 and
  still failed. Propagating the existing count confidence as well preserves the
  original boundary response and passes the unchanged test.

No rejected variant, reference change, skipped failure or raised budget is part
of this repair.

## Qualification

| Check                                    | Result                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Physical banding sweep                   | 90/90 passed; Auto1 neutral spike 0.00345656 < 0.004007                                                                       |
| Full raw-core library                    | 2,810 passed, 100 existing fixture-gated ignores; repeated after the helper split and version update                          |
| Full raw-gpu library on Metal            | 286 passed, four existing ignores                                                                                             |
| Full raw-wasm GPU-enabled native library | 72 passed, eight existing ignores                                                                                             |
| Full raw-ffi library                     | 258 passed, one existing ignore                                                                                               |
| Auto1 embedded-preview controls          | No new per-band RGB-bias breaches across all 16 usable previews                                                               |
| Canonical baseline ACR comparisons       | 39/40 passed; all 20 default Auto comparisons passed; one inherited Sony Neutral bias failure remains                         |
| Source and input identities              | Five candidate source files and two banding inputs unchanged; all 20 preview RAWs and 100 canonical baseline inputs unchanged |

The final release build after the helper split and cache-version update reproduced
all five qualified Auto1 ramp measurements exactly. Its 24 recorded changed-file
hashes and both physical input hashes remained unchanged during that check.

The preview check retains its original absolute 0.05 per-band RGB threshold.
Six existing failing fixtures remain: test_0000, test_0005, test_0011, test_0012,
test_0015 and test_0017. Four fixtures have no usable embedded preview and are
explicitly unqualified for that comparison. This is a no-regression result,
not a claim that the entire preview-bias suite passes.

The canonical baseline gate still exits **1** for test_0011 Neutral. Its inherited
RGB bias is not waived. The full physical color corpus and the separate live
GPU white-balance parity repair remain required before the overall repair lands.
No RAW, authored XMP, Adobe reference, numerical budget or required case changed.

## GPU timing

Three interleaved control/candidate pairs measured actual GPU completion with
resident buffers and four warm-up iterations. Each variant has 36 recorded
samples at each size:

| Size        | Prior evaluator median | Hermite median |
| ----------- | ---------------------: | -------------: |
| 1500 × 1000 |               1.608 ms |       1.585 ms |
| 1920 × 1280 |               1.624 ms |       1.580 ms |

These shared-machine measurements use a debug host and show no clear stage
regression. They do not qualify the complete editor's 16 ms target or 50 ms hard
limit. There is no new per-tick allocation or WASM round trip in this change.

The source patches, logs, frozen binary identities and comparison ledgers are
retained in the task's `auto1-support-conservative-*` and
`auto1-hermite-curve-performance` qualification archives. Earlier rejected
experiments are retained separately so their passing subsets cannot be mistaken
for production qualification.
