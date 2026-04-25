# Web/WASM FFI-Split Design Brief (Plan 3)

> Brainstorm output, 2026-04-25. Becomes input to a future writing-plans session.
> Cross-link: [Plan 1 v2](../plans/2026-04-24-ffi-split-plan-1.md), [Plan 2](../plans/2026-04-25-plan-2-dev-chain-metal-kernels.md), [Deep Zoom plan](../plans/2026-04-25-deep-zoom-tile-rendering.md).

CLAUDE.md § "One Rust core, three native pipelines" makes Web parity load-bearing, not aspirational. Apple just shipped its scene-linear FFI surface (`maple_render_*_scene_linear` family at `src/raw-pipeline/raw-ffi/src/lib.rs:283-880`) and a five-kernel Metal dev chain (`Metal/{WhiteBalance,SceneToneControls,SceneVibrance,SceneSaturation,AgXViewTransform}.metal`). The Web side at `src/raw-pipeline/raw-wasm/src/lib.rs:98-137` still returns `Vec<u8>` sRGB and the canvas component at `src/web/projects/maple-common/src/lib/components/image-canvas/image-canvas.component.ts:99-103` paints an `ImageBitmap` — no shaders, no scene-linear buffer, every adjustment baked at decode time.

## 1. Output buffer format

Mirror Apple: Rec.2020 fp16 RGBA, straight alpha, row-major. The same `pack_fp16` already produces this format at `raw-core/src/pipeline.rs:271-297`. Recommend the Web FFI return a `Uint16Array` view over the WASM heap — the bit pattern is identical to a half-float texture upload. At 100MP that's ~800 MB. Smaller-resolution fp16 (Plan 1 Task 8 sized variants at `raw-ffi/src/lib.rs:492-672`) is the right default for the editor surface; full-res lands only on export. fp8 rejected: gamut-mapped Rec.2020 wide-gamut data needs the headroom that fp16 provides above 1.0 for the AgX shoulder.

## 2. WASM FFI surface

Drop the existing `render_bytes(...) -> MapleRender { rgb: Vec<u8> }` (`raw-wasm/src/lib.rs:46-73`) in favour of a scene-linear-first surface that mirrors Apple but is bytes-only (no filesystem in the browser):

- `renderBytesSceneLinear(raw, ext, xmp, quality) -> { fp16Rgba: Uint16Array, w, h, asShotTemperature, asShotTint }`
- `renderBytesSceneLinearSized(raw, ext, xmp, maxLongEdge, quality) -> ...`
- `renderBytesSceneLinearTile(rawHandle, xmp, srcX, srcY, srcW, srcH, outW, outH, quality) -> ...`

These map 1:1 onto `raw_core::pipeline::render_scene_linear_*from_raw_with_quality` (the same helpers Apple consumes). The handle variant matches Apple's opaque `MapleRawHandle` (commit `fbf36b7`).

## 3. Web GPU pipeline shape

Apple uses `CIColorKernel`s in a CIFilter chain. Web has no CoreImage; recommend a hand-written WebGL2 program chain rendering through ping-pong fp16 framebuffers: `WhiteBalance.frag → SceneToneControls.frag → SceneVibrance.frag → SceneSaturation.frag → AgXViewTransform.frag → sRGB encode (canvas blit)`. Each Apple kernel is a pure pixel function; the GLSL ES 3.0 ports are mechanical. The canvas-color-space invariant (CLAUDE.md § "Build & test — Web") still applies: tag the drawing buffer `colorSpace: 'srgb'`.

## 4. WebGL2 capability check

`EXT_color_buffer_half_float` (render-to-fp16 attachment) and `OES_texture_float_linear` (linear sampling) are required. Both ship in evergreen Chrome/Edge/Firefox/Safari but should be probed at context creation. If absent: fall back to the legacy display-encoded `render_bytes` path with a one-time console warning. Don't ship a software-shader fallback — the slider 16 ms tick budget doesn't tolerate it.

