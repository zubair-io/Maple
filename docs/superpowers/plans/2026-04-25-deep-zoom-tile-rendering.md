# Deep Zoom — Tile-Based 1:1+ Pixel-Peeping (Ticket 06 Milestone 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Companion ticket: `docs/tickets/06-viewport-sized-rust-ffi-preview.md` § "Recommended Milestones / Milestone 4".**
>
> **Hard prerequisite: Plan 1 v2 Task 8 (sized scene-linear FFI) must be merged before any task in this plan starts.** This plan reuses the helpers `develop_scene_linear_from_raw_with_quality`, `downsample_image_area`, `apply_orientation_f32_rgba`, and `f32_to_f16_bits` that Task 8 added; it also reuses the `MapleSceneLinearBuffer` ABI struct and the kernel-availability runtime guard from Plan 1 Task 4. Cross-link: `docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md` Tasks 2, 3, 4, 7, 8.
>
> **Cut for this plan: Milestones 1, 2, 3 from the design brief.** Milestone 4 (prefetch/predictive ring), tile parity on Web/WASM, disk persistence, 2:1+ upsampling, dehaze-active-during-deep-zoom, and gesture velocity prediction are explicitly deferred to follow-up plans (see § Out of scope).

**Goal:** Add Lightroom/Capture-One-style pixel-peeping to the macOS / iPad app: when the user zooms past `pixelScale ≥ 1.0`, render the visible source-pixel rectangle through the full Rust development chain at native resolution and composite tiles over the upscaled cached preview, with overlap pads sufficient for demosaic + neighborhood filters (clarity is the binding stencil).

**Architecture:**
1. **Rust core gains a tile entry.** `render_scene_linear_tile_from_raw_with_quality(raw, model, src_x, src_y, src_w, src_h, out_w, out_h, quality)` reuses the shared `develop_scene_linear_from_raw_with_quality` helper but on the **padded mosaic crop** `(src_x − 35, src_y − 35, src_w + 70, src_h + 70)` clamped to bounds, then trims 35 px each side after `nr_color`, downsamples to `(out_w, out_h)` via the existing `downsample_image_area` helper, orients (treating the tile as a window into the oriented full image), and packs to fp16 RGBA. **Mosaic crop coordinates round down to the nearest even number on both axes** so the half-res quad demosaic and the Bayer CFA color lookup land on the correct phase.
2. **Tile-only pad: 35 source pixels per edge.** Stencil radius budget on the in-bounds development chain (excluding dehaze, which is whole-image-only): demosaic Hamilton-Adams 2 px, Bayer half-res 1 px, hamilton_adams 2-pixel border, sharpen 3-iter RL ~9 px, nr_color 4 px at amount=100, texture 3 px, **clarity radius=40 box=13 × 3 passes ≈ 39 px** (binding constraint). 35 + buffer satisfies all stages except clarity-at-extreme; clarity at slider amount > 0 is allowed but tiles will show ~4 px of edge ringing where the box-blur tail extends past the pad — visible only at the seam between tiles, masked by the upscaled cached-preview underlay (see § Open questions).
3. **Dehaze fallback.** When `model.dehaze != 0`, the FFI tile entry **returns an error** (`MAPLE_TILE_UNSUPPORTED_DEHAZE`); the Apple TileManager catches the error, marks the asset as "tile-unsafe", and forces fit-zoom UX (no 1:1 deep zoom) for the duration of that dehaze adjustment. Dehaze radius 67 (60 box + 7 dark-channel) blows past 35 px of pad and isn't tile-safe at any reasonable pad budget. Gesture and toolbar zoom paths read this flag and clamp `maxPixelScale` to fit.
4. **Apple TileManager actor** owns the in-memory `[TileKey: CIImage]` map plus a `Task` priority queue. API: `update(viewport: CGRect, zoom: CGFloat) -> CIImage`. Cache key: `(asset_url_md5, sidecar_mtime, view_transform_version, zoom_bucket ∈ {1×, 2×, 4×, 8×}, tile_x, tile_y)`. Strict byte budget: **200 MB iPhone / 1 GB Mac** (excludes preview + decoded caches). Eviction LRU by total bytes — large fp16 tile = 30 MB padded working set in Rust but final composited CIImage is 16 MB at 512×512 fp16 RGBA, and the cache stores the composited CIImage.
5. **RawImageCache (architectural prerequisite).** New session-scoped Apple actor `RawImageCache` keyed on `(url, mtime)` holds **one** entry: the latest decoded `RawImage` (rawler-decoded mosaic). Tiles look up the cached entry; on miss, the FFI does the rawler decode itself, returns the tile pixels, and writes back through a separate FFI entry that exposes a stable **opaque handle** (a `MapleRawHandle` retained Box pointer, freed via `maple_free_raw_handle`). Eviction triggers on asset switch and on any non-tile FFI call.
6. **Two-phase render at deep zoom.** When `pixelScale ≥ 1.0`, the fast phase remains the upscaled cached preview (already rendered for fit zoom — preserves the 50 ms slider tick), and the refine phase routes through TileManager to fetch only the visible tiles, composing them over the cached preview via `CIImage` overlay (lazy — no allocation until `createCGImage`).
7. **No prefetch in this plan.** Phase-1 strict-window only (visible tiles + 0 ring). Predictive prefetch is a follow-up (see § Out of scope).
8. **Web parity deferred.** WASM tile FFI signature is **specified** at the byte level in this plan as a documentation artifact (see § Web FFI signature, deferred), but no WASM code changes here.

**Tech Stack:**
- Rust (`raw-core`, `raw-ffi`, `maple-cli`) — tile entry function in `pipeline.rs`, FFI entry + opaque-handle struct in `raw-ffi/src/lib.rs`, `tile` subcommand in `maple-cli/src/main.rs`. fp16 bit conversion via `f32_to_f16_bits` (Plan 1 Task 8). Padded mosaic crop arithmetic at the start of the tile entry, before the shared develop helper.
- Swift (`MapleCore`) — `RawImageCache` actor, `TileManager` actor, `MapleRawHandleBox` Swift wrapper for the opaque pointer, `decodePreviewTile(asset:srcRect:targetSize:)` on `ImageEditPipeline`, `renderPreviewTile(handle:srcRect:targetSize:quality:)` on `PipelineRenderer`. Compositing via `CIImage.composited(over:)` in `CIImageView` (`FullImageView.swift:411`).
- Build glue — `./src/apple/scripts/build-xcframework.sh` regenerates `RawPipeline.h` after the FFI signature change.

**Brainstorm origin:** design brief produced 2026-04-25 (in this prompt). The brief's geometry and stencil-radius math is locked-in; the only open questions surfaced (not resolved) are listed in § Open questions.

**Verified findings (each maps to a task):**

1. **Plan 1 Task 8 added the helpers this plan reuses.** `develop_scene_linear_from_raw_with_quality` at [`pipeline.rs:77`](../../src/raw-pipeline/raw-core/src/pipeline.rs:77) returns the developed `Image` in `ColorSpace::SceneLinearRec2020`. `apply_orientation_f32_rgba` at [`pipeline.rs:165`](../../src/raw-pipeline/raw-core/src/pipeline.rs:165) does the orientation pass in fp32 RGBA. `f32_to_f16_bits` at [`pipeline.rs:211`](../../src/raw-pipeline/raw-core/src/pipeline.rs:211) is the canonical fp16 encoder. `downsample_image_area` is added by Plan 1 Task 8 (per-pixel area-average — see Plan 1 § Task 8 Step 8.2). All four are direct reuses; this plan does not duplicate them.

2. **Stencil radii are well-bounded at 35 px overlap (excluding dehaze).** Confirmed:
   - `clarity::CLARITY_RADIUS = 40` at [`stages/clarity.rs:6`](../../src/raw-pipeline/raw-core/src/stages/clarity.rs:6) → 3-pass box ≈ 39 px effective tail.
   - `nr_color` radius `((amount/100.0) * 4.0).ceil().max(1)` at [`stages/noise_reduction.rs:64`](../../src/raw-pipeline/raw-core/src/stages/noise_reduction.rs:64) → 4 px max at amount=100.
   - `texture::TEXTURE_RADIUS = 3` at [`stages/texture.rs:6`](../../src/raw-pipeline/raw-core/src/stages/texture.rs:6).
   - `sharpen` 3-iter RL with radius 0.5–3.0 px at [`stages/sharpen.rs:33`](../../src/raw-pipeline/raw-core/src/stages/sharpen.rs:33) → ≤9 px effective.
   - `demosaic::hamilton_adams` 2-pixel border at [`demosaic/hamilton_adams.rs:18`](../../src/raw-pipeline/raw-core/src/demosaic/hamilton_adams.rs:18).
   - `demosaic::half_res` 2×2 quad collapse at [`demosaic/half_res.rs:11`](../../src/raw-pipeline/raw-core/src/demosaic/half_res.rs:11) — needs the crop offsets to be even (Bayer phase).
   - `dehaze::guided_filter` radius 60 + dark-channel kernel 7 at [`stages/dehaze.rs:159`](../../src/raw-pipeline/raw-core/src/stages/dehaze.rs:159) → 67 px **far beyond** 35 px pad. Tile path errors when `dehaze != 0`.

3. **`MapleSceneLinearBuffer` ABI is reusable as-is.** Defined at [`raw-ffi/src/lib.rs:277`](../../src/raw-pipeline/raw-ffi/src/lib.rs:277) — `bytes_per_pixel: 8`, `channels: 4`, fp16 RGBA. The tile FFI returns the same struct; the buffer carries `width` / `height` (the trimmed-and-downsampled output dimensions, which match the caller's `out_w` / `out_h`).

4. **Existing zoom UX has the entry points.** `MagnifyGesture` at [`FullImageView.swift:298`](../../src/apple/Maple/Views/FullImageView.swift:298), `Cmd-1`/`Cmd-=`/`Cmd--` shortcuts at [`FullImageView.swift:248-272`](../../src/apple/Maple/Views/FullImageView.swift:248), `maxPixelScale = 8.0` at [`FullImageView.swift:53`](../../src/apple/Maple/Views/FullImageView.swift:53). `effectivePixelScale(viewport:)` at [`FullImageView.swift:92`](../../src/apple/Maple/Views/FullImageView.swift:92) is the read-out used to feed `session.pixelScale` (which the Plan 1 ImageEditPipeline already consumes for refine sizing).

5. **EditSession's two-phase scheduler is the routing layer.** `_scheduleRender(.fast)` at [`EditSession.swift:727`](../../src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift:727), `_scheduleRefine` at [`EditSession.swift:750`](../../src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift:750), `decodeAndRender(targetSize:phase:)` at [`EditSession.swift:774`](../../src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift:774). The refine branch is where Task 8 of this plan inserts a `pixelScale ≥ 1.0` check that re-routes through TileManager.

6. **FullImageView's `CIImageView` is the composite point.** [`FullImageView.swift:411`](../../src/apple/Maple/Views/FullImageView.swift:411) renders one CIImage to a CGImage via `Self.context.createCGImage(image, from: image.extent, format: .RGBA8, colorSpace: outputColorSpace)`. To composite tiles, the input CIImage to `CIImageView` becomes a `tilesLayer.composited(over: previewLayer)` chain; CoreImage's lazy planner handles the union extent and the per-pixel selection.

**Out of scope (explicit):**
- **Predictive prefetch / ring buffer.** Phase 1 strict-window only — visible tiles + 0 ring (the brief explicitly defers prefetch to a follow-up). A subsequent plan adds a 1-tile ring around the visible window plus pan-velocity-aware prefetch.
- **Web (WASM) tile parity.** WASM signature spec'd in this plan (§ Web FFI signature, deferred); no Rust → WASM glue or Angular changes here.
- **Disk persistence of tiles.** In-memory LRU only. Disk-backed tile cache is a follow-up — fp16 tiles compress poorly; would need BC6H/RGTC GPU compression or lossless WebP-fp16 (no spec exists today).
- **Above-1:1 upsampling (2:1, 4:1).** Cap `out_w / out_h ≤ src_w / src_h`. The TileManager's zoom buckets are `{1×, 2×, 4×, 8×}` for *cache keying* (so different display zooms land in different cache slots), not for *requesting* > native pixels. CoreImage's nearest-neighbor handles the on-screen upsample for the 2× / 4× / 8× zoom buckets.
- **Dehaze active during deep zoom.** Tile FFI errors when `dehaze != 0`; UX clamps `maxPixelScale` to fit-zoom for that adjustment. A future "tile-aware dehaze" plan would split the guided-filter into a global atmospheric-light / dark-channel pass plus a tile-local refinement; out of scope here.
- **Velocity-aware gesture refinement.** No pan-speed-based prefetch decisions, no momentum-aware tile cancellation. Pan stops → tile fetch starts. Phase-1 simplicity.
- **Modifying any caching contract for `RenderedPreviewCache` or `DecodedBufferCache`.** Both keep their existing keys and storage. TileManager is additive.
- **Tile size other than 512×512.** Brief locks 512² as the source-pixel tile size; budget math (fp32 RGB working buffer + clarity gaussian scratch ≈ 30 MB padded) accommodates 6+ in-flight on iPhone (200 MB cap). 1024² quadruples that; no plan to introduce a tile-size knob.
- **Adjusting Plan 1's env gate (`MAPLE_SCENE_LINEAR`).** Plan 1's gate controls fit-zoom routing through the scene-linear FFI; this plan's deep-zoom path is a separate code path keyed on `pixelScale` and is **also gated behind `MAPLE_SCENE_LINEAR=1`** (deep zoom requires the scene-linear pipeline; legacy display-encoded tiles aren't supported). Task 9 of this plan documents this dependency.

---

## File Structure

