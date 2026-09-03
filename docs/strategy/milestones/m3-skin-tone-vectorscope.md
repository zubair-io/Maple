# M3a — Skin-tone vectorscope and person skin mask (macOS first)

**Milestone 15 · Local Adjustments & Repair.** A slice of [m3-local-adjustments.md](m3-local-adjustments.md) that ships the first mask UI on Apple and the first live scope on Apple, driven by one product moment: seeing objectively whether a subject's skin sits on the skin-tone line and fixing it in place. Written 2026-09-03; the design was agreed in conversation before this document was written.

## 1. Outcome

A photographer opens a portrait, turns on the vectorscope, creates a mask of the subject's skin in two clicks, and watches the skin cloud move onto the skin-tone line as they drag a Hue slider on that mask. Every slider tick updates both the canvas and the scope inside the 16 ms budget on the GPU live path. Closing the image and reopening it, on this device or another, brings the mask and its edits back from the XMP sidecar, and the sidecar stays readable by Lightroom and Camera Raw.

That sentence decomposes into five capabilities that must all be true at once, and the acceptance test in §8 walks exactly that flow:

1. A vectorscope in the editor with labeled colour targets, a skin-tone line, and a "red at 3 o'clock" graticule option, both toggled from a context menu.
2. A person → skin mask, created from a Mask tool, covering facial and body skin.
3. The scope follows the selected mask: while a mask is selected the vectorscope plots only that mask's pixels.
4. A Hue control on the mask, alongside the existing per-mask temperature, tint and saturation.
5. Real time and non-destructive: no readback of pixels on the present path, and the mask plus its adjustments round-trip through the sidecar in Adobe-readable form.

The demo transcript this is built from, paraphrased: open a portrait whose skin is slightly off; show the vectorscope; right-click it to show the skin-tone line and put red at 3 o'clock; open Masks, choose the person, tick facial skin and body skin, create; the skin plots as a cloud; go to the colour controls for that mask, drag hue until the cloud sits on the line; compare before and after.

Web and Windows are follow-ups, not part of this slice (§10). The core work (§5) is shared by construction so the web slice is UI only.

## 2. Current state, layer by layer

