# Local Inpainting — Phase 1: raw-core composite foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the Phase-0 inverse usable: a raster `InpaintPatch` carrier + an `inpaint_composite` raw-core stage that injects a baked synthetic-raw patch at the **pre-user-grade seam**, wired into both render paths, persisted in XMP as an additive `Removal` local-adjustment (reader-first, back-compat-safe) with pixels stored out-of-band. No ML model yet — patches come from fixtures.

**Architecture:** A fixed-resolution patch (scene-linear Rec.2020 `[f32;3]` + a `[0,1]` coverage mask + normalized placement) is bilinearly resampled onto the working `Image` and `lerp`-composited before `white_balance` (`develop/mod.rs:411`, `scene_linear_chain.rs:146`), so it re-grades like sensor data. Empty patch set is a bit-identical no-op. XMP carries a `Removal` layer (schema-versioned, additive) referencing `.maple/inpaint/<hash>.f16`; the reader skips+preserves unknown layers so older builds don't lose data.

**Tech Stack:** Rust (raw-core), serde_json wire format, existing `Image`/`ColorSpace`, fp16 transport (`pipeline::fp16`).

---

## Scope notes

- **Task 1.1 fully specified** (the composite stage + carrier — pure additive raw-core).
- **Tasks 1.2–1.5 are EXPAND-BEFORE-EXECUTE**: read the named forward source and break into bite-sized steps before coding.
- Builds on Phase 0 (`view::agx_inverse`, `view::grade_inverse`) on branch `claude/inpaint-phase1` (stacked on the Phase 0 PR #1483).

## File structure

- Create: `src/raw-pipeline/raw-core/src/types/inpaint.rs` — `InpaintPatch` carrier (no I/O).
- Create: `src/raw-pipeline/raw-core/src/stages/inpaint_composite.rs` — the composite stage + bilinear resample.
- Modify: `types/mod.rs` (`pub mod inpaint;` + re-export), `stages/mod.rs` (`pub mod inpaint_composite;`).
- Later: `pipeline/develop/mod.rs` + `pipeline/scene_linear_chain.rs` (seam wiring, 1.2); `types/local_adjustment/{mod,wire}.rs` (Removal variant + tolerant reader, 1.3/1.4); a `.maple/inpaint` fp16 store (1.5).

---

## Task 1.1: `InpaintPatch` carrier + `inpaint_composite` stage

**Files:**
- Create: `src/raw-pipeline/raw-core/src/types/inpaint.rs`
- Create: `src/raw-pipeline/raw-core/src/stages/inpaint_composite.rs`
- Modify: `src/raw-pipeline/raw-core/src/types/mod.rs`, `src/raw-pipeline/raw-core/src/stages/mod.rs`
- Test: inline `#[cfg(test)] mod tests` in `inpaint_composite.rs`

- [ ] **Step 1: Define the carrier.** Create `types/inpaint.rs`:

```rust
//! Carrier for a baked synthetic-raw inpaint patch: scene-linear Rec.2020
//! pixels + a coverage (feather) mask, placed by normalized coordinates in the
//! full DefaultCrop image. Resolution-agnostic on purpose — the composite stage
//! resamples it onto whatever buffer size the render path is using
//! (viewport/full/tile). No I/O here (mirrors the `types` module contract).

/// A fixed-resolution inpaint patch in scene-linear Rec.2020.
#[derive(Clone, Debug, PartialEq)]
pub struct InpaintPatch {
    /// Patch native pixel dimensions.
    pub width: u32,
    pub height: u32,
    /// Top-left placement in normalized full-image coords, `[u, v]` in `[0, 1]`.
    pub origin: [f32; 2],
    /// Size in normalized full-image coords, `[du, dv]` in `(0, 1]`.
    pub extent: [f32; 2],
    /// Scene-linear Rec.2020 RGB, row-major, `len == width * height`.
    pub pixels: Vec<[f32; 3]>,
    /// Coverage / feather in `[0, 1]`, row-major, `len == width * height`.
    pub coverage: Vec<f32>,
}

impl InpaintPatch {
    /// True when dimensions are non-zero, extent positive, and both buffers
    /// have the declared length. A malformed patch is skipped by the compositor.
    pub fn is_valid(&self) -> bool {
        let n = (self.width as usize) * (self.height as usize);
        self.width > 0
            && self.height > 0
            && self.extent[0] > 0.0
            && self.extent[1] > 0.0
            && self.pixels.len() == n
            && self.coverage.len() == n
    }
}
```

Add to `types/mod.rs`: `pub mod inpaint;` and `pub use inpaint::InpaintPatch;`.

- [ ] **Step 2: Write the failing test.** Create `stages/inpaint_composite.rs` with a stub `apply` + tests:

```rust
//! Composite baked synthetic-raw patches into the scene-linear working buffer
//! at the pre-user-grade seam. `out = lerp(scene, patch, coverage)`. Empty /
//! invalid patches are bit-identical no-ops.

use crate::image::{ColorSpace, Image};
use crate::types::InpaintPatch;

/// Composite each valid patch into `img` (scene-linear Rec.2020). No-op when
/// `patches` is empty.
pub fn apply(_img: &mut Image, _patches: &[InpaintPatch]) {
    unimplemented!("Task 1.1 step 4")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, c: [f32; 3]) -> Image {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = c;
        }
        img
    }

    fn full_patch(w: u32, h: u32, c: [f32; 3], cov: f32) -> InpaintPatch {
        let n = (w * h) as usize;
        InpaintPatch {
            width: w,
            height: h,
            origin: [0.0, 0.0],
            extent: [1.0, 1.0],
            pixels: vec![c; n],
            coverage: vec![cov; n],
        }
    }

    #[test]
    fn empty_patch_list_is_noop() {
        let mut img = solid(4, 4, [0.2, 0.3, 0.4]);
        let before = img.pixels.clone();
        apply(&mut img, &[]);
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn full_coverage_replaces_pixels() {
        let mut img = solid(8, 8, [0.2, 0.2, 0.2]);
        let patch = full_patch(8, 8, [0.7, 0.5, 0.3], 1.0);
        apply(&mut img, &[patch]);
        for p in &img.pixels {
            for c in 0..3 {
                assert!((p[c] - [0.7, 0.5, 0.3][c]).abs() < 1e-4, "got {:?}", p);
            }
        }
    }

    #[test]
    fn zero_coverage_leaves_unchanged() {
        let mut img = solid(8, 8, [0.2, 0.2, 0.2]);
        let before = img.pixels.clone();
        apply(&mut img, &[full_patch(8, 8, [0.9, 0.9, 0.9], 0.0)]);
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn half_coverage_lerps() {
        let mut img = solid(8, 8, [0.2, 0.2, 0.2]);
        apply(&mut img, &[full_patch(8, 8, [0.4, 0.4, 0.4], 0.5)]);
        for p in &img.pixels {
            assert!((p[0] - 0.3).abs() < 1e-4, "expected lerp to 0.3, got {:?}", p);
        }
    }

    #[test]
    fn invalid_patch_is_skipped() {
        let mut img = solid(4, 4, [0.1, 0.1, 0.1]);
        let before = img.pixels.clone();
        let bad = InpaintPatch {
            width: 4,
            height: 4,
            origin: [0.0, 0.0],
            extent: [1.0, 1.0],
            pixels: vec![[1.0, 1.0, 1.0]; 2], // wrong length
            coverage: vec![1.0; 16],
        };
        apply(&mut img, &[bad]);
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn subrect_patch_only_touches_its_region() {
        // Patch covers the right half (origin u=0.5, extent du=0.5).
        let mut img = solid(8, 8, [0.2, 0.2, 0.2]);
        let n = 16usize; // 4x4 patch
        let patch = InpaintPatch {
            width: 4,
            height: 8,
            origin: [0.5, 0.0],
            extent: [0.5, 1.0],
            pixels: vec![[0.9, 0.9, 0.9]; 32],
            coverage: vec![1.0; 32],
        };
        let _ = n;
        apply(&mut img, &[patch]);
        for y in 0..8u32 {
            for x in 0..8u32 {
                let p = img.pixels[(y * 8 + x) as usize];
                if x >= 4 {
                    assert!((p[0] - 0.9).abs() < 1e-4, "right half should be patched at ({x},{y}): {:?}", p);
                } else {
                    assert!((p[0] - 0.2).abs() < 1e-4, "left half should be untouched at ({x},{y}): {:?}", p);
                }
            }
        }
    }
}
```

Add to `stages/mod.rs`: `pub mod inpaint_composite;`.

- [ ] **Step 3: Run to verify it fails.** Run: `cd src/raw-pipeline && cargo test -p raw-core --lib inpaint_composite 2>&1 | tail -20` → FAIL (`not implemented`).

- [ ] **Step 4: Implement `apply` + bilinear samplers.** Replace the stub:

```rust
#[inline]
fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

fn sample_rgb(pixels: &[[f32; 3]], w: u32, h: u32, fx: f32, fy: f32) -> [f32; 3] {
    let (x0, y0, x1, y1, tx, ty) = bilinear_idx(w, h, fx, fy);
    let at = |x: u32, y: u32| pixels[(y * w + x) as usize];
    let top = lerp3(at(x0, y0), at(x1, y0), tx);
    let bot = lerp3(at(x0, y1), at(x1, y1), tx);
    lerp3(top, bot, ty)
}

fn sample_cov(cov: &[f32], w: u32, h: u32, fx: f32, fy: f32) -> f32 {
    let (x0, y0, x1, y1, tx, ty) = bilinear_idx(w, h, fx, fy);
    let at = |x: u32, y: u32| cov[(y * w + x) as usize];
    let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
    let bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
    top + (bot - top) * ty
}

fn bilinear_idx(w: u32, h: u32, fx: f32, fy: f32) -> (u32, u32, u32, u32, f32, f32) {
    let fx = fx.clamp(0.0, (w - 1) as f32);
    let fy = fy.clamp(0.0, (h - 1) as f32);
    let x0 = fx.floor() as u32;
    let y0 = fy.floor() as u32;
    let x1 = (x0 + 1).min(w - 1);
    let y1 = (y0 + 1).min(h - 1);
    (x0, y0, x1, y1, fx - x0 as f32, fy - y0 as f32)
}

pub fn apply(img: &mut Image, patches: &[InpaintPatch]) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if patches.is_empty() {
        return;
    }
    let (iw, ih) = (img.width, img.height);
    for patch in patches {
        if !patch.is_valid() {
            continue;
        }
        let [ox, oy] = patch.origin;
        let [ex, ey] = patch.extent;
        let (pw, ph) = (patch.width, patch.height);
        for y in 0..ih {
            let v = (y as f32 + 0.5) / ih as f32;
            if v < oy || v > oy + ey {
                continue;
            }
            let pv = ((v - oy) / ey).clamp(0.0, 1.0) * (ph as f32 - 1.0);
            for x in 0..iw {
                let u = (x as f32 + 0.5) / iw as f32;
                if u < ox || u > ox + ex {
                    continue;
                }
                let pu = ((u - ox) / ex).clamp(0.0, 1.0) * (pw as f32 - 1.0);
                let cov = sample_cov(&patch.coverage, pw, ph, pu, pv).clamp(0.0, 1.0);
                if cov <= 0.0 {
                    continue;
                }
                let pp = sample_rgb(&patch.pixels, pw, ph, pu, pv);
                let idx = (y * iw + x) as usize;
                img.pixels[idx] = lerp3(img.pixels[idx], pp, cov);
            }
        }
    }
}
```

- [ ] **Step 5: Run to verify it passes.** Run: `cd src/raw-pipeline && cargo test -p raw-core --lib inpaint_composite 2>&1 | tail -20` → PASS (6 tests).

- [ ] **Step 6: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/types/inpaint.rs src/raw-pipeline/raw-core/src/stages/inpaint_composite.rs src/raw-pipeline/raw-core/src/types/mod.rs src/raw-pipeline/raw-core/src/stages/mod.rs
git commit -m "feat(raw-core): InpaintPatch carrier + inpaint_composite stage"
```

---

## Task 1.2: Wire `inpaint_composite` at the pre-grade seam — EXPAND-BEFORE-EXECUTE

**Read first:** `pipeline/develop/mod.rs` (the `white_balance` call at ~`:411`), `pipeline/scene_linear_chain.rs` (the `white_balance::apply_delta` call at `:146` + the FFI signature), `xmp::AdjustmentModel` (where patches would hang off the model vs. a separate arg).

**Approach:** carry the patches alongside the model into both paths and call `inpaint_composite::apply(&mut img, &patches)` immediately before the WB stage. For the per-tick FFI, thread an optional patch buffer through a new FFI entry (or an out-of-band "set patches" call) so the slider path doesn't re-send patch bytes every tick. Empty patches → bit-identical (gate against the full parity harness). **Decision to confirm:** patches as a field on `AdjustmentModel` vs. a separate compositor input (leaning separate — patches are large binary, not XMP-scalar).

**Test gate:** parity harness baseline unchanged with no patches; a fixture patch composited before WB re-grades correctly under the Phase-0 push matrix (extend the Phase-0 gate to go through the real seam).

## Task 1.3: `Mask::Removal` variant + additive wire format — EXPAND-BEFORE-EXECUTE

**Read first:** `types/local_adjustment/mod.rs`, `types/local_adjustment/wire.rs` (already mapped — design doc §3c).

**Approach:** add a `Removal { region, patch_ref }` arm (raster mask ref + content-hash patch_ref, schema-versioned `"schema": 2`, `"mask":{"type":"raster",…}`); pixels stay out-of-band. Extend `mask_to_json`/`mask_from_json`. **Land after the tolerant reader (1.4).**

## Task 1.4: Tolerant reader (reader-first compat) — EXPAND-BEFORE-EXECUTE

**Read first:** `types/local_adjustment/wire.rs` (`decode_local_adjustments` `collect::<Result>` at `:33`, `mask_from_json` hard error at `:107`, `decode_unknown_mask_type_errors` test at `:275`).

**Approach (design doc §3c):** replace `collect()` with a per-element loop — known-but-malformed still errors; **unknown `mask.type` / newer `schema` is skipped and its raw `Value` preserved** into an `unknown_layers: Vec<Value>` carrier re-emitted on encode (attribute-local passthrough). Rewrite `decode_unknown_mask_type_errors` (it encodes the current hazard). **Must land + ship before any writer emits `Removal`.**

**Test gate:** new→old→new preserves the removal; old-format round-trips byte-identical; unknown-mask-type no longer fails the whole array.

## Task 1.5: `.maple/inpaint/<hash>.f16` patch store — EXPAND-BEFORE-EXECUTE

**Read first:** `pipeline/fp16.rs`, the pano/thumb on-disk precedent (`db/schema.ts`, `pano-stitch.ts`).

**Approach:** serialize/deserialize an `InpaintPatch` to fp16 Rec.2020 RGBA + coverage with a small header (dims, origin, extent), content-addressed by blake3 (reuse `decode_cache` hashing). LRU sweep scoped strictly to `.maple/inpaint/` (must never touch originals — standing invariant). The raw-core side provides (de)serialize; the host owns the directory + LRU.

---

## Self-review

- **Spec coverage:** §4 seam composite → 1.1 (stage) + 1.2 (wiring). §3a raster carrier → 1.1. §3c serialization + tolerant reader → 1.3 + 1.4. §3e on-disk fp16 → 1.5.
- **No placeholders in 1.1** — complete type, stage, and 6 tests. 1.2–1.5 are EXPAND-BEFORE-EXECUTE with named sources + test gates.
- **Type consistency:** `InpaintPatch` fields (`origin`/`extent` as `[f32;2]`, `pixels`/`coverage` row-major len `w*h`) are used identically in `is_valid`, the stage, and the tests.
