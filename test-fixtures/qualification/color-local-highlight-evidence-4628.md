# Local highlight witness weighting — #4628

## Scope

This unreleased candidate extracts the local highlight correction from the
preserved repair branch. It follows the isolated AMaZE, Bayer GainMap, lens
sampler and sharpening candidates. It is not yet ready for a PR or merge;
output/cache version integration, complete corpus and platform/performance
qualification remain open. Known broader failures are retained.

The current AMaZE control reproduces the original issue's Canon 5D Mark III
failure at the same location. Neutral has three pixels above its maximum
ceiling; Auto has two. Main passes both. Disabling false-color suppression
still fails both, so that diagnostic was rejected.

At this edge, local highlight reconstruction imports blue from witnesses
whose surviving R:G ratio differs from the target. The existing wider gather
already discounts such witnesses. Tier 1 now reuses that same weight and
constant, normalizing the weighted ratio by its total weight. Observation
count continues to control confidence: the earlier summed-weight confidence
candidate had regressions and is not reintroduced.

Known channels, unclipped pixels, original RAW/XMP/reference bytes, numerical
budgets and scene range remain unchanged. This camera-prefix stage is shared
by CPU and GPU preparation; there is no separate WGSL recovery implementation.

## Evidence

- 46 focused highlight tests pass, including independent mixed-color and
  uniform-ratio predictions, all channel permutations, exposure scaling and
  exact preservation of known channels/unclipped pixels.
- Canon baseline uses all 10,668,000 pixels per comparison with the frozen
  native-pair protocol and original Adobe renders:

| Profile | Main max ΔE2000 | AMaZE control | Candidate | Ceiling |
| --- | ---: | ---: | ---: | ---: |
| Neutral | 43.733914 | 44.985179 | 43.287535 | 44.1 |
| Auto | 38.548472 | 39.346701 | 37.946625 | 39.0 |

Both candidates pass every metric, with unchanged input hashes.

Six further controls also pass every unchanged budget: test_0000 baseline,
test_0012 exposure_min, and test_0015 contrast_min, exposure_max, tint_min and
whites_min. This confirms that the earlier Pixel repairs remain effective
with the new highlight stage. It is eight targeted comparisons, not a
whole-corpus or performance pass. Original inputs and executables remain
unchanged after each run.

The exact source patch, frozen binary, hashes, test logs and per-case metrics
are in `/Volumes/Projects/maple-color-gate-20261015/local-highlight-evidence-isolated/`.
The first frozen runtime is the sharpening parent `12c83e7a31` plus the saved
highlight patch; the later synthetic-golden update only changes tests/data.
