# 02 — Pipeline

End-to-end trace of one RAW file, from the moment the user double-clicks it in the grid to the moment pixels land on screen, and from the moment the user hits Export to the moment a JPEG lands on disk. Stage order, branch points, and caching behavior.

This document is the system shape. Detailed math for individual stages is in [`03-algorithms.md`](./03-algorithms.md); what colorspace a value is in at each stage is in [`04-color-management.md`](./04-color-management.md); where caches live and when they're hit is in [`05-performance.md`](./05-performance.md).

---

## Actors

Five cooperating subsystems participate in every edit:

1. **Source adapter** — `FilesystemSource`, `PhotoKitSource`, or `SMBSource`. Provides bytes of the RAW and bytes of the sidecar.
2. **RAW decode engine** — Rust `raw-core` (primary) or `CIRAWFilter` (fallback on Apple).
3. **Adjustment pipeline** — `CIFilter` chain on Apple, WebGL2 program chain on web. Consumes `AdjustmentModel`, produces `CGImage`/`HTMLCanvasElement`-bound pixels.
4. **Sidecar layer** — `XMPParser` + `XMPSerializer` + `XMPSidecarStore` (Apple actor) or `xmp-*.service.ts` (web).
5. **Edit session** — orchestrates the above three on behalf of the UI; holds the mutable `AdjustmentModel`.

See [`01-data-model.md`](./01-data-model.md) for the types involved.

---

## Trace A: Folder load (context for Trace B)

Before an image can be edited, the folder it lives in has to be enumerated and its sidecars parsed. This is what the user perceives as "opening a folder".

```
User selects folder
    │
    ▼
SourceAdapter.enumerate(folderURL)
    │   ┐── Filesystem: POSIX opendir; filter by extension allowlist
    │   ├── PhotoKit:  PHFetchResult<PHAsset>
    │   └── SMB:       AMSMB2 listDirectory
    │
    ▼
[ImageAsset stubs] (id, primaryURL, filename, size, mtime)
    │
    ▼
UnifiedLibraryViewModel publishes assetSlots to the grid
    │      (loadGeneration counter guards against stale async)
    ▼
Grid renders with blank cells
    │
    ▼
(per visible cell, concurrency-limited) ThumbnailLoader.thumbnail(for: asset)
    │   ┌── in-memory LRU hit?        → return CGImage
    │   ├── disk cache (.maple/thumbs) hit? → load → memory cache → return
    │   └── miss: extract embedded JPEG from RAW via CGImageSource,
    │            or decode first N×N of the image, write disk + memory, return
    ▼
CullingState hydrated: XMPSidecarStore.read(sidecarURL)
    │   parses xmp:Rating, papp:Flag, papp:ColorLabel
    │   (other fields parsed but not used at this stage)
    ▼
Grid cells update in place
```

Key behaviors:

- **Generation counter guards stale loads.** Every `await` boundary in `UnifiedLibraryViewModel.loadAssets` checks `gen == loadGeneration` before writing state. If the user clicks three folders in rapid succession, only the last folder's results land.
- **Sidecar parse is opportunistic.** Grid rendering does not block on sidecar parse; culling indicators appear as they arrive. A missing sidecar is not an error — culling fields default to unrated/unflagged/nil.
- **The LibraryIndex (if present) short-circuits sidecar parse.** On a warm folder, the cached `.maple/index.json` provides culling state without re-parsing every `.xmp`. The index is non-authoritative; see [`01-data-model.md`](./01-data-model.md) § LibraryIndex.

---

## Trace B: One RAW file, load → preview

The central trace. User double-clicks a DNG in the grid; this is what happens.

### B.0 — Transition

Grid mode → full-image mode is a 180ms ease-out layout shift. The three panels stay in place; the center column crossfades from grid to full-image view. `EditSession` for the new asset is constructed _before_ the transition animation begins, so RAW decode kicks off under the animation.

### B.1 — EditSession construction

```
EditSession.init(asset: ImageAsset)
    ↓
Load sidecar:  SidecarDocument = XMPParser.parse(store.read(asset.sidecarURL))
    ↓
Interpret:     (model, culling, passthrough) = SidecarDocument.interpret()
    ↓
self.model          = model
self.originalModel  = copy(model)
self.passthrough    = passthrough
self.decodedImage   = nil        (kicked off below)
self.renderedPreview = nil
```

If the sidecar does not exist, `model = AdjustmentModel.default()` and the session is marked non-dirty. No sidecar is written until the user actually changes something.

