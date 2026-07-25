# Product Status

Last updated: 2026-07-24

Maple is organized into 5 build phases. Phases 1 and 2 are complete. Phase 3 is largely built, Phase 4 is partially built, and Phase 5 has shipped in pieces.

The phase model dates from the single-platform CoreImage prototype and no longer describes the whole product. Maple now ships three surfaces — the Apple app (macOS / iPadOS / iOS / tvOS), the Angular web app, and the Bun/Elysia API behind Maple Self Hosted — all backed by one Rust core. Where a feature exists on one surface and not another, the row says so. Surfaces the phase tables never anticipated are listed under [Outside the phase model](#outside-the-phase-model).

---

## Summary

| Phase | Name                   | Status                                                                                   |
| ----- | ---------------------- | ---------------------------------------------------------------------------------------- |
| **1** | Foundation             | **Complete** — plus two sources (Maple Cloud, File Provider) the table never planned for |
| **2** | RAW Develop & Export   | **Complete** — re-platformed off CoreImage onto the Rust core                            |
| **3** | Color Engine           | **Mostly built** — HSL, scopes, presets and before/after shipped; curve/wheel UI outstanding |
| **4** | Advanced Editing       | **Partially built** — panorama and crop shipped; masking and healing are core-only       |
| **5** | Platform Polish & Sync | **Partially built** — sync shipped as Maple Cloud, not iCloud                            |

---

## Phase 1 — Foundation

**Status: Complete**

Everything needed to browse, cull, and organize a photo library. The source list grew from three to five.

### Library Browsing

| Feature                                                   | Status | Where it lives                                                  |
| --------------------------------------------------------- | ------ | --------------------------------------------------------------- |
| Local filesystem (folder tree, security-scoped bookmarks) | Built  | `FilesystemSource.swift`, `BookmarkStore.swift`                 |
| Apple Photos (albums, favorites, all photos)              | Built  | `PhotoKitSource.swift`, `PhotoKitCatalog.swift`                 |
| SMB network shares (direct AMSMB2 connection)             | Built  | `SMBSource.swift`, `SMBPickerSheet.swift`, `SMBCredentialStore` |
| Maple Cloud (remote catalog over the Self Hosted API)     | Built  | `Cloud/CloudSource.swift`, `CloudTimelineView.swift`            |
| File Provider mount (Files.app / Finder integration)      | Built  | `MapleFileProvider/`, `FileProvider/RemoteCatalog.swift`        |
| Three-column layout (source tree / grid / detail)         | Built  | `AppShell.swift`, `AppShellMacLayout`, `AppShellSidebar`        |
| Single-column phone shell                                 | Built  | `AppShellIPhoneShell.swift`, `PhoneTabShell.swift`              |
| Image grid with lazy pagination                           | Built  | `BrowseGrid.swift`, `Grid/PhotoGrid.swift`                      |
| Thumbnail loading (memory + disk + cloud cache)           | Built  | `Cache/ThumbnailLoader.swift`, `Cache/ThumbnailDiskCache.swift` |
| Sort (name, date, size, type)                             | Built  | `BrowseViewModel.swift`                                         |
| Filter / search panel                                     | Built  | `SearchFilterPanel.swift`, `SearchViewModel.swift`              |
| Saved folders                                             | Built  | `Sources/SavedFolderStore.swift`                                |
| Last-folder restore on launch                             | Built  | `AppShell.swift` (`ensureReady` mechanism)                      |

### Culling

| Feature                                         | Status          | Where it lives                                                                                                                                      |
| ----------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Star ratings (0-5)                              | Built           | `AdjustmentModel.swift` (`CullingModel.stars`), `InfoPanel/RatingFlagsRow`                                                                          |
| Flags (Pick / Reject / Unflagged)               | Built           | `AdjustmentModel.swift` (`CullFlag`), `InfoPanel/RatingFlagsRow`                                                                                    |
| Color labels (Red, Orange, Yellow, Green, Blue) | Web only        | `models/color-label.ts`, parsed in the web XMP layer. Apple overloads `xmp:Label` for pick/reject and cannot round-trip a real label — milestone 02 |
| Keyword chips                                   | Built           | `InfoPanel/KeywordChipsRow.swift`                                                                                                                   |
| Arrow-key navigation in the preview             | Built           | `PreviewView.swift` (`onKeyPress`)                                                                                                                  |
| Culling hotkeys (P / X / U / 0-5)               | Not implemented | No `onKeyPress` handlers for rating or flag keys on any surface                                                                                     |

### Non-Destructive Sidecar System

| Feature                                             | Status  | Where it lives                                                          |
| --------------------------------------------------- | ------- | ----------------------------------------------------------------------- |
| XMP read/write (`crs:` namespace, Adobe-compatible) | Built   | `XMPSerialization.swift` + `+Attrs` / `+HSL` / `+Metadata` / `+Helpers` |
| Custom `papp:` namespace (profile, hidden, TZ)      | Built   | `XMPSerialization+Metadata.swift`, `RawCoreBridge.swift`                |
| Filesystem sidecars (sibling `.xmp`)                | Built   | `SidecarPath.swift`, `MapleSidecarPaths.swift`                          |
| SMB sidecars (written alongside image on share)     | Built   | `SMBSource.swift`                                                       |
| Cloud sidecars (via the Self Hosted API)            | Built   | `Cloud/CloudSidecarStore.swift`                                         |
| PhotoKit sidecars (app support directory)           | Built   | `MapleBackup/AppSupportSidecarStore.swift`                              |
| Unknown attribute passthrough (round-trip safe)     | Built   | `XMPSerialization.swift`                                                |
| Three-writer parity (Swift / TypeScript / Rust)     | Partial | Byte-canonical output across the three writers is milestone 02          |

---

## Phase 2 — RAW Develop & Export

**Status: Complete** — but not as this table originally described it.

The CoreImage implementation this section documented (`RAWDecodeEngine`, `CIFilterMapping`, a lazy `CIFilter` chain) was replaced by the Rust `raw-core` scene-linear pipeline. `CIRAWFilter` survives only to read as-shot white balance and image dimensions; `ImageMetadataReader.swift` states the invariant directly — Maple never renders with it.

### RAW Pipeline

| Feature                                             | Status | Where it lives                                                                  |
| --------------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| RAW decode (DNG, CR3, NEF, ARW, RAF, ORF, RW2, ...) | Built  | `RawCoreBridge.swift` → `raw-core` via the C FFI                                |
| Neutral scene-linear decode                         | Built  | `raw-core` `develop_scene_linear_*`                                             |
| GPU rendering (wgpu/WGSL live path + Metal kernels) | Built  | `GpuLiveSession.swift`, `ImageEditPipeline+GpuLive.swift`, `MetalKernels.swift` |
| Two-phase rendering (immediate fast + 150ms refine) | Built  | `EditSession+Render.swift`, `RenderActor.swift`                                 |
| Background decode (off the main actor)              | Built  | `RenderActor.swift`, `RenderActor+DecodedCache.swift`                           |
| As-shot WB extraction from EXIF/DNG tags            | Built  | `WbDngTemperature.swift`, `ImageMetadataReader.swift`                           |
| Deep-zoom tiled rendering                           | Built  | `EditSession+DeepZoom.swift`, `TileManager.swift`                               |
| Video assets (thumbnails, preview playback)         | Built  | `PreviewVideoView.swift`, `AssetRef.swift`                                      |

### Adjustment Sliders

25 tools in 4 groups (`Editor/EditorState.swift`, `Tool` enum). Every one maps to an `AdjustmentModel` field consumed by a named `raw-core` stage — there is no `CIFilter` mapping layer. Chain order is `white_balance` → `scene_tone_controls` → `tone_curves` → `vibrance` → `saturation` → `hsl` → `clarity` → `texture` → `dehaze` → `local_adjustments` → `vignette` → `nr_luminance` → AgX → `split_tone` → `grain` (`pipeline/scene_linear_chain.rs`).

| Group   | Tool                                      | Range          | `raw-core` stage             | Status                                        |
| ------- | ----------------------------------------- | -------------- | ---------------------------- | --------------------------------------------- |
| Light   | Exposure                                  | -4 … +4 EV     | `scene_tone_controls`        | Built                                         |
| Light   | Brightness                                | -100 … +100    | `scene_tone_controls`        | Built                                         |
| Light   | Contrast                                  | -100 … +100    | `scene_tone_controls`        | Built                                         |
| Light   | Highlights / Shadows                      | -100 … +100    | `scene_tone_controls`        | Built                                         |
| Light   | Whites / Blacks                           | -100 … +100    | `scene_tone_controls`        | Built                                         |
| Color   | Temperature                               | 2000 … 12000 K | `white_balance`              | Built                                         |
| Color   | Tint                                      | -150 … +150    | `white_balance`              | Built (ACR span, #1870)                       |
| Color   | Vibrance / Saturation                     | -100 … +100    | `vibrance`/`saturation`      | Built                                         |
| Color   | HSL (8 hues × hue/sat/lum)                | -100 … +100    | `hsl`                        | Built (#1112, #274); UX polish is #636        |
| Effects | Clarity / Texture / Dehaze                | -100 … +100    | `clarity`/`texture`/`dehaze` | Built                                         |
| Effects | Vignette (amount, feather)                | -100 … +100    | `vignette`                   | Built (#1109)                                 |
| Effects | Grain (amount, size, roughness)           | 0 … 100        | `grain`                      | Built (#1110)                                 |
| Effects | Split Tone (5 sub-params)                 | varies         | `split_tone`                 | Built (#1111)                                 |
| Detail  | Sharpen (amount, radius, detail, masking) | varies         | `sharpen`                    | Built                                         |
| Detail  | Noise Reduction (luminance)               | 0 … 100        | `noise_reduction`            | Built                                         |
| Detail  | Color NR                                  | 0 … 100        | `noise_reduction`            | Built                                         |
| Detail  | Deconvolution (amount, σ)                 | varies         | `capture_sharpening`         | Built (#875)                                  |
| Detail  | Crop / rotate                             | —              | `crop` (geometry)            | Built (#277, #638)                            |
| Detail  | Presets                                   | —              | —                            | Built (#1115)                                 |

Model fields with no tool pill: parametric tone curve (`parametricHighlights`/`Lights`/`Darks`/`Shadows`, applied by `tone_curves` and round-tripped since #365 — the panel UI is #367), `highlightRecovery`, `autoExposure`, `profile`, `chromaPrefilter`, `hotPixelSuppression`, `deepDenoise`.

### Editing UX

| Feature                                               | Status          | Where it lives                                                                                                                                     |
| ----------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas-first editor shell                             | Built           | `EditorView.swift`, `EditorView+Canvas.swift`, `PillHeader.swift`                                                                                  |
| Tool pills + drag-bar value scrubbing                 | Built           | `ToolDock.swift`, `ToolPillRow.swift`, `DragBar.swift`                                                                                             |
| Control surfaces (desktop / flyout / phone / stacked) | Built           | `ControlCard`, `FlyoutSliderPanel`, `MobileControlBar`, `StackedAdjustmentsPanel`                                                                  |
| Sub-parameter rows (multi-value tools)                | Built           | `SubParamRow.swift`, `Editor/ToolSubParam.swift`                                                                                                   |
| Profile picker (Auto / Neutral)                       | Built           | `ProfilePicker.swift`, `ColorAccessoryRow.swift`                                                                                                   |
| As-Shot white-balance restore                         | Built           | `ColorAccessoryRow.swift`                                                                                                                          |
| WB presets (Daylight, Cloudy, Shade, Tungsten, Flash) | Not implemented | Only As Shot exists; the named presets were never ported                                                                                           |
| WB eyedropper (click image to sample neutral point)   | Not implemented | No sampling path on any surface                                                                                                                    |
| Copy/paste adjustments between images                 | Not implemented | Tracked by #944                                                                                                                                    |
| Undo / redo                                           | Built           | `EditorState.swift`, `PillHeader.swift` (tap / long-press)                                                                                         |
| AUTO + RESET controls                                 | Partial         | `AutoAdjustments.swift` + `EditorState+AutoReset` exist; the controls are unreachable in the canvas-first shell (#2244), tone calibration is #1376 |
| Retina-aware zoom, 100% pixel-perfect, pinch + pan    | Built           | `CanvasZoomModel.swift`, `CanvasZoomController.swift`                                                                                              |

### Caching & Performance

| Feature                                         | Status | Where it lives                                                     |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------ |
| Rendered preview disk cache (instant cold-open) | Built  | `Cache/RenderedPreviewCache.swift`                                 |
| Decoded-image session cache                     | Built  | `RenderActor+DecodedCache.swift`, `SceneLinearChainCache.swift`    |
| Display-preview tier (`.maple/previews/`)       | Built  | `EditSession+DisplayPreviewPersist.swift`, `DisplayPreviewSink`    |
| Thumbnail regeneration after edit save          | Built  | `EditSession+Cache.swift`                                          |
| Slider-tick perf gates                          | Built  | `SliderTickPerfTests.swift`, `FusedChainEncodeSliderTickPerfTests` |

### Export

| Feature                           | Status          | Where it lives                                                                    |
| --------------------------------- | --------------- | --------------------------------------------------------------------------------- |
| JPEG export (sRGB and Display P3) | Built           | `MapleExporter.swift` (`jpegSRGB`, `jpegP3`)                                      |
| HEIC export (Display P3)          | Built           | `MapleExporter.swift` (`heicP3`)                                                  |
| TIFF export (16-bit)              | Built           | `MapleExporter.swift` (`tiff16`)                                                  |
| PNG export                        | Built           | `MapleExporter.swift` (`png`)                                                     |
| Long-edge resize                  | Core only       | `ExportOptions.maxSidePixels` exists; `ExportPanel` exposes format + quality only |
| Export sheet UI                   | Built           | `ExportPanel.swift`                                                               |
| Share sheet (iOS)                 | Built           | `MapleExporter.swift` (`UIActivityViewController`)                                |
| Metadata strip toggle             | Not implemented | No toggle on any surface                                                          |
| Web export                        | Not implemented | Web saves XMP but produces no output file (#943)                                  |
| Batch JPEG export                 | Built           | API JobRunner (`batch_jpeg_export`)                                               |

---

## Phase 3 — Color Engine

**Status: Mostly built**

The scopes and presets work shipped; the remaining gap is panel UI for curves, wheels and B&W — the bulk of milestone 03 · Editor completion.

| Feature                                                | Status        | Notes                                                                                                                                          |
| ------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Curves — parametric (highlights/lights/darks/shadows)  | Core + XMP    | Applied by `tone_curves`, round-trips in all three writers since #365. No panel UI yet (#367)                                                  |
| Curves — per-channel point curves                      | Core only     | `raw-core` holds the point arrays; the Swift `AdjustmentModel` does not mirror them (#273)                                                     |
| HSL panel (8 color ranges: hue, saturation, luminance) | Built         | Oklab 8-band `hsl` stage (#1112), 24 model fields, XMP round-trip, and both the web and Apple panels (#274). Sub-control UX polish is #636     |
| Color wheels (Lift / Gamma / Gain)                     | Not started   | Split Tone ships the 5-field shadows/highlights variant; 3-way wheels are #275                                                                 |
| Black & white mix                                      | Not started   | #276                                                                                                                                           |
| Histogram                                              | Built         | `InfoPanel/HistogramBlock.swift` + `LocalHistogram.swift` (Apple), `components/scopes/histogram.component.ts` (web). Editor-pill chip is #1583 |
| Waveform                                               | Web only      | `components/scopes/waveform.component.ts`; no Apple equivalent                                                                                 |
| Vectorscope                                            | Web only      | `components/scopes/vectorscope.component.ts`; no Apple equivalent                                                                              |
| RGB parade                                             | Web only      | `components/scopes/parade.component.ts`                                                                                                        |
| False color overlay                                    | Not started   |                                                                                                                                                |
| LUT support (.cube files, 33/65-point)                 | Internal only | `AutoProfileLUT.swift` generates per-image Auto Profile cubes; no user `.cube` import                                                          |
| Presets engine (save, load, delete, built-ins)         | Built         | `Editor/PresetStore.swift`, `Editor/Preset.swift`, `PresetsPanel.swift` (#1115). No import/export sharing                                      |
| Before/After                                           | Partial       | Hold-free toggle via `session.showingOriginal` in `PillHeader.swift`. No split-view or reference image                                         |
| Lens corrections (distortion, CA, vignetting)          | Not started   | #376                                                                                                                                           |
| Wide gamut soft-proofing (sRGB, Print)                 | Not started   | Pipeline outputs Display P3. Soft-proofing is #1697 (Icebox); HDR/EDR output is #1702                                                          |

---

## Phase 4 — Advanced Editing

**Status: Partially built**

| Feature                                           | Status      | Notes                                                                                                                              |
| ------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Panorama stitching                                | Built       | Rust `pano` crate + `RustPanoStitcher.swift`, `PanoMergeView.swift`. Spec backlog is milestone 08                                  |
| Masking — linear and radial gradients             | Core only   | `types/local_adjustment/mod.rs`, `stages/local_adjustments/`, wired into the chain. No UI on either surface (#355 Apple, #356 web) |
| Masking — brush                                   | Not started | #360                                                                                                                               |
| Masking — AI subject / sky                        | Not started | #361                                                                                                                               |
| Masking — range (color / luminance / depth)       | Not started | #362                                                                                                                               |
| Healing and cloning (Remove)                      | Core only   | `pipeline/inpaint_store.rs` + seam tests. Apple host wiring is #1486 / #1865, epic #1472                                           |
| Geometry — crop, rotate, straighten, aspect       | Built       | `CropOverlay.swift`, `CropToolbar.swift`, `CropGeometry.swift` (#277, #638)                                                        |
| Geometry — perspective, keystone, lens profiles   | Not started | Lens corrections tracked by #376                                                                                                   |
| Batch editing — metadata                          | Built       | `Views/BatchMetadata/`, `BatchMetadataViewModel.swift` (#1575)                                                                     |
| Batch editing — adjustments across a selection    | Not started | #944                                                                                                                               |
| Smart collections (auto-filter by metadata rules) | Not started | Saved search / filter panel exists; rule-driven collections do not                                                                 |
| Stacking (HDR merge, focus stack)                 | Not started | Dual-pixel / dual-ISO merge is #1701 (Icebox)                                                                                      |
| Export profiles with watermarks                   | Not started |                                                                                                                                    |

---

## Phase 5 — Platform Polish & Sync

**Status: Partially built**

Sync shipped, but not as iCloud — it is Maple Cloud, the Self Hosted API with a local backup agent.

| Feature                                          | Status      | Notes                                                                                              |
| ------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------- |
| iCloud sidecar sync                              | Not started | No CloudKit/ubiquity usage. Superseded in practice by Maple Cloud                                  |
| Maple Cloud sync (catalog, sidecars, thumbnails) | Built       | `Cloud/CloudSource.swift`, `Cloud/CloudSidecarStore.swift`, `src/api`                              |
| Background backup agent                          | Built       | `Packages/MapleBackup/`, `BackupEngine.swift`, `BackupSettingsView.swift`                          |
| Maple TV (tvOS client, device pairing)           | Built       | `Maple TV/`, `PairingCrypto.swift`, `PairAppleTVSheet.swift`. Follow-ups in milestone 10           |
| File Provider (Finder / Files.app)               | Built       | `MapleFileProvider/`, `MapleFileProviderIOS/`, `FileProviderSettingsView.swift`                    |
| Apple Pencil (pressure, hover, scribble)         | Not started | No PencilKit usage                                                                                 |
| Keyboard/trackpad shortcuts                      | Partial     | `⌘O`, `⌘,` and arrow navigation are wired; no `CommandMenu`/`CommandGroup` menu bar                |
| ProRes RAW decode                                | Not started | Video assets play back but are not developed                                                       |
| Plugin API                                       | Not started |                                                                                                    |
| Collaboration (review links, comments)           | Not started | Device pairing exists; multi-user review does not                                                  |
| Tethered capture (USB/WiFi)                      | Not started |                                                                                                    |
| Accessibility (VoiceOver, Dynamic Type)          | Partial     | Accessibility identifiers/labels are pervasive (the UITest harness depends on them); no full audit |
| macOS native polish (menus, Spotlight)           | Partial     | Native target, not Catalyst; menu bar still not wired                                              |

---

## Outside the phase model

Shipped surfaces the 5-phase tables never anticipated. They are listed here so this document stops reading as if they do not exist:

- **Maple Self Hosted API** — Bun + Elysia + MongoDB, serving the built Angular bundle and the native core via `bun:ffi` (`src/api`).
- **Worker pipeline** — per-asset stages (`exif`, `thumb`, `describe`, `geocode`, derivative audit) with pause/resume, retry/backoff and dead-lettering, surfaced on Settings → Workers.
- **Enrichment** — qwen2.5-vl vision descriptions, OCR and transcripts, surfaced in the Info panes.
- **People / faces** — clustering, detail and hide flows.
- **Search** — cross-source search with scope chips, recent queries and top hits.
- **Observability** — DB-backed settings, event-loop diagnostics, GPU frame-time HUD.
- **Parity harnesses** — the ACR color gate (`src/scripts/test_color_pipeline.sh`), the XCUITest visual harness, and the slider matrix.

---

## What's Next

The open milestone is **03 · Editor completion** — finish the adjustment surface so a photographer can do a whole edit without leaving Maple. In rough dependency order:

1. **Tone curve panels (#367)** — parametric curves already round-trip; this is the SwiftUI + Angular curve widget on top of shipped data. Point curves (#273) need the namespace decision first.
2. **AUTO + RESET reachability (#2244, #1370, #1376)** — the logic shipped and then lost its UI in the canvas-first redesign. A regression, not a feature. #2244 is currently unmilestoned and belongs here.
3. **Copy/paste adjustments (#944)** — this document claimed it for months; it has never existed on any surface.
4. **Web export (#943)** — the web app can save an XMP but cannot produce an output file, which makes it non-viable as a standalone editor.
5. **Color grading wheels (#275)** and **Black & white mix (#276)** — the last two adjustment categories with no core support at all.
6. **Lens corrections (#376)** — distortion, CA and vignetting; the largest remaining core-side gap.
7. **HSL sub-control UX (#636)** — the panel shipped with #274; this is the 8 hues × 3 sliders interaction polish.

After that, milestone 04 · Masking & local adjustments is the natural follow-on: the linear/radial engine is already in the chain and gated only on UI (#355, #356).

### Architecture

Adding an adjustment is a cross-platform change, not a local one. The pipeline is a single Rust core with three consumers:

**`raw-core`** (`src/raw-pipeline/raw-core`) owns all color math — decode, demosaic, calibration, LUT generation, dehaze, deconvolution — and works in a scene-referred linear Rec.2020 D65 f32 space. Nothing clips before the single view transform (AgX + Auto Profile) at the end of the chain. It compiles once as a static library for Apple through the C FFI in `raw-ffi` (packaged as `RawPipeline.xcframework`), once as WebAssembly through `raw-wasm`, and once as a dylib for the API through `bun:ffi`.

**The per-tick chain** is `apply_scene_linear_chain` (`pipeline/scene_linear_chain.rs`). It re-applies only the cheap, model-dependent stages in a fixed order — `white_balance` → `scene_tone_controls` → `tone_curves` → `vibrance` → `saturation` → `hsl` → `clarity` → `texture` → `dehaze` → `local_adjustments` → `vignette` → `nr_luminance` → AgX → `split_tone` → `grain`. Every stage in that list is also baked by the FFI decode, so `RawCoreBridge.swift` must strip each chain-handled field before decode or the adjustment applies twice (see the header comment there — #1916 closed the last gap of that kind).

**GPU paths** are idiomatic per platform but generated from the same source: a wgpu/WGSL live path on both Apple and web, with Metal compute kernels for the Apple refine pass. Both are gated against the Rust reference by the parity harness.

**Constants and schemas** that appear in more than one language are single-sourced from `raw-core` and emitted by the `codegen` crate into Swift `let`s, TypeScript `const`s, SCSS tokens and WGSL consts. The `codegen-drift` CI job fails if the committed outputs diverge from a fresh generation.

So adding an adjustment means: add the field to the Rust `Adjustments` struct and its stage, add the XMP field to all three serializers, run `tools/codegen.sh`, mirror the field on `AdjustmentModel` (Swift) and the generated TS model, add the field to the FFI strip list in `RawCoreBridge.swift`, add the `Tool` case in `Editor/EditorState.swift` plus its `ToolSubParam` rows, and add a reference case to the color-parity harness with a budget entry. The sidecar, undo and preset infrastructure picks it up from there.
