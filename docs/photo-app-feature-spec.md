# Photo App — Feature Specification

**Platforms:** macOS, iOS, iPadOS (simultaneous)  
**Stack:** Swift, SwiftUI, Metal, Core Image, PhotoKit, Vision, Accelerate/vImage  
**Color target:** Professional (color wheels, scopes, LUT support)  
**Edit model:** Non-destructive, sidecar-based

---

## Architecture principles

- Shared Swift codebase via Swift Package Manager modules; platform-specific UI layers in SwiftUI
- Non-destructive pipeline: original files never modified; all edits stored in XMP sidecar
- Metal-backed image processing pipeline throughout — GPU acceleration from decode to display
- Two data sources treated as first-class: Apple Photos library (PhotoKit) and filesystem (Files app via FileProvider + Security-Scoped Bookmarks)
- Uniform edit model across platforms — edits made on iPad roam to Mac and vice versa

---

## Phase 1 — Foundation

**Goal:** Library browsing, culling, and sidecar infrastructure. No image editing yet — this phase is about navigating and organising your photos across both PhotoKit and the filesystem.

### Library browser

- PhotoKit integration: browse Albums, Smart Albums, Moments, People, Places
- Local filesystem browser: folder tree, Security-Scoped Bookmarks for persistent access
- Files app integration via FileProvider extension (appears as a location in Files.app)
- Unified grid view across both sources with thumbnail generation
- Lazy thumbnail loading with background decode queue
- Drag-and-drop import (macOS + iPadOS)

### Culling tools

- Star ratings (1–5)
- Flags: Pick / Reject / Unflagged
- Color labels (Red, Orange, Yellow, Green, Blue)
- Quick filter bar: show only picks, by rating, by label
- Keyboard-driven culling on Mac (P/X/1–5 hotkeys)
- Multi-select + batch apply

### Non-destructive sidecar system

- XMP sidecar (`.xmp`) as the primary and only format — no conversion step needed
- **Filesystem images:** sidecar lives alongside the original (`IMG_1234.CR3` → `IMG_1234.xmp`); iCloud Drive syncs it automatically with the photo
- **Photos library images:** PhotoKit does not expose a writable path inside the library package, so sidecars are stored at `~/Pictures/[AppName]/sidecars/<PhotoKit-UUID>.xmp`; app manages sync separately (see Phase 4)
- Custom `papp:` namespace for app-specific data: masks, panorama source references, snapshots, flags
- Standard `xmp:Rating` and `dc:` fields for ratings and labels — interoperable with any XMP-aware tool
- Full edit history with named snapshots (stored in `papp:` namespace)
- Revert to original at any time

---

## Phase 2 — RAW Development & Export

**Goal:** Full RAW develop pipeline on top of the Phase 1 library and sidecar foundation. All edits write to `.xmp` sidecars established in Phase 1.

### RAW development

- Decode via Core Image RAW + AVFoundation; targets 750+ camera formats
- Apple ProRAW and ProRAW Max support
- Demosaic, highlight recovery, shadow lift
- Adjustments: Exposure, Contrast, Highlights, Shadows, Whites, Blacks
- White Balance: temperature + tint + eyedropper
- Vibrance, Saturation
- Clarity, Texture, Dehaze
- Sharpening + noise reduction (luminance + color)

### Export

- JPEG (quality slider), HEIC, TIFF (16-bit), PNG
- Resize by pixel, percentage, long edge
- Metadata: strip, keep, or selectively include EXIF/IPTC
- Share sheet integration (iOS/iPadOS)
- Drag-to-export (macOS)

### Metal image pipeline

- All adjustment math runs on GPU via Metal shaders
- Tile-based processing for large RAW files (>50MP)
- Real-time preview update as sliders move
- Zoom to 100% with pixel-accurate rendering

---

## Phase 3 — Color Engine

**Goal:** Professional color grading suite. Full scopes, color wheels, LUT pipeline.

### Curves

- RGB composite curve
- Individual R, G, B channel curves
- Luminosity curve
- Point-based Bezier control; click to add, drag to remove
- Input/output value readout on hover

