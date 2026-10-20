# Auto / embedded-JPEG color handoff

Updated 2026-10-20. **Stopped at the user's request. Do not resume without their instruction.**

## State and ownership

- Worktree: `/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple`
- Branch: `codex/color-suite-progress`
- Draft PR: https://github.com/zubair-io/Maple/pull/5003
- Tracking issue: #5000.
- Last implementation/evidence HEAD before this handoff: `25a28898ce` (pushed).
- Working tree was clean before writing this document. Runtime source contains only the retained changes; experimental runtime edits were restored.
- The full adaptive-gray experiment was interrupted through exec session `84626`; it exited 130. Process inspection found no remaining experiment CLI or qualification-runner process.
- Goal pause was requested via the goal tool, but it returned `cannot update goal because this thread has no goal`. Work is stopped regardless; do not claim a persisted paused status.

## User constraints

- Keep pushing verified chunks to the draft PR; **do not merge**, mark ready, or push main.
- Avoid rebase/CI loops. Local rebases only when actually needed.
- Do not bump color pipeline version (37) or fit version (7).
- Preserve Neutral's AgX appearance. Auto targets the camera's embedded JPEG.
- ACR comparisons must not remain CI/color acceptance targets.
- Preserve original RAWs, JPEGs, reference bytes, color/detail/banding limits.
- Keep lens corrections enabled. Align comparison coordinates rather than disabling corrections or forcing JPEG framing.
- Cover all 16 JPEG-bearing fixtures, plus exact Auto=Neutral for the four previewless fixtures.
- Numeric passing is insufficient: inspect images, especially the previously misleading passes.
- No permission for autonomous subagents. Do not touch unrelated worktrees.

## Authoritative retained checkpoint

Evidence root below is `/Users/riabuz/.codex/color-suite-evidence/5000` (abbreviated E).

`E/auto-jpeg-combined-gate/summary.json` is the latest **complete retained** 20-RAW run:

- 6 combined passes, 10 failures, 4 exact fallback passes, 0 errors.
- Photographs: 10 pass, 6 fail: `0000`, `0005`, `0006`, `0007`, `0015`, `0017`.
- Gradients: 11 pass, 5 fail: `0005` (neutral and blue), `0008` (magenta), `0009` (neutral), `0010` (neutral), `0012` (neutral).
- Previewless: `0001`, `0018`, `0019`, `0020`; exact Auto=Neutral.
- All 20 original RAW hashes verified. All 16 photo outputs/reference PNGs match the retained baseline bytes.
- Repo compact record: `auto-jpeg-combined-gate/summary.json` under this experiments directory.
- Latest full-size swap/zoom gallery: `E/auto-jpeg-combined-gate/gallery/index.html`.
- Older galleries and aliases can show stale 5-pass/11-fail results; do not use them as current status.

Frozen retained executables:

- `E/auto-jpeg-stage-diagnosis/ramp-maple-cli`: authoritative retained photo/gradient baseline.
- `E/auto-jpeg-coarse-resolution/sparse-grid9-maple-cli`: retained sparse solver, same test_0015 PNG bytes.
- **Do not use `src/raw-pipeline/target/release/maple-cli` without rebuilding. It currently contains the diagnostic geometry override, despite clean source.**

## Most important new finding: geometry affects the color fit

The latest experiment gives direct evidence for the user's lens-alignment hypothesis.

`E/auto-jpeg-geometry-oracle/` contains:

- `aligned-preview.png`: embedded JPEG resampled with the comparator's measured, bounded radial correspondence.
- `oracle.patch`: temporary, hardcoded diagnostic override of the paired fitter's preview. **Never apply as production code.**
- `maple-cli`: frozen diagnostic executable, valid only for test_0015.
- `pilot/summary.json`: completed physical photograph + five gradient checks.
- `comparison.jpg`: visually inspected current / measured-geometry / embedded-JPEG comparison.

For test_0015 (Pixel 6 Pro, orientation 1):

| Metric | Retained Auto | Measured geometry diagnostic |
| --- | ---: | ---: |
| Mean ΔE2000 | 4.2063 | 3.3924 |
| P95 ΔE2000 | 12.0391 | 9.9331 |
| Display-quality breaches | 93 | 24 |
| Five gradient checks | pass | pass |

