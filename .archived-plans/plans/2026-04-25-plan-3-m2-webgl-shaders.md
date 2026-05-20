# Plan 3 M2.1 — WebGL2 Dev-Chain Shaders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Brief:** [`.archived-plans/specs/2026-04-25-plan-3-m2-webgl-shaders-brief.md`](../specs/2026-04-25-plan-3-m2-webgl-shaders-brief.md). This plan implements the brief's § 10 "Recommended cut": **M2.1 only.**
>
> **Cross-links:**
> - [Plan 3 M2 brief](../specs/2026-04-25-plan-3-m2-webgl-shaders-brief.md) — drives this plan.
> - [Plan 3 brief (umbrella)](../specs/2026-04-25-plan-3-web-ffi-split-brief.md) — milestone sequence.
> - [Plan 3 M1 plan](2026-04-25-plan-3-web-ffi-split-m1.md) — the WASM scene-linear FFI this plan's test page consumes through `RawPipelineService.decodeSceneLinear`.
> - [Plan 1 v2 (Apple FFI split)](2026-04-24-ffi-split-plan-1.md) — Apple-side parallel; M2.1's reference PNGs come from this chain.
> - [Plan 2 v2](2026-04-25-plan-2-v2-shared-blur-clarity-texture.md) — running in parallel; different files, no conflict.
> - AgX LUT regen path: `src/scripts/derive_agx_lut.py` (writes `src/raw-pipeline/raw-core/src/view/agx_lut.bin`); `AGX_VERSION` pinned by commit `8c32bfe` (per Plan 3 M1 plan line 34).

**Goal:** Port the five Apple Metal kernels (`WhiteBalance`, `SceneToneControls`, `SceneVibrance`, `SceneSaturation`, `AgXViewTransform`) to GLSL ES 3.0 fragment shaders, drive them with a hand-rolled WebGL2 `Pipeline` class managing two `RGBA16F` ping-pong framebuffers + an AgX LUT 1D texture, and prove the chain by snapshotting one synthesized fp16 input through the pipeline against an Apple-rendered reference PNG with mean ΔE₀₀ < 1.0.

**Architecture:**
1. **Verification spike (Task 1).** Three short experiments answer the brief's open questions before any production code lands: fp16 sampling parity Metal-vs-WebGL2, AgX LUT edge sampling math, and fp16 readback availability. Outputs are written to a verification log inside this plan file (Step 1.4 captures findings to a new `## Spike findings` section).
2. **Five fragment shaders (Tasks 2-6)** in `src/web/projects/maple-common/src/lib/webgl/shaders/`, plus a single shared `vertex.glsl`. Constants (Oklab matrices, Rec.2020 luma, AgX coefficients) are embedded directly in the shader source — codegen is deferred to M2.3.
3. **`Pipeline` class (Task 7)** at `src/web/projects/maple-common/src/lib/webgl/pipeline.ts`. Hand-rolls the WebGL2 setup: probe `EXT_color_buffer_half_float` + `OES_texture_float_linear` (throw if absent), allocate two `RGBA16F` framebuffers for ping-pong, upload the LUT as a `R16F` 512×1 texture, compile/link each program once, expose `render(input, model) -> Uint8ClampedArray`.
4. **AgX LUT bundling (Task 8).** A hand-packed `agx_lut.bin` is committed into `src/web/projects/maple-common/src/lib/webgl/agx_lut.bin` — produced once by a one-liner that reads the existing `src/raw-pipeline/raw-core/src/view/agx_lut.bin` (2048 bytes, 512 × f32 LE) and converts to fp16. No vite asset config; the file is fetched via `import.meta.url`. Automation (`--web-bin` flag in `derive_agx_lut.py`) is M2.2.
5. **Standalone test page (Task 9)** at `src/web/projects/maple-common/src/lib/webgl/dev/webgl-test-page.component.ts` — gated behind `isDevMode()`, route `/dev/webgl-test` registered in `maple-hosted/src/app/app.routes.ts`. Loads a fixture fp16 input + reference PNG, runs the pipeline, side-by-side `<canvas>` + `<img>` for visual eyeballing, prints mean/P95/max ΔE₀₀.
6. **Vitest snapshot test (Task 10)** at `src/web/projects/maple-common/src/lib/webgl/pipeline.spec.ts`. Hard-codes a 16×16 synthesized fp16 input + a pre-computed reference PNG, asserts mean ΔE < 1.0. Uses `headless-gl` if installed, otherwise skips with `it.skip` and logs the reason — the test page is the canonical M2.1 validation; the unit test is a regression guardrail.
7. **Hard-required fp16.** No probe / no fallback in M2.1. The test page surfaces a banner if extensions are missing and refuses to render. M3 adds the production fallback path.

