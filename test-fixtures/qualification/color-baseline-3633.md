# Color baseline investigation — #3633

Tracking issue: https://github.com/zubair-io/Maple/issues/3633

Status: investigation; candidate changes remain unqualified and are not ready for review. Measurements recorded September 15, 2026.

Base: 1f233acb91dd97c2103a6903279be4dee5329192, clean isolated checkout Maple-color-baselines. No original or budget changes. Fresh release CLI, Rayon 4, installed read-only corpus; no performance claims.

| Case         | Current max | Legacy-threshold diagnostic max | Budget |
| ------------ | ----------: | ------------------------------: | -----: |
| 0000 Neutral |       42.07 |                           37.20 |  39.10 |
| 0007 Neutral |       46.16 |                           41.95 |  44.10 |
| 0017 Neutral |       34.76 |                           31.55 |  98.00 |
| 0000 Auto    |       41.72 |                           34.75 |  36.50 |
| 0007 Auto    |       40.89 |                           36.98 |  39.00 |
| 0017 Auto    |       34.17 |                           29.52 |  93.80 |

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

| Case         | Candidate max | Outcome                            |
| ------------ | ------------: | ---------------------------------- |
| 0000 Neutral |         40.06 | fails39.10                         |
| 0007 Neutral |         43.41 | passes44.10                        |
| 0017 Neutral |         47.44 | passes98, but worsens from34.76    |
| 0000 Auto    |         39.36 | fails36.50                         |
| 0007 Auto    |         38.60 | passes39                           |
| 0017 Auto    |         48.08 | passes93.80, but worsens from34.17 |

Artifacts /tmp/maple-3633-witness-run.log, /tmp/maple-3633-witness-source.rs, /tmp/maple-3633-witness-cli; candidates /var/folders/qn/gpgsv1591kz40pfbjgnnvzxm0000gn/T/maple-calibrate-XXXXXX.SKrDSQCwOk.

Raw mosaic probe /tmp/maple-3633-probe2.txt: at0007 sensor5772,1718 the actual sampledR=.72268975, nearbyB samples=1.0 clipped. DemosaicB becomes1.0988 sensor units and HR further extrapolates it. Reconstructed unclipped neighbors near this edge are not necessarily reliable chromaticity witnesses. Wider exclusion trades contamination against useful color information, so algorithm needs a more grounded reliability model and regression coverage.

No external blocker established; issue remains unresolved algorithm work. No PR or production changes claim completion.

## Input provenance

The local paths above identify the installed corpus used in this run; fixtures remain read-only. These hashes identify the exact inputs independently of their installation path.

| Case               | Input         | SHA256                                                             |
| ------------------ | ------------- | ------------------------------------------------------------------ |
| test_0000/baseline | test_0000.DNG | `f4b60b3672bdf7ff7f4376fba9da1b1d22c925ebc3e16baa5fd4a64fa1045aa5` |
| test_0000/baseline | baseline.xmp  | `23cdfdc027d919721421a3f68a2f30790b37b41837e2bfce924e79db86033b52` |
| test_0000/baseline | baseline.png  | `a9c6733cf82470517011dd1839f3439c6923cab561e039e3e6b5b60ad25c1a6c` |
| test_0007/baseline | test_0007.DNG | `95dc76a2f255e623acaa5149b320389f7da7c995da890c3e0d511c0ff681b2e1` |
| test_0007/baseline | baseline.xmp  | `23cdfdc027d919721421a3f68a2f30790b37b41837e2bfce924e79db86033b52` |
| test_0007/baseline | baseline.png  | `24259ae3ae69f014ff8a1c0b6da646d2c39b079ae94a07b3da92bb806942345b` |
| test_0017/baseline | test_0017.dng | `26be5e06dfb53a2938dab3ca8f06024533a9c0dd0c652938f39eb48bc325f95e` |
| test_0017/baseline | baseline.xmp  | `23cdfdc027d919721421a3f68a2f30790b37b41837e2bfce924e79db86033b52` |
| test_0017/baseline | baseline.png  | `703802fcb748ab08492fbae8b408a9696fbdabad6d536b9412eeddabbda4ebf3` |

## Reproduction

Build `maple-cli` at the commit above using `cargo build --release --bin maple-cli -j4` in `src/raw-pipeline`. Construct a manifest with the `baseline` cases for `test_0000`, `test_0007`, and `test_0017` from the installed corpus, retaining each original RAW/XMP/reference path. Run from the repository root:

```bash
MAPLE_CLI=/absolute/path/to/fresh/maple-cli \
MANIFEST=/absolute/path/to/three-case-manifest.json \
KEEP_TMP=1 FILTER=baseline RAYON_NUM_THREADS=4 \
bash src/scripts/test_color_pipeline.sh
```

The harness renders both Neutral and Auto, uses its existing no-bundled-lens path, and applies the committed budgets without overrides. Expect six comparisons and zero skips. The no-fixtures soft-pass path is not evidence of this gate passing.

## Green-denominator consistency experiment

When green is not clipped, keep it as the denominator for the stored R/G and B/G estimates instead of inferring a different green from a brighter red/blue anchor. This is an algebraic consistency hypothesis, not a claim that demosaiced green always has better sensor evidence. The un-clipped output channels remain untouched.

All six cases rendered and compared, zero skipped. `test_0007` now passes Neutral max 43.11 (limit 44.10) and Auto max 37.22 (limit 39.00). `test_0000` remains unchanged and failing at 42.07 / 41.72. `test_0017` remains unchanged at 34.76 / 34.17. This candidate is still incomplete; synthetic edge/channel coverage and wider qualification remain required before it could ship.

At test_0007 sensor (5772,1718), the 20 contributing neighbors give confidence-blended R/G 1.07173 and B/G 2.54682, while the input's R/G is 1.47060. The original red anchor invents a different green to produce B=3.36861; retaining input G=0.96393013 gives B=2.45495. This explains the direction of the measured improvement without changing the physical clipping thresholds.

## test_0000 stage-order observation

A temporary trace inside the actual full develop pipeline (after embedded OpcodeList3) sampled the native footprint of the maximum-error downsampled pixel. At (182,6337), input [2.455214, 1.2348444, 1.317717] has clip mask 0 and passes through. Nearby (184,6337), input [5.122901, 2.0130403, 2.8843458] has clipped green and becomes [5.122901, 2.5850992, 2.8843458]. Thresholds are [5.3988748, 2.0038414, 2.9704792].

This fixture carries WarpRectilinear. The current full/sized/panorama pipeline resamples before reconstructing highlights; the sized pipeline also downsamples before reconstruction. Resampling can mix a sensor-clipped channel below its threshold, so post-resample clip detection does not preserve the original saturation evidence. A diagnostic moving baseline exposure, WB pre-gain, and reconstruction before the warp is being measured. Exposure/WB gains commute with the linear per-channel warp; highlight reconstruction does not. No stage-order change has been accepted yet.

## Pre-warp reconstruction experiment

Moving baseline exposure, WB pre-gain, and highlight reconstruction before OpcodeList3 in the full develop path, together with the green-denominator correction, still fails two of six comparisons (zero skipped). `test_0000` maxima improve to 39.18 Neutral / 39.80 Auto; limits remain 39.10 / 36.50. `test_0007` and `test_0017` retain the preceding experiment's passing results. The maximum on `test_0000` moves to (2811,329) in the 4000-pixel reference; candidate RGB is (0.8471,0.4314,0.4784), reference (0.7333,0.6431,0.3255).

The actual DNG has one WarpRectilinear opcode with identical planes, radial coefficients [0.984778,0.035585,-0.075203,0.054787], tangential [0,0], center [0.5,0.5]. Mapping the new maximum's native output footprint back through this warp locates sensor coordinates near (8612,1042). A pre-warp trace shows green saturation at nearby (8612,1045): input [4.971276,2.013911,2.6488168], reconstructed [4.971276,2.4207985,2.6488168]. Its 40 fully-unclipped witnesses have mean R/G 2.29062, median 2.18548, standard deviation 0.62228. The field includes real spatial color variation; treating it as mere noise is not justified.

The next diagnostic estimates each clipped channel relative to the mean of the target's known channels, using that same known-channel mask for every witness. This avoids both the brightest-anchor choice and taking ratios of independently averaged ratios. It retains existing clip thresholds, neighborhood, witness minimum and confidence rule, keeps every un-clipped channel unchanged, and uses no new tuning constant or heap allocation. This remains a diagnostic until the objective gates and synthetic invariants establish its behavior.