The diagnostic visibly restores foliage contrast. It still fails overall; this is **not a production fix**. Lens correction remains enabled and the original JPEG used for qualification is unchanged. The altered preview is only fitter input. The outer ~0.12% without correspondence is edge-resampled, a diagnostic limitation.

The runtime fitter's previous diagnostic used an affine warp and ultimately selected `original-paired`. The comparator finds a real radial residual: held-out landmark median improves from ~1.014 to ~0.376 px at its fitting size. This is stronger evidence than the earlier failed runtime radial experiment.

### Next promising investigation (not implemented)

`fit_registration::estimate` treats the observations as a regular image grid. But `paired_observations::build_at_scale` chooses a pseudo-random pixel within each grid cell. At display resolution 1024 with a grid capped at 256, the samples are spatially jittered, rather than a true dense thumbnail. That can obscure the small radial displacement the fitter needs to recover.

Inspect this hypothesis before more color-model tuning:

1. Supply actual regularly sampled/BOX-averaged geometry thumbnails to registration, with correct orientation/aspect crop and eval-before-BOX semantics.
2. Verify registration against known synthetic affine/radial distortions and the independently measured correspondence.
3. Recover bounded radial correspondence automatically, retaining coverage, Jacobian and hold-out geometry checks.
4. Qualify all 16 photographs and gradients, plus all 4 fallbacks; review images.

A previously rejected radial implementation exists at `bad547f3d6` and was reverted by `507b96afb3`. It operated on the old registration inputs and produced no changes on its three pilots; do not blindly reapply it. New evidence may justify reworking its inputs/estimator.

## Interrupted adaptive-gray experiment

This is separate from the geometry diagnostic and is **not accepted**.

- Frozen candidate: `E/auto-jpeg-adaptive-gray/combined-maple-cli`.
- Patch and identity preserved in this repo at `auto-jpeg-adaptive-gray/`.
- Source was restored to retained HEAD after freezing the executable.
- Changes: allow fine gray-axis adaptation; require unchanged acceptance guards during refinement backtracking.
- Full run: `E/auto-jpeg-adaptive-gray/full-suite/summary.json`; `complete: false`.
- Stopped after ten recorded cases (0000 through 0009). Do not restart automatically; user asked to stop.

Partial observations:

| Fixture | Mean ΔE before → candidate | Gradient before → candidate |
| --- | --- | --- |
| 0000, 0002, 0003, 0005, 0006, 0007 | unchanged | unchanged |
| 0004 | 2.0221 → 1.8765 | **pass → fail (blue ramp)** |
| 0008 | 1.7745 → 1.7213 | fail → pass |
| 0009 | 0.8493 → 0.7779 | fail → fail |

0001 exact fallback passed. No conclusion for the uncompleted fixtures. The new 0004 failure already prevents retaining the candidate as-is. Its blue max second difference rises from ~0.000448 to ~0.001966.

The candidate also conflicts with the existing exact gray-anchor unit contract. Tests were not weakened or rewritten. The committed identity says the run was running; **this handoff supersedes that status: interrupted, incomplete**.

## Other recent investigations and retained changes

- `f4d60ac95b`: sparse multiplication in coarse normal-equation solver. 103 Auto tests passed, 6 existing ignored. test_0015 output byte-identical. Coarse grid remains **9³**, output LUT remains **33³**.
- `4c3d8593d1`: recorded rejected 17³ coarse-grid experiment. Mean ΔE 4.2063→4.1063; still visibly flat, 90 breaches, all five gradients pass. Source restored to 9³.
- `40f0c8fc48`: diagnostic of rejected fine refinement. It improves RGB objective but worsens 24 regional perceptual means beyond the existing 0.1 margin; 22 also regress on training samples, mostly sky. Use snapshot `refinement_display`, not `display`, to reproduce its actual coordinates.
- Guarded backtracking alone: physical test_0015 unchanged, five gradients pass. 102 unit tests pass, one existing exact-fallback assertion fails; test unchanged, candidate discarded.
- Gray adaptation alone: physical test_0015 unchanged, five gradients pass.
- Coarse monotonic projection is not the primary 0015 loss: unprojected replay is similarly poor (~4.300 mean ΔE vs ~4.286 projected replay). Replays differ slightly from production quantization order and are diagnostic only.
- Full coarse neutral-axis freezing was rejected because it broke a legitimate nonlinear eval-before-BOX test. Do not weaken that test.
- Held-out RGB-only predictor improves 0015 to ~3.30 mean ΔE, but still fails. Local-context features add only modest benefit. These are diagnostic capacity probes, not production transforms or gradient-qualified results.

