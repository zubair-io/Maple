# Decode RAW directly into an MTLTexture (skip CGImage)

## Context

After the no-copy `CGDataProvider` fix in `RawPipeline.swift:makeCGImage`, peak
decode RSS is ~1× the demosaiced buffer (400 MB for a 100 MP DNG) instead of
~2×. The CPU-side buffer still survives as long as any CIImage derived from
the CGImage is alive, because Core Image keeps the CGImage's data provider
retained through the render chain.

The display path is:

```
Rust buffer (u8 RGBA) → CGImage (ref) → CIImage(cgImage:) → CIContext render → MTLTexture
```

Core Image uploads the pixels to an IOSurface-backed texture on first render,
but the CPU-side CGImage stays alive the whole time — so for a 100 MP image
the process holds ~400 MB CPU + ~400 MB GPU = ~800 MB steady-state, before
any edit filters run.

## Proposal

Decode straight into an `MTLTexture` and release `DemosaicedImage` immediately:

1. On decode, create an `MTLTexture` with `.rgba8Unorm` (or `.rgba16Unorm` if we
   move the Rust pipeline to 16-bit output) at the demosaiced size.
2. Upload via `MTLTexture.replace(region:mipmapLevel:withBytes:bytesPerRow:)`
   using `DemosaicedImage.pixelData.baseAddress`.
3. Drop the `DemosaicedImage` reference.
4. Wrap with `CIImage(mtlTexture:options:)` using the sRGB color space.

Everything downstream (`EditSession`, `ImageEditPipeline`) keeps consuming a
`CIImage`, so the change is isolated to `RAWDecodeEngine.decodeRAWViaRust`.

## Acceptance criteria

- `RAWDecodeEngine.decodeRAWViaRust` no longer calls `makeCGImage()` for the
  display path. (Export can still use it if convenient.)
- On the reference 100 MP Hasselblad DNG, peak CPU-side RSS during decode is
  bounded by ~1× buffer (~400 MB) + a transient staging copy during the upload,
  NOT ~2× as today.
- `scripts/test_color_pipeline.sh` passes with the existing ΔE budget —
  color output is unchanged.
- The existing MTLDevice / MTLCommandQueue used elsewhere in the edit pipeline
  is reused; don't create a second device just for upload.

## Pointers

- `Packages/MapleCore/Sources/MapleCore/Pipeline/RAWDecodeEngine.swift:120-139`
- `raw-pipeline/RawPipeline/Sources/RawPipeline/RawPipeline.swift` —
  `DemosaicedImage.pixelData` is already set up for zero-copy GPU upload
  (comment on line 54 says exactly this was the intent).

## Notes / risks

- `CIImage(mtlTexture:)` does NOT apply orientation automatically. If the
  current path relies on `.applyOrientationProperty`, we need to read the
  DNG's orientation tag separately and apply it via `.oriented(_:)`.
- Confirm the Metal texture descriptor uses `.shaderRead` (CIContext renders
  from it) plus `.renderTarget` only if we need to write back, and storageMode
  `.private` on discrete GPUs / `.shared` on unified memory — on Apple Silicon
  `.shared` lets the upload avoid a staging blit.

## Estimated impact

~400 MB peak RSS reduction on 100 MP decodes. Smaller-image decodes scale
proportionally. Combined with the no-copy `CGImage` fix already landed, this
brings total decode overhead to ~1× the pixel buffer.
