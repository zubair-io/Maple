## Sony Neutral: scene-anchor and fixed-AgX attribution

This note records diagnostic results from the Sony Neutral investigation. It is historical attribution evidence, not a production fix, a reference replacement, or a passing color-baseline claim. The probes are read-only with respect to their source RAW, sidecar, references, and budgets; output files go only into a new directory selected by the caller.

### Findings

The Sony baseline parsed as Neutral with auto-exposure **On**, exposure 0, and contrast 0. The canonical scene anchor was **2.891351× (+1.531744 EV)**. Auto uses a different documented path: its preview-fit tail owns brightness and disables this anchor.

| Neutral setting | Mean ΔE2000 | p95 | max | RGB bias |
| --- | ---: | ---: | ---: | --- |
| Existing anchor On | 5.63790 | 19.56266 | 34.81105 | +.037830 / +.031536 / +.031179 |
| Existing anchor Off | 6.67832 | 12.03663 | 30.62613 | −.079207 / −.086949 / −.089536 |

Both native renders were 9504×6336. The comparator was `baseline-native-pair-lanczos`; the .0113 bias ceiling was unchanged. On was pixel/metric-identical to the prior control. Turning Off reversed the dark-neutral-mask residual from approximately +.134 to −.057 and worsened full-image mean and bias. Disabling the stage was therefore rejected as a fix.

For an additional diagnostic, nearly neutral, spatially flat pixels were selected from the same reduced pair: candidate channel spread ≤5 codes; reference spread ≤3; all channels between 10 and 245; each image differed from its four cardinal neighbors by ≤3 codes. Up to 1,000 deterministic samples per reference-code band were used. The existing Rust `display_u8_to_scene_linear` inverse was applied on both sides with contrast and whites at 0, then log2(reference-scene-luma / candidate-scene-luma) was computed. This estimates the exposure change the same fixed AgX curve would require to reproduce each reference pixel; it does not claim these inverse values are Adobe's internal scene values.

| Reference mean code band | Eligible pixels | Median required EV | Median ±1-code bounds |
| --- | ---: | ---: | --- |
| 10–30 | 75,040 | −.4417 | [−.5859, −.2984] |
| 30–60 | 12,139 | −.9266 | [−.9735, −.8823] |
| 60–90 | 6,188 | −1.1829 | [−1.2277, −1.1387] |

The required offset varies materially with brightness, beyond these quantization bounds. A single camera exposure/white-level correction cannot reproduce all these neutral regions. A reference-fitted exposure could improve an aggregate metric, but would be tuning to this photograph, not evidence of an incorrect physical normalization.

The uncapped scene-anchor formula also cancels a uniform upstream scale: both `0.18/midgrey` and `0.85/p95` scale inversely, so multiplying scene values by k and recomputing the anchor returns the same anchored image (apart from clipping/recovery changes). The observed gain is below its 8× cap. This narrows generic camera exposure/white scaling as a causal explanation.

Neutral's AgX appearance and Auto as the default are explicit product requirements; no arbitrary curve or per-camera correction is proposed. Issue #3633 closed on 2026-10-05 after the original five breaches were resolved. Remaining `test_0011` reference-provenance work was carried forward to #3678. These experiments do not resolve that work: verified reference provisioning and migration remain open there.

### Reproducing the diagnostics

From `src/raw-pipeline`, pass the appropriate local RAW/XMP/reference inputs and a path to a **new** output directory:

```sh
cargo run --release -p raw-core --example sony-anchor-probe -- RAW XMP NEW_OUTPUT_DIRECTORY
cargo run --release -p raw-core --example agx-pair-attribution -- PAIRS_JSON
cargo run --release -p raw-core --example sony-sensor-probe -- RAW NEW_OUTPUT_DIRECTORY
cargo run --release -p raw-core --example sony-decoder-render-probe -- RAW XMP LIBRAW_U16LE NEW_OUTPUT_DIRECTORY
cargo run --release -p raw-core --example sized-open-probe -- RAW preview 1600
```

The Sony-specific probes assert the expected ILCE-7RM4 model and dimensions where applicable. `sony-sensor-probe` writes raw samples and metadata; `sony-decoder-render-probe` writes a rendered PNG; `sony-anchor-probe` writes rendered PNGs; the AgX attribution probe reads a pairs JSON file and prints diagnostic JSON to stdout; the sized-open probe reports timing, output dimensions, and a deterministic pixel hash. Output-producing probes require a new output directory. Use locally supplied inputs; no private machine paths or generated result files are part of this record. The sized-open and AgX attribution examples write no files.

Four Rayon threads were used for the original measurements. Those timing observations are not performance claims.
