# Product Status

Last updated: 2026-04-15

Maple is organized into 5 build phases. Phases 1 and 2 are complete. Phase 3 is the next milestone.

---

## Summary

| Phase | Name                   | Status       |
| ----- | ---------------------- | ------------ |
| **1** | Foundation             | **Complete** |
| **2** | RAW Develop & Export   | **Complete** |
| **3** | Color Engine           | Not started  |
| **4** | Advanced Editing       | Not started  |
| **5** | Platform Polish & Sync | Not started  |

---

## Phase 1 — Foundation

**Status: Complete**

Everything needed to browse, cull, and organize a photo library across three data sources.

### Library Browsing

| Feature                                                   | Status | Key Files                                           |
| --------------------------------------------------------- | ------ | --------------------------------------------------- |
| Local filesystem (folder tree, security-scoped bookmarks) | Built  | `FilesystemSource.swift`, `BookmarkStore.swift`     |
| Apple Photos (albums, favorites, all photos)              | Built  | `PhotoKitSource.swift`, `PhotoKitBridge.swift`      |
| SMB network shares (direct AMSMB2 connection)             | Built  | `SMBSource.swift`, `SMBConnectView.swift`           |
| Three-column layout (source tree / grid / detail)         | Built  | `AppShell.swift`, `NavigationSplitView`             |
| Image grid with lazy pagination                           | Built  | `ImageGridView.swift`, `ThumbnailCell`              |
| Thumbnail loading (3-layer cache)                         | Built  | `ThumbnailLoader.swift`, `ThumbnailDiskCache.swift` |
| Sort (name, date, size, type)                             | Built  | `UnifiedLibraryViewModel.swift`                     |
| Filter bar (by flag, rating, label)                       | Built  | `FilterCriteria` in ViewModel                       |
| Favorite folders                                          | Built  | `FavoriteFolderStore.swift`                         |
| Last-folder restore on launch                             | Built  | `AppShell.swift` (`ensureReady` mechanism)          |

### Culling

| Feature                                         | Status | Key Files                                   |
| ----------------------------------------------- | ------ | ------------------------------------------- |
| Star ratings (0-5)                              | Built  | `CullingState.swift`, `RatingView.swift`    |
| Flags (Pick / Reject / Unflagged)               | Built  | `CullingState.swift`, `FlagPillsView.swift` |
| Color labels (Red, Orange, Yellow, Green, Blue) | Built  | `CullingState.swift`, `ColorLabelRow.swift` |
| Keyboard shortcuts (P/X/U/0-5)                  | Built  | `FullImageView.swift` key handlers          |
| Arrow key navigation in full-image mode         | Built  | `FullImageView.swift`                       |

### Non-Destructive Sidecar System

| Feature                                             | Status | Key Files                                |
| --------------------------------------------------- | ------ | ---------------------------------------- |
| XMP read/write (`crs:` namespace, Adobe-compatible) | Built  | `XMPParser.swift`, `XMPSerializer.swift` |
| Custom `papp:` namespace for ratings/flags/labels   | Built  | `XMPSidecarStore.swift`                  |
| Filesystem sidecars (sibling `.xmp`)                | Built  | `SidecarPathResolver.swift`              |
| SMB sidecars (written alongside image on share)     | Built  | `SMBSource.writeSidecar()`               |
| PhotoKit sidecars (app support directory)           | Built  | `SidecarPathResolver.swift`              |
| Unknown attribute passthrough (round-trip safe)     | Built  | `XMPParser.swift`                        |

---

## Phase 2 — RAW Develop & Export

**Status: Complete**

Full RAW decode pipeline with 14 adjustment sliders, real-time preview, and export.

### RAW Pipeline