### B.2 — Rendered-preview cache probe (fast path for cold open)

Before touching the RAW, check the rendered-preview cache:

```
key = hash(primaryURL, primaryURL.mtime, sidecarURL.mtime, screenSize)
if RenderedPreviewCache.exists(key):
    preview = RenderedPreviewCache.load(key)     (decompresses JPEG)
    EditSession.renderedPreview = preview
    UI displays immediately    (sub-100ms cold open)
    continue to B.3 in background
else:
    UI displays a spinner; proceed to B.3 synchronously
```

The rendered preview is an 8-bit opaque JPEG encoded at the screen's native resolution, stored at `~/Library/Caches/MapleMaple/rendered/{hash}.jpg`. It represents the full adjustment chain applied to the RAW at the moment it was last saved — so the cold-open image is exactly what the user last saw. See [`05-performance.md`](./05-performance.md) § RenderedPreviewCache.

### B.3 — Background RAW decode

```
Task.detached(priority: .userInitiated) {
    data = await sourceAdapter.read(asset.primaryURL)
    ↓
    try Rust path:
        handle = raw_decode_and_demosaic(data)
        pixels = raw_get_pixels(handle)              // *const f32, linear RGB
        (width, height) = (raw_get_width(), raw_get_height())
        ↓
        wrap as Metal buffer via bytemuck zero-copy
        upload to CIImage or MTLTexture
        ↓ on success:
        EditSession.decodedImage = ciImage
    catch UnsupportedFormat:
        ↓ Apple fallback:
        ciImage = CIRAWFilter(data: data).outputImage      (neutral decode)
        EditSession.decodedImage = ciImage
}
```

Rust handles: DNG, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW, 3FR, FFF, DCR, MOS, MRW, IIQ, plus standard JPEG/HEIC (passthrough, no demosaic). CIRAWFilter handles everything Rust doesn't, with the caveat that its output uses Apple's built-in color pipeline (see [`04-color-management.md`](./04-color-management.md) § CIRAWFilter fallback).

The decoded image is a session-scoped resource. It is **not** written to any disk cache — only the _rendered_ preview (post-adjustment, screen-sized) is persisted.

### B.4 — First render

As soon as `decodedImage` is set:

```
pipeline = ImageEditPipeline(adjustments: session.model)
ciImage = pipeline.apply(to: session.decodedImage)
        = applyFilters(session.decodedImage, session.model)     [11-stage chain]

renderPhase = .fast
ciContext.startTask(toRender: ciImage,
                    to: metalTexture,
                    bounds: viewport,
                    colorSpace: P3)
    ↓ (~50ms target for 25MP on an M-series)
EditSession.renderedPreview = metalTexture   → SwiftUI redraws
```

The scene-referred filter chain (see § Filter chain below) composes lazily — CIFilter does not evaluate until `ciContext` renders it. Three stages are custom `CIColorKernel`s:

- `SceneToneControls` applies exposure, contrast (as AgX-slope modulator), highlights, shadows, whites, blacks, and tone curves in scene-linear Rec.2020. This replaces the display-referred RtToneCurve from the prior implementation.
- `SceneVibrance` is a chroma-preserving vibrance (RawTherapee skin-protection heuristic adapted to a gamut-invariant chroma space; see [`03-algorithms.md`](./03-algorithms.md)).
- `AgXViewTransform` is the view-transform stage: scene-linear Rec.2020 in, display-linear Rec.2020 out. Applied once, near the end of the chain.

The rest of the chain uses stock Core Image filters where practical (unsharp mask, noise reduction), with input/output explicitly in scene-linear Rec.2020 f32 textures. See [`04-color-management.md`](./04-color-management.md) for the full color-space trace.

### B.5 — Refine pass (300ms target)

Immediately after the fast pass completes, a refine pass runs at full resolution:

```
renderPhase = .refine
ciContext.startTask(toRender: ciImage, to: metalTexture,
                    bounds: fullImageBounds)
    ↓ (~300ms target)
EditSession.renderedPreview = refinedTexture → SwiftUI redraws
```

The two-phase render lets the UI never stall: the fast pass produces a viewport-sized result visible under 100ms, and the refine pass upgrades to full-resolution pixels for pan/zoom. See [`05-performance.md`](./05-performance.md) § Two-phase rendering for the cancellation and coalescing rules.

### B.6 — Slider interaction loop