## 5. WASM memory transfer cost

Apple's FFI is allocate-and-hand-off; Apple owns and later calls `maple_free_scene_linear_buffer` (`raw-ffi/src/lib.rs:871-883`). WASM has no equivalent zero-copy story across the JS boundary — `wasm-bindgen` `getter -> Vec<u16>` `memcpy`'s out of linear memory. Mitigations:

1. Make the **sized** variant the editor's default (Plan 1 Task 8 proves the pattern; ~12 MB for a 4K viewport).
2. The decode worker is already off the main thread (`raw-pipeline.service.ts:42-89`); transfer the resulting `ArrayBuffer` to the main thread with `postMessage([..buf], [buf])`.
3. Tile rendering for the deep-zoom milestone keeps each transfer at ~1 MB.

## 6. AgX LUT in browser

The LUT is 2 KB (`agx_lut.bin`, 512 × f32 derived by `src/scripts/derive_agx_lut.py`). Embed it in the WASM module's data segment via `include_bytes!` — same source-of-truth path used by `raw-core/src/view/agx_lut.bin`. The GLSL fragment shader reads it as a 1D texture (`texture(uLut, vec2(x, 0.5)).r`). Extend `derive_agx_lut.py` to also write a TS constant or `.bin` file consumed via `fetch`. AGX_VERSION 5 pin enforced by commit `8c32bfe`.

## 7. Color codegen

Rec.2020↔Oklab, CCT→xy, and the other matrices live in Rust, are pasted into the Metal kernels, and need to be regenerated for GLSL. Extend `src/scripts/codegen/` (the directory does not exist yet — `derive_agx_lut.py` is the only codegen script; the codegen subdir must be created) to emit:

- Rust `pub const` (existing)
- TypeScript `export const` for JS-side parameter prep
- GLSL `const float` blocks for fragment shader sources at build time

The Apple `WhiteBalance.metal` and `SceneSaturation.metal` (commits `f2cae40`, `10b0db0`) are the constant inventory.

## 8. Sequencing milestones

- **M1 — WASM scene-linear FFI.** New `renderBytesSceneLinear` surface alongside existing `render_bytes`. Worker types extended (`raw-pipeline.types.ts`). Web shell unchanged — still draws the legacy sRGB path.
- **M2 — WebGL2 dev-chain shaders.** Five fragment shaders (GLSL ports of Metal kernels). Standalone test page proves the chain.
- **M3 — Wire into `image-canvas.component.ts`.** Replace `imageDataToBitmap` paint with WebGL2 chain. Fit-to-window works on the new path.
- **M4 (deferred)** — Sized FFI + viewport rendering. Mirrors Plan 1 Task 8.
- **M5 (deferred)** — Tile rendering. Mirrors Deep Zoom plan.

## 9. Open questions

- **fp16 texture upload.** WebGL2 `texImage2D(..., HALF_FLOAT, Uint16Array)` well-defined when `EXT_color_buffer_half_float` is present; verify on Safari 17.
- **Service worker caching.** Probably skip; per-edit-session buffers are large.
- **Threading.** WASM build already supports `--features parallel` and `initThreadPool` (`raw-wasm/src/lib.rs:23-32`).
- **Codegen subdir.** Referenced by CLAUDE.md but absent on disk; M1 should create the structure and migrate `derive_agx_lut.py` into it.

## 10. Recommended cut

**Ship M1 alone first.** New WASM surface + worker plumbing, no shaders, no Angular changes. The legacy paint path keeps working; the new FFI is a tested no-op consumer waiting for M2. This is the smallest landed change that proves the "one Rust core" invariant on Web without creating a half-finished GPU chain in the editor. M2 (shaders) and M3 (wiring) follow as separate plans once the FFI surface is stable, exactly the sequencing Apple used for Plan 1 → Plan 2.
