# Preserve passing RGB checks without discarding useful color fits — #5000

The initial RGB-selection experimentf34e22e324 fell back to a worse prior when a candidate could not reduce an already-failing RGB metric. Its full physical run retained5JPEG passes but introduced21newqualitysubcheck failures versus cleaned6424ae59. That experiment remains explicitly rejected and preserved separately.

Constrain candidate selection so a currently passing display RGB p95/region metric cannot cross the unchanged0.10/0.05limits. Keep all original native RGB and perceptual mean/tail/local guards. Already-failing metrics still fail the independent physical gate; there is no acceptance waiver or budget change. Backtracking must meet all additional passing-metric safeguards.

71Auto unit tests pass(6existingignored), including independent new RGB-tail/local failure witnesses and a correction that improves native/perceptual safeguards while an already-failing RGB tail increases.7sensor-gain tests also pass after correcting absolute image-plane indexing; actual corpus maps are allplane0, so that API fix does not alter their gains. Full20fixture physical qualification, every subcheck, all16visuals, parity and banding follow under a separate immutable binary. Keep NeutralAgX, versions37/7, source bytes and comparison geometry unchanged. Draft5003only; do not merge.

## Completed full physical checkpoint — still unaccepted

Renderer4cfbe38812:5JPEG passes(0002,0004,0009,0013,0014),11failures,4exact Auto==Neutral missing-preview fallback passes,0errors. All20RAW hashes, all16embedded-reference PNG hashes and the frozen executable hash match their recorded identities. See `verification.json` and `all-fixtures.md`. This clears4previously failing cases versus the original strong baseline1pass/15fail; it does not clear4of the old12signed-bias failures.

No new display-quality subcheck breaches versus the clean ed6424ae59checkpoint. Comparing every family also exposes2newsubcheck breaches in0011: native absolute B error in reference luma band3 and legacy signed G bias in0.50–0.75. The current candidate remains unaccepted; an already failing image is not a waiver for those regressions. The initial broader guard's18new0015displaybreaches and3new0003displaybreaches are removed.

71Auto tests(sixexistingignored),7sensor-map tests including native/tile parity,8real-RAW host/cache checks,7GPU LUT parity checks,5unchanged-budget banding ramps and33unchanged Python harness tests pass. Physical failures remain authoritative. Next correct0011's bright-band selection, then the remaining11image-quality failures, preserving every limit and all source bytes. Geometry policy remains pending; no comparison registration or lens default changed. No merge, no ready-for-review, no version bump.

All16original/candidate/embedded-JPEG comparisons were visually inspected across4contact sheets.0015still has flat foreground contrast;0017still looks faded;0005has a partial sky/color improvement but remains failed. `visual-review.json` records that review.