While the user is dragging a slider:

```
slider moved → EditSession.model.{field} = newValue
    ↓
renderPhase = .fast
re-apply chain, render viewport, update texture
    ↓
(slider release)
push undo snapshot; debounce 500ms
    ↓
renderPhase = .refine; full-resolution render
sidecar write scheduled
```

The CIFilter graph re-composes instantly because it's just parameter updates on existing filter nodes; no texture re-upload. The Rust-decoded image stays resident in GPU memory across all slider interactions in the session.

### B.7 — Session teardown

On navigation away:

```
endEditing():
    await debouncedSidecarWrite()        // no fire-and-forget
    encodeRenderedPreviewJPEG()           // opaque, screen-sized
    await RenderedPreviewCache.write(key, jpegData)
    regenerateThumbnailIfDirty()          // ThumbnailCell reads a tick counter
    session.tearDown()
```

Thumbnail regeneration is queued, not blocking — the grid shows the old thumbnail briefly, then updates when the new one lands. `ThumbnailCell` observes a per-asset tick counter and re-queries the thumbnail loader when it increments.

---

## Filter chain (Apple, detailed)

The adjustment pipeline on Apple is a linear sequence of conceptual stages. All operate in **scene-linear Rec.2020 f32** (see [`04-color-management.md`](./04-color-management.md)). A stage may be one `CIFilter`, a custom `CIColorKernel`, or skipped when its parameters are default.

Stages split into three bands: scene-linear chain (pre-view-transform), view transform, display encode.

### Scene-linear chain

| #   | Stage                | Implementation                                                                                                                                                                                              | Skipped when...                                   |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | Neutral decode       | `raw-core` output (scene-linear Rec.2020 f32). Internally: sensor lin → demosaic → highlight reconstruction (see [`03-algorithms.md`](./03-algorithms.md) § 3.3a) → DCP color transform                     | never                                             |
| 2   | White balance        | `CITemperatureAndTint` in scene-linear Rec.2020                                                                                                                                                             | `temperature == 6500 && tint == 0`                |
| 3   | Scene tone controls  | **custom `SceneToneControls` kernel** — exposure, highlights, shadows, whites, blacks, master + RGB tone curves on scene values; contrast is routed to the view transform's sigmoid slope, not applied here | all tone fields default _and_ all curves identity |
| 4   | Presence: vibrance   | **custom `SceneVibrance` kernel** — chroma-preserving, gamut-invariant                                                                                                                                      | `vibrance == 0`                                   |
| 5   | Presence: saturation | chroma-preserving saturation in a gamut-invariant space (not `CIColorControls` directly — see [`03-algorithms.md`](./03-algorithms.md))                                                                     | `saturation == 0`                                 |
| 6   | Presence: clarity    | Unsharp mask, radius=40, on scene-linear (values may exceed 1.0)                                                                                                                                            | `clarity == 0`                                    |
| 7   | Presence: texture    | Unsharp mask, radius=3, on scene-linear                                                                                                                                                                     | `texture == 0`                                    |
| 8   | Presence: dehaze     | Dark-channel prior transmission estimate, applied in scene-linear                                                                                                                                           | `dehaze == 0`                                     |
| 9   | Capture sharpening   | Unsharp mask (radius=sharpenRadius) + edge mask via `CIEdges`                                                                                                                                               | `sharpenAmount == 0`                              |
| 10  | Noise reduction      | `CINoiseReduction` on scene-linear, parameters rescaled from display-referred defaults                                                                                                                      | `nrLuminance == 0 && nrColor == 25`               |
| 11  | Crop                 | `CICrop(rect: cropRectInPixels)` (after rotation if `crop.angle ≠ 0`)                                                                                                                                       | crop is identity                                  |

### View transform

| #   | Stage                                          | Implementation                                                                                                                                  | Skipped when...                                          |
| --- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 12  | **AgX view transform**                         | custom `AgXViewTransform` kernel — per-channel log encode → sigmoid (contrast-slider modulates slope) → optional look → display-linear Rec.2020 | never (identity view transform is not a v1 mode)         |
| 12a | Display-referred curve (Lightroom-compat slot) | LUT-sampled tone curve operating on display-linear Rec.2020 — see [`03-algorithms.md`](./03-algorithms.md) § 3.6b                               | no `crs:ToneCurvePV2012*` populated for the active asset |

### Display encode

