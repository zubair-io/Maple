# Color baseline investigation — #3633

Tracking issue: https://github.com/zubair-io/Maple/issues/3633

Status: investigation; no proposed production fix. Measurements recorded September 15, 2026.

Base: 1f233acb91dd97c2103a6903279be4dee5329192, clean isolated checkout Maple-color-baselines. No original or budget changes. Fresh release CLI, Rayon 4, installed read-only corpus; no performance claims.

| Case | Current max | Legacy-threshold diagnostic max | Budget |
|---|---:|---:|---:|
| 0000 Neutral |42.07|37.20|39.10|
| 0007 Neutral |46.16|41.95|44.10|
| 0017 Neutral |34.76|31.55|98.00|
| 0000 Auto |41.72|34.75|36.50|
| 0007 Auto |40.89|36.98|39.00|
| 0017 Auto |34.17|29.52|93.80|

Current: executed6 failed4 skipped0. Diagnostic: executed6 failed0 skipped0. The diagnostic ONLY replaces baseline_gain with 1.0 in highlight_recovery.rs, reproducing legacy saturation thresholds/margin. Original source restored immediately after build; never proposed for shipping. This attributes remaining failures to September BaselineExposure clipping correction (082bb2b11 and1cb975d8b), relative to unchanged July26 budgets dcfe0872d.

A rollback is invalid: it classifies valid bright pixels as sensor-clipped with positive BaselineExposure and fails the intent of positive_baseline_exposure_does_not_reconstruct_unclipped_pixels. Also 0017 Neutral mean worsens6.09→6.83 and p9510.87→16.52; Auto mean5.16→6.07,p958.71→12.02. Need physically supported saturated-edge reconstruction fix.

Spatial numeric analysis at 4000px:0000 worst(59,2063), only6 pixels aboveDeltaE35;0007 worst(3911,1126), only55 above35.0007 native stage probe at crop(5632,1622) / sensor(5772,1718): pre-recovery[1.417552,.96393013,2.8290658], post[1.417552,.96393013,3.3686075], DCP[1.3101232,.369016,5.3108196]. Sensor BE.25, neutral[.606276,1,.46188504], ceilings[1.9615,1.1892,2.5747]. Reconstruction amplifies B at a bright edge; needs further mosaic/demosaic attribution. No production fix selected.

Artifacts:
- /tmp/maple-3633-baseline-manifest.json (absolute read-only paths)
- /tmp/maple-3633-provenance.json (SHA256 inputs)
- /tmp/maple-3633-baseline-run.log and /tmp/maple-3633-legacy-run.log
- /tmp/maple-3633-spatial.jsonl and /tmp/maple-3633-probe.txt
- /tmp/maple-3633-current-cli immutable fresh main binary
- /tmp/maple-3633-legacy-threshold-cli deliberately altered diagnostic only
- current candidates: /var/folders/qn/gpgsv1591kz40pfbjgnnvzxm0000gn/T/maple-calibrate-XXXXXX.uPxLW9AIMv
- diagnostic candidates: /var/folders/qn/gpgsv1591kz40pfbjgnnvzxm0000gn/T/maple-calibrate-XXXXXX.EwSi0xzXrb

## Rejected witness-exclusion experiment

Excluded fully-unclipped chromaticity witnesses if any pixel in their 3x3 neighborhood was clipped. Original physical thresholds and unchanged-unclipped-output invariant retained. This supports the edge-contamination hypothesis but is NOT a ready patch: four passes/two failures, with new local errors on0017. Source restored.

| Case | Candidate max | Outcome |
|---|---:|---|
|0000 Neutral|40.06|fails39.10|
|0007 Neutral|43.41|passes44.10|
|0017 Neutral|47.44|passes98, but worsens from34.76|
|0000 Auto|39.36|fails36.50|
|0007 Auto|38.60|passes39|
|0017 Auto|48.08|passes93.80, but worsens from34.17|

Artifacts /tmp/maple-3633-witness-run.log, /tmp/maple-3633-witness-source.rs, /tmp/maple-3633-witness-cli; candidates /var/folders/qn/gpgsv1591kz40pfbjgnnvzxm0000gn/T/maple-calibrate-XXXXXX.SKrDSQCwOk.

Raw mosaic probe /tmp/maple-3633-probe2.txt: at0007 sensor5772,1718 the actual sampledR=.72268975, nearbyB samples=1.0 clipped. DemosaicB becomes1.0988 sensor units and HR further extrapolates it. Reconstructed unclipped neighbors near this edge are not necessarily reliable chromaticity witnesses. Wider exclusion trades contamination against useful color information, so algorithm needs a more grounded reliability model and regression coverage.

No external blocker established; issue remains unresolved algorithm work. No PR or production changes claim completion.

## Input provenance

The local paths above identify the installed corpus used in this run; fixtures remain read-only. These hashes identify the exact inputs independently of their installation path.

| Case | Input | SHA256 |
| --- | --- | --- |
| test_0000/baseline | test_0000.DNG | `f4b60b3672bdf7ff7f4376fba9da1b1d22c925ebc3e16baa5fd4a64fa1045aa5` |
| test_0000/baseline | baseline.xmp | `23cdfdc027d919721421a3f68a2f30790b37b41837e2bfce924e79db86033b52` |
| test_0000/baseline | baseline.png | `a9c6733cf82470517011dd1839f3439c6923cab561e039e3e6b5b60ad25c1a6c` |
| test_0007/baseline | test_0007.DNG | `95dc76a2f255e623acaa5149b320389f7da7c995da890c3e0d511c0ff681b2e1` |
| test_0007/baseline | baseline.xmp | `23cdfdc027d919721421a3f68a2f30790b37b41837e2bfce924e79db86033b52` |
| test_0007/baseline | baseline.png | `24259ae3ae69f014ff8a1c0b6da646d2c39b079ae94a07b3da92bb806942345b` |
| test_0017/baseline | test_0017.dng | `26be5e06dfb53a2938dab3ca8f06024533a9c0dd0c652938f39eb48bc325f95e` |
| test_0017/baseline | baseline.xmp | `23cdfdc027d919721421a3f68a2f30790b37b41837e2bfce924e79db86033b52` |
| test_0017/baseline | baseline.png | `703802fcb748ab08492fbae8b408a9696fbdabad6d536b9412eeddabbda4ebf3` |

## Reproduction

Build `maple-cli` at the commit above using `cargo build --release --bin maple-cli -j4` in `src/raw-pipeline`. Construct a manifest with the `baseline` cases for `test_0000`, `test_0007`, and `test_0017` from the installed corpus, retaining each original RAW/XMP/reference path. Run from the repository root:

```bash
MAPLE_CLI=/absolute/path/to/fresh/maple-cli \
MANIFEST=/absolute/path/to/three-case-manifest.json \
KEEP_TMP=1 FILTER=baseline RAYON_NUM_THREADS=4 \
bash src/scripts/test_color_pipeline.sh
```

The harness renders both Neutral and Auto, uses its existing no-bundled-lens path, and applies the committed budgets without overrides. Expect six comparisons and zero skips. The no-fixtures soft-pass path is not evidence of this gate passing.