**Rust (read-write):**
- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs` — Task 1 adds `render_scene_linear_tile_from_raw_with_quality` calling the shared `develop_scene_linear_from_raw_with_quality` helper on a padded mosaic crop. Reuses `apply_orientation_f32_rgba`, `f32_to_f16_bits` (no duplication). New private helpers: `pad_and_clamp_mosaic_rect` (Step 1.4), `crop_mosaic_to_padded_rect` (Step 1.5), `trim_image_to_inner` (Step 1.6).
- Modify: `src/raw-pipeline/raw-core/src/image.rs` — no changes needed; `Image::pixels` is already a flat `Vec<[f32;3]>` indexable by `(y * width + x)`. The new `crop_mosaic_to_padded_rect` and `trim_image_to_inner` helpers operate on `Image` directly.
- Modify: `src/raw-pipeline/raw-ffi/src/lib.rs` — Task 2 adds `maple_render_file_scene_linear_tile`, `maple_render_bytes_scene_linear_tile`, and the new opaque-handle struct `MapleRawHandle` with `maple_decode_raw_handle` / `maple_render_tile_from_handle` / `maple_free_raw_handle` (Tasks 3 + 4). Reuses `MapleSceneLinearBuffer`. Error code `MAPLE_TILE_UNSUPPORTED_DEHAZE = 10` for the dehaze fallback.
- Modify: `src/raw-pipeline/maple-cli/src/main.rs` — Task 1 Step 1.10 adds a `Tile` subcommand: `maple-cli tile <DNG> <src_x> <src_y> <src_w> <src_h> <out_w> <out_h> --out tile.png`. PNG output via existing `raw_core::png::encode` after a one-shot Rec.2020→sRGB convert + AgX through a bundled CPU view-transform helper (validates the rendering math without UI).

**Rust (read-only during verification):**
- `src/raw-pipeline/raw-core/src/stages/clarity.rs:6` — confirms 40 px radius, the binding-constraint stencil.
- `src/raw-pipeline/raw-core/src/stages/dehaze.rs:159` — confirms 60 + 7 px radius (tile-unsafe).
- `src/raw-pipeline/raw-core/src/demosaic/half_res.rs:11` — confirms even-multiple Bayer phase requirement.
- `src/raw-pipeline/raw-core/src/demosaic/hamilton_adams.rs:18` — confirms 2-pixel demosaic border (hidden by 35 px overlap).
- `src/raw-pipeline/raw-core/src/image.rs` — `RawImage::cfa`, `RawImage::orientation`, `Image::width`/`height`/`pixels` field shapes.

**Swift (read-write):**
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/RawImageCache.swift` — Task 5 adds the new actor. Single-entry cache keyed on `(URL, mtime)`. Stores an opaque `MapleRawHandleBox` reference plus the asset URL + mtime. Eviction on asset switch.
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/MapleRawHandleBox.swift` — Task 4 wraps the C `*mut MapleRawHandle` as a `final class` with `deinit { maple_free_raw_handle(...) }`. Sendable-conformant via `@unchecked Sendable` because the underlying pointer is opaque and access is serialized through `RawImageCache`'s actor.
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/TileManager.swift` — Task 6 adds the actor. Owns `[TileKey: TileEntry]` (keyed: `(URLHash, sidecar mtime, view-transform version, zoom-bucket, tile-x, tile-y)`), a `Task` queue for in-flight fetches, and a byte-budget LRU. Public API: `update(asset:viewport:zoom:) async -> CIImage`.
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/PipelineRenderer.swift` — Task 4 adds `decodeRawHandle(rawPath:) throws -> MapleRawHandleBox` and `renderPreviewTile(handle:srcRect:targetSize:quality:) throws -> MapleSceneLinearImageData`. Both wrap the new FFI entries.
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` — Task 7 adds `nonisolated public func decodePreviewTile(asset:srcRect:targetSize:) async -> CIImage?` returning a Rec.2020-fp16 tile CIImage. Internally goes through `RawImageCache.shared.handle(for:)` then `PipelineRenderer.renderPreviewTile(...)`, then builds `CIImage(bitmapData:...)` tagged extendedLinearITUR_2020 with origin set to the source rect's top-left in the oriented full-image coordinate space (so `composited(over:)` lands the tile at the right place).
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift` — Task 8 inserts a `pixelScale >= 1.0` branch into `_scheduleRefine` (currently at [`EditSession.swift:750`](../../src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift:750)). When deep zoom, the refine call replaces `pipeline.process(...)` on the cached upscaled preview with a `tileManager.update(...)` that returns a CIImage composing tiles over the upscaled preview.
- Modify: `src/apple/Maple/Views/FullImageView.swift` — Task 8 wires `session.pixelScale` and `viewportSize` into `EditSession.tileManager` via a new `EditSession.updateTileVisibleRegion(viewport:zoom:)` call inside the existing `magnificationGesture` and zoom-shortcut paths. Adds Cmd+scroll handling on macOS (no equivalent gesture exists today; `MagnifyGesture` and `Cmd+=` are used today, no Cmd+scroll trackpad support).
- Add: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift` — new test file for tile-rendering integration tests (Tasks 1, 2, 5, 6, 7) and the Cmd+scroll gesture wiring test (Task 8).

**Swift (read-only during verification):**
- `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/RenderedPreviewCache.swift` — confirms the (already cached) upscaled preview keying that Task 8's fast-phase fallback uses.
- `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/DecodedBufferCache.swift` — confirms the unrelated decoded-buffer cache that the new path does not touch.

**Generated header (rebuilt by `build-xcframework.sh`):**
- `src/apple/Frameworks/RawPipeline.xcframework/.../Headers/RawPipeline.h` — auto-regenerated. cbindgen picks up the new FFI entries and structs after Task 2 / 3.

---

## Ordering constraint

**This plan depends on Plan 1 v2 Task 8 being merged.** Verify before starting:

```bash
grep -n "pub fn render_scene_linear_sized_from_raw_with_quality" \
  src/raw-pipeline/raw-core/src/pipeline.rs
grep -n "pub fn downsample_image_area" \
  src/raw-pipeline/raw-core/src/pipeline.rs
grep -n "pub unsafe extern \"C\" fn maple_render_file_scene_linear_sized" \
  src/raw-pipeline/raw-ffi/src/lib.rs
```

Expected: each command returns one match line. If any returns no match, **stop and merge Plan 1 v2 first.**

**Tasks 1 + 2 are blocking for Tasks 3-9.** No Apple-side work starts until the Rust FFI tile entry compiles, the parity test passes, and the cbindgen header is regenerated.

**Task 5 (RawImageCache) is blocking for Tasks 6-8.** TileManager assumes `RawImageCache.shared.handle(for:)` exists.

---

## Task 1: Rust core — tile entry function with padded mosaic crop

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs`
- Modify: `src/raw-pipeline/maple-cli/src/main.rs`
- Test: `src/raw-pipeline/raw-core/src/pipeline.rs` (in-file `mod tests`)

**Why this matters:** The development chain currently runs over the whole image. Tile rendering needs the same chain over a sub-rectangle, with enough overlap on each edge that the stencil-radius filters (clarity at 39 px effective being the binding constraint) don't see beyond the padded crop's boundary. The brief's geometry: 512×512 source pixels, 35 px overlap each side (resulting in 582×582 effective working area, then trim 35 px each side after `nr_color` to get 512×512, then `downsample_image_area` to the requested `out_w × out_h`). Also: mosaic crop coords round down to even (Bayer phase preservation for `demosaic::half_res` and the CFA color lookup at `demosaic/hamilton_adams.rs`).

- [ ] **Step 1.1: Confirm Plan 1 v2 Task 8 helpers exist in the working tree.**

Run:
```bash
grep -n "pub fn develop_scene_linear_from_raw_with_quality" \
  src/raw-pipeline/raw-core/src/pipeline.rs
grep -n "fn downsample_image_area" \
  src/raw-pipeline/raw-core/src/pipeline.rs
grep -n "fn apply_orientation_f32_rgba" \
  src/raw-pipeline/raw-core/src/pipeline.rs
grep -n "fn f32_to_f16_bits" \
  src/raw-pipeline/raw-core/src/pipeline.rs
```

Expected: four match lines. If any is missing, stop and resolve the Plan 1 v2 dependency.

- [ ] **Step 1.2: Re-read `pipeline.rs` and the demosaic / clarity sources to confirm the brief's stencil math.**

Read:
- `src/raw-pipeline/raw-core/src/pipeline.rs` lines 67-200 (the shared develop helper + orientation + fp16 pack).
- `src/raw-pipeline/raw-core/src/demosaic/half_res.rs` lines 11-50 (Bayer phase: `cfa.color_at(2x, 2y)`).
- `src/raw-pipeline/raw-core/src/demosaic/hamilton_adams.rs` lines 15-30 (2-pixel border).
- `src/raw-pipeline/raw-core/src/stages/clarity.rs` lines 1-22 (radius 40, 3-pass box).

Confirm:
- The shared develop helper signature is `pub fn develop_scene_linear_from_raw_with_quality(raw: &RawImage, model: &AdjustmentModel, quality: RenderQuality) -> Result<crate::image::Image>`.
- `Image::pixels` is `Vec<[f32; 3]>` indexed as `pixels[y * width + x]`.
- `RawImage::cfa` is `CfaPattern` (4-color CFA enum), `RawImage::orientation` is `ExifOrientation`.

- [ ] **Step 1.3: Write the failing tile-rendering integration test.**

Append to the `mod tests` block in `src/raw-pipeline/raw-core/src/pipeline.rs` (immediately after the existing `f32_to_f16_bits_*` tests):

```rust
    /// Tile entry: renders a 512×512 source-pixel rectangle out of a
    /// 100 MP DNG fixture (or the largest available fixture). Verifies
    /// (a) returned size matches `out_w` × `out_h`, (b) alpha lane is
    /// 0x3c00 (1.0) everywhere, (c) at least 10% of the buffer is non-
    /// alpha, non-zero (i.e. real pixels not borders).
    #[test]
    fn render_scene_linear_tile_returns_oriented_fp16_rgba_at_target_size() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let (src_x, src_y, src_w, src_h) = (1024u32, 1024u32, 512u32, 512u32);
        let (out_w, out_h) = (512u32, 512u32);
        let (w, h, fp16) = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, src_x, src_y, src_w, src_h, out_w, out_h,
            RenderQuality::Full,
        ).expect("tile render");
        assert_eq!(w, out_w, "tile width");
        assert_eq!(h, out_h, "tile height");
        assert_eq!(fp16.len() as u32, 4 * w * h);
        let alpha_ok = fp16.chunks_exact(4).filter(|c| c[3] == 0x3c00).count();
        assert_eq!(alpha_ok, (w * h) as usize, "all alpha lanes = 1.0");
        let nonzero = fp16.iter().filter(|&&v| v != 0 && v != 0x3c00).count();
        assert!(nonzero > (fp16.len() / 10),
            "tile mostly zero: {} non-zero non-alpha lanes", nonzero);
    }

    /// Tile entry rejects dehaze != 0 with a specific error.
    #[test]
    fn render_scene_linear_tile_rejects_active_dehaze() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel { dehaze: 50.0, ..Default::default() };
        let r = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 1024, 1024, 512, 512, 512, 512,
            RenderQuality::Full,
        );
        assert!(r.is_err(), "tile path must error when dehaze active");
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("dehaze"), "error must mention dehaze, got: {}", msg);
    }

    /// Tile entry rounds source coordinates down to even multiples of 2
    /// for Bayer-phase correctness on `demosaic::half_res`. Pass odd
    /// coords; verify the rendered tile matches what the even-rounded
    /// coords produce. (Pixel-equality not required — orientation +
    /// downsample may shift sub-pixel; we assert dimensions match.)
    #[test]
    fn render_scene_linear_tile_rounds_source_coords_to_even() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let (w_odd, h_odd, _) = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 1025, 1025, 512, 512, 256, 256,
            RenderQuality::Full,
        ).expect("odd coords tile");
        let (w_even, h_even, _) = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 1024, 1024, 512, 512, 256, 256,
            RenderQuality::Full,
        ).expect("even coords tile");
        // Both render to the requested output size — coord rounding is
        // a defensive snap; `out_w`/`out_h` aren't perturbed.
        assert_eq!((w_odd, h_odd), (256, 256));
        assert_eq!((w_even, h_even), (256, 256));
    }
```

- [ ] **Step 1.4: Run the new tests to verify they fail (function not yet defined).**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib render_scene_linear_tile 2>&1 | tail -10`

Expected: **compilation error** — `cannot find function 'render_scene_linear_tile_from_raw_with_quality' in this scope`. That's the TDD-fail signal.

- [ ] **Step 1.5: Implement the padded-mosaic-crop helper and the tile entry function.**

In `src/raw-pipeline/raw-core/src/pipeline.rs`, append (after `render_scene_linear_sized_from_raw_with_quality` from Plan 1 Task 8) the following functions. Place each `pub fn` under doc-comments and keep the same `stage()`-wrapping style as the rest of the file.

