# Local Inpainting — Phase 2: Apple host wiring

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Supply baked patches from the Apple host through to the render seam and persist removals, then ship the first eraser model + manual mask UX. Builds on Phase 1 (#1484 / PR #1487): `InpaintPatch`, `inpaint_composite`, the tolerant reader, and the fp16 codec already exist in raw-core.

**Milestones (ticket #1486):**
- **M1 — Rust render-seam threading** (this turn): additive `*_with_patches` per-tick entries that composite at the pre-grade seam. Pure raw-core, CI-relevant, zero-ripple.
- **M2 — Removal serialization (writer)**: `Removal` type + model field + XMP write/read, additive + schema-versioned. Rust; testable.
- **M3 — C-FFI + Swift supply**: new C entry marshalling patch bytes; Swift loads `.maple/inpaint/<hash>.f16` (codec exists) + LRU; calls the new FFI. Needs xcframework rebuild + local `swift test` (not cloud-gated).
- **M4 — Model + mask UX**: LaMa/MI-GAN via ORT+CoreML (reuse PanoProvisioner pattern); Apple Vision auto-segment; SwiftUI paint mask. Largest lift; own sub-plan.

---

## M1: Rust render-seam threading (additive, zero-ripple)

**Insight:** the per-tick entry's input fp16/f32 buffer *is* the pre-user-grade cached buffer (chain runs WB→…→AgX over it). So compositing patches into that input before delegating == compositing at the seam. fp16 unpack→pack is lossless for already-fp16 data, so sensor pixels are untouched; only the patch is fp16-quantized (it's fp16 on disk anyway). The existing entry has only 2 non-test callers (the raw-ffi C wrappers), and a new `*_with_patches` entry disturbs none of them.

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/pipeline/scene_linear_chain.rs` (add `apply_scene_linear_chain_with_patches` + `_f32_with_patches` + a private `composite_into_*` helper)
- Modify: `src/raw-pipeline/raw-core/src/pipeline/mod.rs` (re-export the two new entries)
- Test: `src/raw-pipeline/raw-core/src/pipeline/scene_linear_chain/tests.rs`

- [ ] **Step 1: Write failing tests** (in `scene_linear_chain/tests.rs`):

```rust
#[test]
fn with_patches_empty_matches_plain_entry_f32() {
    let (w, h) = (4u32, 4u32);
    let n = (w * h) as usize;
    let mut input = Vec::with_capacity(n * 4);
    for i in 0..n {
        let v = 0.05 + 0.2 * (i as f32 / n as f32);
        input.extend_from_slice(&[v, v * 0.9, v * 0.8, 1.0]);
    }
    let model = AdjustmentModel::default();
    let plain = apply_scene_linear_chain_f32(&input, w, h, &model, 6500.0, 0.0, false, TargetPrimaries::Srgb).unwrap();
    let with = apply_scene_linear_chain_f32_with_patches(&input, w, h, &model, 6500.0, 0.0, false, TargetPrimaries::Srgb, &[]).unwrap();
    assert_eq!(plain, with, "empty patches must be bit-identical to the plain entry");
}

#[test]
fn with_patches_equals_manual_composite_then_chain_f32() {
    use crate::image::{ColorSpace, Image};
    use crate::stages::inpaint_composite;
    use crate::types::InpaintPatch;
    let (w, h) = (4u32, 4u32);
    let n = (w * h) as usize;
    let mut input = Vec::with_capacity(n * 4);
    for _ in 0..n { input.extend_from_slice(&[0.2, 0.2, 0.2, 1.0]); }
    let model = AdjustmentModel::default();
    let patch = InpaintPatch {
        width: w, height: h, origin: [0.0, 0.0], extent: [1.0, 1.0],
        pixels: vec![[0.6, 0.4, 0.3]; n], coverage: vec![1.0; n],
    };
    // via the new entry
    let via_entry = apply_scene_linear_chain_f32_with_patches(&input, w, h, &model, 6500.0, 0.0, false, TargetPrimaries::Srgb, std::slice::from_ref(&patch)).unwrap();
    // manual: composite into a copy of the input, then plain chain
    let mut img = Image { width: w, height: h, pixels: input.chunks_exact(4).map(|c| [c[0], c[1], c[2]]).collect(), space: ColorSpace::SceneLinearRec2020 };
    inpaint_composite::apply(&mut img, std::slice::from_ref(&patch));
    let mut composited = Vec::with_capacity(n * 4);
    for p in &img.pixels { composited.extend_from_slice(&[p[0], p[1], p[2], 1.0]); }
    let manual = apply_scene_linear_chain_f32(&composited, w, h, &model, 6500.0, 0.0, false, TargetPrimaries::Srgb).unwrap();
    assert_eq!(via_entry, manual, "with_patches must equal composite-then-chain");
    // and it must actually differ from the no-patch render
    let plain = apply_scene_linear_chain_f32(&input, w, h, &model, 6500.0, 0.0, false, TargetPrimaries::Srgb).unwrap();
    assert_ne!(via_entry, plain, "a full-coverage patch must change the output");
}
```

- [ ] **Step 2: Run → fail** (`cargo test -p raw-core --lib scene_linear_chain` → unresolved `apply_scene_linear_chain_f32_with_patches`).

- [ ] **Step 3: Implement** in `scene_linear_chain.rs` (after `apply_scene_linear_chain_f32`):

```rust
use crate::types::InpaintPatch;

fn composite_into_f32(in_f32_rgba: &[f32], width: u32, height: u32, patches: &[InpaintPatch]) -> Result<Vec<f32>> {
    use crate::image::{ColorSpace, Image};
    let pixel_count = (width as usize).checked_mul(height as usize)
        .ok_or_else(|| crate::error::Error::Pipeline("composite_into_f32: pixel overflow".into()))?;
    let expected = pixel_count.checked_mul(4)
        .ok_or_else(|| crate::error::Error::Pipeline("composite_into_f32: len overflow".into()))?;
    if in_f32_rgba.len() != expected {
        return Err(crate::error::Error::Pipeline(format!("composite_into_f32: input {} != {}", in_f32_rgba.len(), expected)));
    }
    let mut img = Image { width, height, space: ColorSpace::SceneLinearRec2020,
        pixels: in_f32_rgba.chunks_exact(4).map(|c| [c[0], c[1], c[2]]).collect() };
    crate::stages::inpaint_composite::apply(&mut img, patches);
    let mut out = Vec::with_capacity(expected);
    for p in &img.pixels { out.extend_from_slice(&[p[0], p[1], p[2], 1.0]); }
    Ok(out)
}

/// Per-tick chain with synthetic-raw patches composited at the pre-user-grade
/// seam (before `white_balance`). Empty `patches` is bit-identical to
/// [`apply_scene_linear_chain_f32`]. The patch rides every downstream stage —
/// WB, exposure, tone, AgX — exactly like sensor data (design doc §4).
pub fn apply_scene_linear_chain_f32_with_patches(
    in_f32_rgba: &[f32], width: u32, height: u32, model: &AdjustmentModel,
    decoded_temp: f32, decoded_tint: f32, skip_agx: bool,
    target_primaries: TargetPrimaries, patches: &[InpaintPatch],
) -> Result<Vec<f32>> {
    if patches.is_empty() {
        return apply_scene_linear_chain_f32(in_f32_rgba, width, height, model, decoded_temp, decoded_tint, skip_agx, target_primaries);
    }
    let composited = composite_into_f32(in_f32_rgba, width, height, patches)?;
    apply_scene_linear_chain_f32(&composited, width, height, model, decoded_temp, decoded_tint, skip_agx, target_primaries)
}
```

Plus the fp16 twins (`composite_into_fp16` using `f16_bits_to_f32`/`f32_to_f16_bits`, and `apply_scene_linear_chain_with_patches`).

- [ ] **Step 4: Run → pass.** Re-export both `*_with_patches` from `pipeline/mod.rs`. Run full `cargo test -p raw-core --lib` (incl. the raw-ffi gates indirectly — the plain entries unchanged).

- [ ] **Step 5: Commit.**

---

## M2–M4 — EXPAND-BEFORE-EXECUTE

- **M2** Removal serialization: add `types::inpaint::Removal { region: [f32;4], patch_ref: String, model_version: String, bake: BakeGrade }`; `AdjustmentModel.inpaint_removals: Vec<Removal>` (codegen-excluded, hand-mirrored); XMP attribute `papp:InpaintRemovals` parse+**serialize** (raw-core gains its first LA-family writer here) + round-trip tests. Read `xmp/mod.rs` serialize path first.
- **M3** C-FFI + Swift: new `maple_apply_scene_linear_chain[_f32]_with_patches` C entries (concat patch `.f16` blobs + count); Swift `InpaintPatchStore` over `.maple/inpaint/` (codec = `pipeline::patch_*`), LRU scoped to that dir; wire into the live render actor. Rebuild xcframework (`FORCE_XCFRAMEWORK_REBUILD=1`); verify `swift test` + `xcodebuild` locally (Apple not cloud-gated).
- **M4** Model + UX: LaMa/MI-GAN ORT+CoreML session (copy `OrtRuntime`/`PanoProvisioner`); generalize the model manifest to a `Vec`; Apple Vision auto people/subject mask; SwiftUI brush mask; bake → inverse (Phase 0) → store (M3) → composite (M1). Own sub-plan; user decision on model + bundle-vs-download pending.