Qualification scope discovered during the investigation: the installed full manifest contains 777 cases across 20 fixtures; all 777 RAW paths and 606 down-resolution references are present. All 20 baseline references are present. The six-case subset reproduces this issue's reported failures; it is not full-corpus qualification. Any accepted candidate needs the wider baseline comparison and relevant synthetic/CPU-GPU parity gates.

## Wider baseline control and rejected follow-up experiments

The fresh unchanged main CLI completed all 20 available baseline fixtures in both
Neutral and Auto: **40 comparisons, 5 failures, zero skips**. In addition to the
four reproduced failures above, `test_0011` Neutral fails its channel-bias budget:
R +0.0378, G +0.0315, B +0.0312 versus 0.0113. Its mean/p95/max are
5.65/19.51/38.15; Auto passes. This additional existing failure must be included
in the final qualification, rather than hidden by the original three-fixture
subset. The exact 20-fixture RAW/XMP/reference input hashes are recorded in
`color-baseline-3633-inputs.json`. Log: `/tmp/maple-3633-all-baselines-current.log`.

The known-channel-mean reconstruction experiment did not clear the six-case
gate: four failures, zero skips. Maxima were 39.28/39.21 for 0000 Neutral/Auto,
44.48/39.59 for 0007, and 30.95/34.17 for 0017. It was removed from the candidate.