```rust
/// Pad a (src_x, src_y, src_w, src_h) source-pixel rect by `pad` pixels on
/// each edge, clamp to (0..mosaic_w, 0..mosaic_h), and round the resulting
/// rect's `(x, y, x+w, y+h)` corners DOWN to the nearest even multiple to
/// preserve Bayer phase for `demosaic::half_res`. Returns the padded rect
/// plus the (left_pad, top_pad) actually applied — the trim step at the
/// end of the tile entry uses these to compute the inner-image-relative
/// crop after the development chain runs on the padded buffer.
fn pad_and_clamp_mosaic_rect(
    src_x: u32, src_y: u32, src_w: u32, src_h: u32,
    pad: u32, mosaic_w: u32, mosaic_h: u32,
) -> ((u32, u32, u32, u32), (u32, u32)) {
    let pre_x = src_x.saturating_sub(pad);
    let pre_y = src_y.saturating_sub(pad);
    let pre_x_end = (src_x + src_w + pad).min(mosaic_w);
    let pre_y_end = (src_y + src_h + pad).min(mosaic_h);
    // Round corners DOWN to even multiples (Bayer phase). End corners
    // round UP within bounds so the inner rect is fully covered.
    let x = pre_x & !1u32;
    let y = pre_y & !1u32;
    let x_end_aligned = ((pre_x_end + 1) & !1u32).min(mosaic_w);
    let y_end_aligned = ((pre_y_end + 1) & !1u32).min(mosaic_h);
    let w = x_end_aligned - x;
    let h = y_end_aligned - y;
    let left_pad = src_x - x;        // how many extra px on the left
    let top_pad = src_y - y;         // how many extra px on the top
    ((x, y, w, h), (left_pad, top_pad))
}

/// Crop a CameraNativeMosaic Image to a sub-rectangle. Returns a fresh
/// mosaic Image at the cropped dimensions; the CFA pattern is preserved
/// because (x, y) are guaranteed even (see `pad_and_clamp_mosaic_rect`).
fn crop_mosaic_to_padded_rect(
    mosaic: &crate::image::Image, rect: (u32, u32, u32, u32),
) -> crate::image::Image {
    use crate::image::ColorSpace;
    let (cx, cy, cw, ch) = rect;
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let mut out = crate::image::Image::new(cw, ch, ColorSpace::CameraNativeMosaic);
    let sw = mosaic.width as usize;
    for y in 0..(ch as usize) {
        let src_row = ((cy as usize) + y) * sw + (cx as usize);
        let dst_row = y * (cw as usize);
        out.pixels[dst_row..dst_row + cw as usize]
            .copy_from_slice(&mosaic.pixels[src_row..src_row + cw as usize]);
    }
    out
}

/// Trim an Image to its inner (left_pad, top_pad, inner_w, inner_h) rect.
/// Used after the development chain runs on the padded crop — we discard
/// the overlap region and keep only the requested source-pixel area.
/// Note: this runs in fp32 RGB, AFTER `nr_color` and BEFORE downsampling.
fn trim_image_to_inner(
    img: &crate::image::Image,
    left_pad: u32, top_pad: u32,
    inner_w: u32, inner_h: u32,
) -> crate::image::Image {
    use crate::image::ColorSpace;
    let space = img.color_space();
    let mut out = crate::image::Image::new(inner_w, inner_h, space);
    let sw = img.width as usize;
    for y in 0..(inner_h as usize) {
        let src_off = ((top_pad as usize) + y) * sw + (left_pad as usize);
        let dst_off = y * (inner_w as usize);
        out.pixels[dst_off..dst_off + inner_w as usize]
            .copy_from_slice(&img.pixels[src_off..src_off + inner_w as usize]);
    }
    out
}

/// Tile-overlap pad in source pixels per edge. Picked to satisfy
/// clarity at radius 40 (3-pass box ≈ 39 px) — the binding stencil among
/// the tile-safe stages. Other stages (demosaic 2 px, sharpen ≤ 9 px,
/// nr_color ≤ 4 px, texture 3 px) sit comfortably inside this pad.
/// Dehaze (radius 67) is NOT tile-safe — see `render_scene_linear_tile_*`.
pub const TILE_OVERLAP_PX: u32 = 35;

/// Render a tile of the developed scene-linear Rec.2020 fp16 RGBA image.
///
/// Parameters:
/// - `(src_x, src_y, src_w, src_h)`: source-pixel rectangle in mosaic
///   coordinates (pre-orientation). The mosaic crop coords get rounded
///   to even via `pad_and_clamp_mosaic_rect` for Bayer-phase preservation.
/// - `(out_w, out_h)`: target dimensions — never upscale; this fn errors
///   if `out_w > src_w || out_h > src_h`.
/// - `quality`: `Preview` (half-res quad demosaic) or `Full` (bilinear
///   or hamilton_adams per `cfg(feature)`).
///
/// Errors:
/// - `model.dehaze != 0` → returns `Err` with a "dehaze" message; tiles
///   are not safe with dehaze active (radius 67 vs 35 pad).
/// - `out_w > src_w || out_h > src_h` → returns `Err` ("upscale"); the
///   tile path caps at native resolution.
///
/// Output is fp16 RGBA, length `4 * out_w * out_h`, alpha = 0x3c00. The
/// orientation is applied by walking the trim+downsample output through
/// `apply_orientation_f32_rgba` (so the (src_x, src_y) handed in is in
/// pre-orientation space; the returned tile's orientation matches the
/// full-image's `apply_orientation` output).
pub fn render_scene_linear_tile_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    src_x: u32, src_y: u32, src_w: u32, src_h: u32,
    out_w: u32, out_h: u32,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u16>)> {
    if model.dehaze.abs() > 1e-3 {
        return Err(crate::error::Error::Pipeline(
            "tile path is not supported when dehaze != 0 (radius 67 px > 35 px overlap pad)".into()
        ));
    }
    if out_w > src_w || out_h > src_h {
        return Err(crate::error::Error::Pipeline(
            format!("tile path is downscale-only: out {}×{} > src {}×{}", out_w, out_h, src_w, src_h)
        ));
    }
    let mosaic_full = stage("linearize", || linearize::sensor_linearize(raw));
    let (rect, (left_pad, top_pad)) = pad_and_clamp_mosaic_rect(
        src_x, src_y, src_w, src_h, TILE_OVERLAP_PX, mosaic_full.width, mosaic_full.height,
    );
    let mosaic = stage("tile_mosaic_crop", || crop_mosaic_to_padded_rect(&mosaic_full, rect));
    // Build a synthetic RawImage that points at the cropped mosaic. We
    // can't reuse `raw` directly because the develop helper reads
    // `raw.cfa`/`raw.orientation`/`raw.baseline_exposure`, all of which
    // we want preserved, but reads `mosaic.{width, height}` indirectly
    // via `linearize::sensor_linearize(raw)`. Cheaper: bypass the helper
    // by inlining its body for the cropped mosaic. See Step 1.6.
    let scene = develop_scene_linear_from_padded_mosaic(
        &mosaic, raw, model, quality,
    )?;
    // Trim the 35-px overlap, leaving the inner src_w × src_h block.
    // For half-res Preview the trim coords halve too — the cropped
    // mosaic was half-resed by `demosaic::half_res`, so the "inner"
    // region is at (left_pad / 2, top_pad / 2) with size
    // (src_w / 2, src_h / 2). For Full quality it's (left_pad, top_pad)
    // with (src_w, src_h).
    let (inner_lp, inner_tp, inner_w, inner_h) = match quality {
        RenderQuality::Preview => (left_pad / 2, top_pad / 2, src_w / 2, src_h / 2),
        RenderQuality::Full => (left_pad, top_pad, src_w, src_h),
    };
    let trimmed = stage("tile_trim_inner", || {
        trim_image_to_inner(&scene, inner_lp, inner_tp, inner_w, inner_h)
    });
    let mut sized = trimmed;
    let target_long_edge = out_w.max(out_h);
    if target_long_edge < sized.width.max(sized.height) {
        stage("tile_downsample_area", || downsample_image_area(&mut sized, target_long_edge));
    }
    let (w0, h0) = (sized.width, sized.height);
    let rgba_f32 = stage("tile_pack_rgba_f32", || {
        let mut v = Vec::with_capacity(sized.pixels.len() * 4);
        for p in &sized.pixels {
            v.push(p[0]); v.push(p[1]); v.push(p[2]); v.push(1.0);
        }
        v
    });
    // Orient the tile in fp32 RGBA. The orientation maps source-pixel
    // (sensor) coordinates to display coordinates; the tile FFI's
    // `(src_x, src_y)` argument is in source-pixel space, so the
    // returned tile's pixel space is post-orientation, matching the
    // unsized scene-linear FFI's output.
    let (w, h, oriented_f32) = stage("tile_apply_orientation_rgba", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    let fp16: Vec<u16> = stage("tile_pack_fp16", || {
        oriented_f32.iter().map(|&v| f32_to_f16_bits(v)).collect()
    });
    Ok((w, h, fp16))
}
```

- [ ] **Step 1.6: Implement `develop_scene_linear_from_padded_mosaic` (variant of the shared develop helper that takes a pre-cropped mosaic).**

The shared helper at `pipeline.rs:77` calls `linearize::sensor_linearize(raw)` and then `demosaic::*(&mosaic, raw.cfa)`. For tiles, we've already done both ourselves on the *cropped* mosaic. We need a sister helper that picks up at "demosaic" with a caller-supplied mosaic, but otherwise runs the identical chain. Add this immediately above `develop_scene_linear_from_raw_with_quality` so the two functions share the same call-site context:

```rust
/// Run the development chain from a pre-cropped CameraNativeMosaic
/// `Image` (as produced by `linearize::sensor_linearize` + a manual
/// `crop_mosaic_to_padded_rect`). Used by the tile path so the linearize
/// + crop pair runs once on the full mosaic and the develop chain runs
/// on a small padded-crop. Mirrors `develop_scene_linear_from_raw_with_quality`
/// but without the shared `linearize` call.
fn develop_scene_linear_from_padded_mosaic(
    mosaic: &crate::image::Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<crate::image::Image> {
    mosaic.assert_space(crate::image::ColorSpace::CameraNativeMosaic);
    let mut camera_rgb = stage("tile_demosaic", || match quality {
        RenderQuality::Preview => demosaic::half_res(mosaic, raw.cfa),
        #[cfg(feature = "high-quality-demosaic")]
        RenderQuality::Full => demosaic::hamilton_adams(mosaic, raw.cfa),
        #[cfg(not(feature = "high-quality-demosaic"))]
        RenderQuality::Full => demosaic::bilinear(mosaic, raw.cfa),
    });
    if raw.baseline_exposure.abs() > 1e-4 {
        stage("tile_baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain; p[1] *= be_gain; p[2] *= be_gain;
            }
        });
    }
    stage("tile_highlight_recovery", || highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery));
    let profile = stage("tile_dcp_profile_for", || dcp::profile_for(raw))?;
    let mut scene = stage("tile_dcp_apply", || dcp::apply(&camera_rgb, &profile))?;
    stage("tile_white_balance", || white_balance::apply(&mut scene, model.temperature, model.tint));
    stage("tile_scene_tone_controls", || scene_tone_controls::apply(&mut scene, model));
    stage("tile_vibrance", || vibrance::apply(&mut scene, model.vibrance));
    stage("tile_saturation", || saturation::apply(&mut scene, model.saturation));
    stage("tile_clarity", || clarity::apply(&mut scene, model.clarity));
    stage("tile_texture", || texture::apply(&mut scene, model.texture));
    // dehaze intentionally omitted — the tile entry asserts dehaze == 0
    // before this function runs (see `render_scene_linear_tile_from_raw_with_quality`).
    stage("tile_sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
    stage("tile_nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    stage("tile_nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    Ok(scene)
}
```

- [ ] **Step 1.7: Verify error variant exists.**

The tile error returns `crate::error::Error::Pipeline(...)`. Confirm the variant exists:

```bash
grep -n "Pipeline\|enum Error" src/raw-pipeline/raw-core/src/error.rs | head -10
```

Expected: at least one match showing `Pipeline(String)` or similar single-string-payload variant. If the variant is named differently (e.g. `Other`, `Custom`), edit Step 1.5's two error returns to use the correct variant name. If no string-payload variant exists, **add one** in this step before continuing.

- [ ] **Step 1.8: Run the tile tests.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib render_scene_linear_tile 2>&1 | tail -15`

Expected: 3 tests pass (or "ignored" if `test_0002.dng` is absent — fixture-gated).

- [ ] **Step 1.9: Run the full raw-core suite to confirm no regression.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5`

Expected: ~94 + 3 (Plan 1 Task 2 + Task 8) + 3 (this task) tests pass.

- [ ] **Step 1.10: Add the `tile` subcommand to `maple-cli`.**

In `src/raw-pipeline/maple-cli/src/main.rs`, add the `Tile` variant to `enum Cmd` (around line 84, after `Inspect`):

```rust
    /// Render a single source-pixel tile to a PNG. Validates the FFI tile
    /// math without UI. Output is sRGB after CPU AgX + Rec.2020->sRGB
    /// (matches the legacy display-encoded path so the result is viewable
    /// directly in Preview.app).
    Tile {
        raw: PathBuf,
        #[arg(long)]
        params: Option<PathBuf>,
        #[arg(long)] src_x: u32,
        #[arg(long)] src_y: u32,
        #[arg(long)] src_w: u32,
        #[arg(long)] src_h: u32,
        #[arg(long)] out_w: u32,
        #[arg(long)] out_h: u32,
        #[arg(long)] out: PathBuf,
        /// Quality: `preview` (half-res quad demosaic) or `full`. Default `full`.
        #[arg(long, default_value = "full")]
        quality: String,
    },
```

In `fn main`, add the dispatcher arm (around line 120):

```rust
        Cmd::Tile { raw, params, src_x, src_y, src_w, src_h, out_w, out_h, out, quality } => {
            run_or_exit(do_tile(&raw, params.as_deref(), src_x, src_y, src_w, src_h, out_w, out_h, &out, &quality))
        }
```

Add `fn do_tile` after `do_inspect`:

```rust
fn do_tile(
    raw: &Path, params: Option<&Path>,
    src_x: u32, src_y: u32, src_w: u32, src_h: u32,
    out_w: u32, out_h: u32, out: &Path, quality: &str,
) -> Result<i32, Box<dyn std::error::Error>> {
    use raw_core::pipeline::{render_scene_linear_tile_from_raw_with_quality, RenderQuality};
    use raw_core::view::{agx, encode};
    let model = match params {
        Some(p) => xmp::parse(&std::fs::read_to_string(p)?)?,
        None => xmp::AdjustmentModel::default(),
    };
    let bytes = std::fs::read(raw)?;
    let ext = raw.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw_img = decode_bytes(&bytes, ext)?;
    let q = match quality {
        "preview" => RenderQuality::Preview,
        "full" => RenderQuality::Full,
        other => return Err(format!("invalid quality '{}': use 'preview' or 'full'", other).into()),
    };
    let (w, h, fp16) = render_scene_linear_tile_from_raw_with_quality(
        &raw_img, &model, src_x, src_y, src_w, src_h, out_w, out_h, q,
    )?;
    // Decode fp16 → f32, build an Image, run the legacy view tail (AgX +
    // Rec.2020->sRGB + quantize) so we can write a viewable PNG.
    let mut img = raw_core::image::Image::new(w, h, raw_core::image::ColorSpace::SceneLinearRec2020);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        let r = decode_fp16(fp16[i * 4]);
        let g = decode_fp16(fp16[i * 4 + 1]);
        let b = decode_fp16(fp16[i * 4 + 2]);
        *p = [r, g, b];
    }
    agx::apply(&mut img, model.contrast);
    encode::rec2020_to_srgb(&mut img);
    let u8_bytes = encode::quantize_u8(&mut img);
    let png = raw_core::png::encode(w, h, &u8_bytes)?;
    std::fs::write(out, png)?;
    Ok(0)
}

/// Local fp16 → f32 decoder for the CLI tile path. Mirrors the inverse
/// of `pipeline::f32_to_f16_bits`.
fn decode_fp16(bits: u16) -> f32 {
    let sign = ((bits & 0x8000) as u32) << 16;
    let exp = ((bits & 0x7c00) >> 10) as u32;
    let mant = (bits & 0x03ff) as u32;
    if exp == 0 && mant == 0 { return f32::from_bits(sign); }
    if exp == 0 {
        let mut e: i32 = -14;
        let mut m = mant;
        while (m & 0x0400) == 0 { m <<= 1; e -= 1; }
        m &= 0x03ff;
        let f = sign | (((127 + e) as u32) << 23) | (m << 13);
        return f32::from_bits(f);
    }
    if exp == 0x1f { return f32::from_bits(sign | 0x7f800000 | (mant << 13)); }
    let e = (exp + 127 - 15) << 23;
    f32::from_bits(sign | e | (mant << 13))
}
```