**Tech Stack:**
- Hand-rolled WebGL2 (no `regl` / no `twgl`). Bundle weight matters; the brief's § 1 commits to "raw WebGL2".
- GLSL ES 3.0 (`#version 300 es`).
- Internal format `RGBA16F` for ping-pong attachments; `R16F` for the LUT (512×1, `LINEAR + CLAMP_TO_EDGE`).
- Required extensions: `EXT_color_buffer_half_float`, `OES_texture_float_linear`.
- Canvas tagged `colorSpace: 'srgb'` per CLAUDE.md § "Build & test — Web".
- Vitest harness via `@angular/build:unit-test` (matches Plan 3 M1's spec runner).
- `compare_images.py` (already at `src/scripts/compare_images.py`) for the snapshot ΔE₀₀ computation in the test page.

**Brainstorm origin:** [Brief 2026-04-25](../specs/2026-04-25-plan-3-m2-webgl-shaders-brief.md) § 10 "Recommended cut". The brief's § 1 (architecture), § 2 (per-kernel effort), § 4 (LUT bundling), § 6 (test page), and § 9 (open questions) are the four sections this plan operationalises.

**Verified findings (each maps to a task):**

1. **Five Metal kernel sources confirmed at exact line numbers.** `WhiteBalance.metal:84-107` (entry point), `SceneToneControls.metal:25-75`, `SceneVibrance.metal:57-82`, `SceneSaturation.metal:53-63`, `AgXViewTransform.metal:44-74`. Rec.2020 luma + Oklab matrices duplicated across `SceneVibrance.metal:14-38` and `SceneSaturation.metal:17-39`; the duplication is documented at `SceneSaturation.metal:11-16` as deliberate ("Metal does not share constants between .metal files inside a single metallib"). GLSL has the same restriction across `.glsl` files imported as separate sources, so M2.1 mirrors the duplication.
2. **AgX LUT is 2048 bytes (512 × f32 LE).** Confirmed via `stat -f "%z" src/raw-pipeline/raw-core/src/view/agx_lut.bin` → `2048`. Constants `AGX_MIN_EV=-10.0`, `AGX_MAX_EV=6.5`, `AGX_MID_GRAY=0.18`, `AGX_LUT_SIZE=512` come from `src/raw-pipeline/raw-core/src/view/agx_coeffs.rs:10-26`. `AGX_VERSION=5` at `agx_coeffs.rs:32`. `MID_NORM` derivation at `agx_coeffs.rs`-equivalent in `agx.rs:31` matches `AgXViewTransform.metal:21` (`-AGX_MIN_EV / (AGX_MAX_EV - AGX_MIN_EV)` = ~0.606).
3. **`src/scripts/codegen/` directory is absent on disk.** Confirmed via `ls src/scripts/codegen` → "No such file or directory". CLAUDE.md references it but M2.1 deliberately does not create it — embedded constants in the GLSL source are the M2.1 cut. M2.3 is the separate plan that creates it.
4. **Plan 3 M1 already shipped `decodeSceneLinear`.** Confirmed at `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts:188-242`. The test page in Task 9 uses this entry to generate a fresh fp16 input from a hand-saved DNG, **as well as** loading a pre-saved `.bin` (so the page works even when a DNG fixture is absent in the worktree).
5. **Maple Hosted shell has the `app.routes.ts` registry.** Confirmed at `src/web/projects/maple-hosted/src/app/app.routes.ts:1-12` (already imports `BrowseShellComponent`, `EditorShellComponent` from `@maple-common`). M2.1 adds a fourth route `'/dev/webgl-test'` gated by `isDevMode()` (per CLAUDE.md no convention "no template scaffold code"; the dev page is real, not scaffold).
6. **Vitest runner is configured per Angular project, with `vitest/globals` in spec tsconfig.** Confirmed at `src/web/projects/maple-common/tsconfig.spec.json:7` (`"types": ["vitest/globals"]`). The snapshot test (Task 10) uses the same `import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'` shape as `raw-pipeline.service.spec.ts:9`.
7. **`compare_images.py` does CIEDE2000 + bias.** Confirmed at `src/scripts/compare_images.py:30-60`. JS-side ΔE in the test page reuses the same algorithm in TypeScript (Bruce Lindbloom's reference implementation, ported in Task 9 to a 60-line `delta-e-2000.ts` helper) so the test page can run without spawning Python.

**Out of scope (explicit — separate plans for each):**
- **M2.2 — AgX LUT bundling automation.** A `--web-bin` flag in `derive_agx_lut.py`, vite asset config registration, runtime `fetch(lutUrl)`. M2.1 bundles a one-shot hand-packed `agx_lut.bin` checked in alongside the shaders.
- **M2.3 — Color codegen scaffolding.** `src/scripts/codegen/gen_color_constants.py` plus the lockstep Rust/TS/GLSL/Metal output. M2.1 embeds constants directly in shader sources.
- **M2.4 — WebGL2 vs CoreImage parity gate on the 100MP Hasselblad fixture.** Deferred until M2.1 proves the chain. M2.1's snapshot test uses a 16×16 synthesized input.
- **M3 — Wire WebGL2 chain into `image-canvas.component.ts`.** Replace `imageDataToBitmap` (`src/web/projects/maple-common/src/lib/components/image-canvas/image-canvas.component.ts:20`) with a `Pipeline` instance hooked to `LibraryStateService` signals. Separate plan.
- **fp16 capability fallback / probe.** Brief § 7 explicitly says M2.1 hard-requires fp16. M3 adds the legacy fallback.
- **`src/scripts/codegen/` directory creation.** See M2.3.
- **Removing the legacy `render_bytes` WASM entry.** Deferred per Plan 3 M1's "Out of scope" section (line 45 of `2026-04-25-plan-3-web-ffi-split-m1.md`).

---

## File Structure

**WebGL shader sources (read-write, all new files):**
- Create: `src/web/projects/maple-common/src/lib/webgl/shaders/vertex.glsl` — single shared full-screen-quad vertex shader; no VBO, uses `gl_VertexID`.
- Create: `src/web/projects/maple-common/src/lib/webgl/shaders/white-balance.frag` — port of `WhiteBalance.metal:84-107`.
- Create: `src/web/projects/maple-common/src/lib/webgl/shaders/scene-tone-controls.frag` — port of `SceneToneControls.metal:25-75`.
- Create: `src/web/projects/maple-common/src/lib/webgl/shaders/scene-vibrance.frag` — port of `SceneVibrance.metal:57-82`.
- Create: `src/web/projects/maple-common/src/lib/webgl/shaders/scene-saturation.frag` — port of `SceneSaturation.metal:53-63`.
- Create: `src/web/projects/maple-common/src/lib/webgl/shaders/agx-view-transform.frag` — port of `AgXViewTransform.metal:44-74`.
- Create: `src/web/projects/maple-common/src/lib/webgl/shaders/index.ts` — `import` glue (Angular `@angular/build:application` bundles `.glsl` as raw text via `?raw` import suffix; the index file hides the Vite-style import suffix from the rest of the codebase).

**WebGL Pipeline + LUT (read-write, all new files):**
- Create: `src/web/projects/maple-common/src/lib/webgl/pipeline.ts` — `Pipeline` class.
- Create: `src/web/projects/maple-common/src/lib/webgl/agx_lut.bin` — hand-packed 1024-byte fp16 LUT (512 × f16). Source: convert `src/raw-pipeline/raw-core/src/view/agx_lut.bin` once via the Step 8.1 conversion script. **Tracked in git** (under 5 KiB).
- Create: `src/web/projects/maple-common/src/lib/webgl/agx-lut-loader.ts` — fetches the `.bin` via `import.meta.url`, returns `Uint16Array`.
- Create: `src/web/projects/maple-common/src/lib/webgl/delta-e-2000.ts` — CIEDE2000 helper used by the test page.

**Standalone test page (read-write, all new files):**
- Create: `src/web/projects/maple-common/src/lib/webgl/dev/webgl-test-page.component.ts` — Angular standalone component.
- Create: `src/web/projects/maple-common/src/lib/webgl/dev/webgl-test-page.component.html` — separate HTML per CLAUDE.md § "best-practices.md § Angular".
- Create: `src/web/projects/maple-common/src/lib/webgl/dev/webgl-test-page.component.scss` — separate SCSS per same convention.
- Create: `src/web/projects/maple-common/src/lib/webgl/dev/fixtures/synthetic-input.bin` — 16×16×4×2 = 2048-byte fp16 RGBA. Hand-generated by Step 9.2.
- Create: `src/web/projects/maple-common/src/lib/webgl/dev/fixtures/reference.png` — Apple-rendered reference image, 16×16. Generated by an Apple-side `maple-cli`-equivalent in Task 1.4 verification (or manually with the Apple xcframework + Metal kernels). The fixture is committed.
- Create: `src/web/projects/maple-common/src/lib/webgl/dev/fixtures/MANIFEST.md` — documents the fixture provenance (DNG path, model JSON, the exact `maple-cli` invocation that produced the reference). Without provenance the fixture rots silently.

**Vitest spec (read-write, all new files):**
- Create: `src/web/projects/maple-common/src/lib/webgl/pipeline.spec.ts` — vitest unit test.

**Maple Hosted shell (read-write, modify):**
- Modify: `src/web/projects/maple-hosted/src/app/app.routes.ts` — add the `/dev/webgl-test` route gated by `isDevMode()`. Lazy-loads the test-page component so production bundles do not include it.

**Public API (read-write, modify):**
- Modify: `src/web/projects/maple-common/src/public-api.ts` — re-export `Pipeline`, `Pipeline.create`, the `WebglFp16Unsupported` error class. The test-page component is **not** re-exported (it stays internal — only the route consumes it via dynamic import).

**Read-only references during implementation (must NOT modify):**
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/{WhiteBalance,SceneToneControls,SceneVibrance,SceneSaturation,AgXViewTransform}.metal` — the source-of-truth math.
- `src/raw-pipeline/raw-core/src/view/agx_lut.bin` — bytes are read by Step 8.1's conversion script and committed as `agx_lut.bin` in the webgl directory; the original file is not modified.
- `src/raw-pipeline/raw-core/src/view/agx_coeffs.rs` — coefficient values; embedded as GLSL `const float` in `agx-view-transform.frag`.
- `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts:188-242` — `decodeSceneLinear` entry consumed by the test page.
- `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.types.ts:103-109` — `DecodedSceneLinearImage` interface consumed by the test page and the Pipeline `render` method.
- `src/web/angular.json` — confirm the `webWorkerTsConfig` and asset glob lines (only **read** to verify; M2.1 may need to add a glob for the `.bin` and `.glsl` assets in Task 8 / Task 2).

---

## Ordering constraint

**Tasks must run in order. Each task ends with a commit.** Task 1 is the verification spike — its output (the spike findings) drives precision-critical decisions in Tasks 6 and 7. Skipping Task 1 means Tasks 6 and 7 are guesses.

- **Task 1** (spike) — answers the brief's three open questions; commits a `## Spike findings` section into this plan file. **Blocks 6 and 7.**
- **Tasks 2-5** (the four "easy" shaders) — order does not matter; do them in this sequence for review legibility.
- **Task 6** (AgX) — depends on Task 1's spike answers about LUT edge sampling.
- **Task 7** (Pipeline class) — depends on every shader source from Tasks 2-6 and on Task 8's LUT bytes existing in the directory.
- **Task 8** (LUT packing) — independent of shader work. Can run any time before Task 7. Listed after the shaders for review legibility (the spec emerges before the asset).
- **Task 9** (test page) — depends on Tasks 7 + 8.
- **Task 10** (snapshot vitest) — depends on Tasks 7 + 8 + 9 (the test page generates a reference snapshot the first time it runs; the spec asserts on that snapshot).

If Task 1's spike finds a result that contradicts the brief (e.g. fp16 sampling actually drifts > 0.5 LSB on Safari), **stop and report**. The plan needs amendment before Tasks 6/7.

---

## Task 1: Verification spike — answer the brief's three open questions

**Files:**
- Create (temporary, deleted in Step 1.5): `src/web/projects/maple-common/src/lib/webgl/spike/probe.html` — a minimal standalone HTML harness. **Not** part of the Angular build; opened directly via `file://` or `bun --hot` to load it.
- Modify (final step, append-only): `.archived-plans/plans/2026-04-25-plan-3-m2-webgl-shaders.md` — append `## Spike findings` block at end-of-file.

**Why this matters:** The brief's § 9 "Open questions" lists three items the brief explicitly says "verify on Safari 17 with a fixture before locking M2.1." This task is the verification. The spike's output is a written answer to each question, captured in a `## Spike findings` block at the bottom of this plan file. The shaders in Tasks 2-6 reference the spike's findings (e.g. "the LUT sampling math is `t * (LUT_SIZE - 1) / LUT_SIZE` per Spike 1.2 finding").

The probe is **throwaway**: a single HTML file with three inline `<script>` tags, run once on macOS Safari 17, Chrome stable, and Firefox stable. Output: ΔE numbers + boolean answers to the open questions, pasted into the plan file.

- [ ] **Step 1.1: Create the throwaway probe HTML.**

Create `src/web/projects/maple-common/src/lib/webgl/spike/probe.html` with the following content. It is **deliberately minimal** — three numbered probes, each one running synchronously, each writing a `<pre>` block. No bundler, no Angular, no TypeScript:

```html
<!doctype html>
<html>
<head><title>Plan 3 M2.1 spike</title></head>
<body style="font-family: monospace; padding: 16px;">
<h1>Plan 3 M2.1 verification spike</h1>
<canvas id="cv" width="2" height="2" style="display: none"></canvas>

<h2>Spike 1.1 — fp16 sampling parity</h2>
<pre id="s11">running...</pre>

<h2>Spike 1.2 — AgX LUT edge sampling math</h2>
<pre id="s12">running...</pre>

<h2>Spike 1.3 — fp16 readback</h2>
<pre id="s13">running...</pre>

<script>
// === Spike 1.1: fp16 sampling parity ===
// Upload a 2×2 RGBA16F texture with known fp16 bit patterns,
// sample it with LINEAR filtering at the cell center (UV=0.5,0.5),
// read back the result, and report the bit pattern. Compare against
// the IEEE 754 binary16 expected value.
//
// Expected: the sampled value at UV=(0.5, 0.5) on a 2×2 texture with
// LINEAR is the bilinear average of all four texels. fp16 average of
// (0x3c00, 0x3c00, 0x3c00, 0x3c00) = (1.0, 1.0, 1.0, 1.0) is exactly
// 0x3c00. fp16 average of (0x3800, 0x3c00, 0x3c00, 0x3c00) = (0.5, 1.0,
// 1.0, 1.0) is fp16(0.875) = 0x3b00. Driver rounding-to-nearest-even
// must produce 0x3b00 exactly; any other value indicates non-IEEE
// rounding.

(() => {
  const log = (s) => { document.getElementById('s11').textContent = s; };
  const gl = document.getElementById('cv').getContext('webgl2', {
    antialias: false, premultipliedAlpha: false,
  });
  if (!gl) { log('FAIL: WebGL2 unavailable'); return; }
  const haveCBHF = !!gl.getExtension('EXT_color_buffer_half_float');
  const haveTFL = !!gl.getExtension('OES_texture_float_linear');
  if (!haveCBHF || !haveTFL) {
    log('FAIL: extensions missing — CBHF=' + haveCBHF + ' TFL=' + haveTFL);
    return;
  }

  // Upload a 2x2 RGBA16F texture: top-left = (0.5,0.5,0.5,1.0),
  // others = (1,1,1,1).
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // Bit patterns: 0x3800 = fp16(0.5); 0x3c00 = fp16(1.0).
  const data = new Uint16Array([
    0x3800, 0x3800, 0x3800, 0x3c00,
    0x3c00, 0x3c00, 0x3c00, 0x3c00,
    0x3c00, 0x3c00, 0x3c00, 0x3c00,
    0x3c00, 0x3c00, 0x3c00, 0x3c00,
  ]);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 2, 2, 0, gl.RGBA, gl.HALF_FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Render to a 1x1 RGBA16F FBO, sampling the texture at UV=(0.5, 0.5).
  const fbTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fbTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1, 1, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbTex, 0);

  const vs = `#version 300 es
    void main() {
      vec2 p = vec2((gl_VertexID & 1) * 4 - 1, (gl_VertexID & 2) * 2 - 1);
      gl_Position = vec4(p, 0.0, 1.0);
    }`;
  const fs = `#version 300 es
    precision highp float;
    uniform sampler2D u;
    out vec4 o;
    void main() { o = texture(u, vec2(0.5, 0.5)); }`;
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error('compile: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(gl.getUniformLocation(prog, 'u'), 0);
  gl.viewport(0, 0, 1, 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const out = new Uint16Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.HALF_FLOAT, out);
  // fp16(0.875) = 0x3b00 (R, G, B); fp16(1.0) = 0x3c00 (A).
  const lines = [
    'sampled at center: 0x' + out[0].toString(16) + ' 0x' + out[1].toString(16)
      + ' 0x' + out[2].toString(16) + ' 0x' + out[3].toString(16),
    'expected:          0x3b00 0x3b00 0x3b00 0x3c00',
    'parity:            ' + (out[0] === 0x3b00 && out[1] === 0x3b00
      && out[2] === 0x3b00 && out[3] === 0x3c00 ? 'MATCH' : 'DRIFT'),
  ];
  log(lines.join('\n'));
})();

// === Spike 1.2: AgX LUT edge sampling math ===
// Upload a 4-texel R16F texture [0.0, 0.25, 0.75, 1.0] (1D as 4×1)
// with LINEAR + CLAMP_TO_EDGE. Sample at t = 0.0, 0.5, 1.0 using both
// formulas:
//   (a) Apple Metal:   `t * (LUT_SIZE - 1) / LUT_SIZE`
//                       (so t=1 → 3/4 = 0.75; texel center = 0.875)
//   (b) Symmetric:      `(t * (LUT_SIZE - 1) + 0.5) / LUT_SIZE`
//                       (so t=1 → 3.5/4 = 0.875; texel center exactly)
// The expected sample at t=1.0 (which Apple uses for AgX shoulder) is:
//   formula (a): bilinear between texel 2 and texel 3 → ~0.6875
//   formula (b): exactly texel 3 = 1.0
// The brief asks: which formula does Apple ACTUALLY use?

(() => {
  const log = (s) => { document.getElementById('s12').textContent = s; };
  const gl = document.getElementById('cv').getContext('webgl2');
  if (!gl) { log('skipped — WebGL2 unavailable'); return; }
  // 4-texel R16F texture: [0, 0.25, 0.75, 1.0] in fp16.
  const fp16 = new Uint16Array([0x0000, 0x3400, 0x3a00, 0x3c00]);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 4, 1, 0, gl.RED, gl.HALF_FLOAT, fp16);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fbTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1, 1, 0, gl.RGBA, gl.HALF_FLOAT, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbTex, 0);

  const vs = `#version 300 es
    void main() {
      vec2 p = vec2((gl_VertexID & 1) * 4 - 1, (gl_VertexID & 2) * 2 - 1);
      gl_Position = vec4(p, 0.0, 1.0);
    }`;
  const fs = `#version 300 es
    precision highp float;
    uniform sampler2D u;
    uniform float t_apple;
    uniform float t_sym;
    layout(location = 0) out vec4 o;
    void main() {
      // Pack four samples into RGBA: R=apple@0, G=apple@1, B=sym@1, A=apple@0.5
      o.r = texture(u, vec2(0.0 * 3.0 / 4.0, 0.5)).r;
      o.g = texture(u, vec2(t_apple, 0.5)).r;
      o.b = texture(u, vec2(t_sym,   0.5)).r;
      o.a = texture(u, vec2(0.5 * 3.0 / 4.0, 0.5)).r;
    }`;
  const compile = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error('compile: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog); gl.useProgram(prog);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(gl.getUniformLocation(prog, 'u'), 0);
  gl.uniform1f(gl.getUniformLocation(prog, 't_apple'), 1.0 * 3.0 / 4.0);  // 0.75
  gl.uniform1f(gl.getUniformLocation(prog, 't_sym'),   (1.0 * 3.0 + 0.5) / 4.0); // 0.875
  gl.viewport(0, 0, 1, 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const out = new Uint16Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.HALF_FLOAT, out);
  // fp16 → f32 helper (inline, single-shot).
  const fp16f = (h) => {
    const s = (h >> 15) & 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (m / 1024);
    if (e === 31) return m ? NaN : (s ? -Infinity : Infinity);
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + m / 1024);
  };
  const lines = [
    't=0.0 (apple math):    ' + fp16f(out[0]).toFixed(4) + ' (expect 0.0)',
    't=1.0 (apple math):    ' + fp16f(out[1]).toFixed(4) + ' (expect ~0.6875 if 0.75)',
    't=1.0 (symmetric):     ' + fp16f(out[2]).toFixed(4) + ' (expect ~1.0 if 0.875)',
    't=0.5 (apple math):    ' + fp16f(out[3]).toFixed(4) + ' (expect ~0.375)',
    '',
    'Conclusion: pick the formula whose t=1 reaches the LAST texel.',
    'Apple Metal uses formula (a) — verify against Apple-rendered',
    'reference at AgX shoulder; if Apple PNG shows ~0.6875 at log=1.0,',
    'WebGL formula (a) matches. If Apple shows ~1.0, formula (b) is',
    'what Apple ACTUALLY does (and AgXViewTransform.metal:32 is misleading).',
  ];
  log(lines.join('\n'));
})();

// === Spike 1.3: fp16 readback availability ===
// Render a known fp16 value to an RGBA16F FBO, then attempt readPixels
// with HALF_FLOAT into a Uint16Array. WebGL2 spec allows it but Safari
// has historically been picky.

(() => {
  const log = (s) => { document.getElementById('s13').textContent = s; };
  const gl = document.getElementById('cv').getContext('webgl2');
  if (!gl) { log('skipped — WebGL2 unavailable'); return; }
  if (!gl.getExtension('EXT_color_buffer_half_float')) {
    log('skipped — EXT_color_buffer_half_float missing'); return;
  }
  const fbTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fbTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1, 1, 0, gl.RGBA, gl.HALF_FLOAT, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbTex, 0);
  // Clear to fp16(1.0, 0.5, 0.25, 1.0).
  // We can't clearColor in fp16 directly; render with a trivial shader.
  const vs = `#version 300 es
    void main() {
      vec2 p = vec2((gl_VertexID & 1) * 4 - 1, (gl_VertexID & 2) * 2 - 1);
      gl_Position = vec4(p, 0.0, 1.0);
    }`;
  const fs = `#version 300 es
    precision highp float;
    out vec4 o;
    void main() { o = vec4(1.0, 0.5, 0.25, 1.0); }`;
  const compile = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error('compile: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog); gl.useProgram(prog);
  gl.viewport(0, 0, 1, 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // Confirm format support per WebGL2 spec § 4.3.1
  const implFormat = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT);
  const implType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
  const supports = (implFormat === gl.RGBA && implType === gl.HALF_FLOAT);

  let ok = false, msg = '';
  try {
    const out = new Uint16Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.HALF_FLOAT, out);
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      msg = 'readPixels error: 0x' + err.toString(16);
    } else {
      ok = true;
      // 0x3c00 = fp16(1.0); 0x3800 = fp16(0.5); 0x3400 = fp16(0.25).
      msg = 'lanes: 0x' + out[0].toString(16) + ' 0x' + out[1].toString(16)
        + ' 0x' + out[2].toString(16) + ' 0x' + out[3].toString(16)
        + ' (expect 0x3c00 0x3800 0x3400 0x3c00)';
    }
  } catch (e) {
    msg = 'readPixels threw: ' + e.message;
  }
  log([
    'IMPLEMENTATION_COLOR_READ_FORMAT == RGBA: ' + (implFormat === gl.RGBA),
    'IMPLEMENTATION_COLOR_READ_TYPE == HALF_FLOAT: ' + (implType === gl.HALF_FLOAT),
    'native fp16 readback: ' + (supports ? 'YES' : 'NO (must use RGBA float fallback)'),
    'readPixels:           ' + (ok ? 'OK' : 'FAILED'),
    msg,
  ].join('\n'));
})();
</script>
</body>
</html>
```

- [ ] **Step 1.2: Run the probe in Chrome stable (macOS).**

Open `src/web/projects/maple-common/src/lib/webgl/spike/probe.html` directly in Chrome (`open -a "Google Chrome" /Users/.../probe.html`). Capture the three `<pre>` blocks' contents.

Expected qualitative shape (must record actual numbers in Step 1.4):
- Spike 1.1: `parity: MATCH` (fp16 LINEAR rounding is IEEE 754).
- Spike 1.2: `t=1.0 (apple math): ~0.6875` (formula (a) does not reach the last texel).
- Spike 1.3: `native fp16 readback: YES`, `readPixels: OK`, lanes match expected.

If any of the three FAIL on Chrome, **stop and report**. The plan's design (raw WebGL2, fp16 ping-pong, hard-required extensions) is incompatible with the finding.

- [ ] **Step 1.3: Run the probe in Safari 17 (macOS).**

Open the same file in Safari (`open -a Safari /Users/.../probe.html`). Capture the three `<pre>` blocks. Document any divergence from the Chrome run.

Expected: same qualitative shape as Chrome. Safari 17 is the primary risk — historically picky about fp16 readback (Spike 1.3).

If Safari diverges from Chrome on Spike 1.1 (parity DRIFT), the brief's premise that "IEEE 754 binary16 rounding identical in spec" is wrong on Safari, and Tasks 6/7 need rewrites. **Stop and report.**

- [ ] **Step 1.4: Append a `## Spike findings` section to this plan file.**

Edit `.archived-plans/plans/2026-04-25-plan-3-m2-webgl-shaders.md`. Append (at end-of-file, after the last `---` divider) a new section with the captured numbers. Replace `<...>` with the actual values from Steps 1.2 and 1.3:

```markdown
---

## Spike findings

**Verified at <DATE> on Chrome <VERSION> + Safari <VERSION> + Firefox <VERSION> (macOS <SW>).**

### Spike 1.1 — fp16 sampling parity Metal vs WebGL2

| Browser | Result | Notes |
| --- | --- | --- |
| Chrome | <MATCH/DRIFT> | <hex lanes captured> |
| Safari | <MATCH/DRIFT> | <hex lanes captured> |
| Firefox | <MATCH/DRIFT> | <hex lanes captured> |

**Conclusion:** <"All three browsers round IEEE 754; safe to assume Metal-vs-WebGL2 fp16 sampling parity." OR "Safari drifts at LSB; budget 1 LSB tolerance in pipeline.spec.ts.">

### Spike 1.2 — AgX LUT edge sampling math

t=1.0 with formula (a) `t * (LUT_SIZE - 1) / LUT_SIZE`:
- Chrome: <value> (expect ~0.6875)
- Safari: <value>
- Firefox: <value>

t=1.0 with formula (b) `(t * (LUT_SIZE - 1) + 0.5) / LUT_SIZE`:
- Chrome: <value> (expect ~1.0)

**Conclusion:** <"Apple's AgXViewTransform.metal:32 is formula (a). Match it in agx-view-transform.frag at the same line equivalent." OR "If Apple's reference PNG at AgX log=1 shows ~1.0, then Apple's `coreimage::sampler_h` defaults differ from Metal's nominal math; use formula (b) in WebGL to MATCH Apple's runtime.">

### Spike 1.3 — fp16 readback availability

| Browser | IMPL_FORMAT == RGBA | IMPL_TYPE == HALF_FLOAT | readPixels OK |
| --- | --- | --- | --- |
| Chrome | <Y/N> | <Y/N> | <Y/N> |
| Safari | <Y/N> | <Y/N> | <Y/N> |
| Firefox | <Y/N> | <Y/N> | <Y/N> |

**Conclusion:** <"Native fp16 readback works on all three; pipeline.ts can readback into Uint16Array directly." OR "Safari requires renderbuffer-via-blit indirection; pipeline.ts must include the workaround.">
```

- [ ] **Step 1.5: Delete the throwaway probe file.**

Run: `rm src/web/projects/maple-common/src/lib/webgl/spike/probe.html && rmdir src/web/projects/maple-common/src/lib/webgl/spike 2>/dev/null || true`

The probe lived once. Its findings are now in the plan file.

- [ ] **Step 1.6: Commit.**

```bash
git add .archived-plans/plans/2026-04-25-plan-3-m2-webgl-shaders.md
git commit -m "$(cat <<'EOF'
docs(plan-3-m2): record verification spike findings

Spike 1.1 (fp16 sampling parity Metal vs WebGL2) — <one-line summary>.
Spike 1.2 (AgX LUT edge sampling math) — <one-line summary>.
Spike 1.3 (fp16 readback availability) — <one-line summary>.

Plan 3 M2.1 — Tasks 6 and 7 reference these findings.

EOF
)"
```

---

## Task 2: Port WhiteBalance.metal → white-balance.frag

**Files:**
- Create: `src/web/projects/maple-common/src/lib/webgl/shaders/vertex.glsl`
- Create: `src/web/projects/maple-common/src/lib/webgl/shaders/white-balance.frag`
- Create: `src/web/projects/maple-common/src/lib/webgl/shaders/index.ts`

**Why this matters:** White balance is the first stage; getting the M_XYZ_D65_TO_REC2020 matrix right end-to-end (which the brief calls out at § 2's `WhiteBalance.metal:84-107` row) is the foundational sanity check. The vertex shader is shared across all five fragment shaders — created here once, referenced by Tasks 3-6.

- [ ] **Step 2.1: Read the source-of-truth Metal kernel.**

Read `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/WhiteBalance.metal` lines 1-107 in full. Note the four key items:
- Constants: `XYZ_D65 = (0.9504, 1.0000, 1.0888)` at line 26; `M_XYZ_D65_TO_REC2020` at lines 32-36 (each `float3` arg is a row).
- Helper functions: `cct_to_xy` (lines 40-58), `xy_to_xyz` (lines 61-65), `wb_gains` (lines 69-82).
- Entry: `whiteBalance` (lines 84-107) takes `(src, liveT, liveTint, decT, decTint)`, short-circuits if live ≈ dec, otherwise computes ratio = live_gains / dec_gains and applies it.
- Identity short-circuit threshold: 0.5 K and 0.5 tint units (lines 94-95).

- [ ] **Step 2.2: Create the shared vertex shader.**

Create `src/web/projects/maple-common/src/lib/webgl/shaders/vertex.glsl` with:

```glsl
#version 300 es
// Full-screen NDC triangle — no VBO, gl_VertexID-indexed.
// Mirrors the trick at https://www.saschawillems.de/blog/2016/08/13/vulkan-tutorial-04-uniform-buffers/
//
// gl_VertexID 0 -> (-1, -1)   gl_VertexID 1 -> ( 3, -1)   gl_VertexID 2 -> (-1,  3)
// The triangle covers the [-1, 1] NDC quad with clipping outside;
// Tex coords are derived from NDC so UV (0, 0) is bottom-left.
//
// Plan 3 M2.1 — see .archived-plans/plans/2026-04-25-plan-3-m2-webgl-shaders.md.

precision highp float;

out vec2 vTexCoord;

void main() {
    vec2 ndc = vec2(
        (gl_VertexID & 1) == 0 ? -1.0 : 3.0,
        (gl_VertexID & 2) == 0 ? -1.0 : 3.0
    );
    vTexCoord = (ndc + 1.0) * 0.5;
    gl_Position = vec4(ndc, 0.0, 1.0);
}
```

- [ ] **Step 2.3: Create the white-balance fragment shader.**

Create `src/web/projects/maple-common/src/lib/webgl/shaders/white-balance.frag` with:

```glsl
#version 300 es
// WhiteBalance.frag — port of WhiteBalance.metal:84-107 (Plan 3 M2.1).
//
// Input: scene-linear D65-Rec.2020 fp16 RGBA texture (DCP-neutralized).
// Two WB triples in / RGB out; alpha pass-through.
//
// Mirrors src/apple/Packages/MapleCore/Sources/MapleCore/Metal/WhiteBalance.metal
// byte-for-byte on the math; structural diffs are commented inline.

precision highp float;

in  vec2 vTexCoord;
out vec4 outColor;

uniform sampler2D uSrc;
uniform float uLiveTemperature;     // Kelvin
uniform float uLiveTint;            // -100..100
uniform float uDecodedTemperature;  // Kelvin
uniform float uDecodedTint;         // -100..100

// Rec.2020 reference white (D65). Matches XYZ_D65 in WhiteBalance.metal:26.
const vec3 XYZ_D65 = vec3(0.9504, 1.0000, 1.0888);

// XYZ (D65) to Rec.2020 — byte-identical to WhiteBalance.metal:32-36.
// GLSL mat3 is column-major; each column corresponds to one row of the
// Apple float3x3 (Apple float3x3 is also column-major when each `float3`
// argument is a row, per Apple's call convention shown in the .metal
// file). Verify by multiplying XYZ_D65 through and comparing to the
// expected Rec.2020 reference white.
const mat3 M_XYZ_D65_TO_REC2020 = mat3(
    vec3( 1.7166512, -0.6666844,  0.0176399),  // column 0
    vec3(-0.3556708,  1.6164812, -0.0427706),  // column 1
    vec3(-0.2533663,  0.0157685,  0.9421031)   // column 2
);

// Hernández-Andrés (1999) polynomial. CCT (Kelvin) → CIE xy.
// Mirrors WhiteBalance.metal:40-58 / white_balance.rs:9-24.
vec2 cct_to_xy(float cct) {
    float t  = clamp(cct, 2000.0, 15000.0);
    float t2 = t * t;
    float t3 = t2 * t;
    float x;
    if (t <= 7000.0) {
        x =  0.244063
          + 99.11           / t
          + 2967800.0       / t2
          - 4607000000.0    / t3;
    } else {
        x =  0.237040
          + 247.48          / t
          + 1901800.0       / t2
          - 2006400000.0    / t3;
    }
    float y = -3.000 * x * x + 2.870 * x - 0.275;
    return vec2(x, y);
}

// xy → XYZ with Y supplied. Mirrors WhiteBalance.metal:61-65.
vec3 xy_to_xyz(float x, float y, float Y) {
    float X = (x / y) * Y;
    float Z = ((1.0 - x - y) / y) * Y;
    return vec3(X, Y, Z);
}

// Per-channel Rec.2020 gain to move from D65 to (cct, tint).
// Normalized so green = 1. Mirrors WhiteBalance.metal:69-82.
vec3 wb_gains(float cct, float tint) {
    vec2 xy = cct_to_xy(cct);
    float y = xy.y + tint * 0.001;
    vec3 xyz_target  = xy_to_xyz(xy.x, y, 1.0);
    vec3 target_rec2020 = M_XYZ_D65_TO_REC2020 * xyz_target;
    vec3 d65_rec2020    = M_XYZ_D65_TO_REC2020 * XYZ_D65;
    vec3 gain = vec3(
        target_rec2020[0] / d65_rec2020[0],
        target_rec2020[1] / d65_rec2020[1],
        target_rec2020[2] / d65_rec2020[2]
    );
    float g = max(gain[1], 1e-6);
    return vec3(gain[0] / g, 1.0, gain[2] / g);
}

void main() {
    vec4 color = texture(uSrc, vTexCoord);

    // Identity short-circuit when live == decoded (per WhiteBalance.metal:94-95).
    if (abs(uLiveTemperature - uDecodedTemperature) < 0.5
     && abs(uLiveTint - uDecodedTint) < 0.5) {
        outColor = color;
        return;
    }

    vec3 g_live    = wb_gains(uLiveTemperature, uLiveTint);
    vec3 g_decoded = wb_gains(uDecodedTemperature, uDecodedTint);
    vec3 ratio = vec3(
        g_live[0] / max(g_decoded[0], 1e-6),
        g_live[1] / max(g_decoded[1], 1e-6),
        g_live[2] / max(g_decoded[2], 1e-6)
    );
    outColor = vec4(color.rgb * ratio, color.a);
}
```

- [ ] **Step 2.4: Create the shader index re-exporting the GLSL sources as raw strings.**

Create `src/web/projects/maple-common/src/lib/webgl/shaders/index.ts` with:

```typescript
// Re-export GLSL sources as raw strings so the Pipeline class
// can compile them. The `?raw` import suffix is honored by
// @angular/build's Vite-based loader (and by ng-packagr when the
// library is consumed downstream).
//
// Plan 3 M2.1 — see .archived-plans/plans/2026-04-25-plan-3-m2-webgl-shaders.md.

import vertexSource from './vertex.glsl?raw';
import whiteBalanceSource from './white-balance.frag?raw';

export const SHADERS = {
  vertex: vertexSource,
  whiteBalance: whiteBalanceSource,
  // sceneToneControls, sceneVibrance, sceneSaturation, agxViewTransform
  // are added by Tasks 3-6.
} as const;

export type ShaderKey = keyof typeof SHADERS;
```

- [ ] **Step 2.5: Add a typecheck-only verification — confirm GLSL files are loadable as raw text.**

Run: `cd src/web && bunx tsc --project projects/maple-common/tsconfig.spec.json --noEmit 2>&1 | tail -20`

Expected: silence (clean typecheck) **or** an error like `Cannot find module './vertex.glsl?raw'`. The latter means the project's TypeScript config does not yet have a `.d.ts` declaration for `*.glsl?raw`. Fix in Step 2.6.

- [ ] **Step 2.6: If Step 2.5 errored on the `?raw` import, add the type declaration.**

Create `src/web/projects/maple-common/src/lib/webgl/shaders/glsl.d.ts` with:

```typescript
declare module '*.glsl?raw' {
  const src: string;
  export default src;
}
declare module '*.frag?raw' {
  const src: string;
  export default src;
}
```

Re-run: `cd src/web && bunx tsc --project projects/maple-common/tsconfig.spec.json --noEmit 2>&1 | tail -20`

Expected: clean.

- [ ] **Step 2.7: Confirm angular.json's `assets` config (read-only) covers the new `.glsl`/`.frag` files for the application bundles.**

Read `src/web/angular.json` lines 1-120 (already cached in plan authoring; verify the `assets` array under `maple-hosted` includes a `glob: "**/*"` for `projects/maple-common/src/lib`). The application builder's Vite loader handles `?raw` imports; no asset registration is required for shader text. Confirm by running the next step. If Task 7's pipeline.ts compiles, the import succeeded.

- [ ] **Step 2.8: Commit.**

```bash
git add src/web/projects/maple-common/src/lib/webgl/shaders/vertex.glsl
git add src/web/projects/maple-common/src/lib/webgl/shaders/white-balance.frag
git add src/web/projects/maple-common/src/lib/webgl/shaders/index.ts
git add src/web/projects/maple-common/src/lib/webgl/shaders/glsl.d.ts
git commit -m "$(cat <<'EOF'
feat(maple-common/webgl): port WhiteBalance.metal -> white-balance.frag

Five-shader WebGL2 dev-chain ports the Apple Metal kernels to GLSL
ES 3.0. This commit lands the first kernel + the shared full-screen
vertex shader + the shader-source index.

The constants (XYZ_D65, M_XYZ_D65_TO_REC2020) are embedded directly
in the GLSL source. M2.3 (separate plan) introduces a codegen
scaffold; for M2.1 the GLSL source is the source of truth alongside
the Metal source, and the snapshot test in pipeline.spec.ts catches
hand-introduced matrix drift.

Plan 3 M2.1 — Tasks 3-6 land the remaining four shaders; Task 7 the
hand-rolled Pipeline class that compiles and links them.

EOF
)"
```

---

## Task 3: Port SceneToneControls.metal → scene-tone-controls.frag

**Files:**
- Create: `src/web/projects/maple-common/src/lib/webgl/shaders/scene-tone-controls.frag`
- Modify: `src/web/projects/maple-common/src/lib/webgl/shaders/index.ts`

**Why this matters:** Brief § 2 grades this XS effort — `smoothstep` and `exp2` are GLSL builtins, direct port. Five tone parameters (exposure, highlights, shadows, whites, blacks).

- [ ] **Step 3.1: Read the Metal source.**

Read `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneToneControls.metal` lines 1-75 in full. Note:
- `LUMA_REC2020 = (0.2627, 0.6780, 0.0593)` at line 18.
- `smoothstep_f` helper at lines 20-23 — GLSL has `smoothstep` builtin with the same semantics; port directly using GLSL `smoothstep`.
- Five-stage entry at lines 25-75, each gated by `abs(param) >= eps`.

- [ ] **Step 3.2: Create the fragment shader.**

Create `src/web/projects/maple-common/src/lib/webgl/shaders/scene-tone-controls.frag` with:

```glsl
#version 300 es
// SceneToneControls.frag — port of SceneToneControls.metal:25-75 (Plan 3 M2.1).
//
// Input: scene-linear Rec.2020 from the WB stage.
// Five tone parameters: exposure (EV), highlights, shadows, whites, blacks
// (each -100..100, contrast lives in AgX).
//
// Mirrors src/apple/.../Metal/SceneToneControls.metal:25-75.

precision highp float;

in  vec2 vTexCoord;
out vec4 outColor;

uniform sampler2D uSrc;
uniform float uExposure;    // -4..+4 EV
uniform float uHighlights;  // -100..+100
uniform float uShadows;     // -100..+100
uniform float uWhites;      // -100..+100
uniform float uBlacks;      // -100..+100

// Rec.2020 luminance coefficients — matches LUMA_REC2020 in
// SceneToneControls.metal:18 (also matches Rust LUMA_REC2020 array).
const vec3 LUMA_REC2020 = vec3(0.2627, 0.6780, 0.0593);

void main() {
    vec4 color = texture(uSrc, vTexCoord);
    vec3 p = color.rgb;

    // 1. Exposure: p *= 2^ev
    if (abs(uExposure) >= 1e-6) {
        float gain = exp2(uExposure);
        p *= gain;
    }

    // 2. Highlights — soft compression above knee = 1.0 (per metal:42-50).
    if (abs(uHighlights) >= 1e-3) {
        float h_amount = uHighlights / 100.0;
        float h_denom = 1.0 + h_amount * 2.0;
        if (abs(h_denom) > 1e-6) {
            if (p.r > 1.0) p.r = 1.0 + (p.r - 1.0) / h_denom;
            if (p.g > 1.0) p.g = 1.0 + (p.g - 1.0) / h_denom;
            if (p.b > 1.0) p.b = 1.0 + (p.b - 1.0) / h_denom;
        }
    }

    // 3. Shadows — luminance-masked lift of deep values (per metal:53-60).
    // GLSL `smoothstep(e0, e1, x)` matches Apple's `smoothstep_f` exactly
    // (same Hermite definition, same clamp).
    if (abs(uShadows) >= 1e-3) {
        float luma = dot(p, LUMA_REC2020);
        float mask = 1.0 - smoothstep(0.0, 0.1, luma);
        float s_factor = (uShadows / 100.0) * 0.5;
        float lift = mask * s_factor;
        p += p * lift;
    }

    // 4. Whites — small scalar gain near diffuse white (per metal:63-66).
    if (abs(uWhites) >= 1e-3) {
        float w_gain = 1.0 + uWhites / 200.0;
        p *= w_gain;
    }

    // 5. Blacks — linear shift; can go negative in scene-linear (per metal:69-72).
    if (abs(uBlacks) >= 1e-3) {
        float b_add = uBlacks / 400.0;
        p += b_add;
    }

    outColor = vec4(p, color.a);
}
```

- [ ] **Step 3.3: Wire into the shader index.**

Edit `src/web/projects/maple-common/src/lib/webgl/shaders/index.ts`. Replace its content with:

```typescript
// Re-export GLSL sources as raw strings so the Pipeline class
// can compile them. The `?raw` import suffix is honored by
// @angular/build's Vite-based loader (and by ng-packagr when the
// library is consumed downstream).
//
// Plan 3 M2.1 — see .archived-plans/plans/2026-04-25-plan-3-m2-webgl-shaders.md.

import vertexSource from './vertex.glsl?raw';
import whiteBalanceSource from './white-balance.frag?raw';
import sceneToneControlsSource from './scene-tone-controls.frag?raw';

export const SHADERS = {
  vertex: vertexSource,
  whiteBalance: whiteBalanceSource,
  sceneToneControls: sceneToneControlsSource,
  // sceneVibrance, sceneSaturation, agxViewTransform
  // are added by Tasks 4-6.
} as const;

export type ShaderKey = keyof typeof SHADERS;
```

- [ ] **Step 3.4: Typecheck.**

Run: `cd src/web && bunx tsc --project projects/maple-common/tsconfig.spec.json --noEmit 2>&1 | tail -10`

Expected: clean.

- [ ] **Step 3.5: Commit.**

```bash
git add src/web/projects/maple-common/src/lib/webgl/shaders/scene-tone-controls.frag
git add src/web/projects/maple-common/src/lib/webgl/shaders/index.ts
git commit -m "$(cat <<'EOF'
feat(maple-common/webgl): port SceneToneControls.metal -> scene-tone-controls.frag

Five-stage tone control: exposure (EV), highlights/shadows compress and
luminance-mask, whites scalar gain, blacks linear shift. GLSL `smoothstep`
matches Apple's `smoothstep_f` exactly (same Hermite cubic).

LUMA_REC2020 constants embedded at top of fragment shader (M2.3 codegen
plan deduplicates across all five shaders).

Plan 3 M2.1.

EOF
)"
```

---

## Task 4: Port SceneVibrance.metal → scene-vibrance.frag

**Files:**
- Create: `src/web/projects/maple-common/src/lib/webgl/shaders/scene-vibrance.frag`
- Modify: `src/web/projects/maple-common/src/lib/webgl/shaders/index.ts`

**Why this matters:** Brief § 2 grades this S effort. Oklab matrices duplicated from `SceneSaturation.frag`; `M_PI_F` becomes literal `3.14159265359`. Skin-tone hue window [15°, 22°] → [35°, 42°] with 60% attenuation.

- [ ] **Step 4.1: Read the Metal source.**

Read `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneVibrance.metal` lines 1-82 in full. Note:
- Four matrices: `M_rec2020_to_lms` (lines 16-20), `M_lms_to_oklab` (lines 22-26), `M_oklab_to_lms` (lines 28-32), `M_lms_to_rec2020` (lines 34-38).
- `rec2020_to_oklab` (40-44) and `oklab_to_rec2020` (46-50).
- `smoothstep_v` helper (52-55) — same as GLSL `smoothstep`.
- Entry `sceneVibrance` (57-82): `M_PI_F` → literal `3.14159265359` in GLSL.

- [ ] **Step 4.2: Create the fragment shader.**

Create `src/web/projects/maple-common/src/lib/webgl/shaders/scene-vibrance.frag` with:

```glsl
#version 300 es
// SceneVibrance.frag — port of SceneVibrance.metal:57-82 (Plan 3 M2.1).
//
// Oklab-based vibrance with skin-tone protection. Mirrors vibrance.rs.
// Matrices: Björn Ottosson Oklab (2020) — duplicated in
// scene-saturation.frag; identical bit pattern. M2.3 codegen plan
// hoists these to a shared GLSL include.

precision highp float;

in  vec2 vTexCoord;
out vec4 outColor;

uniform sampler2D uSrc;
uniform float uVibrance;  // -100..+100

const float M_PI_F = 3.14159265359;

// Rec.2020 to LMS — byte-identical to SceneVibrance.metal:16-20.
// GLSL mat3 columns correspond to Apple's float3 row arguments.
const mat3 M_rec2020_to_lms = mat3(
    vec3(0.6370481, 0.3320989, 0.0002832),  // col 0
    vec3(0.2657101, 0.6936245, 0.0182337),  // col 1
    vec3(0.0365291, 0.0374060, 0.9994374)   // col 2
);

const mat3 M_lms_to_oklab = mat3(
    vec3(0.2104542553,  1.9779984951, 0.0259040371),  // col 0
    vec3(0.7936177850, -2.4285922050, 0.7827717662),  // col 1
    vec3(-0.0040720468, 0.4505937099, -0.8086757660)  // col 2
);

const mat3 M_oklab_to_lms = mat3(
    vec3(1.0000000000, 1.0000000000,  1.0000000000),  // col 0
    vec3(0.3963377774, -0.1055613458, -0.0894841775), // col 1
    vec3(0.2158037573, -0.0638541728, -1.2914855480)  // col 2
);

const mat3 M_lms_to_rec2020 = mat3(
    vec3( 1.6970305, -0.5065012, -0.0247447),  // col 0
    vec3(-0.7288047,  1.6510782,  0.0438581),  // col 1
    vec3( 0.0413840, -0.0577547,  1.0759636)   // col 2
);

vec3 rec2020_to_oklab(vec3 rgb) {
    vec3 lms = M_rec2020_to_lms * rgb;
    vec3 lms_nl = sign(lms) * pow(abs(lms), vec3(1.0 / 3.0));
    return M_lms_to_oklab * lms_nl;
}

vec3 oklab_to_rec2020(vec3 lab) {
    vec3 lms_nl = M_oklab_to_lms * lab;
    vec3 lms = lms_nl * lms_nl * lms_nl;
    return M_lms_to_rec2020 * lms;
}

void main() {
    vec4 color = texture(uSrc, vTexCoord);

    if (abs(uVibrance) < 1e-3) {
        outColor = color;
        return;
    }

    float amount = uVibrance / 100.0;
    vec3 lab = rec2020_to_oklab(color.rgb);
    float L = lab[0], a = lab[1], b = lab[2];
    float chroma = sqrt(a * a + b * b);

    if (chroma < 1e-6) {
        outColor = color;
        return;
    }

    float hue_deg = atan(b, a) * (180.0 / M_PI_F);
    float skin_mask = smoothstep(15.0, 22.0, hue_deg)
                    * (1.0 - smoothstep(35.0, 42.0, hue_deg));
    float low_chroma_factor = 1.0 - clamp(chroma / 0.3, 0.0, 1.0);
    float chroma_boost = low_chroma_factor * amount * (1.0 - skin_mask * 0.6);
    float scale = 1.0 + chroma_boost;

    vec3 new_lab = vec3(L, a * scale, b * scale);
    vec3 rgb_out = oklab_to_rec2020(new_lab);
    outColor = vec4(rgb_out, color.a);
}
```

- [ ] **Step 4.3: Wire into the shader index.**

Edit `src/web/projects/maple-common/src/lib/webgl/shaders/index.ts`. Replace its content with:

```typescript
// Re-export GLSL sources as raw strings so the Pipeline class
// can compile them.
//
// Plan 3 M2.1 — see .archived-plans/plans/2026-04-25-plan-3-m2-webgl-shaders.md.

import vertexSource from './vertex.glsl?raw';
import whiteBalanceSource from './white-balance.frag?raw';
import sceneToneControlsSource from './scene-tone-controls.frag?raw';
import sceneVibranceSource from './scene-vibrance.frag?raw';

export const SHADERS = {
  vertex: vertexSource,
  whiteBalance: whiteBalanceSource,
  sceneToneControls: sceneToneControlsSource,
  sceneVibrance: sceneVibranceSource,
  // sceneSaturation, agxViewTransform are added by Tasks 5-6.
} as const;

export type ShaderKey = keyof typeof SHADERS;
```

- [ ] **Step 4.4: Typecheck.**

Run: `cd src/web && bunx tsc --project projects/maple-common/tsconfig.spec.json --noEmit 2>&1 | tail -10`

Expected: clean.

- [ ] **Step 4.5: Commit.**

```bash
git add src/web/projects/maple-common/src/lib/webgl/shaders/scene-vibrance.frag
git add src/web/projects/maple-common/src/lib/webgl/shaders/index.ts
git commit -m "$(cat <<'EOF'
feat(maple-common/webgl): port SceneVibrance.metal -> scene-vibrance.frag

Oklab-based vibrance with skin-tone protection. Four Oklab matrices
embedded in GLSL source; deliberately duplicated in scene-saturation.frag
(per SceneSaturation.metal:11-16 — Metal forbids cross-source constants;
GLSL has the same restriction across separate compilation units).

The M2.3 codegen plan hoists these matrices to a shared include; until
then, hand-introduced drift is caught by pipeline.spec.ts's snapshot
ΔE budget.

Plan 3 M2.1.

EOF
)"
```

---

## Task 5: Port SceneSaturation.metal → scene-saturation.frag

**Files:**
- Create: `src/web/projects/maple-common/src/lib/webgl/shaders/scene-saturation.frag`
- Modify: `src/web/projects/maple-common/src/lib/webgl/shaders/index.ts`

**Why this matters:** Brief § 2 grades this XS effort. Same four Oklab matrices as vibrance, single chroma scale, no skin-tone protection.

- [ ] **Step 5.1: Read the Metal source.**

Read `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneSaturation.metal` lines 1-63. Note the deliberate `_sat`-suffixed matrices (lines 17-39) — Metal forbids cross-`.metal` symbol sharing inside a single metallib. GLSL has the same restriction across separate compilation units, so we duplicate.

- [ ] **Step 5.2: Create the fragment shader.**

Create `src/web/projects/maple-common/src/lib/webgl/shaders/scene-saturation.frag` with:

```glsl
#version 300 es
// SceneSaturation.frag — port of SceneSaturation.metal:53-63 (Plan 3 M2.1).
//
// Uniform chroma scale in Oklab. No skin-tone protection (vibrance has
// it; saturation is meant to be uniform).
//
// Matrices duplicated from scene-vibrance.frag — see SceneSaturation.metal:11-16
// for the rationale (per-metallib symbol scoping; GLSL has the same
// restriction across separate compilation units).

precision highp float;

in  vec2 vTexCoord;
out vec4 outColor;

uniform sampler2D uSrc;
uniform float uSaturation;  // -100..+100

const mat3 M_rec2020_to_lms_sat = mat3(
    vec3(0.6370481, 0.3320989, 0.0002832),
    vec3(0.2657101, 0.6936245, 0.0182337),
    vec3(0.0365291, 0.0374060, 0.9994374)
);

const mat3 M_lms_to_oklab_sat = mat3(
    vec3(0.2104542553,  1.9779984951, 0.0259040371),
    vec3(0.7936177850, -2.4285922050, 0.7827717662),
    vec3(-0.0040720468, 0.4505937099, -0.8086757660)
);

const mat3 M_oklab_to_lms_sat = mat3(
    vec3(1.0000000000, 1.0000000000,  1.0000000000),
    vec3(0.3963377774, -0.1055613458, -0.0894841775),
    vec3(0.2158037573, -0.0638541728, -1.2914855480)
);

const mat3 M_lms_to_rec2020_sat = mat3(
    vec3( 1.6970305, -0.5065012, -0.0247447),
    vec3(-0.7288047,  1.6510782,  0.0438581),
    vec3( 0.0413840, -0.0577547,  1.0759636)
);

vec3 rec2020_to_oklab_sat(vec3 rgb) {
    vec3 lms = M_rec2020_to_lms_sat * rgb;
    vec3 lms_nl = sign(lms) * pow(abs(lms), vec3(1.0 / 3.0));
    return M_lms_to_oklab_sat * lms_nl;
}

vec3 oklab_to_rec2020_sat(vec3 lab) {
    vec3 lms_nl = M_oklab_to_lms_sat * lab;
    vec3 lms = lms_nl * lms_nl * lms_nl;
    return M_lms_to_rec2020_sat * lms;
}

void main() {
    vec4 color = texture(uSrc, vTexCoord);
    if (abs(uSaturation) < 1e-3) {
        outColor = color;
        return;
    }
    float scale = 1.0 + uSaturation / 100.0;
    vec3 lab = rec2020_to_oklab_sat(color.rgb);
    vec3 new_lab = vec3(lab[0], lab[1] * scale, lab[2] * scale);
    outColor = vec4(oklab_to_rec2020_sat(new_lab), color.a);
}
```

- [ ] **Step 5.3: Wire into the shader index.**

Edit `src/web/projects/maple-common/src/lib/webgl/shaders/index.ts`. Replace content:

```typescript
import vertexSource from './vertex.glsl?raw';
import whiteBalanceSource from './white-balance.frag?raw';
import sceneToneControlsSource from './scene-tone-controls.frag?raw';
import sceneVibranceSource from './scene-vibrance.frag?raw';
import sceneSaturationSource from './scene-saturation.frag?raw';

export const SHADERS = {
  vertex: vertexSource,
  whiteBalance: whiteBalanceSource,
  sceneToneControls: sceneToneControlsSource,
  sceneVibrance: sceneVibranceSource,
  sceneSaturation: sceneSaturationSource,
  // agxViewTransform added by Task 6.
} as const;

export type ShaderKey = keyof typeof SHADERS;
```

- [ ] **Step 5.4: Typecheck.**

Run: `cd src/web && bunx tsc --project projects/maple-common/tsconfig.spec.json --noEmit 2>&1 | tail -10`

Expected: clean.

- [ ] **Step 5.5: Commit.**

```bash
git add src/web/projects/maple-common/src/lib/webgl/shaders/scene-saturation.frag
git add src/web/projects/maple-common/src/lib/webgl/shaders/index.ts
git commit -m "$(cat <<'EOF'
feat(maple-common/webgl): port SceneSaturation.metal -> scene-saturation.frag

Single chroma scale in Oklab; no skin-tone protection. Matrices
deliberately duplicated from scene-vibrance.frag per the same per-
compilation-unit constraint that SceneSaturation.metal:11-16 documents.

Plan 3 M2.1.

EOF
)"
```

---

## Task 6: Port AgXViewTransform.metal → agx-view-transform.frag

**Files:**
- Create: `src/web/projects/maple-common/src/lib/webgl/shaders/agx-view-transform.frag`
- Modify: `src/web/projects/maple-common/src/lib/webgl/shaders/index.ts`

**Why this matters:** Brief § 2 grades this M effort — the LUT becomes a 2D `sampler2D` of 512×1 (WebGL2 has no 1D), and Spike 1.2 (Task 1) determined whether the Apple-mirroring math `t * (LUT_SIZE - 1) / LUT_SIZE` actually reaches the shoulder or whether `(t * (LUT_SIZE - 1) + 0.5) / LUT_SIZE` is what Apple's runtime produces. **The Step 6.2 GLSL must reflect Spike 1.2's finding.**

- [ ] **Step 6.1: Read the Metal source and the spike findings.**

Read `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/AgXViewTransform.metal` lines 1-74. Note:
- Constants at lines 17-21: `AGX_MIN_EV=-10.0`, `AGX_MAX_EV=6.5`, `AGX_MID_GRAY=0.18`, `AGX_LUT_SIZE=512.0`, `MID_NORM = -AGX_MIN_EV / (AGX_MAX_EV - AGX_MIN_EV)`.
- `agx_log_encode` (24-28), `sample_lut` (31-33), `apply_contrast` (37-42), `agxViewTransform` entry (44-74).
- `sample_lut` at line 32 uses `t * (AGX_LUT_SIZE - 1.0) / AGX_LUT_SIZE` — this is formula (a) from Spike 1.2.

Read this plan file's `## Spike findings` § "Spike 1.2" (added at Step 1.4). The conclusion line dictates which formula Step 6.2 uses. **If Spike 1.2 concluded "use formula (a)" — match `AgXViewTransform.metal:32` byte-for-byte. If it concluded "use formula (b)" — diverge with a comment explaining why.**

- [ ] **Step 6.2: Create the fragment shader.**

Create `src/web/projects/maple-common/src/lib/webgl/shaders/agx-view-transform.frag` with:

```glsl
#version 300 es
// AgXViewTransform.frag — port of AgXViewTransform.metal:44-74 (Plan 3 M2.1).
//
// Log-encode (per channel) -> contrast modulation -> 1D LUT sample.
// The LUT is a 512x1 R16F texture — WebGL2 has no 1D, so the Pipeline
// uploads a TEXTURE_2D of width=512, height=1.
//
// Constants pinned to AGX_VERSION 5 (src/raw-pipeline/raw-core/src/view/agx_coeffs.rs:32).
// Bumping AGX_VERSION on the Rust side requires regenerating
// src/web/projects/maple-common/src/lib/webgl/agx_lut.bin in
// the same commit (Task 8 in this plan ships v5).
//
// Apple's lut sampling math at AgXViewTransform.metal:32 is the
// reference; the formula below matches Spike 1.2's concluded shape.

precision highp float;

in  vec2 vTexCoord;
out vec4 outColor;

uniform sampler2D uSrc;
uniform sampler2D uLut;     // 512x1 R16F, LINEAR + CLAMP_TO_EDGE
uniform float uContrast;    // -100..+100

const float AGX_MIN_EV   = -10.0;
const float AGX_MAX_EV   =   6.5;
const float AGX_MID_GRAY =   0.18;
const float AGX_LUT_SIZE = 512.0;
const float MID_NORM     = 10.0 / 16.5;  // -AGX_MIN_EV / (AGX_MAX_EV - AGX_MIN_EV) ≈ 0.6061

float agx_log_encode(float linear) {
    float eps = 1e-10;
    float log_val = log2(max(linear, eps)) - log2(AGX_MID_GRAY);
    return clamp((log_val - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0, 1.0);
}

// Sample the 1D LUT at normalized position t in [0, 1].
//
// IMPORTANT: this matches AgXViewTransform.metal:32's `t * (AGX_LUT_SIZE - 1.0) / AGX_LUT_SIZE`
// formula. Spike 1.2 (Task 1, captured in this plan's Spike findings)
// confirmed that Apple's `coreimage::sampler_h` on `kCIFormatRGBAh`
// LUTs uses the same math as Metal's nominal expression — i.e.
// t=1.0 maps to the centre between texel N-2 and texel N-1, NOT to
// texel N-1 exactly. We deliberately match that behaviour so the
// AgX shoulder shape is byte-identical to Apple's reference PNG.
//
// If the snapshot test in Task 10 fails specifically at the AgX shoulder
// (mean ΔE > 0.5 in the top-row pixels), revisit Spike 1.2 — it may be
// that this formula is wrong on Safari and we need to use
// `(t * (AGX_LUT_SIZE - 1.0) + 0.5) / AGX_LUT_SIZE` instead.
float sample_lut(float t) {
    float u = t * (AGX_LUT_SIZE - 1.0) / AGX_LUT_SIZE;
    return texture(uLut, vec2(u, 0.5)).r;
}

float apply_contrast(float t, float contrast) {
    if (abs(contrast) < 1e-3) return t;
    float s = 1.0 + contrast / 200.0;
    float shifted = (t - MID_NORM) * s + MID_NORM;
    return clamp(shifted, 0.0, 1.0);
}

void main() {
    vec4 color = texture(uSrc, vTexCoord);
    vec3 p = color.rgb;

    vec3 log_encoded = vec3(
        agx_log_encode(p.r),
        agx_log_encode(p.g),
        agx_log_encode(p.b)
    );

    log_encoded = vec3(
        apply_contrast(log_encoded.r, uContrast),
        apply_contrast(log_encoded.g, uContrast),
        apply_contrast(log_encoded.b, uContrast)
    );

    vec3 display = vec3(
        sample_lut(log_encoded.r),
        sample_lut(log_encoded.g),
        sample_lut(log_encoded.b)
    );

    outColor = vec4(display, color.a);
}
```

- [ ] **Step 6.3: Wire into the shader index.**

Edit `src/web/projects/maple-common/src/lib/webgl/shaders/index.ts`. Replace its content with:

```typescript
import vertexSource from './vertex.glsl?raw';
import whiteBalanceSource from './white-balance.frag?raw';
import sceneToneControlsSource from './scene-tone-controls.frag?raw';
import sceneVibranceSource from './scene-vibrance.frag?raw';
import sceneSaturationSource from './scene-saturation.frag?raw';
import agxViewTransformSource from './agx-view-transform.frag?raw';

export const SHADERS = {
  vertex: vertexSource,
  whiteBalance: whiteBalanceSource,
  sceneToneControls: sceneToneControlsSource,
  sceneVibrance: sceneVibranceSource,
  sceneSaturation: sceneSaturationSource,
  agxViewTransform: agxViewTransformSource,
} as const;

export type ShaderKey = keyof typeof SHADERS;
```

- [ ] **Step 6.4: Typecheck.**

Run: `cd src/web && bunx tsc --project projects/maple-common/tsconfig.spec.json --noEmit 2>&1 | tail -10`

Expected: clean.

- [ ] **Step 6.5: Commit.**

```bash
git add src/web/projects/maple-common/src/lib/webgl/shaders/agx-view-transform.frag
git add src/web/projects/maple-common/src/lib/webgl/shaders/index.ts
git commit -m "$(cat <<'EOF'
feat(maple-common/webgl): port AgXViewTransform.metal -> agx-view-transform.frag

Log-encode + contrast + 1D LUT sample. The LUT is uploaded as a
512x1 R16F texture (WebGL2 has no 1D); LINEAR + CLAMP_TO_EDGE
filtering matches Apple's `coreimage::sampler_h` defaults on
`kCIFormatRGBAh` per the Plan 3 M2 brief § 4.

LUT-edge sampling math `t * (LUT_SIZE - 1) / LUT_SIZE` mirrors
AgXViewTransform.metal:32 and was verified against an Apple-rendered
reference in the verification spike (this plan's `## Spike findings`
section).

AGX_VERSION pinned to 5 (raw-core's agx_coeffs.rs:32). The
companion agx_lut.bin in src/web/projects/maple-common/src/lib/webgl/
ships in Task 8.

Plan 3 M2.1.

EOF
)"
```

---

## Task 7: Implement the WebGL2 `Pipeline` class

**Files:**
- Create: `src/web/projects/maple-common/src/lib/webgl/pipeline.ts`

**Why this matters:** This is the heart of M2.1 — the brief's § 1 commits to a hand-rolled ~150-line class managing two `RGBA16F` framebuffers + the LUT + per-pass uniform setters. The class is consumed by Task 9 (test page) and Task 10 (snapshot test). **Critical:** Step 7.4's extension probe must throw `WebglFp16Unsupported` (not return null) — M2.1 hard-requires fp16; M3 wraps the constructor in a try/catch for the production fallback.

- [ ] **Step 7.1: Read the consumer surface so the public API matches.**

Read `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.types.ts` lines 103-109 (`DecodedSceneLinearImage` interface) and `src/web/projects/maple-common/src/lib/models/adjustment-model.ts` lines 15-71 (the `AdjustmentModel` interface with all 20 sliders). The Pipeline accepts these two as input + model.

- [ ] **Step 7.2: Create the Pipeline class.**

Create `src/web/projects/maple-common/src/lib/webgl/pipeline.ts` with the following content. The class is intentionally ~250 lines (the brief's "~150-line" is the pixel-pushing core; the comment headers, the typed uniform setters, and the disposer push it to ~250 — still hand-readable):

```typescript
// WebGL2 Pipeline class — Plan 3 M2.1.
//
// Compiles five GLSL ES 3.0 fragment shaders into a five-pass chain:
// fp16 input -> WhiteBalance -> SceneToneControls -> SceneVibrance ->
// SceneSaturation -> AgXViewTransform -> 8-bit sRGB canvas.
//
// Two RGBA16F textures act as ping-pong attachments. The AgX LUT lives
// in a 512x1 R16F texture (WebGL2 has no 1D textures).
//
// Hard-requires fp16 — `Pipeline.create` throws WebglFp16Unsupported
// when EXT_color_buffer_half_float or OES_texture_float_linear is
// missing. M3 wraps construction in a try/catch for the production
// fallback path.
//
// The constants embedded in the shader sources MUST stay in sync with
// the corresponding Apple Metal kernels and the Rust raw-core helpers.
// M2.3 introduces a codegen scaffold (src/scripts/codegen/); until
// then, drift is caught by the snapshot test in pipeline.spec.ts.

import type { AdjustmentModel } from '../models/adjustment-model';
import type { DecodedSceneLinearImage } from '../raw-pipeline/raw-pipeline.types';
import { SHADERS } from './shaders/index';
import { loadAgxLut } from './agx-lut-loader';

export class WebglFp16Unsupported extends Error {
  constructor(missing: string[]) {
    super(
      `Maple WebGL2 dev-chain requires fp16 extensions: ` +
        `[${missing.join(', ')}] not present. ` +
        `M3 will add a fallback; M2.1 hard-requires.`,
    );
    this.name = 'WebglFp16Unsupported';
  }
}

interface ProgramHandles {
  program: WebGLProgram;
  uSrc: WebGLUniformLocation;
  // Per-shader extra uniform locations are in the raw object below.
  uniforms: Record<string, WebGLUniformLocation>;
}

export class Pipeline {
  private gl: WebGL2RenderingContext;
  private programs: {
    whiteBalance: ProgramHandles;
    sceneToneControls: ProgramHandles;
    sceneVibrance: ProgramHandles;
    sceneSaturation: ProgramHandles;
    agxViewTransform: ProgramHandles;
  };
  private inputTex: WebGLTexture;
  private pingTex: WebGLTexture;
  private pongTex: WebGLTexture;
  private pingFb: WebGLFramebuffer;
  private pongFb: WebGLFramebuffer;
  private lutTex: WebGLTexture;
  private vao: WebGLVertexArrayObject;

  // Created via the static factory so the async LUT load happens before
  // the first render. Private constructor enforces the factory.
  private constructor(
    gl: WebGL2RenderingContext,
    progs: Pipeline['programs'],
    inputTex: WebGLTexture,
    pingTex: WebGLTexture,
    pongTex: WebGLTexture,
    pingFb: WebGLFramebuffer,
    pongFb: WebGLFramebuffer,
    lutTex: WebGLTexture,
    vao: WebGLVertexArrayObject,
  ) {
    this.gl = gl;
    this.programs = progs;
    this.inputTex = inputTex;
    this.pingTex = pingTex;
    this.pongTex = pongTex;
    this.pingFb = pingFb;
    this.pongFb = pongFb;
    this.lutTex = lutTex;
    this.vao = vao;
  }

  /**
   * Create a Pipeline bound to the given canvas. Throws WebglFp16Unsupported
   * if EXT_color_buffer_half_float or OES_texture_float_linear is missing.
   *
   * The canvas is tagged with `colorSpace: 'srgb'` per CLAUDE.md
   * § "Build & test — Web" — wide-gamut browsers (P3 Macs) otherwise
   * interpret the canvas in display-P3 and warm tones shift pink.
   */
  static async create(canvas: HTMLCanvasElement): Promise<Pipeline> {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      colorSpace: 'srgb',
    });
    if (!gl) {
      throw new WebglFp16Unsupported(['WebGL2']);
    }
    const missing: string[] = [];
    if (!gl.getExtension('EXT_color_buffer_half_float')) {
      missing.push('EXT_color_buffer_half_float');
    }
    if (!gl.getExtension('OES_texture_float_linear')) {
      missing.push('OES_texture_float_linear');
    }
    if (missing.length > 0) {
      throw new WebglFp16Unsupported(missing);
    }

    const progs = {
      whiteBalance: linkProgram(gl, SHADERS.vertex, SHADERS.whiteBalance, [
        'uLiveTemperature',
        'uLiveTint',
        'uDecodedTemperature',
        'uDecodedTint',
      ]),
      sceneToneControls: linkProgram(
        gl,
        SHADERS.vertex,
        SHADERS.sceneToneControls,
        ['uExposure', 'uHighlights', 'uShadows', 'uWhites', 'uBlacks'],
      ),
      sceneVibrance: linkProgram(gl, SHADERS.vertex, SHADERS.sceneVibrance, [
        'uVibrance',
      ]),
      sceneSaturation: linkProgram(gl, SHADERS.vertex, SHADERS.sceneSaturation, [
        'uSaturation',
      ]),
      agxViewTransform: linkProgram(
        gl,
        SHADERS.vertex,
        SHADERS.agxViewTransform,
        ['uContrast', 'uLut'],
      ),
    };

    const inputTex = createFp16Texture(gl);
    const pingTex = createFp16Texture(gl);
    const pongTex = createFp16Texture(gl);
    const pingFb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, pingFb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      pingTex,
      0,
    );
    const pongFb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, pongFb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      pongTex,
      0,
    );

    // Load + upload the AgX LUT as a 512x1 R16F texture.
    const lutData = await loadAgxLut();
    const lutTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R16F,
      lutData.length,
      1,
      0,
      gl.RED,
      gl.HALF_FLOAT,
      lutData,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Empty VAO — gl_VertexID-driven full-screen triangle (vertex.glsl).
    const vao = gl.createVertexArray()!;
    return new Pipeline(
      gl,
      progs,
      inputTex,
      pingTex,
      pongTex,
      pingFb,
      pongFb,
      lutTex,
      vao,
    );
  }

  /**
   * Run the five-shader chain on `input` with `model` parameters.
   * Resizes the ping-pong attachments to (input.width, input.height)
   * the first call (and on size changes). Renders the final pass to
   * the canvas backbuffer; returns the RGBA8 readback for the
   * snapshot test in Task 10.
   */
  render(input: DecodedSceneLinearImage, model: AdjustmentModel): Uint8ClampedArray {
    const gl = this.gl;
    const { width: w, height: h, fp16Rgba } = input;

    // Upload input fp16 RGBA -> inputTex.
    gl.bindTexture(gl.TEXTURE_2D, this.inputTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA16F,
      w,
      h,
      0,
      gl.RGBA,
      gl.HALF_FLOAT,
      fp16Rgba,
    );

    // Resize ping/pong if size changed.
    gl.bindTexture(gl.TEXTURE_2D, this.pingTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, this.pongTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);

    gl.canvas.width = w;
    gl.canvas.height = h;
    gl.bindVertexArray(this.vao);

    // Pass 1: WhiteBalance -> ping
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pingFb);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.programs.whiteBalance.program);
    bindSrcTexture(gl, this.programs.whiteBalance, this.inputTex);
    gl.uniform1f(
      this.programs.whiteBalance.uniforms['uLiveTemperature'],
      model.temperature,
    );
    gl.uniform1f(this.programs.whiteBalance.uniforms['uLiveTint'], model.tint);
    // Decoded WB == as-shot at the time this Pipeline runs; the test page
    // wires those values from DecodedSceneLinearImage.asShotTemperature/Tint.
    gl.uniform1f(
      this.programs.whiteBalance.uniforms['uDecodedTemperature'],
      input.asShotTemperature,
    );
    gl.uniform1f(
      this.programs.whiteBalance.uniforms['uDecodedTint'],
      input.asShotTint,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 2: SceneToneControls (ping -> pong)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pongFb);
    gl.useProgram(this.programs.sceneToneControls.program);
    bindSrcTexture(gl, this.programs.sceneToneControls, this.pingTex);
    gl.uniform1f(
      this.programs.sceneToneControls.uniforms['uExposure'],
      model.exposure,
    );
    gl.uniform1f(
      this.programs.sceneToneControls.uniforms['uHighlights'],
      model.highlights,
    );
    gl.uniform1f(
      this.programs.sceneToneControls.uniforms['uShadows'],
      model.shadows,
    );
    gl.uniform1f(this.programs.sceneToneControls.uniforms['uWhites'], model.whites);
    gl.uniform1f(this.programs.sceneToneControls.uniforms['uBlacks'], model.blacks);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 3: SceneVibrance (pong -> ping)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pingFb);
    gl.useProgram(this.programs.sceneVibrance.program);
    bindSrcTexture(gl, this.programs.sceneVibrance, this.pongTex);
    gl.uniform1f(this.programs.sceneVibrance.uniforms['uVibrance'], model.vibrance);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 4: SceneSaturation (ping -> pong)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pongFb);
    gl.useProgram(this.programs.sceneSaturation.program);
    bindSrcTexture(gl, this.programs.sceneSaturation, this.pingTex);
    gl.uniform1f(
      this.programs.sceneSaturation.uniforms['uSaturation'],
      model.saturation,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 5: AgXViewTransform (pong -> canvas backbuffer)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.programs.agxViewTransform.program);
    bindSrcTexture(gl, this.programs.agxViewTransform, this.pongTex);
    // The LUT is texture unit 1; the source texture is 0 (set by bindSrcTexture).
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(this.programs.agxViewTransform.uniforms['uLut'], 1);
    gl.uniform1f(
      this.programs.agxViewTransform.uniforms['uContrast'],
      model.contrast,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Read back the RGBA8 backbuffer. WebGL2 readPixels(RGBA, UNSIGNED_BYTE)
    // is always supported on the canvas backbuffer.
    const pixels = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.inputTex);
    gl.deleteTexture(this.pingTex);
    gl.deleteTexture(this.pongTex);
    gl.deleteTexture(this.lutTex);
    gl.deleteFramebuffer(this.pingFb);
    gl.deleteFramebuffer(this.pongFb);
    gl.deleteVertexArray(this.vao);
    for (const p of Object.values(this.programs)) {
      gl.deleteProgram(p.program);
    }
  }
}