## Earlier retained improvements

- RAF Adobe RGB detection (`98dcabf603`): GFX50S embedded JPEG's EXIF ColorSpace 65535 + Interop R03 was incorrectly treated as sRGB. Corrected shared preview path; 0005 improves but still fails. Original bytes untouched.
- Identity curve-marker removal (`8eff…`): prevents legacy white-knee activation from an identity Auto cache curve. Real FFI tests require `fixtures`; no silent missing-fixture pass.
- Native AMaZE gradient producer (`ae143…`): ramps now use the same native fit as the photograph, rather than RCD. 0005 LUT arrays matched exactly.
- Bounded radial **comparison harness** (`647a5ddc68`): geometry-only SIFT correspondence, RANSAC, spatial hold-out, coverage and Jacobian checks; no color-driven warp selection. Removes false geometry failures while retaining limits.
- Canonical gradient integration (`d679bae94c`, `0cfaf5b683`): every JPEG-bearing fixture runs all five gradient checks. 49 Python harness tests and 4 wrapper tests passed at integration.

## Key files

All repo paths below are relative to the worktree:

- `src/raw-pipeline/raw-core/src/view/auto_profile/paired_fit.rs`
- `.../paired_observations.rs`, `paired_step.rs`, `paired_projection.rs`
- `.../paired_refinement.rs`, `paired_refinement_projection.rs`, `paired_refinement_regions.rs`, `paired_refinement_system.rs`
- `.../fit_registration.rs`, `fit_registration/features.rs`, `fit_registration/optimizer.rs`
- `src/scripts/auto_profile_match.py`, `auto_profile_quality.py`, `auto_profile_alignment.py`
- `src/scripts/auto_profile_radial.py`, `auto_profile_radial_geometry.py`, `auto_profile_gradients.py`
- `src/scripts/test_auto_profile_match.sh`

Additional evidence:

- `E/auto-jpeg-lens-audit/`: all-16 lens diagnostics; controlled distortion-on/off images.
- `E/auto-jpeg-radial-fitter/diagnostic-0015/`: detailed prior, coarse delta, final fit, observations and refinement snapshots. **The `coarse` field is a delta LUT, not a full transform.**
- `E/auto-jpeg-spatial-diagnosis/`: full float pre-Auto prefix, RGB/context capacity probes.
- `E/auto-jpeg-fine-rejection/`: regional replay, rejected backtracking patch, pilot and logs.
- `E/auto-jpeg-coarse-resolution/`: grid experiment and stage replays.
- `E/baseline-cf62d12ddc/CONTINUATION.json`: older working notes; this handoff supersedes stale running-state fields.

## Resuming safely

Wait for user authorization to resume. Then inspect current git state and this document first. Use the worktree above, not the deleted ambient `8b4f/_Maple` path. Rebuild before using target/release. Do not reuse diagnostic executables as production binaries.

User already authorized testing. Preserve normal hooks and conventional commits; no `--no-verify`, no amend. Read AGENTS.md/CONTRIBUTING.md before implementation. File hard limit 600, split headroom 570. Format individual Rust files with `rustfmt --edition 2021 --config skip_children=true`.

Large images and executables are local evidence, not in Git. Some older evidence was backed up to `/Volumes/Projects/maple-color-suite-5000-20261019`; newer evidence is **not confirmed backed up**. Preserve the evidence root during handoff/cleanup.

The quality objective remains incomplete. Nothing in this handoff authorizes merging, tolerance changes, version bumps, or claiming all tests pass.
