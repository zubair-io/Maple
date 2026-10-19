# Preserve passing RGB checks without discarding useful color fits — #5000

The initial RGB-selection experimentf34e22e324 fell back to a worse prior when a candidate could not reduce an already-failing RGB metric. Its full physical run retained5JPEG passes but introduced21newqualitysubcheck failures versus cleaned6424ae59. That experiment remains explicitly rejected and preserved separately.

Constrain candidate selection so a currently passing display RGB p95/region metric cannot cross the unchanged0.10/0.05limits. Keep all original native RGB and perceptual mean/tail/local guards. Already-failing metrics still fail the independent physical gate; there is no acceptance waiver or budget change. Backtracking must meet all additional passing-metric safeguards.

71Auto unit tests pass(6existingignored), including independent new RGB-tail/local failure witnesses and a correction that improves native/perceptual safeguards while an already-failing RGB tail increases.7sensor-gain tests also pass after correcting absolute image-plane indexing; actual corpus maps are allplane0, so that API fix does not alter their gains. Full20fixture physical qualification, every subcheck, all16visuals, parity and banding follow under a separate immutable binary. Keep NeutralAgX, versions37/7, source bytes and comparison geometry unchanged. Draft5003only; do not merge.
