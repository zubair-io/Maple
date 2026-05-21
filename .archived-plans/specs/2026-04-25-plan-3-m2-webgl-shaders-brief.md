# Plan 3 M2 — WebGL2 GLSL Port of the Apple Metal Dev-Chain Brief

> Brainstorm output, 2026-04-25. Becomes input to a future writing-plans session for Plan 3 M2.
> Cross-links: [Plan 3 brief](./2026-04-25-plan-3-web-ffi-split-brief.md), [Plan 3 M1 plan](../plans/2026-04-25-plan-3-web-ffi-split-m1.md).

Plan 3 M1 shipped the scene-linear FFI (`raw-pipeline.service.ts:188-242` exposes `decodeSceneLinear` returning Rec.2020 fp16 RGBA via `Uint16Array`). M2 is the GPU pipeline that consumes that buffer and renders to canvas, by porting the five Apple Metal kernels at `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/` to GLSL ES 3.0. M3 wires the result into `image-canvas.component.ts:99-103` (currently still painting `ImageBitmap`).

## 1. Shader pipeline architecture

Five fragment-shader passes alternating between two `RGBA16F` framebuffer attachments (ping-pong), driven by one trivial vertex shader that emits a full-screen NDC triangle (no VBO; `gl_VertexID`-indexed). Pass order: input fp16 texture → `whiteBalance.frag` → `sceneToneControls.frag` → `sceneVibrance.frag` → `sceneSaturation.frag` → `agxViewTransform.frag` → final blit to the sRGB-tagged `<canvas>`. The AgX pass is the last fp16-domain pass; the canvas blit collapses fp16 → 8-bit sRGB via the WebGL2 default encode (canvas `colorSpace: 'srgb'` per CLAUDE.md § "Build & test — Web").

**Abstraction call: hand-rolled `WebGL2RenderingContext`.** `regl` and `twgl` add bundle weight for what is fundamentally five FBO swaps and five identical full-screen draws. A ~150-line `Pipeline.ts` class managing two FBOs, the LUT texture, and per-pass uniform setters beats either library on bundle size, fp16 internal-format control, and explicit lifecycle. M5 deep-zoom tile work needs the same control. **Use raw WebGL2.**

## 2. Per-kernel GLSL port effort

| Apple kernel | GLSL signature | Effort | Open issues |
|---|---|---|---|
| `WhiteBalance.metal:84-107` | `vec4 whiteBalance(sampler2D src, float liveT, float liveTint, float decT, float decTint)` | S | `cct_to_xy` polynomial computes `1/t³` near 1e12 — fp32 fragment precision is fine, but constants must be source-of-truth doubles, downcast at codegen. |
| `SceneToneControls.metal:25-75` | `vec4 sceneToneControls(sampler2D src, float exposure, float highlights, float shadows, float whites, float blacks)` | XS | `smoothstep_f` and `exp2` are GLSL builtins. Direct port. |
| `SceneVibrance.metal:57-82` | `vec4 sceneVibrance(sampler2D src, float vibrance)` | S | `M_PI_F` → `3.14159265359` const. Oklab matrices duplicated from `SceneSaturation.metal:17-39` — see § 5. |
| `SceneSaturation.metal:53-63` | `vec4 sceneSaturation(sampler2D src, float saturation)` | XS | Same Oklab matrices as Vibrance. Single chroma scale. |
| `AgXViewTransform.metal:44-74` | `vec4 agxViewTransform(sampler2D src, sampler2D lut, float contrast)` | M | LUT becomes `sampler2D` of 512×1 (WebGL2 has no 1D); `texture(lut, vec2(t * 511.0/512.0, 0.5)).r` mirrors Apple's `lut_sampler.sample(float2(...))` at `AgXViewTransform.metal:32`. fp16 rendertarget LSB drift is the only precision risk. |

Metal `coreimage::sampler_h.sample(src.coord())` becomes GLSL `texture(uSrc, vTexCoord)` with the standard `[0, 1]` quad UV. Metal's `float4` return becomes `out vec4 outColor` to an `RGBA16F` attachment; auto-promotion to fp16 on store is well-defined IEEE 754.

## 3. fp16 working format

Required at context init:
- `EXT_color_buffer_half_float` — render-to-fp16 attachment.
- `OES_texture_float_linear` — linear sampling on fp16/f32 textures (LUT and fit-to-window inputs both need it).

Both ship in evergreen Chrome 90+, Edge 90+, Firefox 88+, Safari 15+. **If absent at probe:** fall back to the legacy display-encoded `decode()` path painting `ImageBitmap` (`image-canvas.component.ts:154`), with a one-time `console.warn('Maple: WebGL2 fp16 unavailable, using legacy paint path')`. Matches the Plan 3 brief at line 28 ("Don't ship a software-shader fallback").

## 4. AgX LUT in WebGL

The LUT is 2048 bytes (512 × f32) at `src/raw-pipeline/raw-core/src/view/agx_lut.bin`. Bundling:

1. Vite asset config in the `maple-common` Angular library — register `*.bin` as a copyable asset, served at a known relative URL.
2. At `Pipeline` init: `fetch(lutUrl)` → `arrayBuffer()` → `new Float32Array(arrayBuffer)`.
3. Upload as `gl.texImage2D(TEXTURE_2D, 0, R16F, 512, 1, 0, RED, HALF_FLOAT, fp16Lut)` after CPU-side fp32 → fp16 pack.
4. `gl.LINEAR` + `gl.CLAMP_TO_EDGE` (matches Apple `coreimage::sampler_h` defaults — see § 9).