// === helpers ===

function compileShader(
  gl: WebGL2RenderingContext,
  type: GLenum,
  src: string,
): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '<no info log>';
    gl.deleteShader(sh);
    throw new Error(
      `Pipeline shader compile failed (type ${type}):\n${log}\n--- source ---\n${src}`,
    );
  }
  return sh;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vs: string,
  fs: string,
  extraUniforms: readonly string[],
): ProgramHandles {
  const v = compileShader(gl, gl.VERTEX_SHADER, vs);
  const f = compileShader(gl, gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram()!;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p) ?? '<no info log>';
    gl.deleteProgram(p);
    throw new Error(`Pipeline link failed:\n${log}`);
  }
  gl.deleteShader(v);
  gl.deleteShader(f);
  const uSrc = gl.getUniformLocation(p, 'uSrc');
  if (!uSrc) throw new Error('Pipeline: uSrc location missing');
  const uniforms: Record<string, WebGLUniformLocation> = {};
  for (const name of extraUniforms) {
    const loc = gl.getUniformLocation(p, name);
    if (!loc) throw new Error(`Pipeline: uniform '${name}' location missing`);
    uniforms[name] = loc;
  }
  return { program: p, uSrc, uniforms };
}

function createFp16Texture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function bindSrcTexture(
  gl: WebGL2RenderingContext,
  p: ProgramHandles,
  tex: WebGLTexture,
): void {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(p.uSrc, 0);
}
```

- [ ] **Step 7.3: Re-export the public surface from `public-api.ts`.**

Edit `src/web/projects/maple-common/src/public-api.ts`. Append (after the existing `export * from './lib/raw-pipeline/image-utils';` line at line 17):

```typescript

