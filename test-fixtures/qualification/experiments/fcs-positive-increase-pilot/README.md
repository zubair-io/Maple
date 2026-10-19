# Selective positive-chroma guard trial

Experimental patch, not adopted yet. The complete source-35 suite exposed 29 new failures. Matched frozen controls attribute 16 to the green-support guard and 13 to the camera prefix.

The chart witness is a Bayer sample beside a thin chroma feature. Reconstructed green is below both directional means, but measured red neighbors support an increase in reconstructed red. The unconditional guard prevents that increase and creates a dark artifact.

This patch retains measured-value increases while guarding positive-chroma reductions when green lacks support. Negative-collapse behavior, all existing thresholds, all original assertions and all physical inputs are unchanged. A new phase/exposure regression fails the original implementation; all 28 AMaZE tests pass with the trial. The first physical chart target now passes.

A 91-case cohort is running: the prior 58 controls plus every newly failing or cleared source-35 case. No complete-cohort or full-suite pass is claimed. Exact patch, driver, unit logs and source-35 chart trace samples are preserved here.