| #   | Stage               | Implementation                                                                               | Skipped when... |
| --- | ------------------- | -------------------------------------------------------------------------------------------- | --------------- |
| 13  | Target-gamut matrix | Rec.2020 → sRGB or Rec.2020 → P3 (compiled-constant matrix), chosen by the delivery surface  | never           |
| 14  | Gamma encode        | piecewise sRGB (for sRGB and P3 delivery); handled by `CIContext.render(..., colorSpace: …)` | never           |

**Order is load-bearing.** Specifically:

- White balance before tone — tone-shaping behavior depends on a neutrally balanced scene.
- Vibrance before saturation — vibrance's skin protection relies on unsaturated mid-tones being separable.
- Clarity before texture — clarity's wide radius and texture's small radius compose; reversing produces a flatter result.
- Dehaze in presence band, after contrast-shaping — dehaze's contrast boost is applied to an already-shaped signal on purpose (matching Adobe PV11's ordering).
- Sharpening and NR before the view transform — on scene-linear data, otherwise edge artifacts get baked in under AgX's compression and are harder to reason about.
- Crop before the view transform and display encode — so AgX and the gamma encode operate on the cropped frame, not the full sensor.
- **View transform is last before display encode.** Everything upstream is free to produce values > 1.0 or < 0; AgX handles both.

**Geometry (crop) is last in the scene-linear chain, before the view transform.** The scene-linear pipeline renders the full frame and crops; it does not render only the cropped region. This keeps adjustment previews correct under crop drag.

**The capture-sharpening Metal kernel** is a Maple-specific scene-linear sharpener planned for v1; legacy `MetalCaptureSharpening` code from the display-referred era is not carried forward. See [`03-algorithms.md`](./03-algorithms.md) § Capture sharpening.

---

## Filter chain (Web, detailed)

The web pipeline runs three WebGL2 programs against a triple-FBO chain. All offscreen FBOs are **f32** via `EXT_color_buffer_float` (required); the canvas itself is gamma-encoded u8 or u10.

| #   | Program                     | Inputs                                                                  | Stages it handles                                                                                                                |
| --- | --------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Fused main**              | decoded scene-linear Rec.2020 f32 texture, all AdjustmentModel uniforms | WB → scene tone controls → vibrance → saturation → dehaze → **AgX view transform** → target-gamut matrix → gamma encode → canvas |
| 2   | **Separable Gaussian blur** | scene-linear f32 FBO, radius uniform                                    | Runs twice (H, V) per clarity/texture band on scene-linear data.                                                                 |
| 3   | **Unsharp mask**            | scene-linear source + blurred FBO, intensity uniform                    | Produces clarity and texture contributions, output still scene-linear.                                                           |

The fused program is the main interactive path: one uniform-update, one draw call per slider change. Clarity, texture, capture sharpening, and NR require extra passes before the fused program reads the texture — these run into scene-linear intermediate FBOs and the fused program reads the post-sharpen scene-linear texture. AgX and the gamma encode happen inside the fused program's fragment shader as its final steps.

**Triple FBO chain** exists because Safari conservatively detects read-while-writing feedback loops and will silently fail a draw call if the bound read texture is also the draw target. Maple rotates through three f32 FBOs:

```
         ┌─ FBO A (source, scene-linear) ──┐
         │                                  │
draw scene-linear pre-processing (clarity/texture/sharpen/NR) into FBO B
draw scene-linear pre-processing → FBO C
... ping-pong as needed ...
final fused draw reads last scene-linear FBO, writes gamma-encoded output to the canvas
```

**Canvas color space tag.** Maple tags the canvas as `display-p3` on browsers that support it and `srgb` elsewhere. The target-gamut matrix inside the fused shader matches the canvas tag: Rec.2020 → P3 when tagged P3, Rec.2020 → sRGB when tagged sRGB. Without the correct tag, Safari and Chrome on P3 displays would misinterpret the encoded output and produce a pink cast. See [`04-color-management.md`](./04-color-management.md) § Web parity.

**Crop on web** is a CSS `clip-path` or `object-fit` crop of the final canvas — the pipeline renders the full decoded image. Crop handles are drawn as overlay DOM.

Noise reduction and capture sharpening on web in v1: **minimal implementations.** Capture sharpening is a simple scene-linear unsharp with edge mask; NR is a scene-linear bilateral with conservative defaults. Both are cheaper than the Apple equivalents and produce visibly weaker results; they're on the web roadmap to match Apple quality in v1.x. See [`09-open-questions.md`](./09-open-questions.md).

