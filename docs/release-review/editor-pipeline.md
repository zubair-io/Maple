# Release review: Editor colour and detail pipeline (v0.1.6)

Area 3 of the release feature-story map (rows E1 to E6). Review of `origin/main` at `cf50ef2eca`, by reading the implementation. The 20-fixture RAW corpus (`test-fixtures/raws/`) is not present in this checkout, so no colour, banding or parity harness could be run; every verdict below is a static code review plus the existing gate history.

Profile::Auto as the default is settled by design (CLAUDE.md principle 8) and is not reported.

## Verdicts

| ID  | Feature                                                                                         | Verdict       | Notes                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | White balance: sliders, presets, picker, As Shot, Auto                                          | works with P1 | Open, already tracked colour defects (see below). Windows picker wiring reviewed (`MainWindow.WhiteBalance.cs`); the click-to-normalised-point path is guarded for out-of-image clicks and pans.                        |
| E2  | Tone: exposure, contrast, H/S/W/B, curves, AutoExposure                                         | works         | Curve preparation (`tone_curves/evaluator.rs`) sorts, clamps, de-duplicates equal-x knots and applies the Fritsch-Carlson monotonicity guard; non-finite knots are rejected at XMP import (`xmp/tone_curves.rs:128`).   |
| E3  | Colour: vibrance, saturation, HSL, B&W, grading, profile, highlight recovery                    | works with P1 | Tracked defects #4741 (P3 renders run the sRGB-trained Auto tail) and #4666 (Auto2 dark colours through LUT baking).                                                                                                    |
| E4  | Detail: clarity, texture, dehaze, sharpen, capture sharpening, NR, demosaic, lens, CA, defringe | works with P1 | The decoded-mosaic cache (`decode_cache.rs`) stores the pre-demosaic `RawImage`, which is a pure function of the file bytes, so detail and demosaic edits cannot be served stale. Live-vs-refine seam tracked as #5213. |
| E5  | Effects: vignette, grain, 100 film LUTs                                                         | works with P2 | All 100 catalogue ids have a valid `.mlut` (magic, version 1, size matches payload); category counts match `docs/features.md` (18/12/20/20/10/20). Apple bundles the folder, both Angular apps serve `/film-luts`.      |
| E6  | CPU/GPU/Apple/Web/Windows parity, 16 ms budget                                                  | not verified  | Needs the corpus, a GPU and per-platform builds; none available in this review.                                                                                                                                         |

## Findings

No P0 defects found. Nothing was fixed.

### P1 (already tracked, no new issues opened)

| Area | Finding                                                                                                                                                                                 | Tracking     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| E1   | A live white-balance drag diverges from the refine when the chroma pre-filter or deep denoise is baked into the decode; the refine visibly shifts on landing. Product decision pending. | #5213        |
| E1   | Auto white balance is pulled by dominant subject colour; unresolved Auto WB from an imported XMP is not preserved.                                                                      | #4671, #4669 |
| E1   | Lossy-DNG linearisation: WB/exposure rely on a gamma guess instead of the declared `OpcodeList2` transfer.                                                                              | #5081, #4629 |
| E3   | Display-P3 renders run the sRGB-trained Auto tail on P3-encoded pixels and share the fit with sRGB renders through the cache.                                                           | #4741        |
| E3   | Fitted Auto2 dark colours are not preserved through LUT baking.                                                                                                                         | #4666        |
| E4   | High-amount sharpening produces bright halos.                                                                                                                                           | #4837        |
| E3   | Web e2e `editor-interactions` "persists Auto after Undo/Redo" times out; cause not yet investigated, may be a real undo/redo defect for the Auto profile.                               | #5388        |

### P2

| Area | Location                                                                                    | Finding                                                                                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E5   | `src/raw-pipeline/raw-core/src/stages/vignette.rs:12-24`, `pipeline/develop/mod.rs:358-366` | The vignette ellipse is anchored to the uncropped developed frame, not to the user crop. After a tight crop the darkened corners are cropped away, so the effect weakens or disappears, unlike Adobe's default post-crop vignette. The stage doc still describes the user-crop anchor as future work (#1113 is closed). |
| E5   | `src/raw-pipeline/raw-core/src/stages/film_look.rs:92-105`                                  | The film LUT is sampled on sRGB-clamped input, so saturated Rec.2020 colours outside the sRGB cube blend toward the clamped film result. This is documented behaviour, listed here only because it limits wide-gamut film looks.                                                                                        |
| E4   | `src/raw-pipeline/raw-core/src/stages/capture_sharpening.rs:118-123`                        | Luminance weights are Rec.709 although the plane is Rec.2020; the file comment already notes this and defers it to the parity harness.                                                                                                                                                                                  |

## What could not be verified

- Colour accuracy, banding, slider-matrix and CPU/GPU pixel-parity harnesses (E2 to E6): no RAW fixtures, host load above 40, and no prebuilt Rust target in this worktree.
- The 16 ms slider budget on the reference scene set (E6).
- Windows behaviour (E1, E4, E6): reviewed from source on macOS only.
- The cause of the `persists Auto after Undo/Redo` e2e timeout (#5388).
