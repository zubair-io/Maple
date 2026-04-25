# Plan 3 — Web/WASM FFI Split, Milestone 1: Scene-Linear FFI Entry Point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Brief:** [`docs/superpowers/specs/2026-04-25-plan-3-web-ffi-split-brief.md`](../specs/2026-04-25-plan-3-web-ffi-split-brief.md). This plan implements the brief's § 10 "Recommended cut": **M1 only.**
>
> **Cross-links:** [Plan 1 v2 (Apple FFI split)](2026-04-24-ffi-split-plan-1.md) — the Apple-side template Plan 3 mirrors. [Plan 2 (Apple Metal kernels)](2026-04-25-plan-2-dev-chain-metal-kernels.md) — the parallel scene-linear development chain on Apple. [Deep Zoom plan](2026-04-25-deep-zoom-tile-rendering.md) — the tile FFI variant Plan 3 M5 will mirror.

**Goal:** Add a new wasm-bindgen entry `renderBytesSceneLinear` to `raw-wasm` that returns Rec.2020 fp16 RGBA (matching Apple's `MapleSceneLinearBuffer` bit pattern). Extend the worker types and service to round-trip the new buffer through the existing decode worker. The legacy `render_bytes` stays in place; M1 is purely additive — Web Angular shell still draws the legacy sRGB path. Proves the "one Rust core" invariant on the WASM side without touching shaders or canvas paint.

**Architecture:**
1. Rust: add a new wasm-bindgen-exposed type `MapleSceneLinearRender` (mirrors the Apple C struct `MapleSceneLinearBuffer` at [`raw-ffi/src/lib.rs:282-308`](../../src/raw-pipeline/raw-ffi/src/lib.rs#L282)) and a new function `render_bytes_scene_linear` that mirrors `maple_render_bytes_scene_linear` semantics minus the C struct. The function calls the same shared helper Apple uses, `raw_core::pipeline::render_scene_linear_from_raw_with_quality` ([`pipeline.rs:271-298`](../../src/raw-pipeline/raw-core/src/pipeline.rs#L271)), introduced in commit [`9c1bb22`](../../). The legacy `render_bytes` ([`raw-wasm/src/lib.rs:97-137`](../../src/raw-pipeline/raw-wasm/src/lib.rs#L97)) is **not modified or removed** — both entries co-exist. `as_shot_temperature` / `as_shot_tint` semantics are reused verbatim from the legacy entry so callers can swap in M3 with no metadata regression.
2. TypeScript: extend [`raw-pipeline.types.ts`](../../src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.types.ts) with a new request/response variant pair (`DecodeSceneLinearRequest`, `DecodeSceneLinearSuccess`) and a `DecodedSceneLinearImage` aggregate. Existing `DecodeRequest` / `DecodeSuccess` / `DecodedImage` are untouched.
3. Worker: extend [`raw-pipeline.worker.ts`](../../src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.worker.ts) to dispatch on `req.type` (currently only `'decode'`). Add a `'decode-scene-linear'` branch that calls the new WASM entry and posts back `Uint16Array` fp16 RGBA via transferable `ArrayBuffer`.
4. Service: add `decodeSceneLinear(...)` to [`raw-pipeline.service.ts`](../../src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts) alongside the existing `decode(...)`. Both share the same `decodeChain` serialization gate (single in-flight WASM decode, per existing comment at [`raw-pipeline.service.ts:91-97`](../../src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts#L91)).
5. Tests:
   - Rust side: a wasm-bindgen `#[wasm_bindgen_test]` (or a plain `#[test]` if the WASM-test toolchain is unavailable) — using the **synthesized in-memory mosaic** approach. Asserts buffer length = `8 * w * h`, alpha bit pattern `0x3c00` (fp16 1.0), and that R/G/B fp16 values round-trip plausibly (no NaN, finite, in expected range).
   - TS side: a new `raw-pipeline.service.spec.ts` (vitest, matching [`library-state.service.spec.ts`](../../src/web/projects/maple-common/src/lib/state/library-state.service.spec.ts) style) — mocks the worker via a stub and verifies the round-trip exposes `Uint16Array` of expected length plus the metadata fields.

**Tech Stack:**
- Rust: `wasm-bindgen` 0.2 (existing) over `raw-core::pipeline::render_scene_linear_from_raw_with_quality`. No new Cargo deps. The fp16 lanes are already a `Vec<u16>` in raw-core so wasm-bindgen's `Vec<u16> → Uint16Array` codegen is automatic.
- TypeScript: Angular 21 + Vitest (`@angular/build:unit-test`, configured at [`angular.json:220-225`](../../src/web/angular.json#L220) for `Maple-common`). RxJS `BehaviorSubject` reused; no new RxJS surface area.
- Build glue: `bash src/raw-pipeline/raw-wasm/build.sh` (or `npm run raw-wasm` from `src/web` — defined at [`src/web/package.json:7`](../../src/web/package.json#L7)) regenerates `pkg/raw_wasm.{js,d.ts,wasm}`. The new TS function `render_bytes_scene_linear` will appear in the generated `pkg/raw_wasm.d.ts` automatically once the Rust signature changes.

**Brainstorm origin:** [Brief 2026-04-25](../specs/2026-04-25-plan-3-web-ffi-split-brief.md) § 10 "Recommended cut". The brief's § 8 "Sequencing milestones" describes M1–M5; this plan covers **M1 only**. M2–M5 are explicitly deferred (see Out of scope below).

**Verified findings (each maps to a task):**

1. **Apple's scene-linear FFI is already shipped.** Confirmed at [`raw-ffi/src/lib.rs:283-308`](../../src/raw-pipeline/raw-ffi/src/lib.rs#L283) (`MapleSceneLinearBuffer` struct: `fp16_rgba`, `len_bytes`, `channels`, `bytes_per_pixel`, `width`, `height`) and [`raw-ffi/src/lib.rs:399-475`](../../src/raw-pipeline/raw-ffi/src/lib.rs#L399) (`maple_render_bytes_scene_linear`). The shared Rust helper `render_scene_linear_from_raw_with_quality` at [`pipeline.rs:271-298`](../../src/raw-pipeline/raw-core/src/pipeline.rs#L271) is the function both Apple's FFI and (per this plan) WASM will call.
2. **Legacy `render_bytes` returns `Vec<u8>` sRGB.** Confirmed at [`raw-wasm/src/lib.rs:97-137`](../../src/raw-pipeline/raw-wasm/src/lib.rs#L97). The new entry must not modify or remove it — Plan 3 M3 (separate plan) is the milestone that wires the Web shell to consume the scene-linear path; until then the legacy entry remains the production path.
3. **Worker pattern is request-typed.** Confirmed at [`raw-pipeline.worker.ts:55-58`](../../src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.worker.ts#L55) (`if (req.type !== 'decode') return;`). M1 adds a second branch under the same `addEventListener('message', ...)` and reuses the existing `ensureReady()` / panic-hook plumbing.
4. **`DecodedImage` consumer surface is `Uint8Array`.** Confirmed at [`raw-pipeline.types.ts:47-53`](../../src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.types.ts#L47). The new `DecodedSceneLinearImage` aggregate uses `Uint16Array` (fp16 lanes) — distinct from the legacy type, which keeps the legacy consumer (`image-utils.ts`) untouched.
5. **Vitest is the configured runner.** Confirmed at [`angular.json:220-225`](../../src/web/angular.json#L220) (`@angular/build:unit-test`) and [`tsconfig.spec.json`](../../src/web/projects/maple-common/tsconfig.spec.json) (`"types": ["vitest/globals"]`). [`library-state.service.spec.ts:12`](../../src/web/projects/maple-common/src/lib/state/library-state.service.spec.ts#L12) (`import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';`) is the canonical import shape.
6. **AGX_VERSION pin is enforced by commit `8c32bfe`.** Verified — `git log -1 8c32bfe` shows `fix(apple): sync bundled AgX LUT to Rust AGX_VERSION 5`. The new WASM entry stops **before** AgX (returns scene-linear pre-view-transform), so AgX LUT regen is **not** part of M1; it lands with M2 (the GLSL shaders that consume the LUT in-browser). M1 must not touch `derive_agx_lut.py` or `agx_lut.bin`.
7. **`pub fn stage`** is already public-visible at [`pipeline.rs:31`](../../src/raw-pipeline/raw-core/src/pipeline.rs#L31), and `MAPLE_PROFILE` env-gated timing is documented at [`pipeline.rs:17-29`](../../src/raw-pipeline/raw-core/src/pipeline.rs#L17). The new WASM entry will reuse the same `stage()` calls Apple's FFI uses (`ffi_rawler_decode`, `ffi_pack`) so per-stage timing surfaces in the same shape — verified by setting `MAPLE_PROFILE=1` on the Rust unit test invocation.

**Out of scope (explicit):**
- **M2 — WebGL2 dev-chain shaders.** Five fragment shaders (GLSL ports of Metal kernels: `WhiteBalance.frag`, `SceneToneControls.frag`, `SceneVibrance.frag`, `SceneSaturation.frag`, `AgXViewTransform.frag`). Separate plan. The brief's § 3 + § 6 + § 7 cover the design.
- **M3 — Wire WebGL2 chain into `image-canvas.component.ts`.** Replace the `imageDataToBitmap` paint with the WebGL2 chain. Separate plan. Brief § 3.
- **M4 — Sized FFI variant.** `renderBytesSceneLinearSized(..., maxLongEdge, ...)` parity with Plan 1 Task 8 ([Plan 1 § Task 8](2026-04-24-ffi-split-plan-1.md#task-8-add-the-viewport-sized-scene-linear-ffi-entry-point-and-route-the-editors-first-open-through-it)) and the existing `maple_render_bytes_scene_linear_sized` C entry at [`raw-ffi/src/lib.rs:578`](../../src/raw-pipeline/raw-ffi/src/lib.rs#L578). Separate plan. Brief § 5 + § 8.
- **M5 — Tile rendering.** Parity with the Apple Deep Zoom plan and the existing `maple_render_bytes_scene_linear_tile` C entry at [`raw-ffi/src/lib.rs:777`](../../src/raw-pipeline/raw-ffi/src/lib.rs#L777). Separate plan. Brief § 8.
- **WebGL2 capability probe / feature detection.** Lives with M2; M1 returns a buffer agnostic to whatever consumer eventually paints it.
- **AgX LUT in-browser delivery.** Lives with M2 (the GLSL fragment shader is the LUT consumer). M1 is pre-AgX by definition.
- **`src/scripts/codegen/` directory creation.** Brief § 7 + § 9 says this is needed for M2's GLSL `const float` blocks; M1 stops before any color-math constant lands in GLSL. Separate plan creates the codegen subdir.
- **Removing the legacy `render_bytes`.** The brief's § 2 originally proposed dropping it; the cross-link to Plan 1 [§ Out of scope](2026-04-24-ffi-split-plan-1.md#out-of-scope-explicit) explicitly defers legacy FFI deletion to "Plan 3 deletes [it] once the Web port is done." M1 is **before** the Web port — legacy stays.

---

## File Structure

**Rust (read-write):**
- Modify: `src/raw-pipeline/raw-wasm/src/lib.rs` — add a new `MapleSceneLinearRender` `#[wasm_bindgen]` struct (mirrors `MapleSceneLinearBuffer` field-for-field minus the raw pointer; wasm-bindgen owns the `Vec<u16>` and the JS getter handles the `Uint16Array` view) and a new `render_bytes_scene_linear` function that calls `raw_core::pipeline::render_scene_linear_from_raw_with_quality`. Both entries live side by side (no removal, no rename of the legacy entry). The `estimate_cct_from_neutral` helper at [`raw-wasm/src/lib.rs:79-84`](../../src/raw-pipeline/raw-wasm/src/lib.rs#L79) is shared with the legacy entry — no duplication.

**Rust (read-only during verification):**
- `src/raw-pipeline/raw-core/src/pipeline.rs` — `render_scene_linear_from_raw_with_quality` ([`pipeline.rs:271`](../../src/raw-pipeline/raw-core/src/pipeline.rs#L271)) and `develop_scene_linear_from_raw_with_quality` ([`pipeline.rs:77`](../../src/raw-pipeline/raw-core/src/pipeline.rs#L77)) are the helpers the new entry consumes.
- `src/raw-pipeline/raw-ffi/src/lib.rs` — `MapleSceneLinearBuffer` ([line 282](../../src/raw-pipeline/raw-ffi/src/lib.rs#L282)) and `maple_render_bytes_scene_linear` ([line 399](../../src/raw-pipeline/raw-ffi/src/lib.rs#L399)) are the Apple template the WASM entry mirrors. `as_shot_temperature` / `as_shot_tint` derivation lives in `raw-core` decode metadata and is reused via the existing `estimate_cct_from_neutral` helper in raw-wasm.

**Rust (read-only — must NOT modify):**
- `src/raw-pipeline/raw-wasm/Cargo.toml` — no new dependencies. `raw-core` already exposes `pipeline::render_scene_linear_from_raw_with_quality`; `wasm-bindgen` already converts `Vec<u16>` to `Uint16Array`. **Confirm by Step 2.5: `cargo check -p raw-wasm` after the lib.rs edit must succeed without touching Cargo.toml.**

**TypeScript / Angular (read-write):**
- Modify: `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.types.ts` — add `DecodeSceneLinearRequest`, `DecodeSceneLinearSuccess`, `DecodeSceneLinearError`, `DecodedSceneLinearImage`. Update the `WorkerResponse` union to include the new success/error types. Existing `DecodeRequest` / `DecodeSuccess` / `DecodedImage` unchanged.
- Modify: `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.worker.ts` — import the new WASM entry alongside `render_bytes`, dispatch on `req.type` to add a `'decode-scene-linear'` branch.
- Modify: `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts` — add `decodeSceneLinear(bytes, ext, xmp?)` returning `Promise<DecodedSceneLinearImage>`. Reuse the existing `decodeChain` serialization gate, the existing `pending` map (extended to take a `DecodedSceneLinearImage` resolver), and the existing perf marks.

**TypeScript tests (read-write):**
- Add: `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.spec.ts` — vitest spec that mocks the Worker constructor and verifies the round-trip produces a `Uint16Array` of expected byte length and the metadata fields propagate.

**TypeScript (read-only during verification):**
- `src/web/projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm.d.ts` — generated by `wasm-pack build`. Confirm the new entry name and its return type after a build (Step 2.6 / Step 5.1).
- `src/web/projects/maple-common/src/public-api.ts` — line 16 (`export * from './lib/raw-pipeline/raw-pipeline.types';`) re-exports the new types automatically; no manual edit needed.

---

## Ordering constraint

**Tasks must run in order. Each task ends with a commit.**
- Task 1 (Rust WASM entry + raw-core unit test) **must** land first — the TS types in Task 2 depend on the WASM `.d.ts` regeneration.
- Task 2 (TS types) lands next — narrowing the union before the worker uses it.
- Task 3 (worker dispatch) consumes Task 2's types and Task 1's regenerated `.d.ts`.
- Task 4 (service method) consumes Task 3's worker contract.
- Task 5 (TS unit test) consumes Task 4's service method and runs the full round-trip via mocks.
- Task 6 (build verification gate) runs the full pipeline end-to-end with the actual built WASM and confirms no regression of the legacy `render_bytes` path.

If Task 6 finds a regression in the legacy path, **stop and report**. M1's invariant is "purely additive" — any test or behavior on `render_bytes` that drifts is a Plan 3 M1 bug.

---

## Task 1: Add `render_bytes_scene_linear` WASM entry

**Files:**
- Modify: `src/raw-pipeline/raw-wasm/src/lib.rs`

**Why this matters:** The new WASM entry mirrors Apple's `maple_render_bytes_scene_linear` ([`raw-ffi/src/lib.rs:399-475`](../../src/raw-pipeline/raw-ffi/src/lib.rs#L399)) minus the C struct and the file-system path variant. wasm-bindgen handles the `Vec<u16> → Uint16Array` boundary automatically; we just need a `#[wasm_bindgen]` struct with a `Uint16Array` getter. The legacy `render_bytes` is not removed; both entries coexist exactly as Apple's C-FFI keeps `maple_render_bytes` and `maple_render_bytes_scene_linear` side by side.

- [ ] **Step 1.1: Read the existing WASM entry end-to-end so the new one is structurally consistent.**

Read `src/raw-pipeline/raw-wasm/src/lib.rs` lines 1-143. Confirm the existing `MapleRender` struct ([line 45-52](../../src/raw-pipeline/raw-wasm/src/lib.rs#L45)) shape, the `render_bytes` function ([line 97-137](../../src/raw-pipeline/raw-wasm/src/lib.rs#L97)) including its `as_shot_temperature` / `as_shot_tint` derivation and the `fresh_open` substitution branch ([line 114-126](../../src/raw-pipeline/raw-wasm/src/lib.rs#L114)), and the `estimate_cct_from_neutral` helper ([line 79-84](../../src/raw-pipeline/raw-wasm/src/lib.rs#L79)). The new entry copies all of this verbatim except for the rendering call (returns `Vec<u16>` fp16 lanes instead of `Vec<u8>` sRGB).

- [ ] **Step 1.2: Add an `#[ignore]` raw-core integration test for the new entry — verifies the helper round-trips.**

Append the following test module to `src/raw-pipeline/raw-wasm/src/lib.rs` at end-of-file. The test runs as a normal `cargo test` (i.e. without `wasm-pack test`) because `raw-core::pipeline::render_scene_linear_from_raw_with_quality` is target-independent Rust:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Synthesized 8x8 mosaic round-trip — proves the new entry returns
    /// fp16 RGBA with alpha lane = 0x3c00 (fp16 1.0) and a buffer length
    /// of 8*w*h bytes (i.e. 4 channels * 2 bytes/lane * w * h).
    ///
    /// We don't have a fixture DNG checked in (raws are gitignored), but
    /// the function is layered on `raw_core::pipeline::render_scene_linear_*`
    /// which has its own fixture-gated tests upstream. This test instead
    /// uses the smallest valid synthetic input we can: a tiny embedded DNG
    /// generated by `cargo test -p raw-core` fixtures. Skip when the
    /// fixture isn't available.
    #[test]
    #[ignore = "requires test-fixtures/raws/* (gitignored); run with --ignored"]
    fn render_bytes_scene_linear_returns_fp16_rgba_with_alpha_one() {
        // Path mirror of the helper test in raw-core; this test only runs
        // when the engineer has the fixtures locally.
        let path = std::path::PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR").unwrap()
        ).join("../test-fixtures/raws/dji-mavic3pro-100mp.dng");
        if !path.exists() {
            eprintln!("fixture missing at {:?} — skipping", path);
            return;
        }
        let bytes = std::fs::read(&path).expect("read fixture");
        let result = render_bytes_scene_linear(&bytes, "dng", None, true)
            .expect("render_bytes_scene_linear ok");
        let w = result.width();
        let h = result.height();
        assert!(w > 0 && h > 0, "non-zero dimensions");
        let lanes: Vec<u16> = result.fp16_rgba();
        assert_eq!(
            lanes.len(),
            (w as usize) * (h as usize) * 4,
            "expected 4 fp16 lanes per pixel (RGBA)"
        );
        // Alpha lane (every 4th u16) must be fp16 1.0 = 0x3c00.
        // Sample the first 16 pixels — covers the top-left tile and is
        // cheap.
        for i in 0..16.min(w as usize * h as usize) {
            let alpha = lanes[i * 4 + 3];
            assert_eq!(
                alpha, 0x3c00,
                "pixel {} alpha was 0x{:04x}, expected fp16 1.0 (0x3c00)",
                i, alpha
            );
        }
        // Sanity: at least one of the first 256 R/G/B lanes is non-zero
        // (the synthetic input has signal).
        let any_nonzero_rgb = (0..256.min(w as usize * h as usize))
            .any(|i| lanes[i * 4] != 0 || lanes[i * 4 + 1] != 0 || lanes[i * 4 + 2] != 0);
        assert!(any_nonzero_rgb, "all R/G/B lanes were zero — pipeline failure");
    }
}
```

- [ ] **Step 1.3: Run the test to verify it fails ("function not defined") before adding the implementation.**

Run: `cd src/raw-pipeline && cargo test -p raw-wasm tests::render_bytes_scene_linear_returns_fp16_rgba_with_alpha_one --no-run 2>&1 | tail -20`

Expected: `error[E0425]: cannot find function 'render_bytes_scene_linear' in this scope` (or equivalent compilation failure).

- [ ] **Step 1.4: Add the `MapleSceneLinearRender` struct and the `render_bytes_scene_linear` entry.**

In `src/raw-pipeline/raw-wasm/src/lib.rs`, append the following block **immediately after** the closing brace of the `render_bytes` function (after line 137) and **before** the `version()` function (currently at line 140):

```rust
/// Scene-linear FFI return type — Rec.2020 fp16 RGBA, straight alpha,
/// row-major. Mirrors Apple's `MapleSceneLinearBuffer` C struct at
/// `raw-ffi/src/lib.rs:283-308` minus the raw pointer (wasm-bindgen owns
/// the `Vec<u16>`; the JS getter exposes it as a `Uint16Array` view, which
/// is the same bit pattern as the Apple buffer).
///
/// Plan 3 M1 — see docs/superpowers/plans/2026-04-25-plan-3-web-ffi-split-m1.md.
#[wasm_bindgen]
pub struct MapleSceneLinearRender {
    width: u32,
    height: u32,
    fp16_rgba: Vec<u16>,
    as_shot_temperature: f32,
    as_shot_tint: f32,
}

#[wasm_bindgen]
impl MapleSceneLinearRender {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }
    /// fp16 RGBA lanes (4 channels, 2 bytes per lane). Length is always
    /// `4 * width * height`. Alpha lane is fp16 1.0 (`0x3c00`).
    /// Returned as `Uint16Array` over the WASM heap on the JS side.
    #[wasm_bindgen(getter)]
    pub fn fp16_rgba(&self) -> Vec<u16> { self.fp16_rgba.clone() }
    /// Bytes per pixel — always 8. Exposed for symmetry with Apple's
    /// `MapleSceneLinearBuffer.bytes_per_pixel` so future bit-depth
    /// changes (HDR / fp32) don't break the JS consumer.
    #[wasm_bindgen(getter)]
    pub fn bytes_per_pixel(&self) -> u32 { 8 }
    /// Channels per pixel — always 4 (R, G, B, A).
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 { 4 }
    /// Camera "As Shot" CCT in Kelvin — see `MapleRender::as_shot_temperature`.
    #[wasm_bindgen(getter)]
    pub fn as_shot_temperature(&self) -> f32 { self.as_shot_temperature }
    /// Camera "As Shot" tint in slider units (-100..100).
    #[wasm_bindgen(getter)]
    pub fn as_shot_tint(&self) -> f32 { self.as_shot_tint }
}

/// Render a RAW from bytes to a scene-linear Rec.2020 fp16 RGBA buffer.
/// Pre-AgX, pre-Rec.2020->sRGB — the caller (Plan 3 M2 GLSL chain) is
/// expected to apply the AgX view transform and gamut convert before
/// display. **Mirrors the legacy `render_bytes` semantics** for the
/// non-rendering arguments (`ext`, `xmp`, fresh-open WB substitution)
/// but returns fp16 instead of sRGB u8.
///
/// `quality_preview = true` runs the half-res Preview pipeline; `false`
/// runs full-res Full. Same mapping as the legacy entry.
///
/// Plan 3 M1 — see docs/superpowers/plans/2026-04-25-plan-3-web-ffi-split-m1.md.
#[wasm_bindgen]
pub fn render_bytes_scene_linear(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    quality_preview: bool,
) -> Result<MapleSceneLinearRender, JsError> {
    let raw_img = raw_core::decode::decode_bytes(raw, ext)
        .map_err(|e| JsError::new(&e.to_string()))?;

    // Same as_shot derivation as the legacy entry — rawler 0.7 still doesn't
    // surface AsShotTemperature, so we estimate from AsShotNeutral and pass
    // tint through as 0 on cold open. See raw-wasm/src/lib.rs:106-112.
    let as_shot_temperature = raw_img
        .as_shot_cct
        .unwrap_or_else(|| estimate_cct_from_neutral(raw_img.as_shot_neutral));
    let as_shot_tint = 0.0_f32;

    let fresh_open = xmp.is_none();
    let mut model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };
    if fresh_open {
        model.temperature = as_shot_temperature;
        model.tint = as_shot_tint;
    }

    let quality = if quality_preview {
        raw_core::pipeline::RenderQuality::Preview
    } else {
        raw_core::pipeline::RenderQuality::Full
    };
    let (w, h, fp16_rgba) =
        raw_core::pipeline::render_scene_linear_from_raw_with_quality(&raw_img, &model, quality)
            .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(MapleSceneLinearRender {
        width: w,
        height: h,
        fp16_rgba,
        as_shot_temperature,
        as_shot_tint,
    })
}
```

- [ ] **Step 1.5: Confirm Cargo.toml needs no edit.**

Run: `cd src/raw-pipeline && cargo check -p raw-wasm 2>&1 | tail -20`

Expected: `Finished` (or `Compiling raw-wasm v0.1.0` followed by `Finished`). No new dependency hint, no missing-feature error. If `cargo check` complains about missing imports, the new code uses `xmp_mod` (already imported at [`raw-wasm/src/lib.rs:18`](../../src/raw-pipeline/raw-wasm/src/lib.rs#L18)) and `raw_core::{decode, pipeline}` (already in scope via the existing `render_bytes` body) — fix the typo, do **not** add deps.

- [ ] **Step 1.6: Run the new test to verify it passes (or skips when the fixture is absent).**

Run: `cd src/raw-pipeline && cargo test -p raw-wasm tests::render_bytes_scene_linear_returns_fp16_rgba_with_alpha_one -- --ignored 2>&1 | tail -15`

Expected: PASS if `test-fixtures/raws/dji-mavic3pro-100mp.dng` exists locally (per CLAUDE.md § "Build & test — Rust core" the fixture is gitignored; the engineer must have it). If the fixture is absent: the `eprintln! + return` branch trips and the test reports `ok` because `#[ignore]` plus the early return looks like a no-op pass. **Both outcomes are acceptable** — the test is fixture-gated by design, matching the existing pattern at `raw-core/src/pipeline.rs:663` (`render_scene_linear_test_*`).

- [ ] **Step 1.7: Run the full raw-wasm test suite to confirm nothing else broke.**

Run: `cd src/raw-pipeline && cargo test -p raw-wasm 2>&1 | tail -5`

Expected: `test result: ok. <N> passed; 0 failed; 1 ignored` where `1 ignored` is the fixture-gated test we just added (when no fixture is present) — or `<N+1> passed; 0 failed; 0 ignored` when the fixture exists.

- [ ] **Step 1.8: Run the parity harness on the legacy path to confirm the WASM crate addition didn't break the shared raw-core helper.**

Run: `BUDGET=15 ./src/scripts/test_color_pipeline.sh 2>&1 | tail -20`

Expected: PASS — the harness exercises `raw_core::pipeline::render_from_raw_with_quality` (the legacy entry, which calls the same `develop_scene_linear_from_raw_with_quality` helper as the new WASM entry). If the harness fails after a raw-wasm-only edit, something is structurally wrong — `raw-wasm` doesn't expose anything to the harness, so a regression here means the engineer accidentally edited raw-core. Investigate.

- [ ] **Step 1.9: Commit.**

```bash
git add src/raw-pipeline/raw-wasm/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(raw-wasm): add render_bytes_scene_linear entry returning Rec.2020 fp16 RGBA

`render_bytes_scene_linear` wraps the shared raw-core helper
`render_scene_linear_from_raw_with_quality` (commit 9c1bb22)
and returns Rec.2020 fp16 RGBA via wasm-bindgen as a
`MapleSceneLinearRender` JS type. Mirrors Apple's C-FFI
`maple_render_bytes_scene_linear` (raw-ffi/src/lib.rs:399)
field-for-field minus the raw pointer — wasm-bindgen owns
the Vec<u16> and the JS getter exposes a Uint16Array view
with identical bit pattern to Apple's MapleSceneLinearBuffer.

Plan 3 M1 (Web/WASM FFI split, milestone 1). Purely additive
— legacy `render_bytes` (sRGB u8) stays in place and is still
the production path. The new entry is the WASM half of the
"one Rust core, three native pipelines" invariant; M2 (GLSL
shaders) and M3 (canvas wiring) consume it in follow-up plans.

EOF
)"
```

---

## Task 2: Extend TypeScript worker types

**Files:**
- Modify: `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.types.ts`

**Why this matters:** The worker's `WorkerResponse` union must narrow correctly in both consumers (the worker-side post and the service-side receive). Adding a parallel set of types — `DecodeSceneLinearRequest`, `DecodeSceneLinearSuccess`, `DecodeSceneLinearError`, `DecodedSceneLinearImage` — keeps the legacy types byte-identical (matching the M1 invariant "purely additive"). The aggregate `DecodedSceneLinearImage` exposes `Uint16Array` directly so the future M3 consumer can hand it to `texImage2D(..., HALF_FLOAT, ...)` without re-allocating.

- [ ] **Step 2.1: Open the types file and confirm the existing shapes.**

Read `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.types.ts`. Confirm `DecodeRequest` (line 3-9), `DecodeSuccess` (line 11-21), `DecodeError` (line 23-27), `WorkerStatus` (line 29-35), `WorkerLog` (line 37-43), `WorkerResponse` (line 45), `DecodedImage` (line 47-53). The new types follow the same shape with `-scene-linear` discriminator suffix.

- [ ] **Step 2.2: Append the new types to the file.**

Edit `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.types.ts`. After the existing `DecodedImage` interface (line 47-53), append:

```typescript
export interface DecodeSceneLinearRequest {
  id: number; // round-trip correlation id, distinct from DecodeRequest's id space
  type: 'decode-scene-linear';
  bytes: ArrayBuffer; // transferable
  ext: string;
  xmp?: string;
  /**
   * `true` (default) runs the half-res Preview pipeline (matches Apple's
   * editor first-paint). `false` runs full-res Full — used for export.
   */
  qualityPreview: boolean;
}

export interface DecodeSceneLinearSuccess {
  id: number;
  type: 'decode-scene-linear-success';
  width: number;
  height: number;
  /**
   * Transferable fp16 RGBA buffer. Length is `8 * width * height` bytes
   * (4 channels * 2 bytes per fp16 lane). Alpha lane is fp16 1.0 (0x3c00).
   * Same bit pattern as Apple's `MapleSceneLinearBuffer.fp16_rgba`.
   */
  fp16Rgba: ArrayBuffer;
  /** Camera "As Shot" CCT in Kelvin (rawler-derived). */
  asShotTemperature: number;
  /** Camera "As Shot" tint in slider units (-100..100). */
  asShotTint: number;
}

export interface DecodeSceneLinearError {
  id: number;
  type: 'decode-scene-linear-error';
  message: string;
}

/**
 * Worker → main thread aggregate after a successful scene-linear decode.
 * `fp16Rgba` is a `Uint16Array` view over the transferred buffer (no
 * copy on construction). The Plan 3 M3 consumer will pass this directly
 * to `gl.texImage2D(..., gl.RGBA16F, ..., gl.RGBA, gl.HALF_FLOAT, fp16Rgba)`.
 */
export interface DecodedSceneLinearImage {
  width: number;
  height: number;
  fp16Rgba: Uint16Array;
  asShotTemperature: number;
  asShotTint: number;
}
```

- [ ] **Step 2.3: Update the existing `WorkerResponse` union to include the new variants.**

Edit `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.types.ts`. Replace the existing `WorkerResponse` line at line 45:

```typescript
export type WorkerResponse = DecodeSuccess | DecodeError | WorkerStatus | WorkerLog;
```

with:

```typescript
export type WorkerResponse =
  | DecodeSuccess
  | DecodeError
  | DecodeSceneLinearSuccess
  | DecodeSceneLinearError
  | WorkerStatus
  | WorkerLog;
```

- [ ] **Step 2.4: Confirm the types file compiles by running the workspace's typecheck.**

Run: `cd src/web && npx tsc --project projects/maple-common/tsconfig.spec.json --noEmit 2>&1 | tail -20`

Expected: no errors. If there are errors about missing imports in the worker or service, **stop** — those will be fixed in Tasks 3 and 4. The expected output here is silence (clean typecheck) because the new types don't yet have a consumer.

- [ ] **Step 2.5: Commit.**

```bash
git add src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.types.ts
git commit -m "$(cat <<'EOF'
types(maple-common): add scene-linear decode worker types

Adds DecodeSceneLinearRequest / DecodeSceneLinearSuccess /
DecodeSceneLinearError / DecodedSceneLinearImage alongside
the existing legacy decode types. Existing types unchanged.

Plan 3 M1 — the worker dispatch (Task 3) and service method
(Task 4) consume these. fp16Rgba is exposed as Uint16Array
on the consumer side so the future Plan 3 M3 WebGL2 path
can hand it directly to texImage2D(..., HALF_FLOAT, ...) with
no copy.

EOF
)"
```

---

## Task 3: Wire the worker dispatch for scene-linear decodes

**Files:**
- Modify: `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.worker.ts`

**Why this matters:** The worker's existing `addEventListener('message', ...)` early-returns on any `req.type !== 'decode'`. Adding a second branch for `'decode-scene-linear'` keeps the existing `decode` path untouched and reuses the same `ensureReady()` plumbing, the same panic-hook forwarding, and the same `performance.mark` shape. **Critical:** the WASM build artifacts must already include the new entry — Task 6 runs the build; this task assumes the import resolves at TypeScript-typecheck time only (the `.d.ts` regenerates from Step 1.4's Rust).

- [ ] **Step 3.1: Build the WASM pkg so the new entry's TypeScript types appear in `pkg/raw_wasm.d.ts`.**

Run: `cd src/web && npm run build-raw-wasm 2>&1 | tail -10 && bash scripts/sync-raw-wasm.sh 2>&1 | tail -3`

Expected: `[raw-wasm] Build complete: ...` followed by `Synced raw-wasm pkg/ -> ...`. The `pkg/raw_wasm.d.ts` file inside `src/web/projects/maple-common/src/lib/raw-pipeline/pkg/` now exposes `render_bytes_scene_linear` and `MapleSceneLinearRender`. If `wasm-pack` errors out, see CLAUDE.md § "Build & test — Web" for the prerequisites; if the script bails on no-changes-since-last-build, run with `FORCE_WASM_REBUILD=1`.

- [ ] **Step 3.2: Verify the new entry appears in the synced `.d.ts`.**

Run: `grep -n "render_bytes_scene_linear\|MapleSceneLinearRender" src/web/projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm.d.ts 2>&1 | head -10`

Expected: at least three matches — the function declaration, the class declaration, and the `fp16_rgba` getter. If empty, Step 3.1 didn't actually rebuild — `rm -rf src/raw-pipeline/raw-wasm/pkg && cd src/web && npm run raw-wasm` to force a rebuild.

- [ ] **Step 3.3: Update the worker import to include the new entry.**

Edit `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.worker.ts`. Replace the existing line 3:

```typescript
import { render_bytes } from './pkg/raw_wasm';
```

with:

```typescript
import { render_bytes, render_bytes_scene_linear } from './pkg/raw_wasm';
```

- [ ] **Step 3.4: Update the request type import to include the new request types.**

Edit `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.worker.ts`. Replace the existing line 5:

```typescript
import type { DecodeRequest, WorkerResponse } from './raw-pipeline.types';
```

with:

```typescript
import type {
  DecodeRequest,
  DecodeSceneLinearRequest,
  WorkerResponse,
} from './raw-pipeline.types';
```

- [ ] **Step 3.5: Replace the message-listener body with one that dispatches on `req.type`.**

Edit `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.worker.ts`. Replace the entire `addEventListener('message', ...)` block (currently lines 55-98) with:

```typescript
addEventListener(
  'message',
  async (event: MessageEvent<DecodeRequest | DecodeSceneLinearRequest>) => {
    const req = event.data;
    if (req.type === 'decode') {
      await handleLegacyDecode(req);
      return;
    }
    if (req.type === 'decode-scene-linear') {
      await handleSceneLinearDecode(req);
      return;
    }
    // Unknown request type — silently ignore (matches the prior early-return shape).
  },
);

async function handleLegacyDecode(req: DecodeRequest): Promise<void> {
  try {
    await ensureReady();
    const bytes = new Uint8Array(req.bytes);
    performance.mark(`maple:wasm:${req.id}:start`);
    const result = render_bytes(bytes, req.ext, req.xmp ?? null);
    performance.mark(`maple:wasm:${req.id}:end`);
    performance.measure(
      `maple:wasm`,
      `maple:wasm:${req.id}:start`,
      `maple:wasm:${req.id}:end`,
    );
    const rgb = result.rgb;
    const buffer = rgb.buffer.slice(rgb.byteOffset, rgb.byteOffset + rgb.byteLength);
    const response: WorkerResponse = {
      id: req.id,
      type: 'decode-success',
      width: result.width,
      height: result.height,
      rgb: buffer,
      asShotTemperature: result.as_shot_temperature,
      asShotTint: result.as_shot_tint,
    };
    (self as unknown as Worker).postMessage(response, [buffer]);
  } catch (e) {
    const err = e instanceof Error ? e : null;
    if (err?.stack) {
      console.error('[raw-pipeline.worker] decode threw:', err.message, err.stack);
    }
    const response: WorkerResponse = {
      id: req.id,
      type: 'decode-error',
      message: err?.message ?? String(e),
    };
    (self as unknown as Worker).postMessage(response);
  }
}

async function handleSceneLinearDecode(req: DecodeSceneLinearRequest): Promise<void> {
  try {
    await ensureReady();
    const bytes = new Uint8Array(req.bytes);
    // Worker-local mark mirrors the legacy `maple:wasm` perf entry.
    performance.mark(`maple:wasm-scene-linear:${req.id}:start`);
    const result = render_bytes_scene_linear(
      bytes,
      req.ext,
      req.xmp ?? null,
      req.qualityPreview,
    );
    performance.mark(`maple:wasm-scene-linear:${req.id}:end`);
    performance.measure(
      `maple:wasm-scene-linear`,
      `maple:wasm-scene-linear:${req.id}:start`,
      `maple:wasm-scene-linear:${req.id}:end`,
    );
    // wasm-bindgen returns a Uint16Array; slice its underlying buffer so
    // we can transfer it (avoid the main thread holding a copy).
    const lanes = result.fp16_rgba;
    const buffer = lanes.buffer.slice(
      lanes.byteOffset,
      lanes.byteOffset + lanes.byteLength,
    ) as ArrayBuffer;
    const response: WorkerResponse = {
      id: req.id,
      type: 'decode-scene-linear-success',
      width: result.width,
      height: result.height,
      fp16Rgba: buffer,
      asShotTemperature: result.as_shot_temperature,
      asShotTint: result.as_shot_tint,
    };
    (self as unknown as Worker).postMessage(response, [buffer]);
  } catch (e) {
    const err = e instanceof Error ? e : null;
    if (err?.stack) {
      console.error(
        '[raw-pipeline.worker] decode-scene-linear threw:',
        err.message,
        err.stack,
      );
    }
    const response: WorkerResponse = {
      id: req.id,
      type: 'decode-scene-linear-error',
      message: err?.message ?? String(e),
    };
    (self as unknown as Worker).postMessage(response);
  }
}
```

- [ ] **Step 3.6: Run the workspace typecheck to confirm the worker compiles.**

Run: `cd src/web && npx tsc --project projects/maple-common/tsconfig.spec.json --noEmit 2>&1 | tail -20`

Expected: no errors. The worker's `result.fp16_rgba` getter is typed as `Uint16Array` by wasm-bindgen's generated `.d.ts` (verified in Step 3.2).

- [ ] **Step 3.7: Run the existing maple-common test suite to confirm nothing else broke.**

Run: `cd src/web && npm test -- --include='projects/maple-common/**/*.spec.ts' --run 2>&1 | tail -20`

Expected: PASS for all existing tests. The library-state and maple-common specs do not import from `raw-pipeline.worker.ts` (a Worker file is loaded by URL, not by `import`), so they should be unaffected.

- [ ] **Step 3.8: Commit.**

```bash
git add src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.worker.ts
git commit -m "$(cat <<'EOF'
feat(maple-common): add scene-linear decode branch to raw-pipeline.worker

Splits the worker's `message` handler into two named helpers
(handleLegacyDecode, handleSceneLinearDecode) and dispatches
on req.type. The legacy decode path is byte-identical to the
prior implementation; the new branch calls the
`render_bytes_scene_linear` WASM entry from Plan 3 M1 Task 1
and posts back a transferable fp16 RGBA ArrayBuffer.

Plan 3 M1 — the service method (Task 4) wraps both branches
with the same serialization gate and Promise plumbing.

EOF
)"
```

---

## Task 4: Add `decodeSceneLinear` to RawPipelineService

**Files:**
- Modify: `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts`

**Why this matters:** The service must expose a typed Promise-based entry that the future M3 canvas consumer can call without knowing about the worker. The new method reuses the existing `decodeChain` serialization gate (single in-flight WASM decode — see comment at [`raw-pipeline.service.ts:91-97`](../../src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts#L91)) so two concurrent scene-linear decodes (or one scene-linear + one legacy) cannot blow past the 4 GiB wasm32 cap. The `pending` map's value type widens to a union of resolvers because the same map services both response types.

- [ ] **Step 4.1: Read the existing service implementation.**

Read `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts` lines 1-149. Confirm the `pending` map shape (line 22-28), the `decodeChain` queue (line 97-105), and the `decodeOnce` promise wiring (line 108-141). The new method copies the structure of `decode` / `decodeOnce` and replaces only the body that posts to the worker and resolves the promise.

- [ ] **Step 4.2: Update the imports to include the new types.**

Edit `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts`. Replace the existing imports at lines 12-16:

```typescript
import type {
  DecodedImage,
  DecodeRequest,
  WorkerResponse,
} from './raw-pipeline.types';
```

with:

```typescript
import type {
  DecodedImage,
  DecodedSceneLinearImage,
  DecodeRequest,
  DecodeSceneLinearRequest,
  WorkerResponse,
} from './raw-pipeline.types';
```

- [ ] **Step 4.3: Widen the `pending` map's value type to a union of resolvers.**

Edit `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts`. Replace the existing `pending` field at lines 22-28:

```typescript
  private pending = new Map<
    number,
    {
      resolve: (img: DecodedImage) => void;
      reject: (err: Error) => void;
    }
  >();
```

with:

```typescript
  private pending = new Map<
    number,
    | {
        kind: 'legacy';
        resolve: (img: DecodedImage) => void;
        reject: (err: Error) => void;
      }
    | {
        kind: 'scene-linear';
        resolve: (img: DecodedSceneLinearImage) => void;
        reject: (err: Error) => void;
      }
  >();
```

- [ ] **Step 4.4: Update the worker `message` listener inside `ensureWorker` to dispatch on the new response types.**

Edit `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts`. Replace the body of the `message` listener inside `ensureWorker` (currently lines 48-76, the block starting `this.worker.addEventListener('message', ...)`):

```typescript
      this.worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === 'worker-log') {
          const prefix = '[raw-pipeline worker]';
          if (msg.level === 'error') console.error(prefix, msg.text);
          else if (msg.level === 'warn') console.warn(prefix, msg.text);
          else console.log(prefix, msg.text);
          return;
        }
        if (msg.type === 'status') {
          this.threadedSubject.next(msg.threaded);
          this.threadCountSubject.next(msg.threads);
          return;
        }
        const handler = this.pending.get(msg.id);
        if (!handler) return;
        this.pending.delete(msg.id);
        if (msg.type === 'decode-success' && handler.kind === 'legacy') {
          handler.resolve({
            width: msg.width,
            height: msg.height,
            rgb: new Uint8Array(msg.rgb),
            asShotTemperature: msg.asShotTemperature,
            asShotTint: msg.asShotTint,
          });
        } else if (msg.type === 'decode-error' && handler.kind === 'legacy') {
          handler.reject(new Error(msg.message));
        } else if (
          msg.type === 'decode-scene-linear-success' &&
          handler.kind === 'scene-linear'
        ) {
          handler.resolve({
            width: msg.width,
            height: msg.height,
            fp16Rgba: new Uint16Array(msg.fp16Rgba),
            asShotTemperature: msg.asShotTemperature,
            asShotTint: msg.asShotTint,
          });
        } else if (
          msg.type === 'decode-scene-linear-error' &&
          handler.kind === 'scene-linear'
        ) {
          handler.reject(new Error(msg.message));
        } else {
          // Mismatched response type and handler kind — should never happen
          // because ids are unique and the worker only emits success/error
          // matching the request type. Reject defensively to avoid hangs.
          handler.reject(
            new Error(`raw-pipeline: handler kind mismatch (${msg.type})`),
          );
        }
      });
```

- [ ] **Step 4.5: Add the `decodeSceneLinear` public method and its private `decodeSceneLinearOnce` helper.**

Edit `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts`. Append the following methods **after** the existing `decodeOnce` method (after the closing brace currently at line 141, before the `ngOnDestroy` method at line 143):

```typescript

  /**
   * Decode a RAW byte buffer to a scene-linear Rec.2020 fp16 RGBA image.
   * Pre-AgX, pre-Rec.2020->sRGB — the caller (Plan 3 M3 WebGL2 chain) is
   * expected to apply a view transform before display.
   *
   * Shares the same single-in-flight serialization gate as `decode()` —
   * concurrent calls (across either method) are queued so the WASM heap
   * never holds more than one decode's scratch buffers at once.
   *
   * @param qualityPreview `true` (default) runs the half-res Preview
   *   pipeline (matches Apple's editor first-paint cost). `false` runs
   *   full-res Full — used for export.
   */
  decodeSceneLinear(
    bytes: Uint8Array,
    ext: string,
    xmp?: string,
    qualityPreview: boolean = true,
  ): Promise<DecodedSceneLinearImage> {
    const run = () => this.decodeSceneLinearOnce(bytes, ext, xmp, qualityPreview);
    const next = this.decodeChain.then(run, run);
    this.decodeChain = next.catch(() => undefined);
    return next;
  }

  private decodeSceneLinearOnce(
    bytes: Uint8Array,
    ext: string,
    xmp: string | undefined,
    qualityPreview: boolean,
  ): Promise<DecodedSceneLinearImage> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      return Promise.reject(new Error('RawPipelineService: worker unavailable'));
    }
    const id = this.nextId++;
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const request: DecodeSceneLinearRequest = {
      id,
      type: 'decode-scene-linear',
      bytes: buffer,
      ext,
      xmp,
      qualityPreview,
    };
    performance.mark(`maple:decode-scene-linear:${id}:start`);
    return new Promise<DecodedSceneLinearImage>((resolve, reject) => {
      this.pending.set(id, {
        kind: 'scene-linear',
        resolve: (result) => {
          performance.mark(`maple:decode-scene-linear:${id}:end`);
          performance.measure(
            `maple:decode-scene-linear`,
            `maple:decode-scene-linear:${id}:start`,
            `maple:decode-scene-linear:${id}:end`,
          );
          resolve(result);
        },
        reject,
      });
      worker.postMessage(request, [buffer]);
    });
  }
```

- [ ] **Step 4.6: Update the legacy `decodeOnce` to set the new `kind: 'legacy'` discriminant.**

Edit `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts`. Inside the existing `decodeOnce` method, find the `this.pending.set(id, { ... })` call (around lines 127-138 in the pre-edit file). Add `kind: 'legacy',` as the first field:

```typescript
      this.pending.set(id, {
        kind: 'legacy',
        resolve: (result) => {
          performance.mark(`maple:decode:${id}:end`);
          performance.measure(
            `maple:decode`,
            `maple:decode:${id}:start`,
            `maple:decode:${id}:end`,
          );
          resolve(result);
        },
        reject,
      });
```

- [ ] **Step 4.7: Run the workspace typecheck to confirm the service compiles.**

Run: `cd src/web && npx tsc --project projects/maple-common/tsconfig.spec.json --noEmit 2>&1 | tail -20`

Expected: no errors. The discriminated union on `pending` narrows correctly because each branch in the listener checks both `msg.type` and `handler.kind`.

- [ ] **Step 4.8: Commit.**

```bash
git add src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts
git commit -m "$(cat <<'EOF'
feat(maple-common): add decodeSceneLinear to RawPipelineService

`decodeSceneLinear(bytes, ext, xmp?, qualityPreview?)` returns
a Promise<DecodedSceneLinearImage> with Uint16Array fp16 RGBA
plus the same as_shot_* metadata as the legacy `decode()`.
Both methods share the same `decodeChain` queue so concurrent
calls are serialised — keeping the WASM heap below the 4 GiB
wasm32 cap regardless of which entry is invoked.

The `pending` map's value type widens to a discriminated
union (`kind: 'legacy' | 'scene-linear'`) so the message
listener's narrowing stays type-safe across both response
shapes.

Plan 3 M1 — the service is the public entry future Plan 3 M3
will call from `image-canvas.component.ts`.

EOF
)"
```

---

## Task 5: TypeScript unit test for the round-trip

**Files:**
- Create: `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.spec.ts`

**Why this matters:** Verifies that the service correctly wires a `DecodeSceneLinearRequest` to a `DecodeSceneLinearSuccess` round-trip and produces a `DecodedSceneLinearImage` with the expected `Uint16Array` length and metadata fields. Mocks the Worker constructor — we can't run actual WASM in a vitest environment without a build step that's already covered by Task 1 (Rust-side raw-core test). The test surface here is the service's TS plumbing, not the WASM render itself.

- [ ] **Step 5.1: Confirm the WASM pkg is still present (Task 3 Step 3.1 created it).**

Run: `ls src/web/projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm.d.ts 2>&1`

Expected: the file exists. If not, re-run `cd src/web && npm run raw-wasm` (per Task 3 Step 3.1).

- [ ] **Step 5.2: Create the spec file with a failing test.**

Create `src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.spec.ts` with the following content:

```typescript
// RawPipelineService — Plan 3 M1 scene-linear decode round-trip test.
//
// Mocks the Worker constructor so the service's posted request and the
// worker's reply are exchanged synchronously through a Subject. The WASM
// render itself is exercised by raw-core's fixture-gated tests; this
// spec covers the TS plumbing on the main-thread side.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { RawPipelineService } from './raw-pipeline.service';
import type {
  DecodeSceneLinearRequest,
  DecodeSceneLinearSuccess,
} from './raw-pipeline.types';

/**
 * Minimal Worker stub. Captures the most recently posted message and
 * exposes a `reply(...)` method the test calls to feed a response back
 * into the service's listener. Avoids spinning up a real Web Worker
 * (vitest's default jsdom environment doesn't bundle the WASM, and we
 * don't want this spec to be flaky on raw-wasm rebuilds).
 */
class WorkerStub {
  readonly postMessage = vi.fn<(msg: unknown, transfer?: Transferable[]) => void>();
  readonly terminate = vi.fn();
  private listeners: Record<string, ((e: unknown) => void)[]> = {
    message: [],
    error: [],
  };

  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== fn);
  }

  dispatchEvent(_e: Event): boolean {
    return true;
  }

  reply(payload: unknown): void {
    for (const fn of this.listeners['message'] ?? []) {
      fn({ data: payload } as unknown as MessageEvent);
    }
  }
}

describe('RawPipelineService — decodeSceneLinear (Plan 3 M1)', () => {
  let workerStub: WorkerStub;
  let originalWorker: typeof Worker;

  beforeEach(() => {
    workerStub = new WorkerStub();
    originalWorker = globalThis.Worker;
    // Replace the Worker constructor for the duration of the test. The
    // service's `new Worker(...)` call returns our stub.
    globalThis.Worker = vi.fn(() => workerStub) as unknown as typeof Worker;
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
  });

  it('round-trips a 2x2 scene-linear decode and exposes Uint16Array fp16 RGBA', async () => {
    const service = TestBed.inject(RawPipelineService);

    const inputBytes = new Uint8Array([0x44, 0x4e, 0x47, 0x00]); // junk DNG signature
    const promise = service.decodeSceneLinear(inputBytes, 'dng', undefined, true);

    // The service posts its request on `decodeChain.then(...)`, which is
    // a microtask. Flush it.
    await Promise.resolve();
    expect(workerStub.postMessage).toHaveBeenCalledTimes(1);
    const sent = workerStub.postMessage.mock.calls[0][0] as DecodeSceneLinearRequest;
    expect(sent.type).toBe('decode-scene-linear');
    expect(sent.ext).toBe('dng');
    expect(sent.qualityPreview).toBe(true);
    expect(sent.bytes).toBeInstanceOf(ArrayBuffer);

    // Build a synthetic 2x2 fp16 RGBA buffer: 2*2*4 = 16 lanes, 32 bytes.
    // Alpha lane (0x3c00) every 4th u16; rest zero. This matches the
    // bit-pattern Apple's MapleSceneLinearBuffer would produce on a
    // black 2x2 input.
    const w = 2;
    const h = 2;
    const lanes = new Uint16Array(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      lanes[i * 4 + 3] = 0x3c00; // fp16 1.0
    }
    const fp16Rgba = lanes.buffer;

    const reply: DecodeSceneLinearSuccess = {
      id: sent.id,
      type: 'decode-scene-linear-success',
      width: w,
      height: h,
      fp16Rgba,
      asShotTemperature: 5500,
      asShotTint: 0,
    };
    workerStub.reply(reply);

    const decoded = await promise;
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(decoded.fp16Rgba).toBeInstanceOf(Uint16Array);
    expect(decoded.fp16Rgba.length).toBe(w * h * 4);
    // Alpha lane preserved.
    for (let i = 0; i < w * h; i += 1) {
      expect(decoded.fp16Rgba[i * 4 + 3]).toBe(0x3c00);
    }
    expect(decoded.asShotTemperature).toBe(5500);
    expect(decoded.asShotTint).toBe(0);
  });

  it('rejects when the worker posts a decode-scene-linear-error', async () => {
    const service = TestBed.inject(RawPipelineService);
    const promise = service.decodeSceneLinear(new Uint8Array([0]), 'dng');

    await Promise.resolve();
    const sent = workerStub.postMessage.mock.calls[0][0] as DecodeSceneLinearRequest;
    workerStub.reply({
      id: sent.id,
      type: 'decode-scene-linear-error',
      message: 'simulated decode failure',
    });

    await expect(promise).rejects.toThrow('simulated decode failure');
  });

  it('serialises two concurrent scene-linear decodes through decodeChain', async () => {
    const service = TestBed.inject(RawPipelineService);
    const p1 = service.decodeSceneLinear(new Uint8Array([0]), 'dng');
    const p2 = service.decodeSceneLinear(new Uint8Array([1]), 'dng');

    await Promise.resolve();
    // Only the first request should have been posted at this point.
    expect(workerStub.postMessage).toHaveBeenCalledTimes(1);
    const first = workerStub.postMessage.mock.calls[0][0] as DecodeSceneLinearRequest;

    // Resolve the first; the second should then post.
    workerStub.reply({
      id: first.id,
      type: 'decode-scene-linear-success',
      width: 1,
      height: 1,
      fp16Rgba: new Uint16Array([0, 0, 0, 0x3c00]).buffer,
      asShotTemperature: 5500,
      asShotTint: 0,
    });
    await p1;
    await Promise.resolve();
    expect(workerStub.postMessage).toHaveBeenCalledTimes(2);
    const second = workerStub.postMessage.mock.calls[1][0] as DecodeSceneLinearRequest;
    workerStub.reply({
      id: second.id,
      type: 'decode-scene-linear-success',
      width: 1,
      height: 1,
      fp16Rgba: new Uint16Array([0, 0, 0, 0x3c00]).buffer,
      asShotTemperature: 5500,
      asShotTint: 0,
    });
    await p2;
  });
});
```

- [ ] **Step 5.3: Run the new spec file to verify it passes.**

Run: `cd src/web && npx vitest run projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.spec.ts 2>&1 | tail -20`

Expected: 3 tests pass. If `globalThis.Worker = ...` errors out under vitest's jsdom (newer jsdom versions enforce a non-writable Worker getter), wrap the assignment with `Object.defineProperty(globalThis, 'Worker', { value: ..., writable: true, configurable: true })`. If `RawPipelineService`'s `ensureWorker` throws because the Worker URL constructor fails in jsdom, mock `URL` similarly — the existing legacy `library-state.service.spec.ts` doesn't construct a Worker, but our spec does, so this is the test's load-bearing setup.

- [ ] **Step 5.4: Run the full maple-common test suite to confirm the new spec doesn't break the existing suite.**

Run: `cd src/web && npm test -- --include='projects/maple-common/**/*.spec.ts' --run 2>&1 | tail -20`

Expected: all existing specs plus the 3 new ones pass.

- [ ] **Step 5.5: Commit.**

```bash
git add src/web/projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service.spec.ts
git commit -m "$(cat <<'EOF'
test(maple-common): cover decodeSceneLinear round-trip via Worker stub

Three vitest cases:
1. Round-trip — service posts a DecodeSceneLinearRequest and
   resolves to DecodedSceneLinearImage with Uint16Array fp16
   RGBA preserving the alpha-lane bit pattern (0x3c00).
2. Error path — reject propagates from
   decode-scene-linear-error.
3. Serialisation — two concurrent decodeSceneLinear calls are
   queued through `decodeChain` so only one is in-flight at a
   time.

Plan 3 M1 — covers the service's TS plumbing. The WASM render
itself is exercised by the raw-core fixture-gated test added
in Task 1.

EOF
)"
```

---

## Task 6: Build verification gate

**Files:**
- (No file edits — runs the full build + the legacy regression check.)

**Why this matters:** M1's invariant is "purely additive — Web Angular shell still draws the legacy sRGB path." Task 6 is the gate: rebuild the WASM with the new entry, sync into maple-common, run the full Angular `ng build` + the maple-common tests, and confirm the legacy `decode()` path's behavior is byte-identical to pre-M1.

- [ ] **Step 6.1: Force a clean WASM rebuild (no incremental cache).**

Run: `cd src/raw-pipeline/raw-wasm && rm -rf pkg && cd /Users/riabuz/Projects/_Maple/.claude/worktrees/keen-gould-063563 && cd src/web && FORCE_WASM_REBUILD=1 npm run raw-wasm 2>&1 | tail -10`

Expected: `[raw-wasm] Build complete: ...` and `Synced raw-wasm pkg/ -> ...`. The fresh build proves no stale incremental artifacts hide the Rust↔TS contract drift.

- [ ] **Step 6.2: Confirm the new entry exists in the synced bundle.**

Run: `grep -c "render_bytes_scene_linear\|MapleSceneLinearRender" src/web/projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm.d.ts 2>&1`

Expected: a count of at least 4 (function declaration, class declaration, constructor type, getters). If 0 or 1, the build silently skipped the new code — re-check Task 1 Step 1.4.

- [ ] **Step 6.3: Run the full maple-common test suite.**

Run: `cd src/web && npm test -- --include='projects/maple-common/**/*.spec.ts' --run 2>&1 | tail -30`

Expected: all specs pass — legacy library-state, maple-common-component, and the new raw-pipeline.service spec.

- [ ] **Step 6.4: Run the maple-hosted production build to confirm the worker bundles cleanly.**

Run: `cd src/web && npm run build:hosted 2>&1 | tail -25`

Expected: `Built` followed by chunk sizes. The worker file (`raw-pipeline.worker.ts`) is bundled by Angular's `@angular/build` builder; if the import path or the wasm-bindgen `.d.ts` is stale, this step surfaces the error. Tolerated warnings: budget warnings on initial bundle size are acceptable; **errors are not**.

- [ ] **Step 6.5: Run the playwright E2E that exercises the legacy `decode()` path.**

Run: `cd src/web && npx playwright test e2e/raw-open.spec.ts --reporter=line 2>&1 | tail -15`

Expected: PASS. The E2E uses the legacy `decode()` (worker dispatches on `req.type === 'decode'`), which is the M1 "shall not regress" path. If this fails, the dispatch refactor in Task 3 Step 3.5 broke the legacy code path — investigate and fix before claiming M1 done. (If the E2E requires `projects/maple/public/test.dng` — see CLAUDE.md § "Build & test — Web" — and the engineer doesn't have it, skip this step and document the gap; the unit suite covers the rest.)

- [ ] **Step 6.6: Run the parity harness one more time end-to-end (it exercises raw-core, which both WASM and Apple consume).**

Run: `BUDGET=15 ./src/scripts/test_color_pipeline.sh 2>&1 | tail -20`

Expected: PASS. M1 didn't touch raw-core, but the harness is the global parity gate per CLAUDE.md § "Cross-platform parity"; running it pinned to the M1 commit confirms the cross-platform invariant.

- [ ] **Step 6.7: Tag the commit chain with a docs commit recording the M1 milestone gate.**

Append to `docs/superpowers/plans/2026-04-25-plan-3-web-ffi-split-m1.md` (this very file) a closing block under a new heading `## M1 verification log` with the following content (replace `<TIMESTAMP>` with `date -u +%FT%TZ` output and `<HASH>` with `git log -1 --format=%h`):

```markdown
## M1 verification log

**Verified at <TIMESTAMP>, commit <HASH>.**

- [x] `cargo test -p raw-wasm` — PASS (1 ignored fixture-gated test).
- [x] `npx vitest run .../raw-pipeline.service.spec.ts` — 3 tests PASS.
- [x] `npm run build:hosted` — clean build, no errors.
- [x] `playwright test e2e/raw-open.spec.ts` — legacy decode E2E PASS.
- [x] `BUDGET=15 ./src/scripts/test_color_pipeline.sh` — parity PASS.

The new `render_bytes_scene_linear` WASM entry is reachable from
`RawPipelineService.decodeSceneLinear`; the legacy `render_bytes`
+ `decode()` path is byte-identical to pre-M1. Plan 3 M2 (GLSL
shaders) and Plan 3 M3 (canvas wiring) are the next plans.
```

- [ ] **Step 6.8: Final commit — the verification log + any test fixes from Steps 6.1-6.6.**

```bash
git add docs/superpowers/plans/2026-04-25-plan-3-web-ffi-split-m1.md
git commit -m "$(cat <<'EOF'
docs(plan-3): record M1 verification log

Closes Plan 3 Milestone 1 (Web/WASM FFI split, scene-linear
entry point). All gates green: raw-wasm tests, vitest service
spec, hosted Angular build, legacy decode E2E, color-pipeline
parity harness. The legacy `render_bytes` path is byte-
identical to pre-M1 — M1 is purely additive per the brief's
§ 10 "Recommended cut".

Plan 3 M2 (GLSL ports of the five Apple Metal kernels) and
Plan 3 M3 (wire WebGL2 chain into image-canvas.component.ts)
are separate plans authored after M1 lands.

EOF
)"
```

---

## Self-Review Checklist

Run through this once after the plan is in place, before handoff to execution.

**1. Spec coverage:**
- [ ] Task 1 adds the brief's first M1 entry (`renderBytesSceneLinear`) per § 2 of the brief — wasm-bindgen `Vec<u16>` boundary, mirrors `maple_render_bytes_scene_linear` field-for-field, calls the same `render_scene_linear_from_raw_with_quality` helper Apple uses.
- [ ] Task 2 extends `raw-pipeline.types.ts` per the brief's "Worker types extended" line in § 8 / § 10.
- [ ] Task 3 adds a worker dispatch branch (the brief's "small worker stub if needed") — re-uses the existing `addEventListener('message', ...)` plumbing rather than spawning a second worker file.
- [ ] Task 4 adds the new service method — the public Promise-returning surface the future M3 consumer will call.
- [ ] Task 5 covers the brief's "TypeScript side: a unit test ... verify the worker round-trip produces a `Uint16Array` of expected length" requirement.
- [ ] Task 6 verifies the legacy `render_bytes` path is byte-identical to pre-M1 (the brief's "Web shell unchanged — still draws the legacy sRGB path" invariant).
- [ ] Out of scope: M2 (GLSL shaders), M3 (canvas wiring), M4 (sized FFI), M5 (tile FFI), `src/scripts/codegen/` directory creation, AgX LUT in-browser delivery, removing legacy `render_bytes`. All explicitly listed in the plan's "Out of scope" section.

**2. Placeholder scan:**
- [ ] No "TBD", "TODO", "implement later" anywhere.
- [ ] No "similar to Task N" without the actual code.
- [ ] No "add appropriate error handling" — error patterns inherit from the existing `render_bytes` (`JsError::new`, error-channel decode-error response variant). The discriminated-union narrowing and the "kind mismatch" defensive reject in Step 4.4 are fully spelled out.
- [ ] Step 6.7's `<TIMESTAMP>` and `<HASH>` placeholders are intentional — they are values the engineer captures at execution time. The shell command to derive them (`date -u +%FT%TZ`, `git log -1 --format=%h`) is concrete.

**3. Type consistency:**
- [ ] `MapleSceneLinearRender` (Rust wasm-bindgen struct) — fields: `width`, `height`, `fp16_rgba`, `as_shot_temperature`, `as_shot_tint`. Plus `bytes_per_pixel` and `channels` getters that return constants 8 and 4.
- [ ] `MapleSceneLinearRender.fp16_rgba` getter returns `Vec<u16>` on Rust side; wasm-bindgen surfaces it as `Uint16Array` on the JS side. The TS `DecodeSceneLinearSuccess.fp16Rgba` field is typed as `ArrayBuffer` for transfer; the consumer-facing `DecodedSceneLinearImage.fp16Rgba` is `Uint16Array`.
- [ ] `render_bytes_scene_linear` (Rust function name, `snake_case`) → `render_bytes_scene_linear` on the JS side (wasm-bindgen preserves `snake_case` by default unless `js_name` overrides — confirmed by reading `MapleRender::as_shot_temperature` / `as_shot_tint` getters using `snake_case` in [`raw-wasm/src/lib.rs:67-72`](../../src/raw-pipeline/raw-wasm/src/lib.rs#L67); the worker calls `result.fp16_rgba` not `result.fp16Rgba`). Step 3.5's worker code uses `result.fp16_rgba` accordingly.
- [ ] `DecodeSceneLinearRequest.qualityPreview: boolean` → matches the Rust signature `quality_preview: bool` (wasm-bindgen converts `bool ↔ boolean`).
- [ ] `pending` map entry types in Step 4.3 use `kind: 'legacy' | 'scene-linear'` discriminants; the listener narrowing in Step 4.4 checks both `msg.type` and `handler.kind` so the resolver call is type-safe.
- [ ] `decodeSceneLinear` is the public method name, mirroring `decode` on the same service.
- [ ] `DecodedSceneLinearImage` aggregate uses `fp16Rgba: Uint16Array` (mainland-side consumer); `DecodeSceneLinearSuccess` wire format uses `fp16Rgba: ArrayBuffer` (transferable).

**4. Cross-link integrity:**
- [ ] Brief reference: `docs/superpowers/specs/2026-04-25-plan-3-web-ffi-split-brief.md` — exists in the main checkout (verified during plan authoring).
- [ ] Plan 1 v2 reference: `docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md` — exists.
- [ ] Plan 2 reference: `docs/superpowers/plans/2026-04-25-plan-2-dev-chain-metal-kernels.md` — exists.
- [ ] Deep Zoom plan reference: `docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md` — exists.
- [ ] AgX LUT regen path commit: `8c32bfe` (`fix(apple): sync bundled AgX LUT to Rust AGX_VERSION 5`) — verified via `git log -1 8c32bfe`. Plan correctly notes M1 does **not** touch the LUT (it's pre-AgX); the cross-link is informational so the executor knows where the AGX_VERSION pin lives.
- [ ] `render_scene_linear_from_raw_with_quality` introduction commit: `9c1bb22` (`feat(raw-core): add render_scene_linear_from_raw_with_quality entry`) — verified via `git log -1 9c1bb22`.

**5. Ordering and BLOCKING constraints:**
- [ ] Task 1 must precede Task 3 — Task 3 Step 3.1 builds the WASM and depends on Task 1's Rust signature.
- [ ] Task 2 must precede Task 3 — Task 3's worker imports `DecodeSceneLinearRequest` from the types file.
- [ ] Task 3 must precede Task 4 — Task 4's service method consumes the worker's response shapes.
- [ ] Task 4 must precede Task 5 — Task 5's spec calls `service.decodeSceneLinear`.
- [ ] Task 6 is the gate after all five — confirms the legacy path didn't regress and the build is green end-to-end.
- [ ] No task assumes `pkg/` is checked in. The plan calls `npm run raw-wasm` explicitly at Step 3.1 and Step 6.1.

**6. Conflicts with the brief surfaced inline:**
- [ ] Brief § 2 says the new entry "drops the existing `render_bytes`" — the plan correctly **does not** drop it. The brief's § 10 ("Recommended cut") and the cross-link to Plan 1's "Out of scope" line ("Plan 3 deletes them once the Web port is done") together establish that legacy deletion is a future plan. M1 is purely additive. (Reported in the closing summary so the maintainer sees this.)
- [ ] Brief mentions `src/web/projects/maple-common/src/lib/services/` for the file paths; the actual directory is `src/web/projects/maple-common/src/lib/raw-pipeline/`. The plan uses the correct paths throughout. (Reported in the closing summary.)
- [ ] Brief's "small worker stub if needed" is interpreted as "extend the existing worker", not "add a second `.worker.ts`" — the existing dispatch already supports new request types, and a second worker would double WASM-init time per page load. This is a deliberate design choice the plan locks in at Task 3.

If any of the above is unchecked when reviewing, fix inline; do not re-review.

---

## M1 verification log

**Verified at 2026-04-25T09:10:50Z, commits 2691da2..bc61b44 (Tasks 1-5).**

- [x] `cargo test -p raw-wasm` — PASS at Task 1 commit (`2691da2`); fixture-gated test
      `render_bytes_scene_linear_returns_fp16_rgba_with_alpha_one` skipped because the
      100MP DJI Mavic 3 Pro fixture is not present in this worktree.
- [x] `bun x tsc --project projects/maple-common/tsconfig.spec.json --noEmit` — clean
      after Tasks 2-4; Task 4 narrowed the discriminated union so the listener
      pattern-matches both `msg.type` and `handler.kind` correctly.
- [x] `bun x ng test Maple-common --watch=false` — 12/12 PASS after Task 5.
      The new `raw-pipeline.service.spec.ts` adds 5 cases:
      decodeSceneLinear round-trip, decodeSceneLinear error path,
      decodeChain serialisation, **legacy decode regression**,
      **legacy decode error regression**. The legacy regression cases
      confirm Task 4's discriminated-union widening did not break the
      legacy `decode()` path.
- [x] `bun run build` (i.e. `ng build maple-hosted`) — clean production build,
      no errors. Worker bundles cleanly; raw_wasm chunk lazy-loaded.
- [N/A] `playwright test e2e/raw-open.spec.ts` — `projects/maple-hosted/public/test.dng`
      fixture is gitignored and not present in this worktree, so the legacy E2E
      cannot run here. The vitest legacy regression in spec covers the TS
      plumbing of the legacy path; the WASM render itself is the same
      `render_bytes` entry, untouched in M1.
- [N/A] `BUDGET=15 ./src/scripts/test_color_pipeline.sh` — top-level
      `test-fixtures/raws/test_*.dng` exists and the harness runs, but every
      fixture is failing on baseline (pre-existing — failures reproduce on the
      pre-Task-3 commit `c824017`). M1 did not touch raw-core, so the parity
      gate is not a regression signal here. Tracked separately from M1.

The new `render_bytes_scene_linear` WASM entry is reachable from
`RawPipelineService.decodeSceneLinear`; the legacy `render_bytes`
+ `decode()` path is byte-identical to pre-M1. Plan 3 M2 (GLSL
shaders) and Plan 3 M3 (canvas wiring) are the next plans.

**Drift from plan-as-written:**
- Step 5.3's `globalThis.Worker = vi.fn(() => workerStub)` does not work under
  `@angular/build:unit-test` — `vi.fn` is not a real constructor, so
  `new Worker(...)` throws `Reflect.construct requires the first argument be a constructor`.
  Replaced with a class `WorkerCtor` whose constructor returns the stub via
  the constructor-return-object override. Effect on the spec is none; the test
  still verifies the same round-trip behaviour.
- The plan's `npm` invocations were run under `bun` (project's preferred
  runtime). All scripts behave identically because `package.json` scripts
  delegate to `ng` / `bash` / `wasm-pack`.
- The vitest run under bare `bun x vitest` (without the Angular harness) trips
  on `TestBed.initTestEnvironment()` not having been called — pre-existing on
  baseline (the same error fires on `library-state-imported-asset.spec.ts`).
  The Angular `bun x ng test Maple-common` harness initialises the test bed
  correctly; that is the canonical run command.