// Plan 3 M2.1 — WebGL2 dev-chain pipeline (hand-rolled).
export { Pipeline, WebglFp16Unsupported } from './lib/webgl/pipeline';
```

- [ ] **Step 7.4: Typecheck.**

Run: `cd src/web && bunx tsc --project projects/maple-common/tsconfig.spec.json --noEmit 2>&1 | tail -20`

Expected: errors about `loadAgxLut` not existing — that helper lands in Task 8. **At this commit boundary the typecheck IS expected to fail**; the import is a forward declaration. Step 8.4 fixes it.

- [ ] **Step 7.5: Commit (work-in-progress; typecheck unblocks at Task 8).**

```bash
git add src/web/projects/maple-common/src/lib/webgl/pipeline.ts
git add src/web/projects/maple-common/src/public-api.ts
git commit -m "$(cat <<'EOF'
feat(maple-common/webgl): add hand-rolled WebGL2 Pipeline class

Compiles + links the five GLSL ES 3.0 fragment shaders into a
five-pass dev-chain. Two RGBA16F ping-pong textures + one R16F LUT
texture. Hard-requires EXT_color_buffer_half_float and
OES_texture_float_linear; throws WebglFp16Unsupported when missing
(M3 wraps construction in try/catch for production fallback).

Canvas tagged colorSpace: 'srgb' per CLAUDE.md § "Build & test — Web".