| Feature                                             | Status | Key Files                                         |
| --------------------------------------------------- | ------ | ------------------------------------------------- |
| RAW decode (DNG, CR3, NEF, ARW, RAF, ORF, RW2, ...) | Built  | `RAWDecodeEngine.swift` (CIRAWFilter)             |
| Neutral decode (WB/exposure as post-decode filters) | Built  | `RAWDecodeEngine.swift`, `CIFilterMapping.swift`  |
| Metal-backed GPU rendering                          | Built  | `ImageEditPipeline.swift` (CIContext + MTLDevice) |
| Two-phase rendering (fast 50ms + refine 300ms)      | Built  | `EditSession.swift`                               |
| Background RAW decode (off main actor)              | Built  | `EditSession.scheduleBackgroundDecode()`          |
| As-shot WB extraction from EXIF/DNG tags            | Built  | `RAWDecodeEngine.asShotWB()`                      |

### Adjustment Sliders

| Slider                                    | Range          | CIFilter                        | Status |
| ----------------------------------------- | -------------- | ------------------------------- | ------ |
| Exposure                                  | -4 … +4 EV     | CIExposureAdjust                | Built  |
| Temperature                               | 2000 … 12000 K | CITemperatureAndTint            | Built  |
| Tint                                      | -100 … +100    | CITemperatureAndTint            | Built  |
| Contrast                                  | -100 … +100    | CIColorControls                 | Built  |
| Highlights                                | -100 … +100    | CIHighlightShadowAdjust         | Built  |
| Shadows                                   | -100 … +100    | CIHighlightShadowAdjust         | Built  |
| Whites                                    | -100 … +100    | CIToneCurve                     | Built  |
| Blacks                                    | -100 … +100    | CIToneCurve                     | Built  |
| Vibrance                                  | -100 … +100    | CIVibrance                      | Built  |
| Saturation                                | -100 … +100    | CIColorControls                 | Built  |
| Clarity                                   | -100 … +100    | CIUnsharpMask (r=40)            | Built  |
| Texture                                   | -100 … +100    | CIUnsharpMask (r=3)             | Built  |
| Dehaze                                    | -100 … +100    | CIColorControls + CIGammaAdjust | Built  |
| Sharpen (amount, radius, detail, masking) | varies         | CIUnsharpMask                   | Built  |
| Noise Reduction (luminance, color)        | 0 … 100        | CINoiseReduction                | Built  |

### Editing UX

| Feature                                                        | Status | Key Files                                                 |
| -------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| Color slider UI (gradient tracks, double-tap reset)            | Built  | `ColorTabView.swift`                                      |
| WB presets (As Shot, Daylight, Cloudy, Shade, Tungsten, Flash) | Built  | `ColorTabView.swift`                                      |
| WB eyedropper (click image to sample neutral point)            | Built  | `FullImageView.swift`, `EditSession.sampleWhiteBalance()` |
| Copy/paste adjustments between images                          | Built  | `ColorTabView.swift` action row                           |
| Revert to original                                             | Built  | `EditSession.revert()`                                    |
| Retina-aware zoom (real pixels, not points)                    | Built  | `FullImageView.swift`                                     |
| Pixel-perfect 100% zoom                                        | Built  | `FullImageView.swift`                                     |
| Pinch-to-zoom + pan                                            | Built  | `FullImageView.swift` gestures                            |

### Caching & Performance

| Feature                                         | Status | Key Files                               |
| ----------------------------------------------- | ------ | --------------------------------------- |
| Rendered preview disk cache (instant cold-open) | Built  | `RenderedPreviewCache.swift`            |
| Thumbnail regeneration after edit save          | Built  | `EditSession.regenerateThumbnail()`     |
| Grid thumbnail refresh on return to browse      | Built  | `ThumbnailCell` tick detection          |
| Opaque JPEG encoding (no alpha warning)         | Built  | `ImageEditPipeline.encodePreviewJPEG()` |

### Export

| Feature                      | Status          | Key Files                                          |
| ---------------------------- | --------------- | -------------------------------------------------- |
| JPEG export (quality slider) | Built           | `ExportEngine.swift`                               |
| HEIC export                  | Built           | `ExportEngine.swift`                               |
| TIFF export (16-bit)         | Built           | `ExportEngine.swift`                               |
| PNG export                   | Built           | `ExportEngine.swift`                               |
| Long-edge resize             | Built           | `ExportConfiguration.swift`                        |
| Export sheet UI              | Built           | `ExportSheet.swift`                                |
| Metadata strip toggle        | Partially built | Toggle exists; selective EXIF/IPTC not implemented |
| Share sheet (iOS)            | Not started     |                                                    |