A separate warp-interpolation diagnostic used the Adobe DNG SDK's documented
bicubic coefficient A=-0.75 and support radius two, preserving the existing
coordinate mapping and unbounded scene range. It did not copy the SDK's output
clamp, and used analytic weights rather than the SDK's quantized phase table;
it does not establish exact ACR equivalence. Maxima for 0000 improved only to
39.22/38.94, still failing both limits. The other four comparisons retained the
pre-warp candidate results. This diagnostic was also removed; no cubic warp
change is proposed. Primary source provenance: Adobe-authored
[dng_resample.cpp](https://android.googlesource.com/platform/external/dng_sdk/+/de700ad461e35af50b28b861943a0b0753b10929/source/dng_resample.cpp)
and `dng_lens_correction.cpp` at the same revision.

## Regression evidence for the remaining candidates

The positive lens-gain invariant is independently reproducible with a synthetic
64×64 DNG whose unsaturated sensor samples are 0.8, identity white balance, and
positive FixVignetteRadial gain. On the unchanged stage order, enabling highlight
reconstruction changes a valid output of approximately [1.607114, 1.607109,
1.607111] into approximately [1, 1, 1]. Moving reconstruction ahead of
OpcodeList3 fixes this regression across Full, AMaZE, and Preview demosaic in
both full and sized paths. This is evidence of a real sensor-clipping semantics
bug, independent of reference-image agreement. The test first failed against
the original order and then passed against the candidate.

A separate red/blue edge test fails against the brightest-anchor algorithm and
passes when a known green remains the denominator of the existing R/G and B/G
estimates. All 31 selected highlight-recovery tests pass; one pre-existing
fixture-gated test is ignored. This synthetic case proves the specified
algebraic behavior, not universal superiority of green at every demosaiced
edge. Known-channel preservation and physical BaselineExposure thresholds are
unchanged. Full baseline and cross-path qualification remain required.

## Full candidate baseline result and broad unit coverage

The pre-opcode reconstruction plus known-green candidate completed **40 baseline
comparisons, 3 failures, zero skips**. Both 0007 failures are fixed, no additional
baseline fails, and 0000 still fails max at 39.18 Neutral / 39.80 Auto. The
additional 0011 Neutral bias failure is unchanged to displayed precision. This
is improvement, not a passing canonical gate. Logs:
`/tmp/maple-3633-all-baselines-prewarp.log` and
`/tmp/maple-3633-core-debug-tests.log`.

The documented debug-profile `cargo test -p raw-core --lib -j4` passes **2,384
tests, 92 ignored**. A preceding broad release-profile attempt is not a passing
qualification: three tests require debug assertions, and an existing
release-only noise-reduction timing assertion ran during render contention.
Its timing is invalid performance evidence; no performance claim is made.
The narrow release highlight-recovery correctness filter remains 31 passed,
one pre-existing ignored test.

A diagnostic XMP copy with highlight recovery disabled (originals unchanged)
confirms that removing reconstruction is not a fix: 0000 max becomes 43.22
Neutral / 43.27 Auto, worse than the candidate, while the 0011 metrics are
unchanged. All four comparisons execute, three fail, zero skip. This separates
the Sony failure from highlight reconstruction. Fresh metadata inspection
identifies Sony ILCE-7RM4, BaselineExposure zero, bundled DCP present, and
AsShotNeutral [0.32569975, 1, 0.6666667]. Its reference/budget history still needs
attribution; current hashes do not prove an ignored reference file is identical
to the one used to seed a July budget.

The evidence branch is rebased onto origin/main c280943a5c9c4a803dc2862f36f76413db530dc0.
The intervening API/package type fixes do not change Rust pipeline, harness, or
budgets. Immutable render binary provenance above remains the recorded original
source revision; final qualification will rebuild the accepted source.

## Demosaic witness reliability and rejected FCS changes

`raw-core/examples/highlight-edge-probe.rs` reproduces a two-pixel saturated
stripe with known constant chromaticity across all four Bayer arrangements,
vertical/horizontal/diagonal directions and two phase offsets (24 cases).
This is a diagnostic of undersampled edges, not a promise that arbitrary
subpixel scene detail can be recovered. With the existing extra AMaZE
false-color suppression (FCS), the largest fully-unclipped witness ratio error
is 2.4375. All 46–48 actually measured saturated green sites in each case
reconstruct below the sensor lower bound. Disabling just FCS reduces witness
ratio error to approximately 0.542–0.553 and removes those lower-bound
violations. This isolates a real interaction; it does not establish that
removing FCS improves photographic references generally.

Indeed, **FCS removal is rejected** by the six-case gate: 0000 maxima
39.27/39.25 still fail, and 0007 Auto regresses to 42.45 (limit 39). A second
candidate retained FCS except where its existing 3×3 support contained a
saturated raw photosite. It also fixes the synthetic diagnostic, but fails four
of six reference comparisons: 0000 maxima 39.79/39.75 and 0007 44.51/40.04.
Neither FCS change remains in production source. No suppression-strength
retuning was performed.

## Reference-resampling contribution

The committed reference generator (`src/scripts/acr-reference/acr_batch.jsx`)
saves the native ACR document, then uses Photoshop `BICUBICSHARPER` for the
4000-pixel reference. The comparison harness resizes Maple's native PNG with
Lanczos. Comparing the existing 0000 ACR full PNG through that same Lanczos
resize against its existing ACR down PNG gives mean 1.0233, p95 2.8304 and
max 13.8882 ΔE2000; RGB mean biases are below 0.00002.

At the candidate's remaining downsampled maximum (2811,329), Auto differs by
39.796 from ACR down, versus 37.384 from ACR full resized with the same Lanczos
kernel. At (2811,331), those values are 39.023 versus 30.643. Thus different
resize kernels materially affect the sparse maximum tail, but do not by
themselves explain or fix the remaining regression. No harness, reference,
or budget change is proposed from this observation.

## Sony 0011 reference attribution (read-only, September 15)

The fifth unchanged-main failure is attributable to a changed reference target,
not to the candidate highlight-recovery changes. Comparing the **same** existing
main Neutral candidate with the original and corrected 4000×2667 references,
using the harness's RGB conversion, Lanczos resize, float32 normalization and
float32 mean reduction, gives:

| Reference |    R bias |    G bias |    B bias | .0113 bias budget |
| --------- | --------: | --------: | --------: | ----------------- |
| Original  | .00950799 | .00412983 | .01025915 | passes            |
| Corrected | .03782028 | .03151138 | .03117711 | fails             |

Original PNG SHA256: `b64750bc587b3a98ac137ad0ca341421318c9877007d84e5b431fb8ce36fdaa4`.
Corrected PNG SHA256: `eb0964fca514f80816250b685665f8767790c89ae9958be78e9696844a1da687`.
Original is installed at `_Maple/test-fixtures/references/test_0011/down/baseline.png`
and preserved under the sprint worktree's
`.calibration-cache/acr-corrected-canonical/original-references/`.
Corrected is installed at the sprint worktree's `test-fixtures/references/`
and matches its `.calibration-cache/acr-corrected-canonical/renders/` copy.
The cache's `provenance.json` records Photoshop 27.10.0, ACR 18.6 (2698),
Adobe Standard and original/corrected hashes. This establishes local provenance;
it does not independently prove the original PNG seeded the July budget.

ExifTool's complete XMP-crs comparison finds the material differences:
original ACR Version 18.2.2 -> 18.6; LensProfileEnable 1 -> 0;
AutoLateralCA 1 -> 0. Original has Adobe (Sony FE 24-70mm F4 ZA OSS),
LensDefaults, distortion and vignetting scales 100, and profile digest
2644B741A716B86B2C354452E2587EC9; corrected removes those profile fields.
Corrected additionally explicitly records Glow=0 and ReshapeAmount=0.
Exposure, camera profile, process version, tone curve and all other shared
Camera Raw settings agree. The separate lens-off control PNG has different
file hash (`168201a408d5089563784c539f1700f890c974e7ddfcc84ad0926b060d9d1414`)
but **identical decoded RGB pixels** to corrected.

The old reference is not a valid lens-disabled baseline: it applies both lens
profile and lateral CA corrections, whereas `test_color_pipeline.sh` explicitly
passes `--no-bundled-lens` and documents lens-disabled references. Reverting the
reference merely to pass the budget would restore that mismatch. These data
cannot apportion effects between ACR version and lens correction without a
matched-version render, but the existing lens-off control strongly anchors the
corrected target's reproducibility.

The bias is broad and predominantly tonal, not a sparse saturated-edge error.
Reference L\* bands (sRGB decoded to Y using .2126/.7152/.0722; means accumulated
in float64 for descriptive accuracy) on the corrected target are:

| L\*    | Pixels | R/G/B bias                  |
| ------ | -----: | --------------------------- |
| 0–20   | 50.82% | +.04968 / +.04825 / +.05110 |
| 20–40  | 10.95% | +.20990 / +.20720 / +.20707 |
| 40–60  |   .50% | +.17258 / +.18171 / +.16254 |
| 60–80  |  8.37% | +.00895 / −.00461 / −.03021 |
| 80–100 | 29.35% | −.04011 / −.05400 / −.05121 |

Descriptive float64 full-frame bias differs slightly from the canonical
float32 reduction (+.03808/.03189/.03191); use the canonical values above for
budget decisions. Machine-readable bands for old/corrected/lens-off are in
`/tmp/maple-3633-sony-reference-bands.json`.

Next step: keep the corrected reference and unchanged ratchet; record this as
a distinct Neutral tonal qualification failure exposed by reference repair.
The unchanged .0113 ceiling now tests a different target; no old-versus-new
reference qualification linking that ceiling was found in the inspected cache
provenance. Diagnose Neutral tone/DCP versus the valid lens-disabled Adobe
reference separately from highlight reconstruction. Auto already passes.
Do not infer that Auto should cease being the default, or loosen the budget.
No source, RAW, sidecar, reference or budget was changed in this investigation.

## Relative-variance anchor diagnostic

Choosing the known R/B anchor with the smaller coefficient of variation in its
local ratio witnesses, only when G is clipped, did not resolve the gate. All
six comparisons executed, two failed, zero skipped: 0000 maxima 39.79/39.48,
0007 43.11/37.22, 0017 50.30/36.57. The 0017 Neutral tail worsens substantially
from 34.76, so this estimator is rejected despite remaining within that
fixture's loose maximum budget. Original candidate anchor logic is restored.

## Sensor-domain propagation counterfactual

The AMaZE source has no simple final interpolation-support map: adaptive
ratios, variance choices, median bounds, Nyquist refinement and diagonal
refinement all affect both samples and weights. A cardinal-neighbor clipping
mask would describe uncertainty, not prove the interpolated output is clipped;
no such dilation is proposed.

`raw-core/examples/highlight-sensor-probe.rs` instead uses a CFA-aligned 128×128
crop at sensor origin (8544,960), with the inspected pixels well inside its
halo. Its original output matches the earlier full-image trace exactly. Raising
only actually saturated green at (8612,1045) from 1 to the current reconstructed
estimate 1.2020385 changes neighboring interpolated green at (8611,1045) from
0.9445709 to 1.0192119. Every measured, unclipped photosite remains unchanged.
At (8614,1046), green remains 0.9877275: its dependency is elsewhere. This is
measured support sensitivity, not a fabricated clipping label.

The synthetic probe now also distinguishes direct post-demosaic HR from
replacing only actually clipped photosites and re-demosaicing. Its oracle
replacement mosaic equals the original unclipped ground-truth mosaic exactly.
For the narrow axis-aligned stripe, the second-pass estimate reduces maximum
neighbor green error relative to that oracle from about 0.5633 to 0.2; diagonal
error remains about 0.0683. All measured unclipped values remain unchanged.
The first-pass estimator is therefore still imperfect even when propagation is
corrected; this is not a complete recovery algorithm.

A full-image counterfactual on 0000 replaces only actually saturated normalized
photosites with their first-pass HR estimates, undoing WB/BE exactly once and
respecting each censored observation's lower bound. It then demosaics again,
reapplies BE/WB, and continues through the same pre-opcode pipeline, without a
second HR pass. This restores 559 photosites and yields Neutral max **38.71**
(limit 39.10, now passes) and Auto max **38.36** (limit 36.50, still fails).
Both comparisons execute; one fails; zero skip. All originals remain untouched.

This counterfactual is **not a production proposal**. AMaZE documents normalized
[0,1] inputs and uses fixed 0.8/1 clipping branches; reconstructed values above
one change those branches. A second complete demosaic also adds unacceptable
work without a bounded implementation and qualification. The experiment
establishes that restoring sensor information before interpolation can improve
the reported regression; it does not establish safe, fast support for an
unbounded reconstructed mosaic. Log: `/tmp/maple-3633-redemosaic-run.log`.

## Symmetric sensor replay and reference reduction attribution

Using the previously rejected symmetric known-channel mean estimator only as
input to the sensor-replay counterfactual restores 548 photosites on 0000,
1,873 on 0007, and 947,144 on 0017. Canonical maxima are 0000 **38.25/37.89**,
0007 **41.49/36.64**, and 0017 **29.38/34.08** (Neutral/Auto). The remaining
0000 Auto maximum still fails, and 0017 Neutral now fails its red-bias ceiling:
−0.0362 against 0.0352. Six comparisons execute, two fail, none skip. This is
not an acceptable production change. A follow-up diagnostic restricts replay
to non-fully-clipped pixels with at least four valid local witnesses, to test
whether unsupported neutral extrapolation drives the new broad bias. It does
not splice outputs or invent an interpolation-support mask.

There is also a measurable reference-protocol difference. The ACR generator
saves native resolution and creates its 4000-pixel reference with Photoshop
BICUBICSHARPER; the comparison harness reduces Maple's native output with
Lanczos. Reducing the original full-resolution 0000 ACR reference with the
same Lanczos kernel gives mean/p95/max ΔE of **1.02328/2.83045/13.88816**
against the committed downsampled reference, despite RGB biases below 0.00002.
Full reference SHA-256:
`22475e8d4f13972b779f137df4d2c37906e8e089f46d6f0ac84fc96235c9879a`.

An all-pixel attribution comparison (10,668,000 pixels per result), reducing
both full-resolution outputs with the same kernel, produces:

| Candidate                      | Neutral mean/p95/max         | Auto mean/p95/max            | Worst coordinate |
| ------------------------------ | ---------------------------- | ---------------------------- | ---------------- |
| Unchanged main                 | 5.77884 / 9.53317 / 43.86215 | 2.91909 / 5.65618 / 43.48758 | (59,2063)        |
| Pre-opcode HR + known G anchor | 5.77884 / 9.53317 / 36.65638 | 2.91947 / 5.65814 / 37.38412 | (2811,329)       |
| Symmetric sensor replay        | 5.77883 / 9.53340 / 32.68564 | 2.92263 / 5.66651 / 31.40784 | (2820,318)       |

The unchanged candidate still fails the original numerical maximum ceilings.
The replay counterfactual falls below them only in this noncanonical protocol;
that does **not** make the canonical gate pass or qualify the estimator. The
worst location moves, and all pixels were included rather than only the old
failure coordinates. No reference, manifest, harness or budget is changed.
For a broader attribution, all 20 full/down baseline pairs were checked with
ExifTool: their complete XMP-crs settings match within each pair. Temporary
same-kernel references and full/down/derived hashes are recorded in
`/tmp/maple-3633-common-reference-provenance.json`; numeric results are in
`/tmp/maple-3633-common-kernel-results.jsonl`.

### Supported replay and channel-sweep falsification

Restricting replay to at least four valid witnesses and excluding fully clipped
first-pass RGB pixels changes 523/1,084/29,711 actual photosites on
0000/0007/0017. The original six canonical comparisons now have one failure,
0000 Auto maximum 37.89 (Neutral 38.25); none skip. However 0017 Neutral
mean/p95 worsens from 6.09/10.87 to 6.82/16.42, and Auto from 5.16/8.71 to
5.94/10.77. Its Neutral red bias −0.0345 passes the unchanged 0.0352 ceiling.
Restoring the original fallback only where the frozen first-pass interpolated
RGB mask was fully clipped does not change these printed results. This
ablation is output mixing, not proof of actual sensor saturation or a proposed
algorithm.

The synthetic edge probe now includes saturated red, green, and blue: 72
combinations across four CFA patterns, three edge directions, and two phases.
The diagnostic second demosaic preserves every measured unclipped photosite,
but it does **not** consistently improve missing-channel estimates. Green
stripe maximum neighbor error falls from 0.563271 to 0.2; blue diagonal error
increases from 0.151924 to 0.336695. Eight of 24 red cases and all 24 blue
cases worsen by more than 1e-5 (some blue axis differences are small). The
original green-only experiment cannot justify a general replay algorithm.
Results: `/tmp/maple-3633-edge-channel-sweep.log`.

### Grounded warp interpolation under equal reduction

The earlier no-clamp Adobe-SDK-kernel cubic warp diagnostic, with pre-opcode
HR and known-green anchoring but **without sensor replay**, yields 0000
Neutral mean/p95/max **5.745411/9.420420/36.566240** and Auto
**2.930606/5.631973/34.114136** against the equally Lanczos-reduced native ACR
reference. Both maxima are below the unchanged numerical ceilings; the
canonical down-reference maxima remain 39.22/38.94 and fail. This identifies
a narrower, physically grounded combination of interpolation and measurement
protocol to investigate before any sensor-replay proposal. It is still
noncanonical attribution: no harness/reference change or passing qualification
is claimed. Results: `/tmp/maple-3633-cubic-common-results.jsonl`.

The broader equal-reduction attribution completed **80 comparisons**: 40 for
unchanged main and 40 for pre-opcode HR plus known-green anchoring, with no
missing inputs. Main exceeds the same five numerical ceilings as canonically
(0000 and 0007 maxima in both profiles, 0011 Neutral bias). The candidate
exceeds two (0000 Auto maximum and unchanged 0011 Neutral bias), with no new
failures. Complete metrics and full/down/derived reference hashes are retained
in `color-baseline-3633-resampling.json`. These are explicitly noncanonical
results and do not replace the gate. The cubic candidate is now being rendered
against all 20 baselines to qualify its effect beyond the original three.

## Cubic candidate qualification checkpoint

The broad cubic run executed all 40 canonical baseline comparisons, with three
failures and zero skips: 0000 Neutral/Auto maxima 39.22/38.94 and the unchanged
0011 Neutral bias. The same 40 rendered outputs under equal Lanczos reduction
have just the unchanged 0011 Neutral bias breach; all original six comparisons
are below their existing numerical ceilings. The resampling JSON now includes
all **120** broad attribution rows (main, pre-opcode/known-G, and cubic), with
full/down/derived reference provenance. No canonical protocol change is made.

The candidate checkout was rebased to current `origin/main` **9faf74f71**;
the intervening raw-core changes are ID tests, not color math or budgets.
Current-base core validation: **2,390 passed, 92 pre-existing ignored**.
Synthetic grey, adjustment and DCP gates: **52 passed**. Opcode-specific
validation: **26 passed**, including analytical cubic weights, identity,
sticky active-area borders and preservation of negative and >1 radiance.

A new non-flat GPU parity test uses a generated DNG with positive lens gain,
a cubic warp, a diagonal chromatic edge and actual clipped green photosites.
It exposed an old test-oracle mismatch: `cpu_reference` selected `Full` (RCD
since #3412), while shipping Web CPU and GPU preparation both select `Amaze`.
The flat fixture had hidden that difference. Correcting the oracle to the
shipping CPU demosaic, without changing numeric parity limits, gives exact
byte equality for this new case with HR Off and ChromaticAdaptation.
`MAPLE_REQUIRE_GPU=1` qualification runs **18 tests, all passing**, with no
ignored tests; required fixtures/hardware cannot silently skip. This establishes
the shared CPU preparation + GPU-chain path on the native adapter, not browser
WebGPU or a freshly rebuilt Apple binding qualification.

Production candidate edits remain uncommitted while the canonical protocol
and remaining reference-target failure are unresolved. Output version bump,
code generation, native binding checks and uncontended performance validation
are still required before a ready implementation PR.