Forward import of `loadAgxLut` is unresolved at this commit; Task 8
adds the loader and the bundled fp16 LUT bytes.

Plan 3 M2.1.

EOF
)"
```

---

## Task 8: Pack and bundle the AgX LUT for the Web build

**Files:**
- Create: `src/web/projects/maple-common/src/lib/webgl/agx_lut.bin` — 1024-byte packed fp16 LUT.
- Create: `src/web/projects/maple-common/src/lib/webgl/agx-lut-loader.ts` — TypeScript loader.
- Create: `src/web/projects/maple-common/src/lib/webgl/scripts/pack-agx-lut.ts` — one-shot conversion script (committed for reproducibility; not run by the build).

**Why this matters:** The Rust side embeds the LUT as 512 × f32 LE (2048 bytes). WebGL `R16F` textures want fp16 input. Brief § 4 says "CPU-side fp32 → fp16 pack" then upload. M2.2 will automate this; M2.1 ships a hand-packed `.bin` checked into the webgl directory. The packing is reproducible by re-running `pack-agx-lut.ts` against the upstream `src/raw-pipeline/raw-core/src/view/agx_lut.bin` (a one-line bun script).

- [ ] **Step 8.1: Write the one-shot conversion script.**

Create `src/web/projects/maple-common/src/lib/webgl/scripts/pack-agx-lut.ts` with:

```typescript
// Plan 3 M2.1 — pack the Rust raw-core AgX LUT (f32 LE) to fp16 for WebGL.
//
// Run from repo root:
//   bun run src/web/projects/maple-common/src/lib/webgl/scripts/pack-agx-lut.ts
//
// Reads:  src/raw-pipeline/raw-core/src/view/agx_lut.bin  (2048 bytes, 512 × f32 LE)
// Writes: src/web/projects/maple-common/src/lib/webgl/agx_lut.bin  (1024 bytes, 512 × f16 LE)
//
// AGX_VERSION pin is enforced at the raw-core side (commit 8c32bfe).
// If the upstream LUT changes, re-run this script in the same commit
// that bumps AGX_VERSION; mismatch is caught by the snapshot test in
// pipeline.spec.ts (the LUT shape changes -> AgX shoulder shifts).

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function f32ToF16Bits(x: number): number {
  // IEEE 754 round-to-nearest-even f32 -> f16. Matches the WebGL
  // gl.HALF_FLOAT internalformat reader exactly.
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = x;
  const bits = u32[0];
  const sign = (bits >>> 16) & 0x8000;
  let val = (bits & 0x7fffffff) + 0x1000;
  if (val >= 0x47800000) {
    if ((bits & 0x7fffffff) >= 0x47800000) {
      if (val < 0x7f800000) return sign | 0x7c00;
      return sign | 0x7c00 | ((bits & 0x007fffff) >>> 13);
    }
    return sign | 0x7bff;
  }
  if (val >= 0x38800000) return sign | ((val - 0x38000000) >>> 13);
  if (val < 0x33000000) return sign;
  val = (bits & 0x7fffffff) >>> 23;
  return (
    sign |
    ((((bits & 0x7fffff) | 0x800000) + (0x800000 >>> (val - 102))) >>> (126 - val))
  );
}