| Layer                    | What exists today                                                                                                                                                                                                                                                                                                  | What this slice needs                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vectorscope component    | Maple UI has a Vectorscope molecule on all three platforms (`MuiVectorscope.swift`, `mui-vectorscope.component.ts`, `MuiVectorscope.cs`): a BT.601 Cb/Cr dot scatter on a plain six-spoke circle, no labels, no skin line, no contract doc. Web mounts nothing but the histogram in the editor; Apple mounts none. | Density input, Rec.709 chroma, labeled targets, skin-tone line and wedge, graticule rotation, context menu, a contract doc, and an editor mount on Apple. |
| Scope data, Apple        | The histogram is the only scope. `MiniHistogram` recomputes it off the render path, debounced 350 ms, through `maple_histogram_bytes` (a full re-develop). The GPU live present goes straight to the `CAMetalLayer` with zero CPU readback. #3251 (iceboxed) asks for the three other scopes.                      | A per-tick, mask-aware scope statistic that does not read pixels back.                                                                                    |
| Scope data, web          | The render worker draws the presented WebGPU canvas into a ≤512 px offscreen canvas per frame and hands the RGB snapshot to the scopes (#1045).                                                                                                                                                                    | Nothing in this slice. The GPU statistic in §5 replaces the pixel snapshot when the web UI slice lands.                                                   |
| Mask math and data model | `raw-core` has `Mask::{Linear, Radial}` and `PartialAdjustments` with ten controls, applied between dehaze and sharpen on the CPU and by one WGSL kernel on the GPU (#1698). Flat 24-float records carry layers across the FFI.                                                                                    | `hue`; a colour-range refinement; bitmap and whole-image masks; a raster supply across the FFI; a 32-float record.                                        |
| Mask sidecar             | Rust writes and reads Adobe's `crs:GradientBasedCorrections` / `crs:CircularGradientBasedCorrections`. Swift and TypeScript do not model masks; they pass the elements through verbatim (#2233).                                                                                                                   | Rust learns `crs:MaskGroupBasedCorrections` with `Mask/Image`, `crs:LocalHue`, and Maple-private range attributes. Swift models the whole block.          |
| Mask UI                  | None on any platform. Web's tool dock and Apple's `ToolDock.swift` render Mask and Heal as disabled placeholders citing #1541 and #1472. #355 (Apple) and #1541 (web) are open.                                                                                                                                    | `Tool.mask`, a mask panel, a people picker, per-mask sliders, a raster overlay.                                                                           |
| Segmentation             | Nothing on device. Apple's Vision framework is unused (only VisionKit's QR scanner on tvOS). The server detects faces as boxes (SCRFD) for People, not masks. ONNX Runtime exists only inside the pano stitcher, with user-provisioned models on macOS.                                                            | A Vision-backed person instance mask plus face rectangles, on device, no downloads.                                                                       |
| Fixtures                 | `test_0002` (studio portrait, light skin) and `test_0003` (outdoor portrait, darker skin) have ACR baselines.                                                                                                                                                                                                      | Committed skin rasters for both and a skin-ROI metric.                                                                                                    |

## 3. Product behaviour

### 3.1 The vectorscope

The scope lives as a HUD in the top-trailing corner of the canvas, the same slot and treatment the frame-time HUD uses (`GpuFrameTimeHud.swift`), so it works in both control layouts and on iPad. A "Scope" button in the pill toggles it; the choice persists across launches. Its context menu (right-click or long-press) carries two toggles, "Show skin tone line" and "Red at 3 o'clock", both persisted. The default graticule is the broadcast one; the default skin line is off, matching the demo's discovery of the option.

The plot is a density plot, not a dot scatter: brighter where more pixels land, on a log scale so a small skin cloud still reads against a large neutral mass. Six labeled targets (R, Mg, B, Cy, G, Yl) sit where a pure primary or secondary of the canvas colour space lands, derived from the same matrix that plots the pixels rather than hardcoded angles. The skin-tone line is drawn at 123° in the broadcast orientation with a faint ±10° wedge, the convention Resolve and Lightroom share. "Red at 3 o'clock" rotates the whole graticule and cloud so the R target sits at 0°.

While a mask is selected in the mask panel the scope shows only that mask's pixels, weighted by the mask's feathered edge, and the panel header reads "Scope: <mask name>". With no mask selected the scope shows the whole frame. Toggling "Show overlay" does not change the scope.

### 3.2 The Mask tool

`Tool.mask` joins the Detail group as a special tool the way Crop and Presets do: a real dock button replaces the disabled placeholder in the compact layout, and the stacked layout's special-tools row gains the same button. Arming it shows the mask panel in the inspector slot the armed tool owns.

The panel is a list of the image's layers, one row per `LocalAdjustment`: a kind glyph, a name ("Skin 1"), an enabled toggle, and delete via swipe or a trailing button. Selecting a row selects the mask for the scope and for the sliders below. The Add menu offers People; Linear and Radial appear disabled with #355's number, the same treatment the dock gives Mask today.

People opens a sheet: the developed preview with numbered outlines around each detected person, a picker if there is more than one, two checkboxes (Facial skin, Body skin, both on by default), and Create. With no person detected the sheet says so and offers "Skin range only (whole image)". Create adds the layer, selects it, and the scope narrows to it immediately, before any slider moves.

Below the list, the selected mask's controls are Living sliders in this order: Hue, Temperature, Tint, Saturation, Vibrance, Exposure, Contrast, Highlights, Shadows, Whites, Blacks. Hue is the new control (§5.1). Each slider rides the ordinary sub-param value pipe so undo, redo, the value HUD and fine mode all work unchanged. "Show overlay" tints the mask raster red over the canvas; it visualises the person raster, not the live colour-range refinement, which the scope itself makes visible.

### 3.3 Persistence

The sidecar stores the recipe, never the pixels: which person, which skin flags, which model produced the raster, and a digest. The raster is a derivative under `.maple/masks/` and regenerates when missing. Mask edits participate in undo and in the dirty state; they are excluded from copy/paste/sync settings exactly as local adjustments already are.

## 4. Architecture: the tick

On the GPU live path a slider or mask edit mutates `EditSession.model`, whose `didSet` schedules the fast phase as today. `presentViaGpuLive` builds `MapleGpuLiveParams` with the new tail fields of §5.3 and §5.5 (the mask raster table and plane, the scope-target layer index, the scope-enabled flag, and a pointer to a stats struct) and calls `maple_gpu_present_chain`. Inside `raw-gpu`:

1. The live chain runs unchanged up to `local_adjustments`. That kernel now samples bitmap masks from a plane appended to its layers buffer, evaluates the colour-range refinement on its input pixel, applies `hue`, and, when a layer is flagged as the scope target, writes that layer's weight into the alpha lane of its output. The alpha lane is otherwise untouched by every RGBA pass in the chain (verified by grep during design and pinned by a test in §8), so the weight rides for free to the end of the view tail with no extra binding. Weight-only mode runs even when the layer carries no adjustments, which is the state right after Create.
2. A new scope pass at the end of the view tail, before dither, bins each display-encoded pixel into a 128×128 Cb/Cr histogram weighted by its alpha (or by 1.0 when no scope target is set), in fixed point so feathered edges count fractionally, using integer atomics so the result is deterministic. The pass is not encoded at all when the host has no scope visible.
3. The histogram is copied into one of two staging buffers. The present FFI maps the other one, the previous tick's, with a non-blocking poll, and copies it into the caller's stats struct. The scope is one frame behind the canvas and the present never waits on the GPU.

`GpuLiveSession.present` returns the stats alongside the frame time; `EditSession` publishes an observable `scopeSample`; the HUD view redraws from it.

When the GPU flag is off, and for the non-RAW assets the CPU path develops, `raw-core` computes the same histogram from the developed output after the fast phase, using the same mask weights, and publishes it through the same property. That function is also the parity oracle for the kernel.

## 5. Core: `raw-core`, `raw-gpu`, `raw-ffi`

### 5.1 Hue

`PartialAdjustments.hue: Option<f32>` in −100…100 rotates the Oklab hue of the masked pixel by `slider / 100 · HSL_HUE_MAX_RAD` (30° at full deflection, the same constant the HSL stage uses), preserving lightness and chroma, with the same gamut handling the saturation kernel applies. It runs after `blacks` and before `saturation` in both `stages::local_adjustments::apply_pixel` and the WGSL twin. Wire key `crs:LocalHue`, Adobe's own name; the on-wire scale is pinned against a Lightroom-authored sidecar when one exists (§11) and until then written as the slider value divided by 100, which is how Adobe scales the other `crs:Local*` keys. It takes the padding slot at index 22 of the flat record with presence bit 10.

### 5.2 Colour-range refinement

`LocalAdjustment` gains `range: Option<RangeRefinement>`, with one variant for now: `Color { hue_deg, hue_half_width_deg, chroma_min, l_min, l_max, feather }`, all in Oklab. The weight is the product of the primary mask weight and a raised-cosine hue band gated by chroma and lightness with smoothstep edges of width `feather` of the band. It is evaluated on the pixel entering the local-adjustments stage, so it does not chase the layer's own edit and it does track upstream exposure and white balance. The skin preset seeds it at hue 55° (the commonly-cited skin-locus angle), half-width 25°, chroma at least 0.02, lightness 0.15 to 0.95, feather 0.3. Measured against the two portrait fixtures, `test_0002` (studio, near-neutral as-shot white balance) clusters tightly at 53–63°, matching the seed; `test_0003` (warm, backlit outdoor light) clusters at −48° to +16° across two separate skin regions of the same photo, an 80–100° real divergence no reasonably tight band can bridge without admitting most non-green hues. The seed stays at its literature value rather than being fit to either fixture: this range is a coarse refinement layered on the geometric Vision person/face mask (§5.3), not a white-balance-invariant skin detector on its own — excluding obviously non-skin colours within an already-geometric region. A future per-mask-adjustable range (the eyedropper #362 already plans) is the right fix for a scene like `test_0003`.

The flat record grows from 24 to 32 floats, two more `vec4`s: slots 24…30 carry `range_kind` (0 none, 1 colour) and the six parameters. `LAYER_FLAT_LEN`, the WGSL `Layer` struct, `flat.rs`'s slot map, and the C# mirror change in the same PR (gate #3221). On the wire the refinement is six `papp:Range*` attributes on the correction's `rdf:Description`, Maple-private by design: Adobe's own range-mask schema is undocumented and a reference renderer that ignores the attributes still applies the correction through the primary mask, which is the graceful degradation.

### 5.3 Bitmap and whole-image masks

Two new variants. `Mask::Bitmap { raster: usize }` indexes a raster table supplied by the host; the raster is an R8 plane sampled bilinearly in the same oriented, uncropped, normalized coordinate frame linear and radial masks use, so crop and orientation need no special handling. `Mask::Everywhere` is weight 1, the primitive behind "skin range only".

On the GPU the rasters ride the existing layers storage buffer as a trailing f32 plane, the way the film LUT rides its lattice in a storage buffer, so the kernel keeps its pooled four-binding shape; a bitmap layer record carries raster width, height, and float offset in its geometry slots. Across the FFI both `MapleGpuLiveParams` and `MapleAdjustmentParams` gain an appended `mask_rasters_ptr/len` table of `{digest, width, height, offset}` plus a `mask_plane_ptr/len` f32 plane. A recipe whose raster is absent from the table evaluates to weight 0: the correction never silently becomes global.

The XMP form is a third container, `crs:MaskGroupBasedCorrections`, the one Lightroom 11+ uses for its own AI masks; the correction element is the same shape as the two existing containers, and the mask entry is `crs:What="Mask/Image"` with `crs:MaskSubType="1"` plus Maple-private attributes: `papp:MaskSource` (`PersonSkin` or `Everywhere`), `papp:MaskPerson`, `papp:MaskFacialSkin`, `papp:MaskBodySkin`, `papp:MaskModel`, `papp:MaskDigest`. That is the shape Lightroom itself writes for Select Subject: a reference to a raster it regenerates, no pixels. This supersedes [m3-local-adjustments.md](m3-local-adjustments.md) §8 decision 4, which suggested nesting AI masks under `crs:PaintBasedCorrections`: Adobe paint masks are dab lists, not bitmaps, so a rasterized mask cannot be expressed there without a lossy dab approximation. The tolerant reader keeps skipping any `crs:What` it does not model.

### 5.4 The scope pass

`scope_vectorscope.wgsl` reads the display-encoded RGBA f32 buffer, converts each pixel with the Rec.709 YCbCr matrix, and adds `round(alpha · 255)` to bin `(cb, cr)` over [−0.5, 0.5]² at 128×128, plus a running total. `raw_core::scope::vectorscope_histogram(&Image, weights: Option<&[f32]>)` is the reference implementation and the CPU-path producer. `MapleScopeStats { frame: u64, total: u32, bins: [u32; 16384] }` is the C struct the host supplies.

### 5.5 Gating

`local_adjustments_are_active` also returns true when a scope-target layer is set, so weight-only mode is encoded. The scope pass is gated on the host's `scope_enabled` flag.

## 6. Apple

### 6.1 Segmentation and the raster cache

`PersonSkinMaskService`, an actor in MapleCore, runs `VNGeneratePersonInstanceMaskRequest` and `VNDetectFaceRectanglesRequest` over a fresh, uncropped develop of about one megapixel from `PipelineRenderer.render` (never the display preview, which may carry the crop and would put the raster in the wrong coordinate frame). Both requests need macOS 14 / iOS 17, which are already the package floors. It returns person candidates (instance index, bounding box) for the picker and, on Create, the raster at 1024 px long edge: facial skin is the instance mask intersected with the face rectangles dilated by 20 %, body skin is the instance mask minus that. Skin colour is not baked into the raster; it stays a live refinement (§5.2).

Rasters cache at `.maple/masks/<sha16(basename)>-<recipeDigest>.png`, the thumbnail cache's naming rule, where the digest hashes the recipe attributes and the model identifier. `EditSession` owns a `MaskRasterStore` that resolves every `Mask::Bitmap` recipe in the model to a raster before each render and builds the FFI plane once per change, not per tick. Opening a sidecar whose raster is missing regenerates it in the background; until it lands the layer renders at weight 0 and its row shows "Regenerating mask"; if regeneration fails the row shows "Mask unavailable" and the layer stays inert.

### 6.2 Model and sidecar in Swift

MapleCore gains `LocalAdjustment`, `Mask`, `RangeRefinement` and `PartialAdjustments` mirrors, and `AdjustmentModel.localAdjustments`. The flat-record writer is pinned against a JSON fixture of layers and expected floats that the Rust tests load too, so the two writers cannot drift. `XMPSerialization` emits the three correction containers and parses them; `XMPPassthroughScanner` stops treating those elements as unknown, otherwise every save would emit them twice. The Swift emitter is hand-written, the precedent set by the point tone curves (#365), and pinned by the same byte-canonical corpus tests.

`Tool` gains `.mask` and, per m3 §8 decision 2, `.heal` in the same change so #1472 fills in behaviour behind an existing case; `.heal` arms nothing and shows nothing yet, gated behind #1472 with a code comment saying so, the deliberate-staging exception CLAUDE.md allows.

### 6.3 Views

New files under `src/apple/Maple/Views/Masks/`: `MaskPanel.swift` (list plus controls), `PeoplePickerSheet.swift`, `MaskOverlay.swift` (the red raster tint, mapped with `CropGeometry`'s footprint the way `CropOverlay` maps its rectangle), and `VectorscopeHud.swift` (the HUD host, its context menu and AppStorage keys). `MuiVectorscope` in MapleUI gains the density input, the Rec.709 math, targets, skin line and rotation as additive parameters with defaults that keep the existing call sites valid; `MuiVectorscopeMath` gains the derived target angles and the rotation. Web's `mui-vectorscope` receives the same additive inputs in the same PR so the catalog row stays truthful, and `docs/design/maple-ui/components/vectorscope.md` is written with the sections `tools/check-maple-ui-contracts.sh` requires. The Windows twin is a follow-up ticket (§9).

## 7. Failure modes and guards

The scope never blocks a present: a missed readback keeps the previous sample and logs once. The scope pass costs nothing while hidden. No person detected offers the whole-image fallback; a Vision error shows a toast and creates nothing. Rasters are derived data and are never load-bearing for the sidecar contract, never copied by copy/paste, never embedded in XMP. A raster missing at render time means weight 0, never a global correction. Non-RAW assets and the GPU-off path keep the scope through the CPU producer. The alpha-lane weight is guarded by a chain test, so a future kernel that resets alpha fails CI rather than silently blanking the scope.

## 8. Testing and gates

Rust unit tests cover the hue rotation in closed form (angle moves by the expected amount, lightness and chroma preserved), the range refinement inside, outside and across the band edge, bilinear raster sampling at known points and weight 0 outside the raster, the 32-float round trip against the shared fixture, the XMP round trip of `MaskGroupBasedCorrections` with `Mask/Image`, `papp:Range*` and `crs:LocalHue`, and the tolerant reader's behaviour on unknown masks.

The GPU parity suite extends `local_adjustments/tests.rs` with bitmap, range and hue cases against the Rust apply, adds an alpha-passthrough test across the live chain, and checks the scope kernel's bins against `vectorscope_histogram` within one count per bin.

The colour harness gains `--roi <mask.png>` on `compare_images.py`, committed skin rasters for `test_0002` and `test_0003` under each fixture's `masks/`, and a `baseline_skin` budget cell per fixture so skin ΔE against ACR becomes a ratcheted number. The existing baseline cells guard that the new stage and the alpha plumbing move nothing when no mask exists.

MapleCore tests cover the flat writer against the shared fixture, the XMP corpus (a Maple sidecar with a person-skin mask, a Lightroom sidecar passing through), `MuiVectorscopeMath` (Rec.709 chroma, target angles, rotation, density binning), and a fixture-gated `PersonSkinMaskService` test on `test_0003` that skip-passes without RAWs.

Performance is read off the existing frame-time HUD: a present with the scope enabled stays inside 16 ms on the reference set on Apple silicon, and the number is recorded in the PR that wires the HUD.

The demo itself is an XCUITest: open `test_0003`, show the scope, arm Mask, create the skin mask, assert the scope's accessibility value reports a masked sample, drag Hue, and assert the reported cloud centroid angle moves toward 123°. Objective, no screenshots, alongside the visual harness rather than replacing it.

## 9. Tickets and order

One epic under milestone 15 on the Files board, with eleven sub-issues, each closed by one PR:

1. `raw-core`/`raw-gpu`/XMP: `hue` local adjustment and `crs:LocalHue`.
2. `raw-core`/`raw-gpu`/XMP/C#: colour-range refinement and the 32-float record.
3. `raw-core`/`raw-gpu`/`raw-ffi`/XMP: bitmap and whole-image masks, raster supply, `MaskGroupBasedCorrections`.
4. `raw-gpu`/`raw-core`/`raw-ffi`: scope pass, CPU reference, double-buffered readback, `MapleScopeStats`.
5. Apple: `PersonSkinMaskService` and the `.maple/masks/` cache with regenerate-on-open.
6. Apple: Swift model, flat writer, XMP block, passthrough exclusion, `Tool.mask`/`.heal`.
7. Apple: mask panel, people picker, per-mask sliders, overlay.
8. Apple and web: Vectorscope v2 and its contract doc.
9. Apple: scope HUD wired to the GPU and CPU producers.
10. Harness: `--roi`, committed skin rasters, `baseline_skin` budgets.
11. XCUITest demo flow.

Items 1 to 4 are core and run in parallel except that 2 lands before 3 (both rewrite the flat record). 6 waits on 2 and 3; 7 waits on 5 and 6; 9 waits on 4 and 8; 10 waits on 5; 11 waits on 7 and 9. 5 and 8 have no dependencies.

Relationship to open tickets: #3251 gets its vectorscope slice from 4, 8 and 9 and keeps waveform and parade; #362 gets its core half from 2 and its UI (eyedropper, range sliders) stays open; #361 gets its core half and its Apple person path from 3 and 5, with sky masks staying open; #355 keeps the linear and radial canvas handles and inherits 6's data layer; #1541 is untouched; #2445 links the epic. Follow-ups filed alongside: the Windows `MuiVectorscope` twin, the web mask UI slice, and the web scope switch from pixel snapshot to the GPU statistic.

## 10. Non-goals

Web and Windows mask UI. Waveform and parade on Apple. Brush and sky masks. Linear and radial canvas handles. A sampled-colour Point Color panel with its own range sliders: the mask-scoped Hue plus the skin refinement cover the demo, and a colour picker is the natural extension of §5.2 once a second use case asks for it. Embedded mask rasters in XMP. Any change to the web scope snapshot in this slice.

## 11. Decisions taken here, and what stays open

Taken: the scope is display-referred, in the canvas colour space as encoded, with Rec.709 chroma; the skin line is a graticule convention at 123°, not a colour-space derivation; AI masks are `Mask/Image` recipes in `MaskGroupBasedCorrections`, not paint masks (supersedes m3 §8 decision 4); range refinements are Maple-private attributes; the weight rides the alpha lane; rasters are 1024 px R8 derivatives, never sidecar content.

Open: the exact Adobe scale of `crs:LocalHue` and the `crs:MaskSubType` value Lightroom writes for people masks are best-effort until a Lightroom-authored sidecar for `test_0002` with a Select Subject mask, a Color Range refinement and a Hue adjustment exists as a fixture; the skin band constants stay at their literature seed rather than a fixture-fit value, per §5.2's measurement — a real per-photo white-balance divergence, not something the core plan should paper over with a wider global constant; the Windows vectorscope twin lags the catalog until its follow-up lands.
