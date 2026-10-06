# Mac removal research app

Native macOS research UI for [#4323](https://github.com/zubair-io/Maple/issues/4323), following the [October 6 comparison](../research/2026-10-06/README.md) and its user review: retain both LaMa and Qwen, use guided texture transfer, omit the rejected shared-latent diffusion configuration.

## Use

Build with `python3 tools/removal/mac-prototype/build.py`, then open `~/Applications/Maple Removal Lab.app`.

1. Open a RAW through **Open RAW…**. The preview uses the shared Rust Auto render with As-Shot WB, no automatic exposure or lens profile correction. Existing sidecar edits are deliberately excluded from this isolated research tool.
2. Paint the object and its shadow with **Remove**. Use **Protect** for nearby subjects, **Erase** to clear either mask, and Undo/Redo to revise strokes. Brush coordinates follow the upright photo and are converted back to native DefaultCrop coordinates for reconstruction.
3. Describe the object/background for Qwen, then choose **Generate both candidates**. LaMa runs first; its completed result is reviewable while Qwen runs. Step progress, per-model errors and cancellation are visible. Model execution is sequential to avoid simultaneous model residency.
4. Compare original, LaMa and Qwen, or switch to the native-pixel view. Auto/Neutral, exposure −3/0/+3 EV and WB −1000/0/+1000 K controls select actual Rust RAW grade renders.
5. **Prefer LaMa/Qwen** records a research preference. **Show session files** reveals the complete result. **Open saved session…** restores the selection, prompt, candidates and preference without rerunning models.

This is a standalone exploration tool. It does not install into the existing Maple app, apply removals to XMP, export a corrected whole photo, or stack multiple removals. Originals and their existing sidecars are never written. Sessions are stored beneath `~/Documents/Maple Research/Mac Sessions`; this is local storage, not an off-device backup. Choose a generation-session folder, containing `request.json` with a `source` entry, when reopening.

## Photographic path and limits

- The shared Rust `removal-scene-probe preview` adapter provides an upright selection preview and exact native dimensions/identity. No new color math is implemented in Swift or Python.
- The complete painted intent selects a 1024 or 2048 native context with margin. Oversized selections fail before model work; they are never silently clipped or split into model tiles. Texture transfer's existing 2048 limit is enforced here.
- The context uses the existing fixed AgX/sRGB research encoding, then upright orientation and Lanczos reduction to 512 for both coarse models. The +16 model-pixel expansion and native 4-pixel blend feather follow the reviewed experiment. Context size, orientation, mask and prompt vary with the new user selection; this is not a pixel-identical replay of the old fixtures.
- LaMa uses the pinned original Big-LaMa checkpoint with CPU float32 inference. Qwen uses the pinned Image Edit 2511 q8 checkpoint, seed 0, 40 steps and guidance 4. Both validate model files; Qwen preserves the audited lossless RMSNorm shape normalization and strict loading.
- Predictions return to native coordinates. The exact existing RGB-guided PatchMatch implementation transfers native donor texture, excluding protected regions. One candidate's failure does not discard the other.
- Each candidate runs the existing Rust `bake` path, including its approximate SDR inverse, fp16 patch codec and 18 grade combinations. All 18 grade outputs must preserve outside-coverage and protected pixels exactly before that candidate is published to the UI. The source is identity-checked against opening and checked again after generation.

The SDR inverse remains an experimental limitation. This app does not qualify HDR reconstruction, photographic quality, all camera calibrations, or the shipping RAW edit contract. Perceived quality is still reviewed by the user. Automatic people detection and smart selection remain outside this research app; this version explores the reconstruction recipe with manual masks.

## Local runtime and recovery

`build.py` rebuilds the Rust research binary and Swift executable, copies Python helpers and the Qwen manifest into the app bundle, and ad-hoc signs the local app. `runtime.json` records local dependency locations. There are no new app environment variables or network inference endpoints.

The existing provisioned cache at `~/.cache/maple-removal-research` supplies:

- `powerpaint-env/bin/python3.11` plus `lama-runtime-20261004` for LaMa dependencies;
- `lama-source-20261004` and `lama-weights-20261004/big-lama`;
- `comparison-mlx-env/bin/python3` and `comparison-qwen-weights`.

Model weights and photo artifacts are not committed. Missing dependencies produce a visible model error. Rebuilding an ad-hoc signed app can change macOS privacy authorization; use the native RAW picker to authorize the chosen file. The development `--raw <path>` launch shortcut does not grant file access. `--session <folder>` restores an existing generation session.

Worker output includes `request.json`, `status.json`, `result.json`, logs, source/context identity, masks, coarse/native predictions, model settings, texture-transfer reports, all RAW grade renders and their preservation receipts. `review.json` contains the optional preference. A cancelled session retains completed files and completed candidates, without starting a background continuation.

## Checks

```bash
~/.cache/maple-removal-research/powerpaint-env/bin/python3.11 \
  -m unittest discover -s tools/removal/mac-prototype -p '*_test.py' -v
uvx ruff check tools/removal/mac-prototype
uvx ruff format --check tools/removal/mac-prototype
xcrun swift-format lint --strict tools/removal/mac-prototype/Sources/RemovalLab/*.swift
```

The geometry tests cover all eight EXIF orientations, native mask placement, protection precedence, erasing, complete-context bounds and invalid/oversized selections. Live app verification and real model/RAW checks are recorded in the issue; preservation checks are not a visual-quality verdict.