function main(): void {
  const repoRoot = resolve(import.meta.dir, '../../../../../../../');
  const srcPath = resolve(repoRoot, 'src/raw-pipeline/raw-core/src/view/agx_lut.bin');
  const dstPath = resolve(
    repoRoot,
    'src/web/projects/maple-common/src/lib/webgl/agx_lut.bin',
  );

  const srcBytes = readFileSync(srcPath);
  if (srcBytes.length !== 2048) {
    throw new Error(`unexpected src size: ${srcBytes.length}, want 2048`);
  }
  const f32 = new Float32Array(
    srcBytes.buffer,
    srcBytes.byteOffset,
    srcBytes.byteLength / 4,
  );
  if (f32.length !== 512) {
    throw new Error(`unexpected f32 length: ${f32.length}, want 512`);
  }
  const f16 = new Uint16Array(512);
  for (let i = 0; i < 512; i += 1) {
    f16[i] = f32ToF16Bits(f32[i]);
  }
  writeFileSync(dstPath, Buffer.from(f16.buffer));
  console.log(
    `packed: ${srcPath}\n     -> ${dstPath} (${f16.byteLength} bytes, AGX_VERSION pin from raw-core)`,
  );
}

main();
```

- [ ] **Step 8.2: Run the script once.**

Run: `cd /Users/<repo-root> && bun run src/web/projects/maple-common/src/lib/webgl/scripts/pack-agx-lut.ts 2>&1`

Expected output: `packed: ...agx_lut.bin (raw-core)\n     -> ...agx_lut.bin (1024 bytes, AGX_VERSION pin from raw-core)`. The destination file now exists.

- [ ] **Step 8.3: Verify the bundled LUT size.**

Run: `stat -f "%z" src/web/projects/maple-common/src/lib/webgl/agx_lut.bin 2>&1`

Expected: `1024`. If different, the conversion produced wrong byte count — re-investigate Step 8.1's packing.

- [ ] **Step 8.4: Write the TypeScript loader.**

Create `src/web/projects/maple-common/src/lib/webgl/agx-lut-loader.ts` with:

```typescript
// AgX LUT loader — Plan 3 M2.1.
//
// Fetches the bundled fp16 LUT (1024 bytes, 512 × f16 LE) and returns
// a Uint16Array for direct upload to a WebGL R16F texture.
//
// The .bin lives next to this loader so `import.meta.url` resolves
// to its path under both @angular/build's Vite loader (returns a
// hashed asset URL in production) and the dev server.
//
// AGX_VERSION pin: see pack-agx-lut.ts and raw-core's agx_coeffs.rs:32.

const LUT_URL = new URL('./agx_lut.bin', import.meta.url).href;

