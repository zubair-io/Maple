# Panorama seam comparison — 2026-09-07

This is evidence for [#3243](https://github.com/zubair-io/Maple/issues/3243). Voronoi remains the default. The ticket remains open because its required second motion-affected rotation capture is not available in the inspected fixture corpus. No rendering constant or existing budget has changed.

## Full pano_01 comparison

Both runs used the release `maple-cli` built from `a8f9feedad77527c155bc1351f487a43973f7cf1`, the same 21 original DNGs in their existing order, ONNX Runtime 1.23.2, and the pinned ALIKED/LightGlue models. Every stitch option stayed at its production default except `--seam-strategy`. Outputs were written to an owned temporary directory, with originals and sidecars read-only.

| Measurement                    |      Voronoi |    Graph-cut |
| ------------------------------ | -----------: | -----------: |
| Retained frames                |           21 |           21 |
| Motion-affected frames         |           21 |           21 |
| Canvas                         | 26966 × 9493 | 26966 × 9493 |
| Mean reprojection error, px    |  1.130973545 |  1.130973545 |
| Maximum reprojection error, px |  6.068242474 |  6.068242474 |
| Reference coverage             |  0.927638454 |  0.927616320 |
| Reference RGB RMSE             |  0.228294939 |  0.228440791 |
| Reference-excess seam energy   | 0.0008761553 | 0.0008893450 |
| Wall time, seconds             |       359.69 |       384.29 |
| Composite stage, seconds       |      136.984 |      183.312 |
| Peak RSS, bytes                |  12380962816 |  13274546176 |

Both variants pass all seven existing `pano_01/stitch` budgets, without changing those budgets. Graph-cut raises reference-excess seam energy by approximately 1.51%, with a small RMSE increase and coverage decrease. The source geometry is identical. The runtime figures are measurements on a shared development host, not a controlled performance qualification.

Reference comparisons use the display PNGs and the existing `pano_metrics.py` normalization at a 2048-pixel long edge. The reference canvas is 18189 × 6464; the harness reports the resulting size mismatch and performs its existing resize. These measurements reproduce the previously reported result rather than establishing an improvement.

## Ghosting diagnostic

`pano_ghost_metrics.py`, exposed through `pano_metrics.py --ghost-evidence`, compares a fixed complete subject region with each fully covering source crop warped onto the same canvas before blending. It selects one coherent source for the entire region, using the sum of photometric and signed-gradient mean-square residuals. Selecting a source independently for each pixel would incorrectly accept a doubled subject.

Three measurements are reported against that same source: photometric RMSE, signed-gradient RMSE, and one-sided source-detail loss. The last measurement charges missing source gradients separately, so removing extra ghost edges cannot cancel the loss of genuine source texture. A default change would require improved ghost residuals, no deterioration in source-detail retention, and the existing whole-image gates. A blurred doubled subject is an explicit regression: blur improves the first two scores, but fails the detail-retention condition.

Regions must be fixed independently of the candidate seam strategies and cover the subject's observed positions. The diagnostic does not infer semantic motion from a residual alone: parallax, illumination changes and calibration errors can also make sources disagree. It cannot assess a region without at least two fully covering sources, and it supplements the whole-image gates rather than replacing them.

The `pano-seam-evidence` diagnostic executable reuses the production stitch, warp, gains and local corrections. It verifies the measured baseline region pixels exactly against an existing scene-linear RGB16 candidate, then exports source crops with coverage alpha. Incomplete sources are excluded; the Python loader rejects missing or nonopaque alpha. The metric uses normalized 8-bit samples from those PNGs, following the existing Python harness's decoding convention, so sub-quantization differences and clipped scene highlights are outside this diagnostic's precision.

## Measured ghost residuals on pano_01

The diagnostic rerun matched every baseline sample in the measured regions exactly. Both seam reports have identical camera, canvas, gain, local-correction summary and frame-retention fields; only seam strategy and timings differ. The two fixed wave regions cover 3,850,000 native canvas pixels. The western region has four fully covering source frames; the foreground region has two. Source inspection confirms changing white-water positions. An initially proposed eastern beach region had only one fully covering source and was rejected before either candidate was scored; its scores are not included.

| Ghost measurement, lower is better |      Voronoi |    Graph-cut |  Change |
| ---------------------------------- | -----------: | -----------: | ------: |
| Photometric RMSE                   | 0.0161264982 | 0.0058580581 | −63.67% |
| Signed-gradient RMSE               | 0.0042943548 | 0.0020152104 | −53.07% |
| Source-detail loss                 | 0.0021555259 | 0.0010191994 | −52.72% |

All three measurements improve in each region, not only in the pixel-weighted aggregate. Both strategies select source index 9 for the western region and source index 15 for the foreground region, so the comparison does not depend on switching the coherent anchor between candidates. The region definitions are in `test-fixtures/pano-motion-rois/pano_01.json`; full numeric results are in [pano-seams-3243.json](pano-seams-3243.json).

This establishes a ghosting improvement on this capture, despite the reference-excess seam-energy regression. It does not establish the required multi-capture evidence for promoting graph-cut. Voronoi remains the shipping default pending that evidence.

## Reproduction and validation

Build the release `maple-cli` with `--features pano` and the release `pano-seam-evidence` binary with `--features ml`. Use the pinned models and ONNX Runtime paths described in `docs/pano.md`. Run both strategies with the same sorted inputs and unchanged defaults:

```bash
maple-cli pano stitch /path/to/pano_01/*.DNG \
  --out /owned/output/voronoi/linear.png \
  --display /owned/output/voronoi/display.png \
  --report /owned/output/voronoi/report.json --seam-strategy voronoi
```

Repeat with separate graph-cut outputs and `--seam-strategy graph-cut`. Generate the source evidence once from the Voronoi linear output and the fixed regions, using a new output directory:

```bash
pano-seam-evidence /path/to/pano_01/*.DNG \
  --candidate /owned/output/voronoi/linear.png \
  --regions test-fixtures/pano-motion-rois/pano_01.json \
  --out-dir /owned/output/evidence
python3 src/scripts/pano_metrics.py \
  --candidate /owned/output/graph-cut/linear.png \
  --reference /owned/output/voronoi/linear.png \
  --ghost-evidence /owned/output/evidence/evidence.json
```

Repeat the last command with the Voronoi candidate and retain each `ghosting` result. Whole-image reference budgets use each **display** candidate against the committed pano reference, separately from this scene-linear ghost diagnostic. Generated source crops and the 256MP output images are local artifacts; originals and their sidecars are never written.

Validation completed: 338 panorama library tests, the native crop/coverage test, seven Python ghost controls including actual PNG/CLI failure cases, and the existing procedural metric self-tests pass. Both real full pano_01 runs pass all seven existing budgets. The ordinary harness in this fresh worktree runs its always-on controls and reports its missing-RAW skip; it is not counted as another full fixture run. Formatting, file-budget and headroom checks pass. No Apple UI or color-pipeline production stage changed.

## Remaining fixture requirement

All inspected worktrees contain the same five distinct pano sets. `pano_01` is the qualifying real rotation capture. `pano_02` is the static synthetic ring generated by `gen_pano_02.sh`. The real `pano_00`, `pano_03` and `pano_04` captures are nadir mapping strips; their existing budget records identify the tile strategy, where the graph-cut option has no effect. A subset of `pano_01` would not provide evidence from another independent capture.

A second rotation capture with moving subjects or other observed scene motion is required before this comparison can satisfy #3243. Treating a tile-path no-op or relabelled subset as that second capture would provide misleading evidence for a global default change.