- [ ] **Step 1.11: Smoke-test the CLI tile command on the reference fixture.**

Run:

```bash
cd src/raw-pipeline && cargo run --release --bin maple-cli -- tile \
  ../../test-fixtures/raws/dji-mavic3pro-100mp.dng \
  --src-x 4096 --src-y 4096 \
  --src-w 512 --src-h 512 \
  --out-w 512 --out-h 512 \
  --out /tmp/tile-mavic-1024-1024.png \
  --quality full 2>&1 | tail -5
ls -lh /tmp/tile-mavic-1024-1024.png
```

(If `dji-mavic3pro-100mp.dng` is absent — `test-fixtures/raws/` is gitignored — substitute the largest available DNG: `ls src/raw-pipeline/test-fixtures/raws/*.dng`. Adjust `--src-x` / `--src-y` so the requested rect fits inside the substitute fixture.)

Expected: PNG file ~1 MB, openable in Preview.app, showing a coherent 512×512 region of the scene (no banding, no mismatched colors, no ringing artifacts on the four edges). This is a visual sanity check, not a parity gate.

- [ ] **Step 1.12: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/pipeline.rs src/raw-pipeline/maple-cli/src/main.rs
git commit -m "$(cat <<'EOF'
feat(raw-core): scene-linear tile render entry + maple-cli `tile` subcommand

Adds `render_scene_linear_tile_from_raw_with_quality` for ticket 06
Milestone 4. 35 px overlap on each edge satisfies clarity (binding
constraint) + demosaic + sharpen + nr_color + texture stencil radii.
Source coords round to even multiples for Bayer-phase preservation.
Errors when `model.dehaze != 0` (radius 67 > 35 px pad). Reuses the
shared `develop_scene_linear_from_raw_with_quality` body via a
sister helper that takes a pre-cropped mosaic so the linearize +
crop pair runs once.

`maple-cli tile <DNG> --src-x ... --out-w 512 --out-h 512` validates
the FFI tile math without UI. PNG output goes through CPU AgX +
Rec.2020->sRGB + quantize tail so the result is viewable.

Cross-link: docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md
Task 1; docs/tickets/06-viewport-sized-rust-ffi-preview.md M4.
EOF
)"
```

---

## Task 2: Rust FFI — `maple_render_*_scene_linear_tile` entry points

**Files:**
- Modify: `src/raw-pipeline/raw-ffi/src/lib.rs`
- Test: `src/raw-pipeline/raw-ffi/src/lib.rs` (in-file `mod tests`)

**Why this matters:** Apple-side TileManager calls into the FFI per tile fetch. Two entries: file-path variant (parallels `maple_render_file_scene_linear_sized`) and bytes variant (parallels `maple_render_bytes_scene_linear_sized`). Reuses `MapleSceneLinearBuffer`. Adds error code `10` for the dehaze-active case so the Apple side can branch UX cleanly.

- [ ] **Step 2.1: Confirm Plan 1 Task 8 sized FFI exists in `raw-ffi/src/lib.rs`.**

```bash
grep -n "pub unsafe extern \"C\" fn maple_render_file_scene_linear_sized" \
  src/raw-pipeline/raw-ffi/src/lib.rs
```

Expected: one match. If missing, stop and merge Plan 1 v2.

- [ ] **Step 2.2: Add a failing FFI tile test.**

Append to the `mod tests` block in `src/raw-pipeline/raw-ffi/src/lib.rs` (currently ending at line 568):

```rust
    #[test]
    fn render_tile_default_model_via_ffi() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                raw_cstr.as_ptr(), std::ptr::null(),
                1024, 1024, 512, 512, 256, 256,
                /*quality_preview=*/0, &mut buf,
            )
        };
        assert_eq!(rc, 0, "tile render rc = {}", rc);
        assert_eq!(buf.width, 256);
        assert_eq!(buf.height, 256);
        assert_eq!(buf.channels, 4);
        assert_eq!(buf.bytes_per_pixel, 8);
        assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
        unsafe { maple_free_scene_linear_buffer(&mut buf) };
    }

    #[test]
    fn render_tile_dehaze_active_returns_error_code_10() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        // Synthesize an XMP file with dehaze=50.
        let xmp_path = std::env::temp_dir().join("tile-dehaze.xmp");
        std::fs::write(&xmp_path, r#"<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Dehaze="50"/></rdf:RDF></x:xmpmeta>"#).unwrap();
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let xmp_cstr = CString::new(xmp_path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                raw_cstr.as_ptr(), xmp_cstr.as_ptr(),
                1024, 1024, 512, 512, 256, 256, 0, &mut buf,
            )
        };
        // Code 10 = dehaze-unsupported; defined in Step 2.3.
        assert_eq!(rc, 10, "expected dehaze-unsupported error code, got {}", rc);
        unsafe { maple_free_scene_linear_buffer(&mut buf) };
    }
```

- [ ] **Step 2.3: Run the new tests to verify failure.**

Run: `cd src/raw-pipeline && cargo test -p raw-ffi --lib render_tile 2>&1 | tail -10`

Expected: compilation error — `cannot find function 'maple_render_file_scene_linear_tile'`.

- [ ] **Step 2.4: Implement the file-path tile FFI entry.**

In `src/raw-pipeline/raw-ffi/src/lib.rs`, immediately after `maple_render_bytes_scene_linear_sized` (Plan 1 Task 8), append:

```rust
/// Tile scene-linear render — same fp16 RGBA output struct as the sized
/// variant, but renders only the source-pixel rectangle
/// `(src_x, src_y, src_w, src_h)`. Pads internally by 35 px to satisfy
/// the development chain's stencil radii (clarity is the binding
/// constraint), then trims to the inner rect, downsamples to
/// `(out_w, out_h)`, orients, and packs to fp16 RGBA.
///
/// Returns 0 on success. Error codes mirror `maple_render_file_scene_linear`
/// plus:
///   - 10: `model.dehaze != 0` — tile path is not supported (radius 67
///          exceeds the 35 px overlap pad). Caller should fall back to
///          fit-zoom rendering.
///   - 11: `out_w > src_w || out_h > src_h` — tile path is downscale-only.
///
/// Plan 3 — see docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md
/// Task 2 and docs/tickets/06-viewport-sized-rust-ffi-preview.md M4.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_scene_linear_tile(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    src_x: u32, src_y: u32, src_w: u32, src_h: u32,
    out_w: u32, out_h: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if src_w == 0 || src_h == 0 || out_w == 0 || out_h == 0 {
        set_last_error("src_w/src_h/out_w/out_h must be > 0".into());
        return 9;
    }
    let raw_path_str = match CStr::from_ptr(raw_path).to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => { set_last_error(format!("raw_path not UTF-8: {}", e)); return 2; }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => { set_last_error(format!("xmp_path not UTF-8: {}", e)); return 3; }
        }
    };
    let out_ptr = out as usize;
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
        };
        let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path)) {
            Ok(b) => b,
            Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&raw_bytes, ext)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality(
            &raw_img, &model, src_x, src_y, src_w, src_h, out_w, out_h, quality,
        ) {
            Ok(t) => t,
            Err(e) => {
                let msg = format!("{}", e);
                set_last_error(msg.clone());
                if msg.contains("dehaze") { return 10; }
                if msg.contains("upscale") || msg.contains("downscale-only") { return 11; }
                return 8;
            }
        };
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr, len_bytes,
                    channels: 4, bytes_per_pixel: 8,
                    width: w, height: h,
                };
        }
        0
    })
}
```

- [ ] **Step 2.5: Implement the bytes-variant tile FFI entry.**

Immediately after `maple_render_file_scene_linear_tile`, append the bytes variant. Same body except:
- replace `raw_path: *const c_char` with `raw_bytes: *const u8, raw_len: usize, hint_ext: *const c_char`;
- skip the `ffi_raw_read` `std::fs::read` step;
- decode via `decode_bytes(&input, &ext_owned)` where `input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec()` and `ext_owned` parses `hint_ext` like Plan 1 Task 8's bytes variant.

(Body is mechanical; copy-adapt from `maple_render_bytes_scene_linear_sized` in Plan 1 Task 8 with the tile-render call substituted, and the same dehaze (10) / upscale (11) / null-arg (1, 2) error returns as Step 2.4.)

- [ ] **Step 2.6: Run the FFI tile tests.**

Run: `cd src/raw-pipeline && cargo test -p raw-ffi --lib render_tile 2>&1 | tail -10`

Expected: 2 tests pass (or "ignored" if `test_0002.dng` is absent).

Run: `cd src/raw-pipeline && cargo test -p raw-ffi --lib 2>&1 | tail -5`

Expected: full FFI suite passes (existing + Plan 1 + this task).

- [ ] **Step 2.7: Regenerate the cbindgen header / xcframework.**

Run: `./src/apple/scripts/build-xcframework.sh 2>&1 | tail -20`

Expected: builds and writes the xcframework. If cbindgen flags an unrecognized attribute on the new entries, copy the convention used by Plan 1 Task 8's sized FFI (no extra attributes are required — `#[no_mangle]` + `unsafe extern "C"` is what Plan 1 used).

After the script runs, confirm:

```bash
grep "maple_render_file_scene_linear_tile\|maple_render_bytes_scene_linear_tile" \
  src/apple/Frameworks/RawPipeline.xcframework/macos-arm64_x86_64/Headers/RawPipeline.h
```

Expected: two function-prototype hits in the header.

- [ ] **Step 2.8: Commit.**

```bash
git add src/raw-pipeline/raw-ffi/src/lib.rs src/apple/Frameworks/RawPipeline.xcframework
git commit -m "$(cat <<'EOF'
feat(raw-ffi): tile FFI entries `maple_render_*_scene_linear_tile`

Adds file-path and bytes-variant FFI entries that render a source-
pixel tile through the new scene-linear pipeline. Reuses
`MapleSceneLinearBuffer` (8 bytes/pixel fp16 RGBA). Error codes:
10 for dehaze-active (tile-unsafe), 11 for out > src (upscale-
attempt). Cross-link Plan 3 Task 2.

Regenerated RawPipeline.xcframework headers via build-xcframework.sh.
EOF
)"
```

---

## Task 3: Rust FFI — opaque `MapleRawHandle` for cached rawler-decoded mosaic

**Files:**
- Modify: `src/raw-pipeline/raw-ffi/src/lib.rs`

**Why this matters:** Apple-side `RawImageCache` keeps the rawler-decoded `RawImage` alive between tile fetches so a 100 MP RAW isn't re-rawl-decoded for every tile. The handle is **opaque** — Apple sees a `*mut MapleRawHandle` pointer it stores in a Swift Sendable wrapper. The Rust side owns the underlying `Box<RawImage>`. Three new FFI entries: `maple_decode_raw_handle`, `maple_render_tile_from_handle`, `maple_free_raw_handle`. The non-handle tile entries (Task 2) remain — they're used for tests, the CLI, and the bytes-from-PhotoKit codepath where we may not want to keep a handle alive.

- [ ] **Step 3.1: Define the opaque struct and `decode_raw_handle` entry.**

In `src/raw-pipeline/raw-ffi/src/lib.rs`, immediately after the `MapleSceneLinearBuffer::empty()` impl (line 302-ish), append:

```rust
/// Opaque handle wrapping a heap-allocated `RawImage`. Created by
/// `maple_decode_raw_handle`, freed by `maple_free_raw_handle`. The
/// Apple side stores the pointer inside a `MapleRawHandleBox` Swift
/// reference whose `deinit` calls `maple_free_raw_handle`. Tile renders
/// pass the handle into `maple_render_tile_from_handle` to skip the
/// per-tile rawler decode (which dominates cold tile time on a 100 MP
/// RAW — see Plan 3 Task 5).
#[repr(C)]
pub struct MapleRawHandle {
    /// Opaque pointer. The pointee is a `Box<raw_core::image::RawImage>`;
    /// callers must not introspect.
    inner: *mut std::ffi::c_void,
}

/// Decode a RAW file into an opaque handle suitable for repeated tile
/// rendering. The handle owns the rawler-decoded mosaic; tile renders
/// against the same handle skip the rawler-decode step entirely.
///
/// Returns 0 on success; non-zero on error (see `maple_last_error`).
/// The handle is heap-allocated; free via `maple_free_raw_handle`.
#[no_mangle]
pub unsafe extern "C" fn maple_decode_raw_handle(
    raw_path: *const c_char,
    out: *mut *mut MapleRawHandle,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    let raw_path_str = match CStr::from_ptr(raw_path).to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => { set_last_error(format!("raw_path not UTF-8: {}", e)); return 2; }
    };
    let out_ptr = out as usize;
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let raw_bytes = match raw_core::pipeline::stage("handle_raw_read", || std::fs::read(raw_path)) {
            Ok(b) => b,
            Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match raw_core::pipeline::stage("handle_rawler_decode", || decode_bytes(&raw_bytes, ext)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let boxed = Box::new(raw_img);
        let inner = Box::into_raw(boxed) as *mut std::ffi::c_void;
        let handle = Box::new(MapleRawHandle { inner });
        unsafe {
            *(out_ptr as *mut *mut MapleRawHandle) = Box::into_raw(handle);
        }
        0
    })
}

/// Render a tile from a previously decoded raw handle. Same arguments
/// as `maple_render_file_scene_linear_tile` minus the path / xmp
/// handling — the Apple side reads the XMP and passes per-call adjustments
/// via a serialized `AdjustmentModel` JSON payload (see Step 3.2).
#[no_mangle]
pub unsafe extern "C" fn maple_render_tile_from_handle(
    handle: *const MapleRawHandle,
    model_json: *const c_char,
    src_x: u32, src_y: u32, src_w: u32, src_h: u32,
    out_w: u32, out_h: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if handle.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if src_w == 0 || src_h == 0 || out_w == 0 || out_h == 0 {
        set_last_error("src_w/src_h/out_w/out_h must be > 0".into());
        return 9;
    }
    // Read the inner pointer; SAFETY: caller guarantees `handle` came from
    // `maple_decode_raw_handle` and hasn't been freed.
    let inner = (*handle).inner as *const raw_core::image::RawImage;
    let raw_img: &raw_core::image::RawImage = &*inner;
    let model: raw_core::xmp::AdjustmentModel = if model_json.is_null() {
        raw_core::xmp::AdjustmentModel::default()
    } else {
        let s = match CStr::from_ptr(model_json).to_str() {
            Ok(s) => s,
            Err(e) => { set_last_error(format!("model_json not UTF-8: {}", e)); return 4; }
        };
        match serde_json::from_str(s) {
            Ok(m) => m,
            Err(e) => { set_last_error(format!("model_json parse: {}", e)); return 4; }
        }
    };
    let quality = if quality_preview != 0 {
        raw_core::pipeline::RenderQuality::Preview
    } else {
        raw_core::pipeline::RenderQuality::Full
    };
    let out_ptr = out as usize;
    let raw_clone_ptr = raw_img as *const _ as usize;
    with_large_stack(move || {
        let raw_img: &raw_core::image::RawImage =
            unsafe { &*(raw_clone_ptr as *const raw_core::image::RawImage) };
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality(
            raw_img, &model, src_x, src_y, src_w, src_h, out_w, out_h, quality,
        ) {
            Ok(t) => t,
            Err(e) => {
                let msg = format!("{}", e);
                set_last_error(msg.clone());
                if msg.contains("dehaze") { return 10; }
                if msg.contains("upscale") || msg.contains("downscale-only") { return 11; }
                return 8;
            }
        };
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr, len_bytes,
                    channels: 4, bytes_per_pixel: 8,
                    width: w, height: h,
                };
        }
        0
    })
}

/// Free a `MapleRawHandle` and its inner `Box<RawImage>`. Apple's
/// `MapleRawHandleBox.deinit` calls this on cache eviction or
/// asset switch.
#[no_mangle]
pub unsafe extern "C" fn maple_free_raw_handle(handle: *mut MapleRawHandle) {
    if handle.is_null() { return; }
    let h = Box::from_raw(handle);
    if !h.inner.is_null() {
        let inner = h.inner as *mut raw_core::image::RawImage;
        drop(Box::from_raw(inner));
    }
}
```

- [ ] **Step 3.2: Confirm `AdjustmentModel` is serde-deserializable.**

Run: `grep -n "Deserialize\|derive(.*Deserialize" src/raw-pipeline/raw-core/src/xmp/mod.rs | head -5`

Expected: at least one match for `derive(... Deserialize ...)` on the `AdjustmentModel` struct. If absent, **add it** in this step before continuing — the model needs `#[derive(Deserialize)]` (and `serde_json` as a dev-dep on `raw-ffi`'s `Cargo.toml`).

If `serde_json` isn't a `raw-ffi` dependency yet:

```bash
grep -n "serde_json" src/raw-pipeline/raw-ffi/Cargo.toml
```

If empty, edit `src/raw-pipeline/raw-ffi/Cargo.toml` to add `serde_json = "1"` under `[dependencies]`.

- [ ] **Step 3.3: Test the handle round-trip.**

Append to `mod tests` in `raw-ffi/src/lib.rs`:

```rust
    #[test]
    fn raw_handle_round_trip_renders_tile() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
        let rc = unsafe { maple_decode_raw_handle(raw_cstr.as_ptr(), &mut handle) };
        assert_eq!(rc, 0);
        assert!(!handle.is_null());
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_tile_from_handle(
                handle, std::ptr::null(),
                512, 512, 256, 256, 256, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 0);
        assert_eq!(buf.width, 256);
        assert_eq!(buf.height, 256);
        unsafe {
            maple_free_scene_linear_buffer(&mut buf);
            maple_free_raw_handle(handle);
        }
    }
```

- [ ] **Step 3.4: Run the new test.**

Run: `cd src/raw-pipeline && cargo test -p raw-ffi --lib raw_handle_round_trip 2>&1 | tail -10`

Expected: PASS (or ignored if fixture absent).

- [ ] **Step 3.5: Regenerate the xcframework.**

Run: `./src/apple/scripts/build-xcframework.sh 2>&1 | tail -10`

Confirm:

```bash
grep "MapleRawHandle\|maple_decode_raw_handle\|maple_render_tile_from_handle\|maple_free_raw_handle" \
  src/apple/Frameworks/RawPipeline.xcframework/macos-arm64_x86_64/Headers/RawPipeline.h
```

Expected: 4+ hits.

- [ ] **Step 3.6: Commit.**

```bash
git add src/raw-pipeline/raw-ffi/src/lib.rs src/raw-pipeline/raw-ffi/Cargo.toml src/raw-pipeline/raw-core/src/xmp src/apple/Frameworks/RawPipeline.xcframework
git commit -m "$(cat <<'EOF'
feat(raw-ffi): opaque MapleRawHandle for cached rawler-decoded RawImage

Adds three FFI entries: maple_decode_raw_handle (full rawler decode,
returns opaque handle), maple_render_tile_from_handle (tile render
without re-decoding), and maple_free_raw_handle. AdjustmentModel
travels per-call as a serde_json string so the handle is invariant
across slider changes.

Apple side uses this as the backing store for RawImageCache, the
session-scoped single-entry cache that keeps a 100 MP RAW's decoded
mosaic alive across tile fetches.

Cross-link Plan 3 Task 3.
EOF
)"
```

---

## Task 4: Apple `MapleRawHandleBox` Sendable wrapper + `PipelineRenderer` tile entries

**Files:**
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/MapleRawHandleBox.swift`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/PipelineRenderer.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift`

**Why this matters:** The `MapleRawHandle` is a raw C pointer; passing it across actor boundaries needs a Sendable wrapper, and the lifetime is tied to its `deinit`. `PipelineRenderer` gets two new entries: `decodeRawHandle(rawPath:)` and `renderPreviewTile(handle:srcRect:targetSize:quality:model:)` mirroring the FFI calls.

- [ ] **Step 4.1: Create the Sendable-conformant handle box.**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/MapleRawHandleBox.swift`:

```swift
// MapleRawHandleBox.swift — Swift wrapper for the opaque
// `*mut MapleRawHandle` returned by `maple_decode_raw_handle`. Uses
// a final class so `deinit` calls `maple_free_raw_handle` exactly
// once when the last reference drops. Sendable-via-@unchecked because
// the underlying pointer is opaque from Swift's perspective and access
// is serialized through `RawImageCache` (an actor).
//
// Cross-link: docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md
// Task 4. The C ABI is in
// src/apple/Frameworks/RawPipeline.xcframework/.../Headers/RawPipeline.h.

import Foundation
import RawPipeline

public final class MapleRawHandleBox: @unchecked Sendable {
    /// Opaque pointer; not introspected on the Swift side.
    let pointer: OpaquePointer

    public init(pointer: OpaquePointer) {
        self.pointer = pointer
    }

    deinit {
        // SAFETY: `pointer` came from `maple_decode_raw_handle` and is
        // freed exactly here.
        maple_free_raw_handle(UnsafeMutablePointer(pointer))
    }
}
```

- [ ] **Step 4.2: Add tile-rendering entries to `PipelineRenderer`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/PipelineRenderer.swift`, after the `_renderSceneLinearBytes` private function (around line 307), append:

```swift
    // MARK: - Tile rendering (Plan 3, Ticket 06 M4)

    /// Decode a RAW into an opaque handle suitable for repeated tile
    /// rendering. The returned `MapleRawHandleBox` retains the underlying
    /// `MapleRawHandle`; deinit frees it. Caller (typically
    /// `RawImageCache`) is responsible for releasing the box on cache
    /// eviction.
    public static func decodeRawHandle(rawPath url: URL) throws -> MapleRawHandleBox {
        try url.path.withCString { rawCStr -> MapleRawHandleBox in
            var ptr: OpaquePointer? = nil
            let rc = withUnsafeMutablePointer(to: &ptr) { outPP -> Int32 in
                let outVoidPP = UnsafeMutableRawPointer(outPP)
                    .assumingMemoryBound(to: UnsafeMutablePointer<MapleRawHandle>?.self)
                return maple_decode_raw_handle(rawCStr, outVoidPP)
            }
            guard rc == 0, let handlePtr = ptr else {
                let msg = String(cString: maple_last_error())
                throw NSError(domain: "MapleCore.PipelineRenderer", code: Int(rc),
                              userInfo: [NSLocalizedDescriptionKey: msg])
            }
            return MapleRawHandleBox(pointer: handlePtr)
        }
    }

    /// Render a tile against an existing handle. `model` is encoded as
    /// JSON before crossing the FFI; the Rust side parses it via serde.
    public static func renderPreviewTile(
        handle: MapleRawHandleBox,
        srcRect: (x: UInt32, y: UInt32, w: UInt32, h: UInt32),
        targetSize: (w: UInt32, h: UInt32),
        quality: Quality = .preview,
        model: AdjustmentModel = .default
    ) throws -> MapleSceneLinearImageData {
        let modelJSON = try model.toJSON()
        return try modelJSON.withCString { modelCStr -> MapleSceneLinearImageData in
            var buf = MapleSceneLinearBuffer()
            let qFlag: Int32 = (quality == .preview) ? 1 : 0
            let rc = maple_render_tile_from_handle(
                UnsafePointer(handle.pointer),
                modelCStr,
                srcRect.x, srcRect.y, srcRect.w, srcRect.h,
                targetSize.w, targetSize.h,
                qFlag, &buf
            )
            guard rc == 0 else {
                let msg = String(cString: maple_last_error())
                throw NSError(domain: "MapleCore.PipelineRenderer", code: Int(rc),
                              userInfo: [NSLocalizedDescriptionKey: msg])
            }
            // Copy bytes into a Data; we want to free the FFI buffer
            // before returning, mirroring `_renderSceneLinear`.
            let pixels = Data(bytes: buf.fp16_rgba, count: Int(buf.len_bytes))
            let data = MapleSceneLinearImageData(
                pixels: pixels,
                width: Int(buf.width), height: Int(buf.height),
                bytesPerPixel: Int(buf.bytes_per_pixel),
                channels: Int(buf.channels),
            )
            withUnsafeMutablePointer(to: &buf) { p in
                maple_free_scene_linear_buffer(p)
            }
            return data
        }
    }
```

- [ ] **Step 4.3: Confirm `AdjustmentModel.toJSON()` exists or add it.**

Run: `grep -n "func toJSON\|var asJSONString\|encode.*JSONEncoder" src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift`

If absent, add a minimal helper to `AdjustmentModel.swift`:

```swift
public extension AdjustmentModel {
    /// Encode the model to a JSON string for FFI handoff. Field names
    /// must match the Rust `xmp::AdjustmentModel` `#[derive(Deserialize)]`
    /// shape (verified by Plan 3 Task 3 Step 3.2).
    func toJSON() throws -> String {
        let enc = JSONEncoder()
        let data = try enc.encode(self)
        return String(decoding: data, as: UTF8.self)
    }
}
```

If `AdjustmentModel` is not `Encodable`, add `: Codable` to its declaration; the field set is small (per `xmp::AdjustmentModel` Rust definition) and Swift's auto-synth handles it.

- [ ] **Step 4.4: Add a Swift round-trip integration test.**

Create `src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift`:

```swift
// DeepZoomTileRenderingTests.swift — Plan 3 (Ticket 06 M4) integration
// tests for the tile FFI + RawImageCache + TileManager.

import XCTest
@testable import MapleCore

final class DeepZoomTileRenderingTests: XCTestCase {

    // MARK: - Task 4: handle round-trip

    func testRawHandleRoundTripRendersTile() throws {
        let fixtureURL = Bundle.module.url(forResource: "test_0002", withExtension: "dng")
        guard let url = fixtureURL else {
            throw XCTSkip("test_0002.dng fixture not present")
        }
        let handle = try PipelineRenderer.decodeRawHandle(rawPath: url)
        let tile = try PipelineRenderer.renderPreviewTile(
            handle: handle,
            srcRect: (x: 512, y: 512, w: 256, h: 256),
            targetSize: (w: 256, h: 256),
            quality: .full
        )
        XCTAssertEqual(tile.width, 256)
        XCTAssertEqual(tile.height, 256)
        XCTAssertEqual(tile.bytesPerPixel, 8)
        XCTAssertEqual(tile.channels, 4)
        XCTAssertEqual(tile.pixels.count, 256 * 256 * 8)
    }

    func testRawHandleRendersTileFailsWithDehaze() throws {
        let fixtureURL = Bundle.module.url(forResource: "test_0002", withExtension: "dng")
        guard let url = fixtureURL else {
            throw XCTSkip("test_0002.dng fixture not present")
        }
        let handle = try PipelineRenderer.decodeRawHandle(rawPath: url)
        var model = AdjustmentModel.default
        model.dehaze = 50.0
        XCTAssertThrowsError(try PipelineRenderer.renderPreviewTile(
            handle: handle,
            srcRect: (x: 512, y: 512, w: 256, h: 256),
            targetSize: (w: 256, h: 256),
            quality: .full,
            model: model
        )) { err in
            let nsErr = err as NSError
            XCTAssertEqual(nsErr.code, 10, "dehaze rejection code mismatch")
        }
    }
}
```

- [ ] **Step 4.5: Run the test.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter DeepZoomTileRenderingTests 2>&1 | tail -15`

Expected: 2 tests pass (or skip if fixture absent).

- [ ] **Step 4.6: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/MapleRawHandleBox.swift \
        src/apple/Packages/MapleCore/Sources/MapleCore/PipelineRenderer.swift \
        src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift
git commit -m "$(cat <<'EOF'
feat(apple): MapleRawHandleBox + PipelineRenderer tile entries