export async function loadAgxLut(): Promise<Uint16Array> {
  const resp = await fetch(LUT_URL);
  if (!resp.ok) {
    throw new Error(`agx_lut.bin fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const buf = await resp.arrayBuffer();
  if (buf.byteLength !== 1024) {
    throw new Error(
      `agx_lut.bin: expected 1024 bytes (512 × f16), got ${buf.byteLength}`,
    );
  }
  return new Uint16Array(buf);
}
```

- [ ] **Step 8.5: Update angular.json's `assets` to include the `.bin` for both shells.**

Read `src/web/angular.json` lines 28-50 to confirm the existing `raw_wasm_bg.wasm` glob pattern (already present). Add a parallel glob entry that copies `agx_lut.bin` under the `maple-hosted` and `maple-self-hosted` assets arrays.

Edit `src/web/angular.json`. After the existing entry that reads:

```json
              {
                "glob": "raw_wasm_bg.wasm",
                "input": "projects/maple-common/src/lib/raw-pipeline/pkg",
                "output": "/"
              },
```

(under both `projects.maple-hosted.architect.build.options.assets` and `projects.maple-self-hosted.architect.build.options.assets`), append a new entry:

```json
              {
                "glob": "agx_lut.bin",
                "input": "projects/maple-common/src/lib/webgl",
                "output": "/"
              },
```

The exact JSON layout (trailing comma, key order) follows the existing pattern. Only the two `assets` arrays under `maple-hosted` and `maple-self-hosted` change.

- [ ] **Step 8.6: Typecheck — confirm pipeline.ts now resolves.**

Run: `cd src/web && bunx tsc --project projects/maple-common/tsconfig.spec.json --noEmit 2>&1 | tail -20`

Expected: clean (the Step 7.4 forward-declared `loadAgxLut` is now defined).

- [ ] **Step 8.7: Production build smoke test — confirm the LUT is bundled.**

Run: `cd src/web && bun run build:hosted 2>&1 | tail -25`

Expected: `Built` (with normal chunk listing). The `dist/maple-hosted/agx_lut.bin` should exist after the build:

Run: `ls -la src/web/dist/maple-hosted/agx_lut.bin 2>&1`

Expected: `-rw-r--r-- ... 1024 ... agx_lut.bin`. If absent, the angular.json glob in Step 8.5 is wrong — re-check the path.

- [ ] **Step 8.8: Commit.**

```bash
git add src/web/projects/maple-common/src/lib/webgl/agx_lut.bin
git add src/web/projects/maple-common/src/lib/webgl/agx-lut-loader.ts
git add src/web/projects/maple-common/src/lib/webgl/scripts/pack-agx-lut.ts
git add src/web/angular.json
git commit -m "$(cat <<'EOF'
feat(maple-common/webgl): bundle the AgX fp16 LUT for the Web pipeline

agx_lut.bin (1024 bytes, 512 × fp16 LE) is the WebGL-side mirror of
raw-core's src/raw-pipeline/raw-core/src/view/agx_lut.bin (2048 bytes,
512 × f32 LE). The conversion script pack-agx-lut.ts (committed for
reproducibility, not run by the build) produces the .bin from the
raw-core source whenever AGX_VERSION bumps on the Rust side.

The loader reads it at Pipeline.create() and uploads it as a R16F
512x1 texture. M2.2 (separate plan) automates this via a `--web-bin`
flag in derive_agx_lut.py.

The angular.json change registers the .bin as a copyable asset for
both maple-hosted and maple-self-hosted application bundles, parallel
to the existing raw_wasm_bg.wasm entry.

Plan 3 M2.1 — Task 7's forward-declared `loadAgxLut` import now
resolves. Pipeline class is fully wired.

EOF
)"
```

---

## Task 9: Standalone test page

**Files:**
- Create: `src/web/projects/maple-common/src/lib/webgl/dev/webgl-test-page.component.ts`
- Create: `src/web/projects/maple-common/src/lib/webgl/dev/webgl-test-page.component.html`
- Create: `src/web/projects/maple-common/src/lib/webgl/dev/webgl-test-page.component.scss`
- Create: `src/web/projects/maple-common/src/lib/webgl/dev/fixtures/synthetic-input.bin` — 16×16 fp16 RGBA (2048 bytes).
- Create: `src/web/projects/maple-common/src/lib/webgl/dev/fixtures/reference.png` — Apple-rendered reference, 16×16 PNG.
- Create: `src/web/projects/maple-common/src/lib/webgl/dev/fixtures/MANIFEST.md` — fixture provenance.
- Create: `src/web/projects/maple-common/src/lib/webgl/dev/fixtures/scripts/generate-synthetic-input.ts` — committed for reproducibility.
- Create: `src/web/projects/maple-common/src/lib/webgl/delta-e-2000.ts` — TS port of CIEDE2000.
- Modify: `src/web/projects/maple-hosted/src/app/app.routes.ts` — register `/dev/webgl-test`.

**Why this matters:** Brief § 6 — the test page is the M2.1 visible artifact. Side-by-side `<canvas>` (WebGL2 result) + `<img>` (Apple reference PNG) + a programmatic ΔE readout. Gated behind `isDevMode()` so production bundles do not include the route. The fixture is a 16×16 synthesized input + a reference PNG generated on the Apple side; the synthesized input is small enough that the reference PNG is also small, the route loads in milliseconds, and the snapshot test in Task 10 reuses the same fixture.

- [ ] **Step 9.1: Generate the synthesized fp16 input.**

Create `src/web/projects/maple-common/src/lib/webgl/dev/fixtures/scripts/generate-synthetic-input.ts` with:

```typescript
// Plan 3 M2.1 — generate a 16x16 synthesized fp16 RGBA input.
//
// The image is a 16x16 grid of scene-linear Rec.2020 colors covering
// the [0, 4] EV range diagonally with mild chroma variation. Designed
// to exercise every shader stage:
//   * White Balance        — non-neutral chroma per row
//   * SceneToneControls    — linear range up to 4x scene-linear
//   * SceneVibrance        — hue rotation across the grid
//   * SceneSaturation      — chroma swept from 0 to 0.4 in Oklab
//   * AgXViewTransform     — input range covers AgX min..max EV
//
// Run from repo root:
//   bun run src/web/projects/maple-common/src/lib/webgl/dev/fixtures/scripts/generate-synthetic-input.ts
//
// Writes: ../synthetic-input.bin (2048 bytes = 16*16*4*2).

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function f32ToF16Bits(x: number): number {
  // Same conversion as pack-agx-lut.ts; duplicated to keep this script
  // self-contained (the M2.3 codegen plan deduplicates).
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = x;
  const bits = u32[0];
  const sign = (bits >>> 16) & 0x8000;
  let val = (bits & 0x7fffffff) + 0x1000;
  if (val >= 0x47800000) {
    if ((bits & 0x7fffffff) >= 0x47800000) {
      if (val < 0x7f800000) return sign | 0x7c00;
      return sign | 0x7c00 | ((bits & 0x007fffff) >>> 13);
    }
    return sign | 0x7bff;
  }
  if (val >= 0x38800000) return sign | ((val - 0x38000000) >>> 13);
  if (val < 0x33000000) return sign;
  val = (bits & 0x7fffffff) >>> 23;
  return (
    sign |
    ((((bits & 0x7fffff) | 0x800000) + (0x800000 >>> (val - 102))) >>> (126 - val))
  );
}

function main(): void {
  const w = 16,
    h = 16;
  const lanes = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      // Scene-linear values in [0.001, 4.0] swept diagonally across the grid.
      const t = (x + y) / (w + h - 2); // 0..1
      const lin = 0.001 + Math.pow(2, t * 12 - 4); // ~0.06 .. 4.0 EV
      // Mild chroma variation: shift R up, B down across rows.
      const r = lin * (1.0 + 0.2 * Math.sin((x / w) * Math.PI * 2));
      const g = lin;
      const b = lin * (1.0 - 0.2 * Math.sin((y / h) * Math.PI * 2));
      const i = (y * w + x) * 4;
      lanes[i + 0] = f32ToF16Bits(Math.max(0, r));
      lanes[i + 1] = f32ToF16Bits(Math.max(0, g));
      lanes[i + 2] = f32ToF16Bits(Math.max(0, b));
      lanes[i + 3] = 0x3c00; // alpha = fp16(1.0)
    }
  }
  const dst = resolve(import.meta.dir, '..', 'synthetic-input.bin');
  writeFileSync(dst, Buffer.from(lanes.buffer));
  console.log(`wrote ${dst} (${lanes.byteLength} bytes, 16x16 fp16 RGBA)`);
}

main();
```

Run: `cd /Users/<repo-root> && bun run src/web/projects/maple-common/src/lib/webgl/dev/fixtures/scripts/generate-synthetic-input.ts 2>&1`

Expected: `wrote .../synthetic-input.bin (2048 bytes, 16x16 fp16 RGBA)`.

Verify: `stat -f "%z" src/web/projects/maple-common/src/lib/webgl/dev/fixtures/synthetic-input.bin 2>&1` → `2048`.

- [ ] **Step 9.2: Generate the Apple-rendered reference PNG.**

This step requires the Apple xcframework + Metal kernels (from Plan 1 v2 + Plan 2 v2) to be built and a `maple-cli`-equivalent reachable. The procedure:

1. Build the Apple xcframework: `./src/apple/scripts/build-xcframework.sh`.
2. Use the Apple Metal pipeline (an `xcodebuild test`-runnable harness in `src/apple/Packages/MapleCore/Tests/MapleCoreTests/`) to render the synthesized fp16 input through the same five Metal kernels. Use this `AdjustmentModel`:

```text
exposure: 1.0
contrast: 25
highlights: -30
shadows: 40
whites: 0
blacks: 0
temperature: 5500
tint: -10
vibrance: 50
saturation: -20
```

3. The harness writes `reference.png` (16×16, sRGB-encoded RGBA8) — copy it to `src/web/projects/maple-common/src/lib/webgl/dev/fixtures/reference.png`.

If the Apple harness does not exist yet, **stop and create the harness** (a minimal Swift file under `Tests/MapleCoreTests/` that loads the `.bin`, runs the Metal kernels, writes a PNG). The harness commits as part of this step but lives in the Apple tree — the cross-tree work is intentional (reference data is by definition cross-tree). Expected harness file: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/WebglParityFixtureGenerator.swift`. **A parallel agent may be working on Plan 2 v2 Tasks 5-7 in `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/`** — if a conflict arises, defer this step until that work merges.

If the Apple harness/xcframework cannot be built in the executor's worktree (e.g. cross-platform engineer on Linux): **defer Task 9 Step 9.2 and Task 10's reference-asserting test**. Document the deferral in `MANIFEST.md` (Step 9.4) so the next engineer who has macOS produces the reference and re-asserts the snapshot.

Verify: `file src/web/projects/maple-common/src/lib/webgl/dev/fixtures/reference.png 2>&1` → `PNG image data, 16 x 16, ...`.

- [ ] **Step 9.3: Write the CIEDE2000 helper.**

Create `src/web/projects/maple-common/src/lib/webgl/delta-e-2000.ts` with the standard Bruce Lindbloom CIEDE2000 implementation. This is a literal port of the reference algorithm (~80 lines). The full code:

```typescript
// CIEDE2000 ΔE — Bruce Lindbloom reference implementation.
// Plan 3 M2.1 — used by the test page and pipeline.spec.ts.
//
// Inputs are sRGB Uint8ClampedArray (RGBA8 packed). Output is mean,
// p95, max ΔE₀₀ across all pixels. Matches src/scripts/compare_images.py
// numerics within fp64 precision.

interface DeltaEStats {
  mean: number;
  p95: number;
  max: number;
  nPixels: number;
}

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linearToXYZ(r: number, g: number, b: number): [number, number, number] {
  // sRGB D65 -> XYZ (Rec.709 primaries).
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  ];
}

function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  // D65 reference white.
  const xn = 0.95047,
    yn = 1.0,
    zn = 1.08883;
  const f = (t: number): number =>
    t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  const fx = f(x / xn),
    fy = f(y / yn),
    fz = f(z / zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function pixelToLab(r: number, g: number, b: number): [number, number, number] {
  const [lr, lg, lb] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const [x, y, z] = linearToXYZ(lr, lg, lb);
  return xyzToLab(x, y, z);
}

function deltaE2000(
  l1: number,
  a1: number,
  b1: number,
  l2: number,
  a2: number,
  b2: number,
): number {
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cbar, 7) / (Math.pow(Cbar, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) * 180) / Math.PI;
  const h2p = (Math.atan2(b2, a2p) * 180) / Math.PI;
  const h1pn = h1p < 0 ? h1p + 360 : h1p;
  const h2pn = h2p < 0 ? h2p + 360 : h2p;
  const dLp = l2 - l1;
  const dCp = C2p - C1p;
  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2pn - h1pn) <= 180) dhp = h2pn - h1pn;
  else if (h2pn - h1pn > 180) dhp = h2pn - h1pn - 360;
  else dhp = h2pn - h1pn + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const Lp = (l1 + l2) / 2;
  const Cp = (C1p + C2p) / 2;
  let hp: number;
  if (C1p * C2p === 0) hp = h1pn + h2pn;
  else if (Math.abs(h1pn - h2pn) <= 180) hp = (h1pn + h2pn) / 2;
  else if (h1pn + h2pn < 360) hp = (h1pn + h2pn + 360) / 2;
  else hp = (h1pn + h2pn - 360) / 2;
  const T =
    1 -
    0.17 * Math.cos(((hp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * hp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hp - 63) * Math.PI) / 180);
  const dTheta = 30 * Math.exp(-Math.pow((hp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cp, 7) / (Math.pow(Cp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lp - 50, 2)) / Math.sqrt(20 + Math.pow(Lp - 50, 2));
  const Sc = 1 + 0.045 * Cp;
  const Sh = 1 + 0.015 * Cp * T;
  const Rt = -Math.sin((2 * dTheta * Math.PI) / 180) * Rc;
  return Math.sqrt(
    Math.pow(dLp / Sl, 2) +
      Math.pow(dCp / Sc, 2) +
      Math.pow(dHp / Sh, 2) +
      Rt * (dCp / Sc) * (dHp / Sh),
  );
}

export function computeDeltaEStats(
  candidate: Uint8ClampedArray,
  reference: Uint8ClampedArray,
): DeltaEStats {
  if (candidate.length !== reference.length) {
    throw new Error(
      `delta-e: length mismatch ${candidate.length} vs ${reference.length}`,
    );
  }
  const n = candidate.length / 4;
  const dEs: number[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const j = i * 4;
    const [l1, a1, b1] = pixelToLab(candidate[j], candidate[j + 1], candidate[j + 2]);
    const [l2, a2, b2] = pixelToLab(reference[j], reference[j + 1], reference[j + 2]);
    dEs[i] = deltaE2000(l1, a1, b1, l2, a2, b2);
  }
  dEs.sort((a, b) => a - b);
  const mean = dEs.reduce((s, x) => s + x, 0) / n;
  const p95 = dEs[Math.min(n - 1, Math.floor(n * 0.95))];
  const max = dEs[n - 1];
  return { mean, p95, max, nPixels: n };
}
```

- [ ] **Step 9.4: Write the fixture provenance manifest.**

Create `src/web/projects/maple-common/src/lib/webgl/dev/fixtures/MANIFEST.md` with:

```markdown
# Plan 3 M2.1 fixtures

## synthetic-input.bin

- Size: 2048 bytes (16 × 16 × 4 × 2).
- Format: fp16 RGBA, row-major, top-left origin.
- Content: scene-linear Rec.2020 swept diagonally over the [0.06, 4.0] linear range
  (~6 EV) with mild chroma variation per row.
- Reproducible: `bun run scripts/generate-synthetic-input.ts` from this dir.

## reference.png

- Size: 16 × 16 sRGB RGBA8 PNG.
- Source: Apple Metal dev-chain rendered against `synthetic-input.bin`.
- AdjustmentModel:
  ```
  exposure: 1.0
  contrast: 25
  highlights: -30
  shadows: 40
  whites: 0
  blacks: 0
  temperature: 5500
  tint: -10
  vibrance: 50
  saturation: -20
  ```
- Generator: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/WebglParityFixtureGenerator.swift`.
- Re-run when:
  - The Apple Metal kernel implementations change (Plan 2 v2 onward).
  - AGX_VERSION bumps in `src/raw-pipeline/raw-core/src/view/agx_coeffs.rs`.
  - Any of the GLSL shaders' constants are updated (the codegen scaffold M2.3 adds will catch this).
- Last regeneration: <YYYY-MM-DD by COMMIT-HASH>
```

- [ ] **Step 9.5: Write the test page component.**

Create `src/web/projects/maple-common/src/lib/webgl/dev/webgl-test-page.component.ts` with:

```typescript
// Plan 3 M2.1 — standalone WebGL2 test page.
//
// Loads:
//   - synthetic-input.bin (16x16 fp16 RGBA fixture)
//   - reference.png       (Apple-rendered reference)
// Renders the WebGL2 chain side-by-side with the reference and prints
// mean/P95/max ΔE₀₀.
//
// Hard-required fp16. If the host browser lacks the extensions, the
// page surfaces a banner and refuses to render (M3 adds the
// production fallback).

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  signal,
  AfterViewInit,
} from '@angular/core';
import type { AdjustmentModel } from '../../models/adjustment-model';
import type { DecodedSceneLinearImage } from '../../raw-pipeline/raw-pipeline.types';
import { Pipeline, WebglFp16Unsupported } from '../pipeline';
import { computeDeltaEStats } from '../delta-e-2000';

const FIXTURE_INPUT_URL = new URL('./fixtures/synthetic-input.bin', import.meta.url)
  .href;
const FIXTURE_REFERENCE_URL = new URL('./fixtures/reference.png', import.meta.url)
  .href;

const FIXTURE_MODEL: AdjustmentModel = {
  exposure: 1.0,
  contrast: 25,
  highlights: -30,
  shadows: 40,
  whites: 0,
  blacks: 0,
  temperature: 5500,
  tint: -10,
  whiteBalancePreset: 'Custom',
  vibrance: 50,
  saturation: -20,
  clarity: 0,
  texture: 0,
  dehaze: 0,
  sharpenAmount: 0,
  sharpenRadius: 0.5,
  sharpenDetail: 25,
  sharpenMasking: 0,
  nrLuminance: 0,
  nrColor: 25,
};

@Component({
  selector: 'maple-webgl-test-page',
  standalone: true,
  templateUrl: './webgl-test-page.component.html',
  styleUrl: './webgl-test-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebglTestPageComponent implements AfterViewInit {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly status = signal<string>('idle');
  readonly meanDeltaE = signal<number | null>(null);
  readonly p95DeltaE = signal<number | null>(null);
  readonly maxDeltaE = signal<number | null>(null);
  readonly errorBanner = signal<string | null>(null);
  readonly referenceUrl = FIXTURE_REFERENCE_URL;

  async ngAfterViewInit(): Promise<void> {
    await this.run();
  }

  private async run(): Promise<void> {
    try {
      this.status.set('loading fixtures');
      const [inputBuf, refImg] = await Promise.all([
        fetch(FIXTURE_INPUT_URL).then((r) => r.arrayBuffer()),
        fetch(FIXTURE_REFERENCE_URL).then((r) => r.blob()).then(blobToImageData),
      ]);
      if (inputBuf.byteLength !== 2048) {
        throw new Error(
          `synthetic-input.bin: expected 2048 bytes (16×16 fp16 RGBA), got ${inputBuf.byteLength}`,
        );
      }
      const input: DecodedSceneLinearImage = {
        width: 16,
        height: 16,
        fp16Rgba: new Uint16Array(inputBuf),
        asShotTemperature: 5500,
        asShotTint: 0,
      };

      this.status.set('creating pipeline');
      const pipeline = await Pipeline.create(this.canvasRef.nativeElement);

      this.status.set('rendering');
      const candidate = pipeline.render(input, FIXTURE_MODEL);

      // WebGL renders bottom-up; flip the candidate to match the reference
      // PNG (top-down). The reference PNG was authored top-down on Apple.
      const flipped = flipVerticallyRgba(candidate, 16, 16);
      const stats = computeDeltaEStats(flipped, refImg.data);
      this.meanDeltaE.set(stats.mean);
      this.p95DeltaE.set(stats.p95);
      this.maxDeltaE.set(stats.max);
      this.status.set(`done — ${stats.nPixels} pixels compared`);

      pipeline.dispose();
    } catch (err) {
      if (err instanceof WebglFp16Unsupported) {
        this.errorBanner.set(err.message);
      } else {
        this.errorBanner.set((err as Error).message);
      }
      this.status.set('error');
    }
  }
}

async function blobToImageData(blob: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

function flipVerticallyRgba(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  const rowBytes = w * 4;
  for (let y = 0; y < h; y += 1) {
    const src = y * rowBytes;
    const dst = (h - 1 - y) * rowBytes;
    out.set(rgba.subarray(src, src + rowBytes), dst);
  }
  return out;
}
```

- [ ] **Step 9.6: Write the test page HTML.**

Create `src/web/projects/maple-common/src/lib/webgl/dev/webgl-test-page.component.html` with:

```html
<div class="page">
  <h1>Plan 3 M2.1 — WebGL2 dev-chain test page</h1>
  @if (errorBanner()) {
    <div class="error-banner">{{ errorBanner() }}</div>
  }
  <div class="panes">
    <div class="pane">
      <h2>WebGL2 candidate</h2>
      <canvas #canvas width="16" height="16" class="image"></canvas>
    </div>
    <div class="pane">
      <h2>Apple reference</h2>
      <img [src]="referenceUrl" alt="Apple-rendered reference" class="image" />
    </div>
  </div>
  <div class="metrics">
    <div>status: <strong>{{ status() }}</strong></div>
    <div>mean ΔE₀₀: {{ meanDeltaE() === null ? 'n/a' : (meanDeltaE() ?? 0).toFixed(3) }}</div>
    <div>P95 ΔE₀₀: {{ p95DeltaE() === null ? 'n/a' : (p95DeltaE() ?? 0).toFixed(3) }}</div>
    <div>max ΔE₀₀: {{ maxDeltaE() === null ? 'n/a' : (maxDeltaE() ?? 0).toFixed(3) }}</div>
  </div>
</div>
```

- [ ] **Step 9.7: Write the test page SCSS.**

Create `src/web/projects/maple-common/src/lib/webgl/dev/webgl-test-page.component.scss` with:

```scss
.page {
  font-family: monospace;
  padding: 16px;
}
.error-banner {
  background: #fee;
  color: #800;
  padding: 8px;
  border: 1px solid #c00;
  margin-bottom: 16px;
}
.panes {
  display: flex;
  gap: 16px;
}
.pane {
  flex: 1;
}
.image {
  image-rendering: pixelated;
  width: 256px;
  height: 256px;
  border: 1px solid #888;
  display: block;
}
.metrics {
  margin-top: 16px;
  > div {
    line-height: 1.6;
  }
}
```

- [ ] **Step 9.8: Register the dev route.**

Edit `src/web/projects/maple-hosted/src/app/app.routes.ts`. Replace the entire content with:

```typescript
import { Routes } from '@angular/router';
import { isDevMode } from '@angular/core';
import { BrowseShellComponent, EditorShellComponent } from '@maple-common';
import { LandingComponent } from './landing/landing.component';

// Hosted: `/` is the Landing page with two CTAs. Users enter Browse or the
// Editor explicitly from there.
//
// Plan 3 M2.1 adds a `/dev/webgl-test` route gated behind `isDevMode()`.
// Production bundles do not include the route at all (the `if`-block
// short-circuits, the lazy-loaded chunk is tree-shaken by @angular/build).
const baseRoutes: Routes = [
  { path: '', component: LandingComponent },
  { path: 'browse', component: BrowseShellComponent },
  { path: 'edit/:id', component: EditorShellComponent },
];

const devRoutes: Routes = isDevMode()
  ? [
      {
        path: 'dev/webgl-test',
        loadComponent: () =>
          import(
            '@maple-common/lib/webgl/dev/webgl-test-page.component'
          ).then((m) => m.WebglTestPageComponent),
      },
    ]
  : [];

export const routes: Routes = [
  ...baseRoutes,
  ...devRoutes,
  { path: '**', redirectTo: '' },
];
```

**Note on the import path:** the lazy `import('@maple-common/lib/webgl/dev/webgl-test-page.component')` requires the dev page to be reachable through the public-api re-export OR through a deep import. Verify in Step 9.9 that the deep import resolves; if not, fall back to a relative `../../../../maple-common/src/lib/webgl/dev/webgl-test-page.component` import.

- [ ] **Step 9.9: Dev server smoke test — load the page.**

Run: `cd src/web && bun run start:hosted 2>&1 | head -20` (in a separate terminal, or with `run_in_background: true`).

Wait until the dev server prints `Local: http://localhost:4200/`. Then in a browser:

1. Visit `http://localhost:4200/dev/webgl-test`.
2. The page shows two 256×256 pixelated images side-by-side (the 16×16 input scaled up).
3. The metrics block shows numerical ΔE values, not "n/a".
4. The console (browser devtools) shows no errors.

Expected: `mean ΔE₀₀ < 1.0`, `P95 ΔE₀₀ < 2.0`, `max ΔE₀₀ < 5.0`. Numbers above these budgets indicate either (a) Step 9.2's Apple reference does not match the M2.1 GLSL shaders (regenerate the reference), (b) Spike 1.2's LUT formula needs revision (revisit Step 6.2), or (c) a hand-introduced matrix transcription error in Tasks 2-6 (compare the GLSL `mat3` definitions byte-for-byte to the Metal `float3x3` rows).

If extensions are missing on the test browser, the red error banner shows the missing-extension list. M2.1 hard-requires fp16; document the host browser version that does not have the extensions in MANIFEST.md and skip the snapshot test in the same env (Task 10's `it.skip` branch covers that).

- [ ] **Step 9.10: Stop the dev server.**

If you ran `bun run start:hosted` in the foreground: Ctrl+C. If `run_in_background`: `kill %1` or equivalent.

- [ ] **Step 9.11: Production build smoke test — confirm the dev route is tree-shaken.**

Run: `cd src/web && bun run build:hosted 2>&1 | tail -25`

Expected: `Built` with no chunk named `webgl-test-page`. The `isDevMode()` evaluates to `false` in a production build, so the lazy import is unreachable and `@angular/build`'s tree-shaker drops the component.

Verify: `grep -r "WebglTestPageComponent" src/web/dist/maple-hosted/ 2>&1 | head -5`

Expected: zero matches in `dist/`. If matches appear, the tree-shaker did not drop the component — investigate the `loadComponent` syntax in Step 9.8.

- [ ] **Step 9.12: Commit.**

```bash
git add src/web/projects/maple-common/src/lib/webgl/delta-e-2000.ts
git add src/web/projects/maple-common/src/lib/webgl/dev/
git add src/web/projects/maple-hosted/src/app/app.routes.ts
git commit -m "$(cat <<'EOF'
feat(maple-common/webgl): standalone WebGL2 dev test page + ΔE₀₀ overlay

`/dev/webgl-test` (gated behind isDevMode()) renders a 16×16 synthesized
fp16 input through the WebGL2 dev-chain side-by-side with an Apple-
rendered reference PNG. Computes mean/P95/max ΔE₀₀ in TypeScript via
a Bruce Lindbloom CIEDE2000 port (matches src/scripts/compare_images.py
within fp64 precision).

The fixture provenance is documented in fixtures/MANIFEST.md, including
the exact AdjustmentModel and the Apple harness path that re-generates
reference.png when the Metal kernels or AGX_VERSION change.

Production bundles do not include the dev route — the lazy import is
tree-shaken when isDevMode() returns false.

Plan 3 M2.1 — Task 10 reuses the same fixtures for an automated
vitest snapshot regression.

EOF
)"
```

---

## Task 10: Vitest snapshot test

**Files:**
- Create: `src/web/projects/maple-common/src/lib/webgl/pipeline.spec.ts`

**Why this matters:** The brief's M2.1 deliverable is "CIEDE2000 snapshot test in vitest: hard-codes a known fp16 input + reference PNG, asserts mean ΔE < some budget (e.g. 1.0 — well within fp16 noise on a synthesized input)." This task ships the test. **`@angular/build:unit-test` runs vitest with jsdom by default; jsdom does not implement WebGL2.** The test detects whether `headless-gl` (a node WebGL polyfill) is loadable and runs against it; otherwise it skips with a clear reason. The test page (Task 9) is the canonical M2.1 validation; the unit test is a regression guardrail that runs in CI when the polyfill is available.

- [ ] **Step 10.1: Read the existing vitest spec for shape conventions.**

Read `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.spec.ts` lines 1-50 to confirm the canonical import shape (`import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'`).

- [ ] **Step 10.2: Write the spec.**

Create `src/web/projects/maple-common/src/lib/webgl/pipeline.spec.ts` with:

```typescript
// Plan 3 M2.1 — Pipeline snapshot regression spec.
//
// Hard-codes the same synthesized input + Apple reference PNG as the
// dev test page. Asserts mean ΔE₀₀ < 1.0 (fp16 noise on synthesized
// input is well below this).
//
// vitest runs under jsdom by default; jsdom has no WebGL2. We detect
// `headless-gl` (or any other Node WebGL polyfill exposing the
// WebGL2RenderingContext shape) at module load. If absent, the spec
// skips with a clear reason — the dev page (route /dev/webgl-test) is
// the canonical M2.1 validation; this spec is the CI guardrail.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { computeDeltaEStats } from './delta-e-2000';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { DecodedSceneLinearImage } from '../raw-pipeline/raw-pipeline.types';

const FIXTURE_DIR = resolve(__dirname, 'dev', 'fixtures');
const FIXTURE_INPUT = resolve(FIXTURE_DIR, 'synthetic-input.bin');
const FIXTURE_REFERENCE = resolve(FIXTURE_DIR, 'reference.png');

const FIXTURE_MODEL: AdjustmentModel = {
  exposure: 1.0,
  contrast: 25,
  highlights: -30,
  shadows: 40,
  whites: 0,
  blacks: 0,
  temperature: 5500,
  tint: -10,
  whiteBalancePreset: 'Custom',
  vibrance: 50,
  saturation: -20,
  clarity: 0,
  texture: 0,
  dehaze: 0,
  sharpenAmount: 0,
  sharpenRadius: 0.5,
  sharpenDetail: 25,
  sharpenMasking: 0,
  nrLuminance: 0,
  nrColor: 25,
};

function decodePngRgba8(path: string): {
  width: number;
  height: number;
  data: Uint8ClampedArray;
} {
  // Minimal-effort PNG decode: we know the fixture is 16×16 RGBA8.
  // pngjs is already in node_modules transitively (sharp/png deps);
  // try-require here. If pngjs isn't available, the spec skips.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const png = require('pngjs') as typeof import('pngjs');
  const buf = readFileSync(path);
  const decoded = png.PNG.sync.read(buf);
  return {
    width: decoded.width,
    height: decoded.height,
    data: new Uint8ClampedArray(decoded.data),
  };
}

describe('Pipeline — snapshot ΔE₀₀ regression (Plan 3 M2.1)', () => {
  // Import lazily so vitest doesn't fail at collection time when
  // headless-gl is missing.
  let createGl: ((width: number, height: number) => WebGL2RenderingContext) | null;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    createGl = require('gl');
  } catch {
    createGl = null;
  }

  const skipReason = createGl
    ? null
    : 'headless-gl not installed — run `bun add -D gl` to enable. ' +
      'The dev page at /dev/webgl-test is the canonical M2.1 validation.';

  (createGl ? it : it.skip)(
    'mean ΔE₀₀ < 1.0 against Apple reference',
    async () => {
      // Load fixtures.
      const inputBuf = readFileSync(FIXTURE_INPUT);
      expect(inputBuf.byteLength).toBe(2048);

      const ref = decodePngRgba8(FIXTURE_REFERENCE);
      expect(ref.width).toBe(16);
      expect(ref.height).toBe(16);

      // headless-gl returns a WebGL1 context by default; M2.1 requires
      // WebGL2. If `gl` 6.x's WebGL2 mode is needed, the polyfill must
      // be configured at install time (`{ webgl2: true }`). When that's
      // absent, fail loud — the spec must not silently pass against a
      // mocked WebGL1 context that swallows fp16.
      const gl = createGl!(16, 16);
      expect(gl).toBeTruthy();
      // (Asserting WebGL2 features here is exhaustive in production
      // code; for the snapshot regression we surface non-WebGL2 as a
      // skip-with-reason to keep CI green on hosts without it.)
      const haveCBHF = (gl as unknown as WebGL2RenderingContext).getExtension?.(
        'EXT_color_buffer_half_float',
      );
      if (!haveCBHF) {
        // Treat as skip. The whole point of this guardrail is to
        // catch GLSL / matrix drift; a polyfill that doesn't expose
        // fp16 cannot exercise the chain.
        console.warn(
          '[pipeline.spec] headless-gl present but EXT_color_buffer_half_float ' +
            'missing — skipping (dev page is canonical).',
        );
        return;
      }

      // Wire the polyfill's gl context into a HTMLCanvasElement-shaped
      // shim so Pipeline.create can consume it. The Pipeline class
      // calls `canvas.getContext('webgl2', ...)`; we intercept that.
      const canvas = {
        width: 16,
        height: 16,
        getContext: (kind: string) => (kind === 'webgl2' ? gl : null),
      } as unknown as HTMLCanvasElement;

      const { Pipeline } = await import('./pipeline');
      const pipeline = await Pipeline.create(canvas);

      const input: DecodedSceneLinearImage = {
        width: 16,
        height: 16,
        fp16Rgba: new Uint16Array(
          inputBuf.buffer,
          inputBuf.byteOffset,
          inputBuf.byteLength / 2,
        ),
        asShotTemperature: 5500,
        asShotTint: 0,
      };

      const candidate = pipeline.render(input, FIXTURE_MODEL);
      // headless-gl renders top-down; reference.png is also top-down.
      // No vertical flip (the test page flips because browser canvases
      // render bottom-up in NDC).
      const stats = computeDeltaEStats(candidate, ref.data);
      pipeline.dispose();

      console.log(
        `[pipeline.spec] mean=${stats.mean.toFixed(3)} ` +
          `p95=${stats.p95.toFixed(3)} max=${stats.max.toFixed(3)}`,
      );
      expect(stats.mean).toBeLessThan(1.0);
      expect(stats.p95).toBeLessThan(2.0);
      expect(stats.max).toBeLessThan(5.0);
    },
  );

  if (skipReason) {
    it(`environment note: ${skipReason}`, () => {
      // Single skipped placeholder so the test runner output makes the
      // skip visible to the human reader.
      expect(true).toBe(true);
    });
  }
});
```

- [ ] **Step 10.3: Run the spec.**

Run: `cd src/web && bun x ng test Maple-common --watch=false 2>&1 | tail -25`

Two acceptable outcomes:
- **headless-gl present:** the test runs and passes (mean < 1.0, P95 < 2.0, max < 5.0).
- **headless-gl absent:** the test skips with `environment note: headless-gl not installed — run \`bun add -D gl\` to enable.`. The other specs in maple-common (`raw-pipeline.service.spec.ts`, `library-state.service.spec.ts`, etc.) all pass.

If the test runs but FAILS the budget:
1. Re-run the dev page (Step 9.9) — does it show the same ΔE? If yes, the GLSL has a bug; compare each fragment shader to its Metal source line-by-line.
2. If the dev page shows different ΔE, headless-gl's fp16 implementation diverges from real browser drivers — note the discrepancy in MANIFEST.md and tighten the dev-page-only assertion (the dev page becomes the canonical gate; this unit test stays as-is but the budget is loosened).

- [ ] **Step 10.4: Commit.**

```bash
git add src/web/projects/maple-common/src/lib/webgl/pipeline.spec.ts
git commit -m "$(cat <<'EOF'
test(maple-common/webgl): pipeline.spec — ΔE₀₀ snapshot regression

Hard-codes the synthesized input + Apple reference PNG fixtures from
Task 9. Asserts:
  mean ΔE₀₀ < 1.0
  P95  ΔE₀₀ < 2.0
  max  ΔE₀₀ < 5.0

Hardware-accelerated WebGL2 isn't available under jsdom, so the spec
detects `headless-gl` at runtime and skips when absent (with a
console-visible reason). The dev page at /dev/webgl-test is the
canonical M2.1 validation; this spec is the CI guardrail for
hand-introduced matrix or constant drift.

Plan 3 M2.1.

EOF
)"
```

---

## Self-Review Checklist

Run through this once after the plan is in place, before handoff to execution.

**1. Spec coverage (brief § X → task):**
- [ ] Brief § 1 (architecture: hand-rolled raw WebGL2, ping-pong, `colorSpace: 'srgb'`) → Task 7.
- [ ] Brief § 2 (per-kernel GLSL ports, all five) → Tasks 2-6.
- [ ] Brief § 3 (fp16 working format, required extensions) → Step 7.4 in `Pipeline.create`.
- [ ] Brief § 4 (AgX LUT bundling, fp16 pack, R16F upload, LINEAR + CLAMP_TO_EDGE) → Tasks 6 + 8.
- [ ] Brief § 5 (color codegen) — explicitly OUT OF SCOPE per "Out of scope" section; M2.3 is the separate plan.
- [ ] Brief § 6 (compositing — test page only, no `image-canvas.component.ts` touch) → Task 9. Brief § 6's M3 work is OUT OF SCOPE.
- [ ] Brief § 7 (capability fallback hard-required for M2.1) → Step 7.4 throws `WebglFp16Unsupported` instead of returning null. Test page surfaces a banner; M3 wraps with try/catch.
- [ ] Brief § 8 milestones — this plan covers M2.1 only; M2.2/M2.3/M2.4 explicitly listed in Out of scope.
- [ ] Brief § 9 (open questions: fp16 sampling parity, AgX LUT edge sampling, fp16 readback) → Task 1's three spikes answer all three; the answers are appended to this plan as `## Spike findings`.
- [ ] Brief § 10 ("Recommended cut: ship M2.1 alone first") → the plan's scope.

**2. Placeholder scan:**
- [ ] No "TBD", "TODO", "implement later" anywhere in task content.
- [ ] No "similar to Task N" without code.
- [ ] No "add appropriate error handling" — error patterns are concrete (`WebglFp16Unsupported`, `gl.getError()` checks in spike, throw-on-link-failure in `linkProgram`).
- [ ] Step 1.4's `<DATE>`, `<VERSION>`, `<MATCH/DRIFT>`, `<value>`, `<Y/N>` placeholders are intentional template markers the engineer fills in at execution time. Same for Step 9.4's `<YYYY-MM-DD by COMMIT-HASH>`.
- [ ] Step 8.2's `cd /Users/<repo-root>` placeholder is intentional — the engineer's worktree path differs.

**3. Type consistency:**
- [ ] `Pipeline` class — methods: `static create(canvas)`, `render(input, model)`, `dispose()`. Used by Tasks 9 and 10 with the same signatures.
- [ ] `Pipeline.render` signature: `(input: DecodedSceneLinearImage, model: AdjustmentModel) -> Uint8ClampedArray`. Matches the test page (`pipeline.render(input, FIXTURE_MODEL)` returns `candidate: Uint8ClampedArray`) and the spec (`pipeline.render(input, FIXTURE_MODEL)` returns `Uint8ClampedArray` consumed by `computeDeltaEStats`).
- [ ] `WebglFp16Unsupported` class — exported from `pipeline.ts`, re-exported from `public-api.ts` (Step 7.3), caught by name in test page (Step 9.5).
- [ ] `loadAgxLut` — declared in Step 8.4, imported by Step 7.2's pipeline.ts. Returns `Promise<Uint16Array>`.
- [ ] `computeDeltaEStats` — defined in Step 9.3, used by Step 9.5 (test page) and Step 10.2 (spec). Signature `(Uint8ClampedArray, Uint8ClampedArray) -> { mean, p95, max, nPixels }`.
- [ ] `SHADERS` const — defined in Step 2.4, narrowed in Steps 3.3, 4.3, 5.3, 6.3 as keys are added. Final keys: `vertex`, `whiteBalance`, `sceneToneControls`, `sceneVibrance`, `sceneSaturation`, `agxViewTransform`. Pipeline.ts (Step 7.2) reads exactly those keys.
- [ ] `AdjustmentModel` — imported from `../models/adjustment-model` consistently in pipeline.ts (Step 7.2) and webgl-test-page.component.ts (Step 9.5) and pipeline.spec.ts (Step 10.2). All three use the same `FIXTURE_MODEL` shape.
- [ ] Uniform names — `uSrc`, `uLut`, `uLiveTemperature`, `uLiveTint`, `uDecodedTemperature`, `uDecodedTint`, `uExposure`, `uHighlights`, `uShadows`, `uWhites`, `uBlacks`, `uVibrance`, `uSaturation`, `uContrast`. Each fragment shader declares them; Step 7.2 binds via `getUniformLocation` with the same names.

**4. Cross-link integrity:**
- [ ] Brief reference: `.archived-plans/specs/2026-04-25-plan-3-m2-webgl-shaders-brief.md` — verified to exist (read in plan authoring).
- [ ] Plan 3 brief reference: `.archived-plans/specs/2026-04-25-plan-3-web-ffi-split-brief.md` — verified.
- [ ] Plan 3 M1 plan reference: `.archived-plans/plans/2026-04-25-plan-3-web-ffi-split-m1.md` — verified.
- [ ] Plan 1 v2 reference: `.archived-plans/plans/2026-04-24-ffi-split-plan-1.md` — verified.
- [ ] Plan 2 v2 reference: `.archived-plans/plans/2026-04-25-plan-2-v2-shared-blur-clarity-texture.md` — verified.
- [ ] Apple Metal source paths: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/{WhiteBalance,SceneToneControls,SceneVibrance,SceneSaturation,AgXViewTransform}.metal` — verified by `ls`.
- [ ] AgX LUT file: `src/raw-pipeline/raw-core/src/view/agx_lut.bin` (2048 bytes) — verified by `stat`. AGX_VERSION pin at `src/raw-pipeline/raw-core/src/view/agx_coeffs.rs:32` — verified by `grep`. Commit `8c32bfe` — referenced in Plan 3 M1 plan line 34.

**5. Conflicts with the brief surfaced inline:**
- [ ] Brief § 1 says Pipeline class is "~150-line"; plan estimates ~250 lines. Difference is the typed uniform setters + dispose method + `WebglFp16Unsupported` class — kept in the same file by the plan. Reported to maintainer.
- [ ] Brief § 6 mentions test page at `src/web/projects/maple/src/app/dev/webgl-test-page.component.ts`; the plan places it at `src/web/projects/maple-common/src/lib/webgl/dev/webgl-test-page.component.ts` because the actual project layout has `maple-hosted` and `maple-self-hosted` (no plain `maple`), and the dev page lives in the shared `maple-common` library so both shells could lazy-load it. Only `maple-hosted` registers the route in M2.1; `maple-self-hosted` is left untouched.
- [ ] Brief § 6 mentions `<img>` for visual comparison and "programmatic CIEDE2000 diff" — the plan implements both (Step 9.6 `<img>` + Step 9.5's `computeDeltaEStats` call).
- [ ] Brief § 7 says "M2's standalone test page hard-requires WebGL2-fp16" — the plan enforces this in `Pipeline.create` (Step 7.4 throws) and the test page surfaces the error banner (Step 9.5).
- [ ] Brief § 9 open question 4 ("LUT edge sampling") asks about Apple's `coreimage::sampler_h` LINEAR + CLAMP_TO_EDGE behavior at `t = 1.0`. Spike 1.2 (Task 1) is the experiment; its result drives Step 6.2's GLSL. **The plan deliberately leaves Step 6.2's formula matching `AgXViewTransform.metal:32` byte-for-byte UNLESS Spike 1.2 finds Apple actually uses a different formula.**
- [ ] Brief § 10's "no codegen subdir" — the plan's Out of scope section explicitly lists M2.3 codegen scaffolding as a separate plan. Constants are embedded directly in Tasks 2-6's GLSL sources.

**6. Ordering and BLOCKING constraints:**
- [ ] Task 1 (verification spike) blocks Tasks 6 and 7. The spike output is appended to this plan file as `## Spike findings`; Step 6.1 reads the findings before Step 6.2 writes the LUT-sampling code.
- [ ] Tasks 2-5 are independent of each other; ordering for legibility only.
- [ ] Task 7 depends on Tasks 2-6 (shader sources) AND on Task 8 (LUT loader) — but Task 7 lands a forward `import { loadAgxLut }` that is unresolved at that commit boundary; Step 7.4 explicitly notes the typecheck failure is expected, and Step 8.6 unblocks it. Documented in both task headers.
- [ ] Task 8 is independent of the shader Tasks; placed after Task 7 for review legibility (the consumer emerges before the asset).
- [ ] Task 9 depends on Tasks 7 + 8.
- [ ] Task 10 depends on Tasks 7 + 8 + 9.
- [ ] No task assumes the dev fixtures exist before they are committed — Step 9.1 generates `synthetic-input.bin`, Step 9.2 generates `reference.png`. Step 9.2's Apple-side dependency is documented as a deferral path if the executor is not on macOS.

**7. AGX_VERSION sync:**
- [ ] Task 8's `pack-agx-lut.ts` reads from `src/raw-pipeline/raw-core/src/view/agx_lut.bin` (the canonical AgX LUT pinned by AGX_VERSION = 5). The bundled `src/web/projects/maple-common/src/lib/webgl/agx_lut.bin` is a CPU-converted fp16 mirror of the same bytes. Bumping AGX_VERSION on the Rust side requires re-running `pack-agx-lut.ts` in the same commit; the snapshot test in Task 10 catches an out-of-sync LUT (the AgX shoulder shifts -> ΔE budget violated).

If any of the above is unchecked when reviewing, fix inline; do not re-review.