---

## Trace C: Export

Export is a distinct code path from preview rendering. It never uses the rendered-preview cache (wrong resolution, wrong color treatment) and does not share intermediate textures with the interactive pipeline.

```
ExportEngine.export(asset: ImageAsset, config: ExportConfiguration)
    ↓
load sidecar → adjustments
decode RAW at full resolution:
    Rust path: raw_decode_and_demosaic with high-quality demosaic
               (feature flag: AMaZE instead of bilinear)
    Apple fallback: CIRAWFilter(neutral)
    ↓
apply scene-linear chain at full resolution
    ↓
crop + resize (long-edge target from config)
    ↓
branch on export format:
    JPEG / HEIC / PNG / display-TIFF:
        AgX view transform → target gamut → gamma encode → quantize
    scene-linear TIFF (16-bit ProPhoto):
        NO view transform; matrix Rec.2020→ProPhoto; u16 linear
    EXR (v1.x, scene-linear Rec.2020):
        NO view transform; f16 EXR write
    ↓
target color space and bit depth:
    JPEG: sRGB 8-bit, or Display P3 8-bit if config.wideGamut
    HEIC: Display P3 10-bit
    TIFF (display): Display P3 16-bit
    TIFF (scene-linear): ProPhoto RGB 16-bit linear
    PNG:  sRGB 8-bit
    EXR:  Rec.2020 float16 linear
    ↓
encode:
    JPEG: quality slider 1–100 → libjpeg-turbo via ImageIO
    HEIC: CIContext.writeHEIFRepresentation
    TIFF: CGImageDestination, 16-bit
    PNG:  CGImageDestination
    EXR:  OpenEXR writer (v1.x)
    ↓
copy or strip metadata per config:
    keep: EXIF, IPTC, XMP, color profile
    strip: GPS, serial numbers (partial impl in v1 — see 09)
    ↓
write to user-selected destination
```

### Differences from preview rendering

- **High-quality demosaic.** Export uses AMaZE if the Rust core was compiled with the `high-quality-demosaic` feature; preview uses bilinear or half-res quad.
- **Full resolution.** Preview renders at the viewport size; export renders at the sensor's full pixel count.
- **Tiled render for large images.** Images above ~50MP are tiled (~2048px tiles) through the full pipeline to cap peak GPU memory. Scene-linear f32 doubles the per-tile memory footprint vs display-referred f16; tile size budgets are in [`05-performance.md`](./05-performance.md).
- **View transform is export-format-dependent.** Scene-linear export formats (16-bit linear TIFF, EXR) **skip AgX** and preserve scene values. All display-referred formats (JPEG, HEIC, PNG, display-TIFF) apply AgX as part of the export pipeline. See [`04-color-management.md`](./04-color-management.md) § Export color transforms.

### iOS share sheet

Not implemented in v1. The macOS export uses `NSSavePanel`; iOS is blocked on implementing the share-sheet wiring. See [`09-open-questions.md`](./09-open-questions.md).

---

## Branch points summary

| Decision                   | Branches on                            | Consequence                                       |
| -------------------------- | -------------------------------------- | ------------------------------------------------- |
| **Decode engine**          | RAW format in Rust's supported list?   | Rust raw-core vs Apple CIRAWFilter                |
| **Fast vs refine**         | Is a slider actively being dragged?    | Viewport-only at 50ms vs full-res at 300ms        |
| **Chain stage skip**       | Is field == default?                   | Stage is omitted from the CIFilter graph entirely |
| **Clarity/texture on web** | `clarity ≠ 0` or `texture ≠ 0`         | Run the blur + unsharp programs; otherwise skip   |
| **Cache hit/miss**         | Does rendered-preview cache key exist? | Sub-100ms cold open vs full decode path           |
| **Export demosaic**        | Config requests high-quality?          | AMaZE vs bilinear                                 |

---

## What this document does not define

- **The math inside each stage.** See [`03-algorithms.md`](./03-algorithms.md).
- **Caching layer internals, tile sizes, thread limits.** See [`05-performance.md`](./05-performance.md).
- **How the Swift and web pipelines stay byte-compatible on the adjustment side.** See [`06-cross-platform.md`](./06-cross-platform.md).
- **Where the sidecars go on disk.** See [`08-io.md`](./08-io.md).
- **What the UI looks like while rendering.** See [`07-ui-architecture.md`](./07-ui-architecture.md).