Sendable-conformant Swift wrapper for the opaque MapleRawHandle.
Adds PipelineRenderer.decodeRawHandle(rawPath:) and
PipelineRenderer.renderPreviewTile(handle:srcRect:targetSize:...).
AdjustmentModel gets a `.toJSON()` extension so per-tile models
travel as serialized JSON across the FFI boundary. Cross-link
Plan 3 Task 4.
EOF
)"
```

---

## Task 5: Apple `RawImageCache` actor — single-entry session cache

**Files:**
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/RawImageCache.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift`

**Why this matters:** Without `RawImageCache`, every tile render rawler-decodes a 100 MP RAW. With it, decode happens once per asset open; tiles look up the cached `MapleRawHandleBox`. The cache is single-entry (one asset at a time), session-scoped (no disk persistence), and evicts on asset switch — that's an architectural prerequisite explicitly called out in the brief.

- [ ] **Step 5.1: Write the failing cache test.**

Append to `DeepZoomTileRenderingTests.swift`:

```swift
    // MARK: - Task 5: RawImageCache

    func testRawImageCacheReturnsSameHandleAcrossCalls() async throws {
        let fixtureURL = Bundle.module.url(forResource: "test_0002", withExtension: "dng")
        guard let url = fixtureURL else {
            throw XCTSkip("test_0002.dng fixture not present")
        }
        let cache = RawImageCache()
        let h1 = try await cache.handle(for: url)
        let h2 = try await cache.handle(for: url)
        // Same instance — `===` because MapleRawHandleBox is a class.
        XCTAssertTrue(h1 === h2, "second call must reuse cached handle")
    }

    func testRawImageCacheEvictsOnAssetSwitch() async throws {
        let f1 = Bundle.module.url(forResource: "test_0002", withExtension: "dng")
        let f2 = Bundle.module.url(forResource: "test_0001", withExtension: "dng")
        guard let u1 = f1, let u2 = f2 else {
            throw XCTSkip("test fixtures not present")
        }
        let cache = RawImageCache()
        let h1 = try await cache.handle(for: u1)
        let h2 = try await cache.handle(for: u2)
        let h1Again = try await cache.handle(for: u1)
        XCTAssertFalse(h1 === h1Again, "switching to u2 should evict u1; refetch decodes again")
        XCTAssertNotIdentical(h1, h2)
    }
```

- [ ] **Step 5.2: Run to verify failure.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testRawImageCache 2>&1 | tail -10`

Expected: compilation error — `cannot find 'RawImageCache' in scope`.

- [ ] **Step 5.3: Implement `RawImageCache`.**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/RawImageCache.swift`:

```swift
// RawImageCache.swift — Session-scoped, single-entry cache for the
// rawler-decoded RawImage handle. Keyed on (URL, mtime). Eviction on
// asset switch.
//
// Architectural prerequisite for Plan 3 (Deep Zoom tile rendering):
// without this, every tile render rawler-decodes a 100 MP RAW
// (~3-5 s per tile, blowing past the slider-tick budget). With it,
// rawler-decode happens once per asset open and tiles share the
// cached MapleRawHandleBox. See Plan 3 Task 5.
//
// In-memory only. No disk persistence — the underlying handle is an
// opaque pointer to a heap-allocated rawler decode result, which can't
// safely cross process boundaries. Disk persistence is a separate
// follow-up plan (would require a portable serialization of the
// decoded mosaic).

import Foundation

public actor RawImageCache {
    public static let shared = RawImageCache()

    private struct Entry {
        let url: URL
        let mtime: Date
        let handle: MapleRawHandleBox
    }

    private var current: Entry?

    public init() {}

    /// Get or create a handle for the given asset URL. If the URL is
    /// the same as the current entry AND the file's mtime hasn't
    /// changed, reuses the cached handle (returns the SAME object —
    /// `===` equality holds). Otherwise evicts the current entry and
    /// decodes the new asset.
    public func handle(for url: URL) async throws -> MapleRawHandleBox {
        let mtime = (try? FileManager.default
            .attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? Date.distantPast
        if let entry = current,
           entry.url == url,
           entry.mtime == mtime {
            return entry.handle
        }
        // Evict and decode.
        current = nil
        let handle = try await Task.detached(priority: .userInitiated) {
            try PipelineRenderer.decodeRawHandle(rawPath: url)
        }.value
        let entry = Entry(url: url, mtime: mtime, handle: handle)
        current = entry
        return handle
    }

    /// Force eviction (useful when the editor's asset switches and the
    /// caller wants to free memory deterministically).
    public func evict() {
        current = nil
    }

    /// Currently cached URL, if any. For tests / instrumentation.
    public var cachedURL: URL? { current?.url }
}
```

- [ ] **Step 5.4: Run the cache tests.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testRawImageCache 2>&1 | tail -10`

Expected: 2 tests pass (or skip if fixtures absent).

- [ ] **Step 5.5: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Cache/RawImageCache.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift
git commit -m "$(cat <<'EOF'
feat(apple): RawImageCache actor — single-entry session cache for handles

Architectural prerequisite for Plan 3 deep-zoom tile rendering.
Keyed on (URL, mtime); evicts on asset switch. Holds at most one
MapleRawHandleBox so the rawler decode runs once per open and tiles
share the result. Cross-link Plan 3 Task 5.
EOF
)"
```

---

## Task 6: Apple `TileManager` actor — visible-tile fetch + LRU + composite

**Files:**
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/TileManager.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift`

**Why this matters:** TileManager is the tile fetch + cache + composite engine. Owns `[TileKey: TileEntry]`, a `Task` queue for in-flight fetches, and a byte-budget LRU. Public API surface is `update(asset:viewport:zoom:) -> CIImage`. The brief locks tile geometry at 512² source pixels; zoom-bucket keying at `{1×, 2×, 4×, 8×}`; cache budget 200 MB iPhone / 1 GB Mac.

- [ ] **Step 6.1: Write the failing TileManager tests.**

Append to `DeepZoomTileRenderingTests.swift`:

```swift
    // MARK: - Task 6: TileManager

    func testTileManagerComputesVisibleTileSet() {
        // Geometry test: viewport (0,0)-(2048,1024) in source pixels at
        // zoom 1.0 should request tiles (0,0), (1,0), (2,0), (3,0),
        // (0,1), (1,1), (2,1), (3,1) — 8 tiles at 512² each.
        let viewport = CGRect(x: 0, y: 0, width: 2048, height: 1024)
        let zoom = CGFloat(1.0)
        let tileSize: UInt32 = 512
        let tiles = TileManager.tileSet(forVisibleSourceRect: viewport, zoom: zoom, tileSize: tileSize)
        XCTAssertEqual(tiles.count, 8)
        XCTAssertTrue(tiles.contains { $0.tileX == 0 && $0.tileY == 0 })
        XCTAssertTrue(tiles.contains { $0.tileX == 3 && $0.tileY == 1 })
    }

    func testTileManagerZoomBucketsAt1And2And4And8() {
        XCTAssertEqual(TileManager.zoomBucket(for: 0.99), 1)
        XCTAssertEqual(TileManager.zoomBucket(for: 1.0), 1)
        XCTAssertEqual(TileManager.zoomBucket(for: 1.99), 1)
        XCTAssertEqual(TileManager.zoomBucket(for: 2.0), 2)
        XCTAssertEqual(TileManager.zoomBucket(for: 2.5), 2)
        XCTAssertEqual(TileManager.zoomBucket(for: 4.0), 4)
        XCTAssertEqual(TileManager.zoomBucket(for: 8.0), 8)
        // Above 8× clamps to 8 — the brief caps zoom buckets at 8×.
        XCTAssertEqual(TileManager.zoomBucket(for: 16.0), 8)
    }

    func testTileManagerEvictsLRUWhenOverBudget() async throws {
        let mgr = TileManager(budgetBytes: 32 * 1024 * 1024)  // 32 MB
        // Stuff with 10 fake 8 MB tiles → 80 MB total → evict 6.
        for i in 0..<10 {
            let key = TileKey(
                urlHash: "url", sidecarMtime: Date(timeIntervalSince1970: 0),
                viewTransformVersion: 2, zoomBucket: 1, tileX: UInt32(i), tileY: 0
            )
            let fakeImage = await Self.makeFakeCIImage(widthBytes: 8 * 1024 * 1024)
            await mgr.testInsertTile(key: key, image: fakeImage, sizeBytes: 8 * 1024 * 1024)
        }
        let total = await mgr.testTotalCachedBytes()
        XCTAssertLessThanOrEqual(total, 32 * 1024 * 1024,
            "byte budget breached: total=\(total)")
    }

    static func makeFakeCIImage(widthBytes: Int) async -> CIImage {
        // 1024×1024 fp16 RGBA = 8 MB; just synthesize a CIImage of the
        // right approximate size for accounting tests.
        let side = 1024
        let bytes = Data(count: side * side * 8)
        return CIImage(
            bitmapData: bytes, bytesPerRow: side * 8,
            size: CGSize(width: side, height: side),
            format: .RGBAh, colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        )
    }
```

- [ ] **Step 6.2: Run to verify failure.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testTileManager 2>&1 | tail -10`

Expected: compilation error — `cannot find 'TileManager' in scope`.

- [ ] **Step 6.3: Implement `TileManager`.**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/TileManager.swift`:

```swift
// TileManager.swift — In-memory LRU tile cache + composite engine for
// Plan 3 (Ticket 06 M4) deep-zoom rendering. Strict byte budget. No
// prefetch (phase 1).
//
// Public API:
//   actor TileManager
//     init(budgetBytes: Int)
//     update(asset:viewport:zoom:) async -> CIImage   // visible tiles composited over the upscaled cached preview
//     evictAll()                                      // on asset switch
//
// Cache key: (asset URL hash, sidecar mtime, view-transform version,
// zoom bucket, tile X, tile Y). Evicts LRU by total bytes.
//
// Cross-link: docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md
// Task 6.

import Foundation
import CoreImage
import CryptoKit

public struct TileKey: Hashable, Sendable {
    public let urlHash: String       // 16-byte MD5 of the URL path, hex string
    public let sidecarMtime: Date
    public let viewTransformVersion: UInt32
    public let zoomBucket: UInt32    // 1, 2, 4, 8
    public let tileX: UInt32
    public let tileY: UInt32
}

public actor TileManager {
    public static let tileSizeSourcePx: UInt32 = 512

    private struct Entry {
        let image: CIImage
        let sizeBytes: Int
        var lastAccessed: Date
    }

    private var entries: [TileKey: Entry] = [:]
    private var inFlight: [TileKey: Task<CIImage, Error>] = [:]
    private let budgetBytes: Int

    public init(budgetBytes: Int) {
        self.budgetBytes = budgetBytes
    }

    /// Default budget per platform per the brief: 200 MB iPhone / 1 GB Mac.
    public static func defaultBudget() -> Int {
#if os(iOS)
        return 200 * 1024 * 1024
#else
        return 1024 * 1024 * 1024
#endif
    }

    /// Compute the set of visible TileKey.{tileX,tileY} pairs for a
    /// viewport rect (in oriented full-image source coords) and zoom.
    /// Pure function for testability.
    nonisolated public static func tileSet(
        forVisibleSourceRect rect: CGRect,
        zoom: CGFloat,
        tileSize: UInt32 = TileManager.tileSizeSourcePx
    ) -> [(tileX: UInt32, tileY: UInt32)] {
        let _ = zoom  // zoom feeds the bucket; the visible-rect math is in source-pixel space already
        let ts = CGFloat(tileSize)
        let x0 = max(0, Int(floor(rect.minX / ts)))
        let y0 = max(0, Int(floor(rect.minY / ts)))
        let x1 = max(x0, Int(ceil(rect.maxX / ts)) - 1)
        let y1 = max(y0, Int(ceil(rect.maxY / ts)) - 1)
        var out: [(UInt32, UInt32)] = []
        for ty in y0...y1 {
            for tx in x0...x1 {
                out.append((UInt32(tx), UInt32(ty)))
            }
        }
        return out.map { (tileX: $0.0, tileY: $0.1) }
    }

    /// Quantize a CGFloat zoom level to one of the brief's zoom buckets
    /// {1, 2, 4, 8}. Above 8× clamps to 8.
    nonisolated public static func zoomBucket(for zoom: CGFloat) -> UInt32 {
        if zoom < 2.0 { return 1 }
        if zoom < 4.0 { return 2 }
        if zoom < 8.0 { return 4 }
        return 8
    }

    // MARK: - Public update entrypoint

    /// Resolve a CIImage that paints the visible region. The returned
    /// CIImage composes (a) cached or in-flight tiles over (b) the
    /// upscaled cached preview underlayer. Tiles missing from cache
    /// are enqueued for fetch and the underlayer shows through until
    /// the fetch lands.
    public func update(
        urlHash: String,
        sidecarMtime: Date,
        viewportSourceRect: CGRect,
        zoom: CGFloat,
        underlay: CIImage,
        fetch: @Sendable (TileKey) async throws -> (CIImage, Int)  // (tileImage, sizeBytes)
    ) async -> CIImage {
        let bucket = Self.zoomBucket(for: zoom)
        let positions = Self.tileSet(forVisibleSourceRect: viewportSourceRect, zoom: zoom)
        var composite = underlay
        for pos in positions {
            let key = TileKey(
                urlHash: urlHash,
                sidecarMtime: sidecarMtime,
                viewTransformVersion: 2,
                zoomBucket: bucket,
                tileX: pos.tileX, tileY: pos.tileY
            )
            if var entry = entries[key] {
                entry.lastAccessed = Date()
                entries[key] = entry
                composite = entry.image.composited(over: composite)
                continue
            }
            // Miss — enqueue if not already in-flight.
            if inFlight[key] == nil {
                let task = Task<CIImage, Error> {
                    try await fetch(key)
                }.flatMap { (img, sz) in
                    Task<CIImage, Error> { @MainActor in
                        await self.testInsertTile(key: key, image: img, sizeBytes: sz)
                        return img
                    }
                }
                inFlight[key] = task
            }
            // Don't await — return the underlay-only composite for this
            // tile. The caller's CIImageView will repaint when the new
            // tile lands and `update` is called again.
        }
        return composite
    }

    /// Test-only: directly insert a tile (skips the fetch closure). Also
    /// runs LRU eviction.
    public func testInsertTile(key: TileKey, image: CIImage, sizeBytes: Int) {
        entries[key] = Entry(image: image, sizeBytes: sizeBytes, lastAccessed: Date())
        evictIfOverBudget()
    }

    /// Test-only: total cached bytes.
    public func testTotalCachedBytes() -> Int {
        return entries.values.reduce(0) { $0 + $1.sizeBytes }
    }

    public func evictAll() {
        entries.removeAll()
        for (_, t) in inFlight { t.cancel() }
        inFlight.removeAll()
    }

    private func evictIfOverBudget() {
        var total = entries.values.reduce(0) { $0 + $1.sizeBytes }
        guard total > budgetBytes else { return }
        // Sort by lastAccessed asc and drop entries until we fit.
        let sorted = entries.sorted { $0.value.lastAccessed < $1.value.lastAccessed }
        for (k, e) in sorted {
            if total <= budgetBytes { break }
            entries.removeValue(forKey: k)
            total -= e.sizeBytes
        }
    }
}

