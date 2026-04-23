# Downsampled display preview for >50 MP RAW (honor the spec invariant)

## Context

`CLAUDE.md` states: _"Metal-backed pipeline end-to-end. Tile-based for >50MP RAW."_
The app does not currently honor this. Every decode — browse grid selection,
detail view, full-image mode — produces a full-resolution CIImage (100 MP for
the reference Hasselblad DNG) and pipes the whole thing through the edit chain
before the CIContext downscales at render time.

Concrete consequences:

- iPad screen is ~3 MP. We compute ~30× more pixels than we display.
- Every CIFilter intermediate (tone curve, WB, HSL, etc.) allocates at full
  resolution. With fp16 intermediates that's ~800 MB per live buffer the
  pipeline can't discard yet.
- Slider response is slow because each adjustment re-renders 100 MP worth of
  filter chain, even though only a tiny downsampled preview is visible.

This is the design-level fix. It supersedes a lot of low-level micro-tuning.

## Proposal

Introduce two render paths on `EditSession` / `ImageEditPipeline`:

1. **Display path** — operates on a downsampled `CIImage` sized to fit
   `max(screenResolution, 1:1-zoom crop)`. Used for the grid, detail,
   filmstrip, and full-image view. Target ~6–8 MP ceiling.
2. **Full-res path** — operates on the full `CIImage`. Used by `ExportEngine`
   and triggered by 1:1 zoom in the full-image view.

The display `CIImage` is produced by applying a Lanczos (or CIAffineClamp +
CILanczosScaleTransform) to the decoded full-res CIImage. Because CIImage is
lazy, the full-res never materializes in RAM when only the display path is
active — the scale happens inside CoreImage's render plan.

Edits apply to a shared `AdjustmentModel` and are rendered through whichever
path is active; WB/tone/HSL sliders exclusively hit the display path.

## Acceptance criteria

- Browse grid, detail view, and full-image view at fit-to-screen use the
  display path.
- 1:1 zoom in full-image view transparently switches to a full-res crop (only
  the visible tile is rendered, not the whole image).
- Export uses the full-res path; `scripts/test_color_pipeline.sh` still passes
  with the same ΔE budget.
- Slider response time (WB / Exposure / Contrast) is < 16ms per frame on a
  100 MP DNG on iPad Pro M4.
- Peak RSS when opening the reference DNG and adjusting a slider is under
  ~1 GB on a 100 MP image.

## Pointers

- `Packages/MapleCore/Sources/MapleCore/Pipeline/EditSession.swift` —
  currently caches the full-res decoded CIImage and re-renders the full chain
  on every adjustment change.
- `Packages/MapleCore/Sources/MapleCore/Pipeline/RenderedPreviewCache.swift`
  — existing cache seam; may be the right place to hook the display path.
- `Packages/MapleCore/Sources/MapleCore/Pipeline/ImageEditPipeline.swift`.

## Notes / risks

- Scopes (`ScopesTabView`) MUST sample from the full-res render, not the
  display path, or histograms/waveforms will lie. This is a real design
  question: either render scopes separately off the full-res path on a lower
  cadence, or accept that scopes reflect a downsampled approximation (matches
  what Lightroom / Capture One do).
- When switching to 1:1 zoom, the display path's cached render should NOT
  be reused — we want the full-res chain to re-evaluate on the visible tile.
  This is where ticket #03 (CIContext tiled render) starts to matter.

## Estimated impact

Largest single memory and latency win of the three tickets. Probably halves
working set and makes sliders feel instant on large RAW.