### HSL panel

- 8 color ranges: Red, Orange, Yellow, Green, Aqua, Blue, Purple, Magenta
- Per-range: Hue shift, Saturation, Luminance
- On-image color picker to select target hue range
- Expanded range handles for precise control

### Color wheels

- Three-way wheels: Lift (shadows), Gamma (midtones), Gain (highlights)
- Per-wheel: saturation ring + luminance slider
- Reset individual wheel or all
- Numeric readout (RGB + Luma offset values)

### Scopes

- Histogram: RGB overlay or parade (stacked R/G/B)
- Waveform: luma, RGB parade, or individual channel
- Vectorscope: chroma + hue distribution plot, with broadcast-safe circle overlay
- False color mode: exposure value heatmap overlaid on image
- All scopes update live with edits; resizable panel

### LUT support

- Import `.cube` 3D LUTs (33-point and 65-point)
- Intensity slider (0–100% blend)
- LUT library with preview thumbnails
- Export edited images with LUT baked in, or keep as non-destructive adjustment

### Presets engine

- Create user preset from any edit state
- Apply preset to single image or batch
- Partial preset application: choose which adjustment groups to apply
- Built-in starter presets: Neutral, Cinematic, Matte, B&W

### Wide gamut

- Display P3 color space throughout the pipeline
- ProPhoto RGB for RAW processing headroom
- Soft-proof against sRGB and Print profiles
- HDR display support on Pro Display XDR and iPad Pro (P3 + EDR)

### Before/after

- Split screen: adjustable divider, horizontal or vertical
- Toggle view (tap/click to flip)
- Reference image: pin any image as a color reference alongside current edit

---

## Phase 4 — Advanced Editing

**Goal:** Panorama stitching, masking, retouching, geometry, and batch tools.

### Panorama stitching

- Select source images from library or filesystem
- Feature detection via Vision framework (`VNHomographicImageRegistrationRequest`)
- Seam blending via vImage multi-band blending
- Projection options: Cylindrical, Spherical, Perspective
- Auto-crop with boundary warp fill option
- Output as full-resolution TIFF or HEIC; retains non-destructive edit capability
- Supports exposure-bracketed source sets (HDR panorama)

### Masking system

- Subject mask: Vision `VNGenerateForegroundInstanceMaskRequest`
- Sky mask: Vision sky segmentation
- Luminance range mask: mask by brightness range with smoothness control
- Color range mask: sample a color, dial in hue/saturation range
- Gradient mask: linear and radial, with feather
- Brush mask: paint in/out with Apple Pencil or mouse; pressure-sensitive
- Mask intersect / combine / subtract operators
- Per-mask: invert, feather, density

### Healing and cloning

- Content-aware heal brush (patch-based inpainting via Core Image)
- Clone stamp with offset source point
- Remove tool: AI-assisted object removal (on-device ML model)
- Apple Pencil: pressure controls brush size on iPad

### Geometry

- Crop and straighten (freeform, aspect-ratio locked, or preset ratios)
- Perspective correction: horizontal + vertical keystone sliders
- Guided upright: tap two lines that should be parallel
- Lens profile correction: distortion, vignette, chromatic aberration
- Rotation and flip

### Batch editing

- Sync settings from hero image to selection
- Choose which adjustment modules to sync
- Apply preset to entire album or folder
- Export batch with per-image filename templates

### Smart collections

- Filter library by: camera model, lens, ISO range, focal length, date range, edit state, rating, label
- Saved filters as persistent smart albums
- Combine multiple filters with AND / OR logic

### Stacking

- HDR merge: align + merge exposure-bracketed sets, deghost option
- Focus stack: align + merge focus-bracketed sets for extended depth of field
- Motion blur average: creative long-exposure simulation from burst

### Export profiles

- Named export profiles (Web, Print, Social, Archive)
- Per-profile: format, resolution, color space, metadata policy, watermark
- Watermark: text or image, position, opacity, scale

---

## Phase 5 — Platform Polish & Sync

**Goal:** First-class platform experience on all three targets, cloud sync, extensibility.

### iCloud sync

