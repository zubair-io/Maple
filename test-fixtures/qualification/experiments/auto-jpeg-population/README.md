# Auto population weights — #5000

Integer sampling cells represent unequal target pixel counts in all 16 corpus photographs. Each observation now carries its represented target-cell area, used in fitting normal equations, projection confidence, native heldout moments, native luminance-band absolute/signed errors, display regional moments and weighted empirical p95 selection. Sample-count coverage guards remain sample counts. The empirical percentile rank is the original floor(N×0.95), applied to represented pixel population without expanding it.

89 Auto unit tests pass (six existing ignored), including explicit population repetition as independent solver/selection/quantile oracles, exact full-target population coverage, large-cell tail/band regressions and rejection of sparse coverage despite huge weights. Release build succeeds. All original quality limits, original native/display observations, Neutral AgX, output version37 and fit version7 remain.

Physical all20 suite, host/GPU/banding and visual qualification pending. Latest previous complete checkpoint remains5JPEGpasses/11failures/4exactfallbacks/0errors. This is incremental work in draft#5003; no merge authorized.
