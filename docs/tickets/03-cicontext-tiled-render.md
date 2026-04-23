# Tighten CIContext: tiled render, fp16 intermediates, no cache

## Context

Current `CIContext` usage (see `ImageEditPipeline` / `EditSession`) does not
explicitly configure intermediate format, caching, or tile size. Defaults:

- `cacheIntermediates: true` — Core Image keeps every filter's output alive
  between renders. On a 100 MP image with ~6 filters in the chain this is
  several GB of implicitly retained CVPixelBuffers.
- `workingFormat: .RGBAf` — 32-bit float per channel. Doubles memory vs.
  `.RGBAh` (fp16) for no perceptible quality difference in LDR workflows.
- No `outputColorSpace` hint — CoreImage re-derives the conversion per render.

For export at 100 MP the render target itself is ~1.6 GB at fp32 RGBA, which
can't fit in a single allocation on memory-constrained devices.

## Proposal

1. Configure the shared `CIContext` with:
   ```swift
   CIContext(mtlDevice: device, options: [
       .workingFormat: CIFormat.RGBAh,
       .cacheIntermediates: false,
       .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB),
       .outputColorSpace: CGColorSpace(name: CGColorSpace.displayP3),
   ])
   ```
2. For export, render in tiles: iterate over the output rect in N-row strips
   (e.g. 512 or 1024 rows), render each strip into a reusable MTLTexture,
   and stream encoded bytes out to the destination (`CGImageDestination` for
   JPEG/HEIC/PNG/TIFF accepts tile-by-tile data via the right configuration).
3. For display (if ticket #02 isn't in yet), render with
   `render(_:to:CVPixelBuffer, bounds:colorSpace:)` against a screen-sized
   pixel buffer so Core Image's planner never materializes the full-res
   intermediate.

## Acceptance criteria

- Single shared `CIContext` instance on the app (not one per render).
- Intermediate format is fp16 (`RGBAh`), not fp32, unless a specific pipeline
  stage (HDR, extreme tone-curve) needs more headroom — document those.
- `scripts/test_color_pipeline.sh` passes with the existing ΔE budget (this
  is the critical guard-rail: fp16 must not regress color).
- Export of the reference 100 MP DNG to JPEG / HEIC / TIFF succeeds on an
  iPhone (not just iPad Pro).
- Measured peak RSS during export is within 2× of the output buffer size, not
  6–8× as today.

## Pointers

- `Packages/MapleCore/Sources/MapleCore/Pipeline/EditSession.swift` —
  CIContext creation site.
- `Packages/MapleCore/Sources/MapleCore/Export/ExportEngine.swift` —
  full-res render target; primary beneficiary of tiling.
- `Packages/MapleCore/Sources/MapleCore/Pipeline/ImageEditPipeline.swift`.

## Notes / risks

- fp16 color regressions are the main risk. Soft-proofing modes and extreme
  tone curves can clip differently. The color-pipeline harness catches this,
  but watch specifically for ΔE at the highlights / shadows percentiles, not
  just the mean.
- `cacheIntermediates: false` trades memory for recompute. For the display
  path with many slider-driven re-renders we may want it back ON once
  ticket #02 downsamples the input. The combination "display path + cache ON"
  is fine; "export path + cache OFF" is the rule.
- Tile-based export needs a destination that accepts incremental writes.
  `CGImageDestination` does (via `CGImageDestinationAddImage` on sub-regions
  with `kCGImageDestinationLossyCompressionQuality`), but HEIC may need
  `ImageIO`'s newer progressive API — verify before implementing.

## Estimated impact

Directly unblocks exporting large RAW on iPhone and older iPads. Also reduces
steady-state memory during editing by ~30–50% on top of what ticket #01 and
ticket #02 save.
