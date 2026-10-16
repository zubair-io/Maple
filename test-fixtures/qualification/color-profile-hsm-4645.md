# Physical camera HueSatMap adoption — #4645

The candidate was withdrawn after broader physical qualification exposed
regressions. Its exact Adobe Standard HueSatMap pairs for Fujifilm GFX 50S,
GFX 50R and Leica M10 cleared the initial tint controls, but failed other
required cases. The source bundle is restored byte-for-byte; output 38 and
Auto-fit model 10 invalidate artifacts made with the experimental tables.
The frozen v36 run completed all 132 comparisons: 12 fail, zero required
cells are missing, and all 489 input hashes remain unchanged.

## Attribution and scope

The bundled profiles deliberately omitted HSM tables to reduce bundle size.
The installed Adobe profile matrices were byte-identical to the bundle,
so this is missing metameric calibration, not stale matrices. The converter's
existing opt-in HSM support encodes the original table values without fitting.

Read-only probes tested six camera fixtures across Neutral baseline/tint rails
and Auto baseline. Auto variants ran in separate fresh processes so each fit
and render used the same calibration. Source RAWs, XMPs, references and budgets
stayed unchanged. The three selected bodies passed all initial controls and
cleared their tint breaches. Canon table additions introduced baseline or Auto
regressions and were excluded from this candidate.

| Fixture   | Body             | Tint case | Control mean ΔE | HSM mean ΔE |
| --------- | ---------------- | --------- | --------------: | ----------: |
| test_0005 | Fujifilm GFX 50S | tint_min  |          12.464 |       9.786 |
| test_0012 | Fujifilm GFX 50R | tint_min  |          11.922 |       9.279 |
| test_0017 | Leica M10        | tint_max  |          10.214 |       7.428 |

The unchanged channel-bias ceilings also pass in these probes. These are
focused results, not a new aggregate failure count.

## Bundle provenance

All 1,406 records retain their ordering. The other 1,403 records are
byte-identical. The selected records' non-HSM bytes are identical to both the
previous bundle and conversion of the installed DCP with HSM disabled.
Each selected record adds two 90×30×1 Linear tables; no aesthetic LookTable
or ProfileToneCurve is introduced.

- Original bundle: 263,094 bytes,
  SHA256 `2547ce6c134bb8ee7e8b528da5cf6723c321a430760a9c9ef554d1228dcf00b4`.
- Candidate: 457,494 bytes,
  SHA256 `632ed2a8d05365495bb093c194c4aafebbd216e2cf0ac9b35ea020b8db2c33ab`.
- Converter SHA256:
  `32f621144052b021c4e13c893c87454579c121201408b508919db1d364b93b16`.
- GFX 50S source DCP SHA256:
  `69959c20dac69b7e6af63966236cce4619de5694871949fa927767685834e1e0`.
- GFX 50R source DCP SHA256:
  `2df9ae4aa832a07641427a378b3e4de507ecbddf45e6f88ab7402966f33a3f08`.
- M10 source DCP SHA256:
  `edb6b03484d58cec1b33b9bc1f800785dfb9d0e5181d6f3230c68b9d72ed1b5a`.

A regression verifies the original matrices, encoded and decoded table
identities, dimensions, encoding, flags and profile count. Physical GPU tests
now include the three bodies, retaining their original parity tolerances.
Pipeline output 36 and Auto-fit model 8 invalidate prior derived artifacts.

## Frozen v36 qualification

The v36 CLI SHA256 is
`9c43ae045c1b8a0e8e4b8dfed0f61f4fd46f660eec83f94c3ec0a67d28e91132`.
All 14 domain gates pass and recorded source/input hashes remain unchanged:

- Core: 2,831 pass, 102 existing fixture-gated ignores.
- GPU: 292 pass, five existing ignores; four explicit physical HSM tests pass.
- Five explicit core camera/DCP tests pass, including physical RAW photographs.
- WASM binding: 74 pass, eight existing ignores.
- Native GPU binding: 301 pass, six existing ignores.
- Actual browser target, 49 WGSL modules, gray/adjustment/DCP gates,
  all 90 banding cases, WASM SIMD witness and source headroom pass.

The canonical physical gate completed every manifest case for the three
bodies: 129 cases, 132 comparisons including Auto baselines and native detail,
489 unchanged physical input hashes. It used the unchanged comparator and budgets.
A later v37 diagonal-DNG correction is qualified separately; this v36 run
uses its frozen binary and source snapshot.

The completed down and Auto passes have 12 failing cells. New breaches include
contrast_min on all three bodies; dehaze_max/dehaze_min/temperature_min on
GFX 50S; dehaze_min/exposure_min/temperature_min/wb_auto on GFX 50R; and wb_auto
on Leica M10. GFX 50R whites_max still fails. All three Auto baselines pass.
All 30 native-detail comparisons pass; the final input audit is unchanged.
The full result rejects adoption. The additional physical camera
coverage remains in the GPU tests. No numerical budget changed.

Evidence: `/Volumes/Projects/maple-color-gate-20261015/hsm-coverage-audit/`
and `/Volumes/Projects/maple-color-gate-20261015/hsm-table-adoption/`.

## Requalification with the corrected bias metric

The subsequent v46 experiment includes only the two Fujifilm bodies. Each
variant completed all 88 comparisons with 326 unchanged physical input hashes
and the corrected float64 bias accumulator (#4667). Control had 23 failures;
the candidate had 10: 22 cleared, nine newly failed, and one remained.
All 20 Fujifilm native-detail bias failures cleared. The new failures were:

- GFX 50S: `contrast_min`, `dehaze_max`, `dehaze_min`, `temperature_min`.
- GFX 50R: `contrast_min`, `dehaze_min`, `exposure_min`, `temperature_min`,
  `wb_auto`.

GFX 50R `whites_max` remained failing. Both Auto baselines passed. This result
still rejects adoption; it does not qualify Leica or the complete corpus.
Evidence: `/Volumes/Projects/maple-color-gate-20261015/fuji-hsm-v46/paired-results.json`.

## Selected-white composition on output 47

The next diagnostic composes all three cameras' exact table pairs with #4633's
selected-white interpolation at commit
`38abc3b26c0d831dec4f822fd921a43d061f100f`. It preserves all other 1,404 bundle
records and every non-HSM field. Its frozen CLI SHA256 is
`eb9822acfcf5477082ad2dff421bc2daf2e531660ce20be6345b5e0ca7b169d2`.
The source bundle and ordinary v47 CLI were restored after the build.

Both explicit physical GPU tests passed, with no ignored cases. Across eleven
cameras, 66 photograph/WB-prefix comparisons had maximum absolute scene error
`1.2397766e-5`; 275 calibration/WB-intent comparisons had maximum error
`1.9073486e-5`. Both retain the `1e-4` ceiling. All eleven original RAW hashes
were unchanged, the source patch was unchanged during testing, and production
sources were restored afterward. These tests cover the standalone camera
stage; persistent live sessions and absolute frame-time limits remain separate
acceptance requirements.

The control and candidate physical runs each require 132 comparisons over all
129 manifest cases and three Auto baselines, with 489 input hashes each. Those
runs are still in progress. No current photographic pass or table adoption is
claimed. Evidence, reproducible extraction and build identity are under
`/Volumes/Projects/maple-color-gate-20261015/three-camera-hsm-v47/`.