- Sidecar files sync via iCloud Drive automatically
- Preview cache sync for faster loading on secondary devices
- Conflict resolution: last-edit-wins with per-adjustment granularity
- Offline-first: full editing capability without network; syncs on reconnect

### Apple Pencil (iPadOS)

- Pressure sensitivity for brush mask size
- Hover preview before touch
- Double-tap gesture to toggle tool mode (mask / clone / crop)
- Scribble support for text fields (rename albums, add captions)

### Keyboard and trackpad (Mac + iPadOS)

- Full keyboard shortcut coverage; customizable on Mac
- Multi-touch trackpad gestures: pinch zoom, two-finger scroll in library
- Stage Manager and external display support on iPad
- Menu bar integration on Mac (full menu hierarchy)

### ProRes RAW

- Decode and develop ProRes RAW and ProRes RAW HQ from supported cameras
- Full tone curve and white balance applied in RAW space before compression

### Plugin API

- Swift-based extension points: custom filter, export destination, import source
- In-process extensions for performance (no XPC overhead for filters)
- Sandboxed plugin model; distribute via direct download or Mac App Store

### Collaboration

- Share a read-only review link to an edited image or album (via CloudKit share)
- Recipient can view image + edit decisions in a web viewer (no app required)
- Comments and annotations on shared images

### Tethered capture

- USB tethering for supported cameras via IOKit (macOS)
- WiFi tethering via camera HTTP APIs where available
- Auto-import to designated library folder on capture
- Live view display on iPad (camera-dependent)

### Accessibility

- Full VoiceOver support: image descriptions via Vision API
- Dynamic Type throughout
- Reduce Motion compliance
- High Contrast mode adjustments

### macOS native

- Mac Catalyst baseline, with AppKit overrides for panels, inspectors, and toolbar
- Mac-native inspector panel layout (sidebar + detail + inspector)
- Touch Bar support (older hardware)
- Spotlight integration: index image metadata

---

## Technical notes

### Sidecar schema (v1)

XMP with two namespaces: standard `crs:` for common adjustments, custom `papp:` for app-specific data.

```xml
<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.com/maple-maple/1.0/"

      xmp:Rating="5"
      crs:Exposure2012="+0.30"
      crs:Temperature="5800"
      crs:Tint="-2"
      crs:Highlights2012="-40"
      crs:Shadows2012="+30"
      crs:ToneCurvePV2012="0, 0, 128, 140, 255, 255"
      crs:LookName="Rec709"
      crs:LookAmount="0.75"

      papp:Flag="pick"
      papp:ColorLabel="green"
      papp:SourceHash="sha256:abc123..."
      papp:AppVersion="1.0"
    />
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
```

Mask geometry, panorama source lists, and snapshot state are stored as serialised `papp:` child elements (RDF bags) within the same `.xmp` file.

### Panorama stitching pipeline

1. Feature extraction: `VNDetectKeyPointsRequest` or SIFT via Accelerate
2. Homography estimation: `VNHomographicImageRegistrationRequest`
3. Cylindrical / spherical warp: Metal compute shader
4. Multi-band blending: vImage Gaussian pyramid blend (3–5 bands)
5. Boundary fill: content-aware inpainting for crop padding
6. Output: 16-bit TIFF or HEIC with embedded sidecar

### Scope rendering

- All scopes rendered as Metal textures, updated on edit commit
- Waveform: 1-pixel column histogram across image width
- Vectorscope: Cb/Cr scatter plot in YCbCr space
- Parade: side-by-side R, G, B waveforms with fixed 100% IRE scale

---

## Milestones summary

| Phase   | Target      | Key unlock                                           |
| ------- | ----------- | ---------------------------------------------------- |
| Phase 1 | ~2–3 months | Library navigation, culling, sidecar foundation      |
| Phase 2 | +3–4 months | RAW develop + export — app becomes usable end-to-end |
| Phase 3 | +3–4 months | Professional color grading differentiator            |
| Phase 4 | +4–5 months | Panorama + masking = power user feature set          |
| Phase 5 | +3–4 months | Polished, synced, extensible                         |
