# Image Pipeline & Editing

The image pipeline takes a RAW (or standard) file from disk, decodes it into a GPU-backed CIImage, applies a chain of adjustments as lazy CIFilters, and renders the result to a CGImage for display or export.

---

## Decode

```
RAW file on disk
  │
  ▼
RAWDecodeEngine.decode(url:)
  │  Creates CIRAWFilter(imageURL:)
  │  Sets neutral decode: exposure=0, temperature=6500K, tint=0
  │  Calls CIRAWFilter.outputImage → lazy CIImage
  │
  ▼
decodedImage: CIImage  (cached in EditSession — never re-decoded
                         unless the user switches to a different image)
```

The decode is always **neutral** — white balance and exposure are applied as post-decode CIFilters. This means changing the exposure slider costs ~30ms (a filter chain re-evaluation), not ~300ms (a full RAW re-decode).

For non-RAW files (JPEG, HEIC, PNG, TIFF), `CIImage(contentsOf:)` is used instead of `CIRAWFilter`.

### Why Neutral Decode?

RAW decoding involves demosaic, color matrix, and white balance — all in linear light with full bit depth. Historically, WB and exposure were baked in at decode time for best quality. We trade a small quality delta for a 10x latency improvement: the user can drag the exposure slider at 30ms/frame instead of waiting 300ms per change.

The decode runs off the main actor via `Task.detached` so the UI thread is never blocked during the ~300ms demosaic.

---

## Filter Chain

`CIFilterMapping.apply(_:to:)` composes a lazy CIImage chain. No pixels are computed until a render call.

```
decodedImage (neutral CIImage)
  │
  ├─ 0a. CITemperatureAndTint   (WB: neutral=6500/0 → target=user's Kelvin/tint)
  ├─ 0b. CIExposureAdjust       (EV stops, linear-light)
  ├─ 1.  CIColorControls        (contrast: -100..+100 → 0.25..1.75)
  ├─ 2.  CIHighlightShadowAdjust (highlights + shadows)
  ├─ 3.  CIToneCurve             (whites + blacks via 5-point curve)
  ├─ 4.  CIVibrance              (saturation-aware boost)
  ├─ 5.  CIColorControls         (saturation: -100..+100 → 0..2)
  ├─ 6.  CIUnsharpMask           (clarity: large radius ~40px)
  ├─ 7.  CIUnsharpMask           (texture: small radius ~3px)
  ├─ 8.  CIColorControls + CIGammaAdjust (dehaze approximation)
  ├─ 9.  CIUnsharpMask           (sharpening: user radius + intensity)
  └─ 10. CINoiseReduction        (luminance + color NR)
  │
  ▼
processed: CIImage (lazy — still no pixels)
```

Each filter is skipped (identity pass-through) when its slider is at the default value. The chain order matches Adobe Camera Raw for sidecar compatibility.

### Slider Ranges

| Slider         | Field           | Range          | Default | CIFilter                        |
| -------------- | --------------- | -------------- | ------- | ------------------------------- |
| Exposure       | `exposure`      | -4 … +4 EV     | 0       | CIExposureAdjust                |
| Temperature    | `temperature`   | 2000 … 12000 K | 6500    | CITemperatureAndTint            |
| Tint           | `tint`          | -100 … +100    | 0       | CITemperatureAndTint            |
| Contrast       | `contrast`      | -100 … +100    | 0       | CIColorControls                 |
| Highlights     | `highlights`    | -100 … +100    | 0       | CIHighlightShadowAdjust         |
| Shadows        | `shadows`       | -100 … +100    | 0       | CIHighlightShadowAdjust         |
| Whites         | `whites`        | -100 … +100    | 0       | CIToneCurve                     |
| Blacks         | `blacks`        | -100 … +100    | 0       | CIToneCurve                     |
| Vibrance       | `vibrance`      | -100 … +100    | 0       | CIVibrance                      |
| Saturation     | `saturation`    | -100 … +100    | 0       | CIColorControls                 |
| Clarity        | `clarity`       | -100 … +100    | 0       | CIUnsharpMask (r=40)            |
| Texture        | `texture`       | -100 … +100    | 0       | CIUnsharpMask (r=3)             |
| Dehaze         | `dehaze`        | -100 … +100    | 0       | CIColorControls + CIGammaAdjust |
| Sharpen Amount | `sharpenAmount` | 0 … 150        | 0       | CIUnsharpMask                   |
| Sharpen Radius | `sharpenRadius` | 0.5 … 3.0      | 1.0     | CIUnsharpMask                   |
| NR Luminance   | `nrLuminance`   | 0 … 100        | 0       | CINoiseReduction                |
| NR Color       | `nrColor`       | 0 … 100        | 25      | CINoiseReduction                |

