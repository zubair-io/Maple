# AI removal research handoff — October 5, 2026

This is a preserved research checkpoint for [#3941](https://github.com/zubair-io/Maple/issues/3941), not a shipping feature or a merge-ready branch. Start a new session here. Work still required is tracked in that issue and the canonical design documents; the files here describe completed experiments and how to recover them.

## Source and product documents

- Checkpoint branch: `codex/removal-research-handoff`.
- Historical source base: `edbf50086e1eccebc7bb6ed1e012d9eadf82b27e`. It intentionally retains the experiment's base rather than rebasing against newer main before preservation.
- Unsuccessful application prototype: [draft PR #4239](https://github.com/zubair-io/Maple/pull/4239), `codex/ai-object-removal`.
- Useful independent extraction: [binary16 shadow encoding fix #4240](https://github.com/zubair-io/Maple/pull/4240), merged October 5.
- [PRD](https://chatgpt.com/space/page_4c1035a13efc8191b39a4a264e32144d) and [Engineering RFC](https://chatgpt.com/space/page_7fd972e84c3c81919405004ebda76895) contain the current Mac-first scope and two-model candidate direction. Frozen copies are included under `documents/`; live Pages remain canonical.

## What is preserved

| Directory                                      | Evidence                                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-quality-9ikrgf16/`                    | Earlier photographic/RAW LaMa harness and controls.                                                                                 |
| `moebius-quality-yzitv43p/`                    | Moebius and LaMa 512 comparison, reviewed mask controls and RAW bake scripts.                                                       |
| `three-model-quality-20261005/`                | 90 completed generations: 30 LaMa, 40 Klein, 20 Qwen; protocols, checkpoint manifests, source hashes, control metrics and findings. |
| `three-model-quality-20261005/mask-expansion/` | 24 new LaMa/Qwen generations, original and expanded coverage composites, protection assertions, grade checks and findings.          |

The Rust research example and its `encoding`, `large_masks`, and `masks` modules are preserved in `src/raw-pipeline/raw-core/examples/`. They admit research contexts of 1024/1536/2048/3072 pixels and fixed inference exposure, using shared mask preparation. These are example-only changes; they do not increase the application's qualified native extent.

`snapshot-manifest.json` records the original cache source and SHA-256 for each captured runner/evidence file. These are historical experiment scripts, with local absolute paths and import assumptions. They are not an installed tool or a portable one-command benchmark. Do not execute preparation scripts against completed results: some overwrite inputs. Start a separate experiment directory and audit all paths first. Recorded original bytes also remain in the local backup, independently of formatting and lint cleanup in this branch. Cleanup removes unused imports, uses context-safe JSON reads and dictionary literals, and explicitly binds per-run decoder callbacks; model settings are unchanged. Inference was not rerun for this preservation pass.

## Results and limits

LaMa and Qwen both show useful results, with different strengths. Qwen's expanded wood-table fill is promising; LaMa is more consistent at actually removing people in the retained failure control. Expanded masks do not cure every problem: Qwen still regenerates a person in camera case 1/seed 1, and the indoor floor can retain a pale person-shaped region or foot oval. LaMa's corresponding floor is less conspicuous but soft. Kept-subject overlap remains difficult.

The 512 input is a downsampled RGB rendering of a native context crop, **not native-resolution synthesis**. Native crop sides for cases 1–5 are 1024, 2048, 3072, 2048 and 1536 pixels. Current predictions are enlarged with bilinear interpolation and composited through the native mask. Gallery labels such as native/100% describe the display scale, not recovered detail. No generative upscaler or guided detail pass has been tested in this checkpoint.

- LaMa: 512/768/1024, deterministic CPU float32 single pass.
- FLUX.2 Klein 4B: 512/1024, seeds 0/1, q8, 4 steps, guidance 1, MLX.
- Qwen Image Edit 2511: 512, seeds 0/1, q8, 40 steps, guidance 4, MLX; no Lightning adapter. Qwen 1024 was interrupted early and has no completed quality result.
- Expansion: +8/+16 pixels at model resolution, unchanged input bytes/settings/seeds. Five RAW cases plus camera case 1/seed 1, two models, 24 predictions and 48 composites.
- Expansion validation recorded 576 outside-coverage/protected-pixel checks over 32 grade sets. The baseline comparison recorded 864 outside-coverage checks, including identity and resize controls. These checks do **not** establish perceptual fill quality.
- Five originals were hash-checked unchanged. Masks were assistant-reviewed, not human-certified ground truth. There is no hidden-background reference.
- Case 5's saved outputs lack calibrated RAW/WB qualification. Issue #4283 is now closed, but these historical runs have not been rerun against a validated camera change. Do not silently relabel them as qualified.
- Fixed photographic AgX/sRGB input and experimental inverse conversion are not proof of HDR/gamut recovery. Runtime measurements on a 128 GiB M5 Max included concurrent work and are not deployment benchmarks.

Detailed observations are in `visual-notes.json` and `mask-expansion/findings.json`. Frozen protocols retain their historical statements even where later issue status changed.

## Recovery on this Mac

The complete three experiment directories (images, float predictions, masks, reports, grades and scripts) have local copies outside the cache:

`/Users/riabuz/Documents/Maple Research/removal-checkpoint-2026-10-05/`

`artifact-manifest.json` there inventories copied files and their SHA-256 digests. This is a local copy on the same disk, not off-device disaster recovery. Photos, generated images and model weights are deliberately not in GitHub. The Git checkpoint contains source and text evidence. The original RAW fixtures remain in `/Users/riabuz/Desktop/test`.

The working cache remains `/Users/riabuz/.cache/maple-removal-research`. View the preserved gallery without running inference:

```bash
python3 -m http.server 8771 --bind 127.0.0.1 \
  --directory '/Users/riabuz/Documents/Maple Research/removal-checkpoint-2026-10-05/three-model-quality-20261005'
```

Open `http://127.0.0.1:8771/` or `http://127.0.0.1:8771/mask-expansion/`. If port 8771 is already serving the cache copy, keep that server or use another port. Gallery/report links are local assets; no remote service is needed to review saved results.

For regeneration, restore a **working copy** of the backed-up experiment tree, inspect absolute paths in scripts/manifests, and use the pinned environments below. Existing completion JSON files cause runners to skip completed jobs. Preserve them; do not delete results merely to trigger a rerun.

| Component           | Existing local dependency                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| LaMa Python         | `~/.cache/maple-removal-research/powerpaint-env/bin/python3.11`                                                               |
| LaMa source/runtime | `lama-source-20261004` / `lama-runtime-20261004` under the cache; source rev `786f5936b27fb3dacd2b1ad799e4de968ea697e7`       |
| LaMa weights        | `lama-weights-20261004/big-lama/models/best.ckpt`; SHA-256 `fccb7adffd53ec0974ee5503c3731c2c2f1e7e07856fd9228cdcc0b46fd5d423` |
| MLX environment     | `comparison-mlx-env`, Python 3.14, mlx 0.32.3, mlx-gen 0.38.0                                                                 |
| MLX source          | `comparison-mlx-source`, rev `99fb94dd3eaa9dd1931cd3cd8eae1ae3e20f2ef3`                                                       |
| Qwen weights        | `comparison-qwen-weights`; exact repository/revision/file hashes in `qwen-manifest.json` and `model-verification.json`        |
| Klein weights       | Exact local path/repository/revision/file hashes in `klein-manifest.json` and `model-verification.json`                       |

Model weights and Python environments remain cache dependencies and may need reprovisioning after cache loss. The manifests preserve pins; this checkpoint does not redistribute weights or certify their deployment licenses. MLX runners enforce strict loading, permit only the documented lossless Qwen VAE norm singleton reshape, assert finite latents and capture float decoder output before PIL conversion.

Rust example check from this repository:

```bash
cd src/raw-pipeline
cargo test -p raw-core --example removal-scene-probe
```

## Session boundaries

The user requested preservation before the next test. No new detail-refinement experiment was started. #3941 records the proposed next comparison and current design decisions. The two-model candidate UI, memory-aware scheduling and native-detail refinement are **not implemented** by these standalone tests. The existing Mac app still uses the old experimental integration; this checkpoint does not rebuild or qualify it.

The original checkout at `~/.codex/worktrees/2c7f/_Maple` has extensive pre-existing deletions and generated files. The older `removal-quality-spike/_Maple` checkout has a separate uncommitted `ucm_mapping.rs` camera edit. Neither was restored, stashed, committed or discarded. This checkpoint was assembled in isolated `removal-research-checkpoint/_Maple` and includes only the four research example changes plus captured research assets/documentation. Do not blindly stage the other worktrees during a new session.