---

## Phase 3 — Color Engine

**Status: Not started**

Advanced color grading tools and real-time scopes.

| Feature                                                | Status      | Notes                                                   |
| ------------------------------------------------------ | ----------- | ------------------------------------------------------- |
| Curves (RGB, per-channel, luminosity)                  | Not started | No `AdjustmentModel` fields, no CIFilter mapping        |
| HSL panel (8 color ranges: hue, saturation, luminance) | Shipped     | Oklab 8-band stage (#1112) + Web and Apple panels (#274) |
| Color wheels (Lift / Gamma / Gain)                     | Not started |                                                         |
| Histogram                                              | Not started | `ScopesTabView.swift` exists with placeholder text      |
| Waveform                                               | Not started |                                                         |
| Vectorscope                                            | Not started |                                                         |
| False color overlay                                    | Not started |                                                         |
| LUT support (.cube files, 33/65-point)                 | Not started |                                                         |
| Presets engine (save, load, share)                     | Not started | Copy/paste of `AdjustmentModel` exists in UI            |
| Before/After (split, toggle, reference image)          | Not started |                                                         |
| Wide gamut soft-proofing (sRGB, Print)                 | Not started | Pipeline outputs Display P3; soft-proof not implemented |

---

## Phase 4 — Advanced Editing

**Status: Not started**

| Feature                                                               | Status      |
| --------------------------------------------------------------------- | ----------- |
| Panorama stitching (Vision + vImage)                                  | Not started |
| Masking (subject, sky, luminance, color, gradient, brush)             | Not started |
| Healing and cloning                                                   | Not started |
| Geometry (crop, perspective, keystone, lens profiles, rotation, flip) | Not started |
| Batch editing (apply adjustments to selection)                        | Not started |
| Smart collections (auto-filter by metadata rules)                     | Not started |
| Stacking (HDR merge, focus stack)                                     | Not started |
| Export profiles with watermarks                                       | Not started |

---

## Phase 5 — Platform Polish & Sync

**Status: Not started** (some groundwork laid)

| Feature                                           | Status          | Notes                                              |
| ------------------------------------------------- | --------------- | -------------------------------------------------- |
| iCloud sidecar sync                               | Not started     |                                                    |
| Apple Pencil (pressure, hover, scribble)          | Not started     |                                                    |
| Keyboard/trackpad shortcuts                       | Partially built | Culling hotkeys exist; full menu bar not wired     |
| ProRes RAW decode                                 | Not started     |                                                    |
| Plugin API                                        | Not started     |                                                    |
| Collaboration (review links, comments)            | Not started     |                                                    |
| Tethered capture (USB/WiFi)                       | Not started     |                                                    |
| Accessibility (VoiceOver, Dynamic Type)           | Partially built | Basic support; full audit pending                  |
| macOS native polish (menus, Touch Bar, Spotlight) | Partially built | Native target, not Catalyst; menus not fully wired |

---

## What's Next

Phase 3 is the natural next step. The priority features that would most impact usability:

1. **Histogram** — real-time scope in the detail panel (most requested by photographers)
2. **Curves** — the single most powerful color tool; unlocks fine tonal control
3. **HSL** — per-color adjustments (shift sky hue, desaturate greens, etc.)
4. **Before/After** — essential for evaluating edits
5. **Crop/Rotate** — basic geometry (could be pulled from Phase 4)

The pipeline architecture (lazy CIFilter chain + `AdjustmentModel` + XMP serialization) is designed to absorb new adjustments: add the field to `AdjustmentModel`, map it in `CIFilterMapping`, add the slider in `ColorTabView`, and the sidecar/undo/copy-paste infrastructure picks it up automatically.