---

## Render

```
processed CIImage
  │
  ▼
ImageEditPipeline.renderPreview(processed, targetSize:)
  │  Scales down if targetSize < extent (never upscales)
  │  CIContext.createCGImage(scaled, from: extent)  ← GPU render happens HERE
  │
  ▼
CGImage → assigned to EditSession.previewImage → SwiftUI Image() displays it
```

The `CIContext` is Metal-backed (`MTLCreateSystemDefaultDevice()`), uses extended linear sRGB working space, and outputs Display P3. Tiling for large images is handled automatically by Core Image.

---

## Two-Phase Rendering

To keep sliders responsive while supporting pixel-perfect zoom:

| Phase      | Debounce   | Target Size                             | Purpose                                              |
| ---------- | ---------- | --------------------------------------- | ---------------------------------------------------- |
| **Fast**   | 50ms       | `previewSize` (viewport in real pixels) | Immediate feedback during slider drag                |
| **Refine** | 300ms idle | `nativeImageSize × min(zoomScale, 1.0)` | Crisp pixels when zoomed in, up to native resolution |

The refine pass only fires when the refined target exceeds the fast target by more than 1 pixel. At fit zoom, both targets are the same size, so refine is skipped entirely.

After the refine completes, the rendered preview is persisted to the disk cache (see [Caching](./caching.md)) so future cold-opens of the same image are instant.

---

## Editing Lifecycle

```
User clicks image in grid
  │
  ▼
AppShell.onChange(of: appMode)
  │  Calls editSession.beginEditing(asset:source:)
  │
  ▼
EditSession.beginEditing:
  1. Load as-shot WB from CIRAWFilter metadata
  2. Read XMP sidecar (if exists) → populate adjustments
  3. Check RenderedPreviewCache → if hit, show instantly, decode in background
  4. If no cache: decode RAW (off main actor) → render → show
  │
  ▼
User drags slider
  │  adjustments.exposure = newValue (didSet fires)
  │
  ├─ scheduleRender() — 50ms debounce
  │   └─ decodeAndRender(targetSize: fastTargetSize)
  │       └─ pipeline.process() + renderPreview() → previewImage updated
  │
  ├─ scheduleRefine() — 300ms idle debounce (if zoomed in)
  │   └─ decodeAndRender(targetSize: refinedTargetSize)
  │       └─ renders at higher resolution for crisp zoom
  │       └─ persistCurrentPreviewToCache() — JPEG written to disk
  │
  └─ scheduleSave() — 500ms debounce
      └─ sidecarStore.write(adjustments, for: asset) → .xmp file
      └─ regenerateThumbnail(for: asset) → grid thumb updated
  │
  ▼
User navigates back to grid
  │
  ▼
editSession.endEditing()
  1. Cancel in-flight render/refine/save tasks
  2. Flush final sidecar write
  3. Regenerate thumbnail → fires onThumbnailRegenerated callback
  4. Persist preview to disk cache
  5. Clear all state (decodedImage, previewImage, etc.)
```

### Debounce Timings

| Action                    | Delay              | Reason                                                                     |
| ------------------------- | ------------------ | -------------------------------------------------------------------------- |
| Render (fast preview)     | 50ms               | Responsive slider feedback; avoids rendering every intermediate value      |
| Refine (high-res preview) | 300ms idle         | Only fires once the user stops dragging; avoids expensive renders mid-drag |
| Sidecar save              | 500ms idle         | Batch rapid slider changes into a single disk write                        |
| Thumbnail regen           | After sidecar save | Grid thumbnail reflects the saved state                                    |

### Eyedropper (White Balance Picker)

The eyedropper samples a 5x5 pixel region from the decoded CIImage at the tap location, computes the R/G and B/G ratios to derive a temperature/tint shift, and applies it to `adjustments.temperature` / `adjustments.tint`. The cursor changes to a crosshair while active (macOS).

---

## Export

`ExportEngine` renders the full-resolution processed CIImage to disk:

1. Decode the RAW at neutral settings (same as editing)
2. Apply the full adjustment chain via `CIFilterMapping`
3. Resize if the user selected a long-edge constraint
4. Encode via `CIContext.jpegRepresentation` / `heifRepresentation` / `pngRepresentation` / `tiffRepresentation`
5. Write to `~/Pictures/Maple Exports/` (macOS) or `Documents/Exports/` (iOS)

Supported formats: JPEG (quality slider), HEIC, TIFF (16-bit), PNG.