The `AGX_VERSION 5` pin (commit `8c32bfe`, per Plan 3 M1 plan line 34) means WASM `include_bytes!` and the bundled `.bin` must come from the same `derive_agx_lut.py` invocation. M2.2 adds a `--web-bin` flag writing to `src/web/projects/maple-common/assets/agx_lut.bin`, parallel to the existing `--apple-bin`.

## 5. Color codegen for shared constants

`src/scripts/codegen/` referenced in CLAUDE.md is **absent on disk** (verified `ls`). The Oklab matrices already appear twice in `SceneVibrance.metal:14-38` and `SceneSaturation.metal:17-39` — `SceneSaturation.metal:11-16` documents the duplication as deliberate. Adding GLSL triples the pasting cost.

- **(a) Build-time embed.** Vite plugin reads `src/web/projects/maple-common/src/lib/webgl/color-constants.ts`, expands `// @inject COLOR_CONSTANTS` markers in `.glsl` sources at bundle time. Matrix parity covered by the existing `raw-core/src/color/oklab.rs` unit test plus M2.1's snapshot diff.
- **(b) Codegen fresh.** Create `src/scripts/codegen/gen_color_constants.py`: parse `raw-core/src/color/{matrices,oklab}.rs`, emit Rust/TS/GLSL/Metal in lockstep. Adds golden CI gate.

**Recommend (a) for M2.1, (b) as M2.3 follow-on.** (a) is one vite plugin and a TS file; (b) needs a Rust parser. M2.1's CIEDE2000 snapshot vs Apple reference will catch hand-introduced matrix drift.

## 6. Compositing into Angular `image-canvas.component.ts`

Per the M1 plan (line 38, "Out of scope: M3"), M2 must **not** touch `image-canvas.component.ts`. M2 ships a standalone test page at `src/web/projects/maple/src/app/dev/webgl-test-page.component.ts` that:

- Loads a static fp16 input from a fixture asset.
- Initializes WebGL2 with `colorSpace: 'srgb'`.
- Manages texture lifecycle (input fp16 + 2 ping-pong FBOs + LUT) explicitly.
- Snapshots via `canvas.toDataURL()`, diffed against an Apple-rendered reference PNG using `compare_images.py` CIEDE2000 (CLAUDE.md § "Objective color testing").

M3 ports the `Pipeline` class into `image-canvas.component.ts`, replacing `imageDataToBitmap` at line 154, hooking `LibraryStateService` signals into per-pass uniforms, binding `ngOnDestroy` to `gl.delete*`.

## 7. WebGL2 capability fallback

Probe runs once at `Pipeline.create(canvas)`; on failure return `null` — the M3 caller keeps the legacy paint. M2's standalone test page **hard-requires** WebGL2-fp16 (it's a dev/CI artifact, not user-facing). The probe failure path is exercised by an explicit `gl.getExtension(...)` mock in unit tests.

## 8. Sequencing milestones for M2

- **M2.1.** GLSL ports of five kernels + standalone Angular test page + CIEDE2000 snapshot vs Apple reference PNG.
- **M2.2.** AgX LUT bundling (`--web-bin` flag in `derive_agx_lut.py`; vite asset config; runtime fetch + upload).
- **M2.3.** Color codegen scaffolding (option (b)) — separate plan after M2.1 lands.
- **M2.4 (deferred).** WebGL2 vs Apple Metal parity test on the 100MP Hasselblad fixture; gates entry to M3.

## 9. Open questions

- **fp16 sampling parity Metal vs WebGL2.** `texture(s, uv)` on `RGBA16F` vs `coreimage::sampler_h.sample()` — IEEE 754 binary16 rounding identical in spec; verify on Safari 17 with a fixture before locking M2.1.
- **Output rounding.** GLSL `out vec4 → RGBA16F` auto-promote vs Metal `half4(...)` cast: both round-to-nearest-even. Confirm with a one-pixel fixture.
- **LUT edge sampling.** `gl.LINEAR` vs `gl.NEAREST` is observable at the AgX shoulder. Apple's `kCIInputBackgroundOptions` for `coreimage::sampler_h` defaults to bilinear with `kCIFormatRGBAh`; MUST match `gl.LINEAR + gl.CLAMP_TO_EDGE`. Unit-test `t = 1.0`.
- **fp16 readback.** Does `EXT_color_buffer_half_float` permit `gl.readPixels(..., HALF_FLOAT, Uint16Array)` from the last fp16 attachment for the snapshot test? Evergreen yes; confirm Safari 17.

## 10. Recommended cut

**Ship M2.1 alone first.** Five fragment shaders, hand-rolled WebGL2 `Pipeline` class, standalone Angular test page, CIEDE2000 snapshot diff vs Apple reference PNG of one fixture rendered with one non-trivial `AdjustmentModel`. No LUT bundling automation (commit a hand-packed fp16 `.bin` once, defer `--web-bin` to M2.2). No codegen subdir. No Angular wiring. Test page hard-requires fp16 — no probe yet. One plan, one snapshot, full chain end-to-end. M2.2/M2.3/M2.4 each become their own writing-plans run after M2.1 proves the chain.