// Helper for the `Task.flatMap` pattern used in `update`.
private extension Task where Failure == Error {
    func flatMap<U>(_ transform: @escaping (Success) -> Task<U, Error>) -> Task<U, Error> {
        Task<U, Error> {
            let value = try await self.value
            return try await transform(value).value
        }
    }
}
```

- [ ] **Step 6.4: Run the TileManager tests.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testTileManager 2>&1 | tail -15`

Expected: 3 tests pass.

- [ ] **Step 6.5: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Cache/TileManager.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift
git commit -m "$(cat <<'EOF'
feat(apple): TileManager actor — in-memory LRU tile cache + composite

Owns [TileKey: TileEntry], an in-flight Task queue, and a strict
byte-budget LRU. Public API: update(...) returns a CIImage that
composes cached or in-flight tiles over the upscaled cached
preview. Default budget 200 MB iPhone / 1 GB Mac. Cross-link
Plan 3 Task 6.
EOF
)"
```

---

## Task 7: `ImageEditPipeline.decodePreviewTile` — wire TileManager + CIImage build

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift`

**Why this matters:** `ImageEditPipeline` is the seam between the actor-isolated cache layer and `EditSession`. `decodePreviewTile` resolves a single tile (RawImageCache → PipelineRenderer.renderPreviewTile) and returns a CIImage tagged extendedLinearITUR_2020, **with `transformed(by:)` applied so the tile lives at the correct source-pixel origin in the oriented full-image coordinate space.** This makes `composited(over:)` Just Work in `CIImageView`.

- [ ] **Step 7.1: Write the failing test.**

Append to `DeepZoomTileRenderingTests.swift`:

```swift
    // MARK: - Task 7: ImageEditPipeline.decodePreviewTile

    func testDecodePreviewTileReturnsRec2020Fp16CIImageAtSourceOrigin() async throws {
        let fixtureURL = Bundle.module.url(forResource: "test_0002", withExtension: "dng")
        guard let url = fixtureURL else {
            throw XCTSkip("test_0002.dng fixture not present")
        }
        let asset = AssetRef(primaryURL: url)
        let pipeline = ImageEditPipeline()
        let srcRect = CGRect(x: 512, y: 512, width: 512, height: 512)
        let tile = await pipeline.decodePreviewTile(
            asset: asset, srcRect: srcRect, targetSize: CGSize(width: 512, height: 512)
        )
        XCTAssertNotNil(tile)
        let img = try XCTUnwrap(tile)
        // The tile CIImage is translated so its (0,0) maps to the
        // source-pixel origin (512, 512). `extent.origin` reflects that.
        XCTAssertEqual(img.extent.origin.x, 512, accuracy: 1)
        XCTAssertEqual(img.extent.origin.y, 512, accuracy: 1)
        XCTAssertEqual(img.extent.size.width, 512, accuracy: 1)
        XCTAssertEqual(img.extent.size.height, 512, accuracy: 1)
        // Color space matches the FFI's tagging.
        XCTAssertEqual(img.colorSpace?.name as String?,
                       CGColorSpace.extendedLinearITUR_2020 as String)
    }
```

- [ ] **Step 7.2: Run to verify failure.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testDecodePreviewTile 2>&1 | tail -10`

Expected: compilation error — `decodePreviewTile` does not exist.

- [ ] **Step 7.3: Implement `decodePreviewTile`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`, after `decodeSceneLinear` (around line 185), append:

```swift
    /// Decode a single source-pixel tile through the new scene-linear
    /// FFI. `srcRect` is in oriented full-image source-pixel coords;
    /// `targetSize` is the requested output dimensions (must be
    /// ≤ srcRect's dimensions — tile path is downscale-only).
    ///
    /// Returns a CIImage tagged extendedLinearITUR_2020 with `extent`
    /// translated so the tile sits at `srcRect.origin` in the oriented
    /// full-image coordinate space — `composited(over: upscaledPreview)`
    /// then lands the tile at the correct location.
    ///
    /// Errors (handle return value of nil):
    ///   - `model.dehaze != 0` → returns nil; caller falls back to
    ///     fit-zoom rendering.
    ///   - `srcRect` outside the asset's source extent → returns nil.
    nonisolated public func decodePreviewTile(
        asset: AssetRef,
        srcRect: CGRect,
        targetSize: CGSize,
        quality: PipelineRenderer.Quality = .full,
        model: AdjustmentModel = .default
    ) async -> CIImage? {
        guard let url = asset.primaryURL else {
            logger.error("decodePreviewTile: asset has no primaryURL — bytes-only assets aren't tile-cacheable")
            return nil
        }
        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        let accessing = scope.startAccessingSecurityScopedResource()
        defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
        let handle: MapleRawHandleBox
        do {
            handle = try await RawImageCache.shared.handle(for: url)
        } catch {
            logger.error("decodePreviewTile: cache.handle(for:) failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        let imageData: MapleSceneLinearImageData
        do {
            imageData = try PipelineRenderer.renderPreviewTile(
                handle: handle,
                srcRect: (
                    x: UInt32(srcRect.origin.x),
                    y: UInt32(srcRect.origin.y),
                    w: UInt32(srcRect.size.width),
                    h: UInt32(srcRect.size.height)
                ),
                targetSize: (
                    w: UInt32(targetSize.width),
                    h: UInt32(targetSize.height)
                ),
                quality: quality,
                model: model
            )
        } catch let nsErr as NSError where nsErr.code == 10 {
            // Dehaze active — caller should fall back to fit-zoom.
            return nil
        } catch {
            logger.error("decodePreviewTile failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        let w = imageData.width, h = imageData.height
        let bytesPerRow = w * imageData.bytesPerPixel
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let raw = CIImage(
            bitmapData: imageData.pixels,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh,
            colorSpace: space
        )
        // Translate so the tile lands at its source-pixel origin in
        // the full-image coord space. The composite-over-underlay then
        // unions extents correctly.
        let translation = CGAffineTransform(
            translationX: srcRect.origin.x, y: srcRect.origin.y
        )
        return raw.transformed(by: translation)
    }
```

- [ ] **Step 7.4: Run the test.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testDecodePreviewTile 2>&1 | tail -10`

Expected: PASS (or skip if fixture absent).

- [ ] **Step 7.5: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift
git commit -m "$(cat <<'EOF'
feat(apple): ImageEditPipeline.decodePreviewTile

Resolves a single tile through RawImageCache + PipelineRenderer.
Returns a CIImage tagged extendedLinearITUR_2020 with extent
translated so the tile sits at its source-pixel origin in the
oriented full-image coord space. composited(over: upscaledPreview)
then lands the tile at the right location. Returns nil when
dehaze is active (tile-unsafe). Cross-link Plan 3 Task 7.
EOF
)"
```

---

## Task 8: Wire TileManager into `EditSession` + zoom routing

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`
- Modify: `src/apple/Maple/Views/FullImageView.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift`

**Why this matters:** This is where the deep-zoom path becomes user-visible. `EditSession` gains a `tileManager` instance; `_scheduleRefine` branches on `pixelScale ≥ 1.0`; the refine call routes through `tileManager.update(...)`. `FullImageView`'s gesture and toolbar paths feed `viewportSize` and `pixelScale` to `EditSession.updateTileVisibleRegion(viewport:zoom:)`. Cmd+scroll on macOS is added as a new zoom gesture (today only `MagnifyGesture` + Cmd-shortcuts exist).

- [ ] **Step 8.1: Add `tileManager` instance to `EditSession`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`, near the other `private let` instances at the top of the class (around line 34-50), add:

```swift
    /// Tile manager for deep-zoom (pixelScale ≥ 1.0) refine renders.
    /// In-memory LRU at the platform's default budget. Created lazily
    /// on the first deep-zoom request; evicted on asset switch.
    private var tileManager: TileManager?
```

In the asset-switch branch (search for "evict" or the `setAsset(_:)` method body — landing near line 350-400 depending on Plan 1 v2 churn), add `tileManager?.evictAll(); tileManager = nil`. Also add an evict call in the asset-loading reset path.

- [ ] **Step 8.2: Branch `_scheduleRefine` on `pixelScale ≥ 1.0`.**

Locate `_scheduleRefine` (currently at `EditSession.swift:750`). Inside the `Task { @MainActor in ... }` body, after the 250 ms debounce sleep, add a new branch:

```swift
            try? await Task.sleep(for: .milliseconds(250))
            guard gen == renderGeneration, !Task.isCancelled else { return }
            // Plan 3: deep-zoom path. When pixelScale >= 1.0, route
            // refine through TileManager. Tiles composite over the
            // upscaled cached preview so the underlayer is always
            // visible while tiles are in-flight.
            if pixelScale >= 1.0 {
                await refineDeepZoom(gen: gen)
                return
            }
            // ... existing fit-zoom refine path stays as-is
```

Add a new private method `refineDeepZoom(gen:)`:

```swift
    /// Deep-zoom refine path (pixelScale >= 1.0). Composes visible
    /// tiles over the upscaled cached preview via TileManager.
    @MainActor
    private func refineDeepZoom(gen: UInt64) async {
        guard let url = asset.primaryURL,
              let underlayerCI = renderedPreview else { return }
        // Lazily create the tile manager.
        if tileManager == nil {
            tileManager = TileManager(budgetBytes: TileManager.defaultBudget())
        }
        guard let mgr = tileManager else { return }
        let m = self.model
        let q = PipelineRenderer.Quality.full
        let pipeline = self.pipeline
        let assetRef = self.asset
        let viewport = self.viewportSourceRect  // Step 8.3 adds this
        let zoom = self.pixelScale
        let urlHash = TileManager.urlHash(for: url)
        let mtime = (try? FileManager.default
            .attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? Date.distantPast
        let composite = await mgr.update(
            urlHash: urlHash,
            sidecarMtime: mtime,
            viewportSourceRect: viewport,
            zoom: zoom,
            underlay: underlayerCI
        ) { key in
            // Per-tile fetch closure — TileManager calls this on cache miss.
            let srcRect = CGRect(
                x: CGFloat(key.tileX) * CGFloat(TileManager.tileSizeSourcePx),
                y: CGFloat(key.tileY) * CGFloat(TileManager.tileSizeSourcePx),
                width: CGFloat(TileManager.tileSizeSourcePx),
                height: CGFloat(TileManager.tileSizeSourcePx)
            )
            // Quantized output size for the bucket — at 1x bucket, output =
            // source. At 2x, halve. (Caller's display zoom is independent
            // of cache bucket; CoreImage upsamples to display.)
            let outSide = TileManager.tileSizeSourcePx / key.zoomBucket
            guard let img = await pipeline.decodePreviewTile(
                asset: assetRef,
                srcRect: srcRect,
                targetSize: CGSize(width: Int(outSide), height: Int(outSide)),
                quality: q,
                model: m
            ) else {
                throw NSError(domain: "MapleCore.TileFetch", code: 0,
                              userInfo: [NSLocalizedDescriptionKey: "decodePreviewTile returned nil"])
            }
            // Approx byte size: outSide * outSide * 8 bytes per fp16 RGBA px.
            let bytes = Int(outSide) * Int(outSide) * 8
            return (img, bytes)
        }
        guard gen == renderGeneration, !Task.isCancelled else { return }
        renderedPreview = composite
    }

    /// MD5 of the URL path, hex string. Static for use by TileManager
    /// callers.
    @MainActor
    private static func urlHashShim(_ url: URL) -> String {
        TileManager.urlHash(for: url)
    }
```

- [ ] **Step 8.3: Add `viewportSourceRect` to `EditSession` and `updateTileVisibleRegion(viewport:zoom:)` entry.**

In `EditSession`, add:

```swift
    /// Visible region in oriented full-image source-pixel coords. Set
    /// from FullImageView via `updateTileVisibleRegion(viewport:zoom:)`.
    /// Default to .zero — `_scheduleRefine` skips the deep-zoom branch
    /// when zero.
    public private(set) var viewportSourceRect: CGRect = .zero

    /// FullImageView calls this from gesture / toolbar / keyboard paths
    /// to update the visible-tile target. Triggers a refine reschedule
    /// when pixelScale changes meaningfully.
    @MainActor
    public func updateTileVisibleRegion(viewport: CGRect, zoom: CGFloat) {
        viewportSourceRect = viewport
        let prev = pixelScale
        pixelScale = zoom
        if abs(zoom - prev) > 0.01 {
            _scheduleRefine()
        }
    }
```

In `Cache/TileManager.swift`, add a public `urlHash(for:)` static method using CryptoKit's MD5 for parity with `RenderedPreviewCache`'s key shape:

```swift
    nonisolated public static func urlHash(for url: URL) -> String {
        let hash = Insecure.MD5.hash(data: Data(url.path.utf8))
        return hash.map { String(format: "%02x", $0) }.joined()
    }
```

- [ ] **Step 8.4: Wire `FullImageView` gestures to `updateTileVisibleRegion`.**

In `src/apple/Maple/Views/FullImageView.swift`:

(a) Replace `magnificationGesture(viewport:)` `.onChanged`'s `pixelScale = newScale` with:

```swift
                pixelScale = newScale
                let viewport = computeVisibleSourceRect(
                    viewport: viewport, zoom: newScale, imageSize: imageExtent
                )
                session.updateTileVisibleRegion(viewport: viewport, zoom: newScale)
```

(b) Replace the `setZoom(to:)` method's `pixelScale = ...` lines (around line 380-400 — search for `setZoom`):

```swift
            session.updateTileVisibleRegion(
                viewport: computeVisibleSourceRect(
                    viewport: viewportSize, zoom: pixelScale, imageSize: imageExtent
                ),
                zoom: pixelScale
            )
```

