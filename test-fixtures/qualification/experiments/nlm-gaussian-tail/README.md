# Gaussian-tail NLM candidate

The normal Panasonic exposure witness preserves its measured blue sensor sample. At color NR, its a component has finite weights while all48 b-component weights are discarded by the x>=8 lookup cutoff. The actual smallest b exponent is8.12594. The full Gaussian neighbor sum is0.00077313, which is significant after normalization. Retaining the tail changes the discontinuous identity fallback.

The candidate keeps the existing lookup below8, uses hardware exp above8 until natural f32 underflow, and mirrors this in scalar, ARM64, wasm SIMD and WGSL paths. No filter strengths, original image settings or physical error budgets change. Three CPU witnesses and one GPU witness fail the old implementation;20 CPU NLM,22 GPU NR,10 caller NR tests and composed CPU/GPU parity pass with the candidate. Two existing GPU benchmarks remain ignored.

Tests that demanded the old exact-zero cutoff now demand the Gaussian tail or its independently derived normalized mean. Existing error bounds remain unchanged; the f64 reference no longer copies the cutoff. The initial obsolete-expectation failure is retained alongside the corrected passing run.

All5opposing physical anchors and all20Auto baselines pass. Of25focused comparisons, two source36failures clear and no new failure appears; fixture15dehaze bias remains. This does not establish a whole-corpus count. See ../../color-suite-5000-nlm-tail-focused.json and its25-record JSONL ledger.

Method: [Buades, Coll, Morel: Non-Local Means Denoising](https://www.ipol.im/pub/art/2011/bcm_nlm/revisions/2011-09-13/bcm_nlm.htm), normalized weights and max-neighbor center weight. No external implementation code was copied.