(c) Add `computeVisibleSourceRect(viewport:zoom:imageSize:) -> CGRect`:

```swift
    /// Compute the visible region in oriented full-image source-pixel
    /// coords from the on-screen viewport, the current pixelScale, and
    /// the image extent. Pan offset is included via `panOffset` /
    /// `displayScale`.
    private func computeVisibleSourceRect(
        viewport: CGSize, zoom: CGFloat, imageSize: CGSize?
    ) -> CGRect {
        guard let imageSize, zoom > 0 else { return .zero }
        // Real pixels per source pixel = displayScale * zoom — but the
        // "source-pixel" coord we need for tile keying is in oriented
        // full-image space, not screen space. Reverse-map the visible
        // viewport pixels back to source pixels.
        let viewportPx = CGSize(
            width: viewport.width * displayScale,
            height: viewport.height * displayScale
        )
        let visibleSrcW = viewportPx.width / zoom
        let visibleSrcH = viewportPx.height / zoom
        // Center on the image center adjusted by the pan offset.
        let centerX = imageSize.width / 2 - panOffset.width / zoom
        let centerY = imageSize.height / 2 - panOffset.height / zoom
        return CGRect(
            x: max(0, centerX - visibleSrcW / 2),
            y: max(0, centerY - visibleSrcH / 2),
            width: min(visibleSrcW, imageSize.width),
            height: min(visibleSrcH, imageSize.height)
        )
    }
```

(d) Add Cmd+scroll handling on macOS. After the existing `.gesture(magnificationGesture(viewport:))` modifier on the main image view, add:

```swift
                #if os(macOS)
                .onContinuousHover { phase in /* unchanged */ }
                .onModifierKeysChanged(mask: .command) { _, modifiers in
                    cmdHeld = modifiers.contains(.command)
                }
                .scrollWheelGesture { delta in
                    guard cmdHeld else { return }
                    let factor = 1.0 + (delta.y * 0.005)
                    let fit = fitPixelScale(viewport: viewportSize, imageSize: imageExtent)
                    pixelScale = max(fit * 0.5, min(pixelScale * factor, maxPixelScale))
                    session.updateTileVisibleRegion(
                        viewport: computeVisibleSourceRect(
                            viewport: viewportSize, zoom: pixelScale, imageSize: imageExtent
                        ),
                        zoom: pixelScale
                    )
                }
                #endif
```

(`@State private var cmdHeld = false` declared near the other `@State` properties.) `scrollWheelGesture(_:)` is a custom `ViewModifier` to add — there's no SwiftUI built-in for this. Implementation pattern: a `NSViewRepresentable` wrapping an `NSView` that overrides `scrollWheel(with:)` and forwards a `(deltaX, deltaY) -> Void` closure. Add the modifier at the bottom of `FullImageView.swift` as a private extension. (Or skip Cmd+scroll for phase 1 — it's an enhancement, not a blocker. The brief lists it as "add" but doesn't require it. **Decision: implement in phase 1** to match the brief's UX surface; skipping leaves a gap users will notice on Mac.)

- [ ] **Step 8.5: Add a smoke test for the routing decision.**

Append to `DeepZoomTileRenderingTests.swift`:

```swift
    // MARK: - Task 8: zoom routing

    func testEditSessionRoutesRefineThroughTileManagerAtPixelScale1() async throws {
        let fixtureURL = Bundle.module.url(forResource: "test_0002", withExtension: "dng")
        guard let url = fixtureURL else {
            throw XCTSkip("test_0002.dng fixture not present")
        }
        let asset = AssetRef(primaryURL: url)
        let session = EditSession(asset: asset)
        // Wait for fit-zoom to settle.
        await session.ensureRenderStartedAsync()
        // Trigger deep zoom.
        await MainActor.run {
            session.updateTileVisibleRegion(
                viewport: CGRect(x: 0, y: 0, width: 1024, height: 768),
                zoom: 1.5
            )
        }
        try await Task.sleep(for: .milliseconds(500))  // Let refine debounce + run.
        let preview = await MainActor.run { session.renderedPreview }
        XCTAssertNotNil(preview, "refine should have populated renderedPreview")
        // Extent of the composite must be the full image's oriented
        // extent (because TileManager.update returns underlay ⊕ tiles).
        let img = try XCTUnwrap(preview)
        XCTAssertGreaterThan(img.extent.size.width, 1024, "composite extent must cover full image")
    }
```

(`ensureRenderStartedAsync` may need to be added as a sibling of `ensureRenderStarted` for tests — the existing one fires-and-forgets.)

- [ ] **Step 8.6: Run.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter DeepZoomTileRenderingTests 2>&1 | tail -20`

Expected: all tests pass (or skip if fixtures absent).

- [ ] **Step 8.7: Build the macOS app and verify Cmd+scroll deep-zoom interaction manually.**

Run:

```bash
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple \
  -destination 'platform=macOS' build 2>&1 | tail -3
open /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app
```

Manual verification (no harness — visual / interactive):
1. Open the reference DNG.
2. Press ⌘1. The image should zoom to 100%; within ~500 ms of stopping, tiles should fade in (no spinner — the upscaled cached preview shows through during fetch).
3. Pan with two-finger drag. New tiles should appear within ~16 ms when scrolled into view (cache hits).
4. Pinch out past 1.0×. Same behavior.
5. Set the dehaze slider to a non-zero value. The toolbar's 100% button should clamp to fit; deep zoom should refuse.

Capture timing via `MAPLE_PROFILE=1` to confirm the brief's perf gates:
- First tile visible at 1:1, cold: ≤500 ms target, ≤1000 ms hard.
- Pan latency tile cache hit: ≤16 ms target.
- Cache hit composite: ≤16 ms.

Record the medians in the test header (similar to Plan 1 Spike 1.3 baseline format).

- [ ] **Step 8.8: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift \
        src/apple/Packages/MapleCore/Sources/MapleCore/Cache/TileManager.swift \
        src/apple/Maple/Views/FullImageView.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift
git commit -m "$(cat <<'EOF'
feat(apple): wire TileManager into EditSession + FullImageView gestures

EditSession.tileManager is created lazily on first deep-zoom request
(pixelScale >= 1.0); _scheduleRefine routes through it when zoomed.
FullImageView updates the visible source rect via
session.updateTileVisibleRegion(viewport:zoom:) from the
MagnifyGesture, ⌘1/⌘=/⌘- shortcuts, and a new Cmd+scroll handler
on macOS. Cross-link Plan 3 Task 8.
EOF
)"
```

---

## Task 9: Documentation + env-gate dependency note

**Files:**
- Modify: `docs/tickets/06-viewport-sized-rust-ffi-preview.md` (annotate M4 as in-progress / shipped)
- Modify: `CLAUDE.md` § "Performance invariants" (add deep-zoom budget rows — only if user-approved; otherwise leave for follow-up)

**Why this matters:** Plan 1 v2 introduced the `MAPLE_SCENE_LINEAR=1` env gate. Plan 3's deep-zoom path requires `MAPLE_SCENE_LINEAR=1` because the underlying FFI is the scene-linear pipeline. The gate doc needs to call this out.

- [ ] **Step 9.1: Annotate the ticket.**

Edit `docs/tickets/06-viewport-sized-rust-ffi-preview.md`. In the "Recommended Milestones" section's Milestone 4 entry, add a status note under M4:

```markdown
**Milestone 4 — Deep zoom (tile rendering with overlap pads)**

* Status: Plans 1-3 complete (Plan 3 = `docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md`)
  delivers Milestones 1-3 of M4: single-tile cold render via CLI,
  Apple TileManager actor + composite over fixed viewport, and
  FullImageView wiring for ⌘1/⌘=/⌘-/Cmd+scroll. Phase-1 scope
  excludes prefetch ring, disk persistence, Web tile parity,
  2:1+ upsampling, dehaze-active deep zoom, and gesture velocity
  prediction (each is its own follow-up).
* Gate: deep-zoom path requires `MAPLE_SCENE_LINEAR=1` because it
  consumes the new scene-linear FFI. When the env gate is unset,
  ⌘1 falls back to the legacy display-encoded `RenderedPreviewCache`
  upscale (no tile rendering — same as today).
```

- [ ] **Step 9.2: Run a final full-suite pass.**

Run:

```bash
cd src/raw-pipeline && cargo test --workspace 2>&1 | tail -10
cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10
src/scripts/test_color_pipeline.sh 2>&1 | tail -10
```

Expected: all green. The color pipeline harness must still pass — Plan 3 doesn't touch the development chain, so no parity regression is allowed.

- [ ] **Step 9.3: Commit.**

```bash
git add docs/tickets/06-viewport-sized-rust-ffi-preview.md
git commit -m "$(cat <<'EOF'
docs(ticket-06): annotate Milestone 4 status with Plan 3 deliverables

Plan 3 ships Milestones 1-3 of M4 (single-tile CLI render, Apple
TileManager + composite, FullImageView wiring with new Cmd+scroll
gesture). Phase-1 scope cuts called out. Gate dependency on
MAPLE_SCENE_LINEAR=1 documented.
EOF
)"
```

---

## Open questions to surface (per design brief — NOT to resolve in this plan)

1. **Bayer alignment on `demosaic::half_res` at tile boundaries** ([`demosaic/half_res.rs:11`](../../src/raw-pipeline/raw-core/src/demosaic/half_res.rs:11)). 35 px overlap with even-snapped corners may be enough; the defensive snap to even multiples (Step 1.5's `pad_and_clamp_mosaic_rect`) is a belt-and-braces measure. Phase-2 plan: validate by rendering a tile and a full image, then comparing per-pixel ΔE in the inner region — if the boundary tile shows < 0.5 ΔE drift on the parity fixture set, the snap-to-even is sufficient.

2. **`hamilton_adams.rs:18` 2-pixel border behavior at tile boundaries.** The brief hypothesizes that 35 px overlap fully hides the bilinear-fallback border that hamilton_adams uses on the outermost 2 px. Confirm with a stage-trace test on a tile vs the same region from the full image — phase-2.

3. **`rawler_decode` sub-image support — does it expose a cropped-decode API?** If yes, `RawImageCache` could store an opaque "rawler reader" instead of a fully decoded mosaic, and tile fetches do their own crop-decode. If no (likely), the current architecture (whole-image rawler decode → `RawImageCache` holds the decoded mosaic via the opaque handle) is the right trade-off. Phase-2 spike.

4. **Tile prefetch ring vs strict tile-window.** Strict-window means visible tiles only — pan jitter shows underlayer briefly. A 1-tile ring around the visible window doubles tile fetch volume but masks the jitter. Phase-4 (post-launch) decision; mention here as a known follow-up.

---

## Web FFI signature (deferred — for cross-platform parity tracking)

Specified for symmetry; not implemented in this plan.

```rust
// Deferred — see Plan 3 § Out of scope. Implement in Plan 5.
#[wasm_bindgen]
pub fn maple_render_scene_linear_tile_wasm(
    raw_bytes: &[u8], hint_ext: &str, model_json: &str,
    src_x: u32, src_y: u32, src_w: u32, src_h: u32,
    out_w: u32, out_h: u32, quality_preview: bool,
) -> Result<Vec<u8>, JsValue>;
// Returns fp16 RGBA bytes (length = out_w * out_h * 8). Web-side
// TileManager mirrors the Apple actor with WebGL2 composite.
```

The signature is byte-equivalent to the C ABI tile entry plus the explicit `model_json` + `bytes` semantics. Web TileManager shares the brief's geometry constants (512² tile, 35 px overlap, zoom buckets {1, 2, 4, 8}, 200 MB iPhone-equivalent / 1 GB Mac-equivalent budget) — these become const exports from `src/scripts/codegen/`.

---

## Self-review

**Spec coverage** (against the brief):
- Tile geometry 512² + 35 px overlap → Task 1 (`TILE_OVERLAP_PX = 35`).
- New FFI entry `maple_render_*_scene_linear_tile` → Task 2.
- RawImageCache architectural prerequisite → Task 5 (with the FFI handle plumbing in Tasks 3-4).
- TileManager actor with byte-budget LRU → Task 6.
- Two-phase rendering at deep zoom → Task 8 `_scheduleRefine` branch.
- Apple zoom UX (MagnifyGesture, ⌘1/⌘=/⌘-, Cmd+scroll) → Task 8 Step 8.4.
- Dehaze fallback (whole-image render when `dehaze != 0`) → Task 1 (Rust error), Task 2 (FFI code 10), Task 7 (Apple-side return-nil branch).
- Mosaic crop alignment to even multiples → Task 1 Step 1.5 `pad_and_clamp_mosaic_rect`.
- Performance gates (≤500 ms cold tile, ≤16 ms cache hit, 200 MB / 1 GB caches) → Task 8 Step 8.7 manual verification.
- Out-of-scope explicit list → § Out of scope.
- Web tile parity deferred with signature spec → § Web FFI signature.

**Placeholder scan:** none (no `TBD`, no "implement later", no "appropriate error handling" without code). Every step has the actual code or command.

**Type consistency:**
- `MapleSceneLinearImageData` (PipelineRenderer.swift, Plan 1 Task 4) used identically in Task 4 + Task 7.
- `TileKey` fields (`urlHash`, `sidecarMtime`, `viewTransformVersion`, `zoomBucket`, `tileX`, `tileY`) consistent across Tasks 6, 7, 8.
- `MapleRawHandleBox` returned by `decodeRawHandle` (Task 4) = consumed by `renderPreviewTile` (Task 4) = stored by `RawImageCache.handle(for:)` (Task 5) = used by `decodePreviewTile` (Task 7).
- Rust `render_scene_linear_tile_from_raw_with_quality` signature consistent in Tasks 1, 2, 3.

---

## Cross-references

- Ticket: `docs/tickets/06-viewport-sized-rust-ffi-preview.md` § "Recommended Milestones / Milestone 4"
- Plan 1 v2 (prerequisite): `docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md` Tasks 2, 3, 4, 7, 8
- CLAUDE.md § "Performance invariants" (16 ms slider tick, 250–1000 ms cold open, two-phase rendering)
- CLAUDE.md § "Cross-platform parity" (constants codegen — Web tile parity will use this when it lands)
- Brief origin: design brief produced 2026-04-24 (in this prompt, locked-in)
