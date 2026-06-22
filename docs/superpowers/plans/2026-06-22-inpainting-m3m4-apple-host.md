# Local Inpainting — M3/M4: Apple host integration (FFI · Swift · model · UX)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.
>
> **Environment requirement:** M3.2+ run on a **Mac with Xcode**. Apple is **not** gated by cloud CI — verify with local `swift test` + `xcodebuild` (see CLAUDE.md "Build & test — Apple"). The XCUITest runner needs the screen **unlocked** (see memory: UITest needs unlocked screen). FFI changes need an **xcframework rebuild** (`FORCE_XCFRAMEWORK_REBUILD=1 ./src/apple/scripts/build-xcframework.sh --release`; see memory: xcframework rebuild workflow).

**Goal:** Make AI removal work end-to-end on Apple: the host runs an eraser model on a user mask, bakes the result to synthetic-raw via the Phase-0 inverse, stores it in `.maple/inpaint/`, persists a `Removal` in XMP, and supplies the patch to the live render through a new FFI — so the removal re-grades like sensor data.

**Builds on:** Phase 0 (`view::agx_inverse`, `view::grade_inverse`), Phase 1 (`InpaintPatch`, `inpaint_composite`, `pipeline::patch_{to,from}_bytes`, tolerant reader), Phase 2 M1 (`apply_scene_linear_chain[_f32]_with_patches`), M2 (`Removal`, `decode_removals`, `papp:InpaintRemovals`).

**rustfmt footgun (carried from M2):** never `rustfmt` a `mod.rs` — it recurses through `mod` decls and reformats the whole subtree. Only rustfmt leaf files. No Rust fmt CI gate.

---

## M3 — C-FFI + Swift patch supply + store + XMP writer

### M3.0 — `patches_from_blob` codec (raw-core; VERIFIABLE WITHOUT A MAC — do this first)

**Files:** `raw-core/src/pipeline/inpaint_store.rs` (+ re-export in `pipeline/mod.rs` — hand-edit, don't rustfmt mod.rs).

The FFI needs to pass N patches across one C pointer. Define a blob = `[u32 count][patch0][patch1]…`, each `patchK` the existing `patch_to_bytes` self-describing record (header carries `w`,`h` → total len `32 + w*h*8`).

- [ ] **Test (failing):** `blob_round_trips_multiple_patches` — `patches_to_blob(&[a,b])` → `patches_from_blob` → `[a,b]` (fp16 tolerance); `bad count / truncated → Err`; empty blob (`count=0`) → `[]`.
- [ ] **Implement:**

```rust
pub fn patches_to_blob(patches: &[InpaintPatch]) -> Vec<u8> {
    let mut out = (patches.len() as u32).to_le_bytes().to_vec();
    for p in patches { out.extend_from_slice(&patch_to_bytes(p)); }
    out
}
pub fn patches_from_blob(bytes: &[u8]) -> Result<Vec<InpaintPatch>, String> {
    if bytes.len() < 4 { return Err("inpaint blob: truncated count".into()); }
    let count = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let mut off = 4;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        if bytes.len() < off + HEADER_LEN { return Err("inpaint blob: truncated header".into()); }
        let w = u32::from_le_bytes([bytes[off+8],bytes[off+9],bytes[off+10],bytes[off+11]]) as usize;
        let h = u32::from_le_bytes([bytes[off+12],bytes[off+13],bytes[off+14],bytes[off+15]]) as usize;
        let n = w.checked_mul(h).ok_or("inpaint blob: dim overflow")?;
        let len = HEADER_LEN + n.checked_mul(8).ok_or("inpaint blob: size overflow")?;
        let end = off.checked_add(len).ok_or("inpaint blob: offset overflow")?;
        if bytes.len() < end { return Err("inpaint blob: truncated patch body".into()); }
        out.push(patch_from_bytes(&bytes[off..end])?);
        off = end;
    }
    Ok(out)
}
```
(`HEADER_LEN` is already a const; make it `pub(crate)` or inline 32. The `*8` = 3 fp16 pixel lanes + 1 fp16 coverage lane.)

- [ ] **Commit** (`feat(raw-core): inpaint patch blob codec for FFI transport`). Suite green.

### M3.1 — C-FFI entries (raw-ffi)

**Files:** `raw-ffi/src/scene_linear_chain.rs` (mirror `maple_apply_scene_linear_chain[_f32]`), `raw-ffi/src/scene_linear_chain_tests.rs`, cbindgen header regen.

- [ ] Add `maple_apply_scene_linear_chain_f32_with_patches(in_ptr,len,w,h,params_ptr,patches_ptr,patches_len,out_ptr) -> i32` (and the fp16 twin): null-guard, decode patches via `patches_from_blob`, call `raw_core::pipeline::apply_scene_linear_chain_f32_with_patches`, copy out. Empty `patches_len==0` must match the plain entry. Mirror the existing entries' error/overflow handling exactly.
- [ ] raw-ffi test: a full-coverage patch blob changes the output vs the plain entry; empty blob == plain entry; malformed blob → error code (not UB).
- [ ] Regen cbindgen header (`./src/apple/scripts/build-xcframework.sh` regenerates headers; or `cbindgen` per CLAUDE.md). Verify the new symbols appear.
- [ ] **Commit.**

### M3.2 — Swift `InpaintPatchStore` over `.maple/inpaint/` (MAC)

**Files:** new `src/apple/Packages/MapleCore/Sources/MapleCore/Inpaint/InpaintPatchStore.swift` (+ tests).

- [ ] Content-addressed `save(patch) -> ref` / `load(ref) -> Data?` under `<sidecar-dir>/.maple/inpaint/<blake3>.f16`, writing the `patch_to_bytes` layout (mirror the Rust header: magic `MIPF`, version 1, w/h u32-le, origin/extent f32-le, fp16 pixels, fp16 coverage). Atomic write (temp + rename), like `RenderedPreviewCache`.
- [ ] LRU sweep: a 500 MB budget scoped **strictly** to `.maple/inpaint/`. **Test that the sweep can never escape that directory or touch an original** (standing invariant: originals are sacred — see memory `feedback_no_photo_deletion_code`). Diffusion patches are NOT regenerable, so do not evict them like thumbs without the XMP `Removal` (which can regenerate deterministic LaMa patches).
- [ ] **Commit.** `swift test` green locally.

### M3.3 — Swift XMP writer for `papp:InpaintRemovals` + passthrough (MAC)

**Files:** `src/apple/.../Sidecar/XMPSerialization.swift`, `XMPSidecarStore.swift`, the Swift `AdjustmentModel` mirror.

- [ ] Mirror `Removal`/`BakeGrade` in Swift; add `inpaintRemovals: [Removal]` to the Swift `AdjustmentModel` (hand-written, like `localAdjustments`).
- [ ] Serialize removals to the `papp:InpaintRemovals` attribute as the same compact JSON the Rust reader expects (`{schema,kind,region,patch,model,bake}`); parse on read.
- [ ] **Attribute-local passthrough:** the Swift writer rebuilds the sidecar from the model (no passthrough today — memory/design §3c). Preserve unknown `papp:LocalAdjustments` / `papp:InpaintRemovals` array elements (store raw, re-emit) so a build that doesn't model a future kind doesn't drop it. Round-trip test: new→old→new preserves an unknown element.
- [ ] **Commit.** `swift test` green.

### M3.4 — Wire patches into the live render actor (MAC)

**Files:** `src/apple/.../Pipeline/PipelineRenderer.swift` (+ the render actor that calls the per-tick FFI).

- [ ] On image open / removal change: load each `Removal`'s patch via `InpaintPatchStore`, build the `patches_to_blob` buffer **once**, cache it. Per slider tick, call `maple_apply_scene_linear_chain_f32_with_patches` with the cached blob (do NOT re-marshal per tick — performance invariant).
- [ ] No active removals → call the existing entry (zero overhead, bit-identical).
- [ ] Rebuild xcframework; verify a fixture removal composites + re-grades in the live editor (screenshot before/after a WB/exposure push — the patch must track, per the Phase-0 gate, now through the real Apple path).
- [ ] **Commit.** Open the M3 PR.

---

## M4 — Eraser model + segmentation + mask UX — EXPAND-BEFORE-EXECUTE

> **DECISION REQUIRED before M4.1** (see design doc §2): inpainter model + delivery.
> - Recommended: **LaMa** (Apache-2.0, deterministic, ~50–100 MB) primary; **MI-GAN** (MIT, ~tens of MB) as the iOS/mobile default. Both deterministic → the bake is a recomputable cache, regenerable from the XMP `Removal`.
> - Delivery: **downloaded on first use** via the PanoProvisioner pattern (not bundled — keeps the app binary small), SHA-256 pinned.
> - Diffusion (SD1.5-inpaint) is a later, separately-labeled **Generative Fill**, not this milestone.

### M4.1 — Model provisioning + ORT session (MAC + Rust)
- [ ] Generalize the model manifest from the fixed `{aliked, lightglue}` struct to a keyed registry — Rust `models.toml` (`maple-pano/src/models.rs`) **and** the hardcoded Swift `PanoProvisionManifest.swift` array. Add the chosen model entry (`file/sha256/size/source/license`).
- [ ] New native sibling crate (mirror `maple-pano`): an `ort` + CoreML-EP session wrapper for the eraser (copy `OrtRuntime::preflight`, the `lightglue.rs` session-build + EP-registration). **Validate the model's op set against the CoreML EP** — it was hand-checked for ALIKED/LightGlue only; a LaMa/MI-GAN op set is different. CPU-ORT is the correctness floor (as macOS pano already does).
- [ ] ORT gotchas (memory): macOS dylib ≥1.23 (1.22 aborts at exit); iOS static-links 1.22; `libloading` preflight; disable ORT memory-pattern/arena (saves GBs).

### M4.2 — Inference glue (Rust/native)
- [ ] Crop the masked region from the **display-referred** preview (the model needs graded context — design §4 bake-preview path, creative/spatial stages OFF). Run the eraser → display-referred RGB output for the region.

### M4.3 — Bake to synthetic-raw (raw-core, VERIFIABLE) 
- [ ] Feed the model's display-referred output through `view::agx_inverse::display_u8_to_scene_linear` → `view::grade_inverse::{inverse_exposure, inverse_white_balance}` (snapshot the image's bake grade into `BakeGrade`) → scene-linear Rec.2020 patch → `InpaintPatch` (coverage = feathered mask) → `patches`/store. This is the Phase-0 inverse in production; unit-test the bake path on a synthetic crop like the Phase-1 seam test.

### M4.4 — Auto segmentation (MAC, Apple Vision — zero model download)
- [ ] `VNGeneratePersonInstanceMaskRequest` (per-person) + `VNGenerateForegroundInstanceMaskRequest` (subject) → coverage mask for the "remove people/subject" one-tap path. ANE-accelerated, no provisioning. Accept the 4-person cap.

### M4.5 — Mask UX (MAC, SwiftUI)
- [ ] Brush/lasso paint → raster mask; a "Remove" action that runs M4.2→M4.3, stores the patch + `Removal`, triggers a re-render. Re-bake only on explicit user request or mask edit (never on a grade tick — the cache key omits grade fields, design §3d). Progress UI for the few-second model run.
- [ ] Product framing: label it **Remove** (eraser/heal), not Generative Fill (design §2).

---

## Verification gates (Apple, local)
- raw-core suite green (`cd src/apple/Packages/MapleCore && swift test`; `cargo test -p raw-core`).
- The XCUITest visual harness: a fixture removal renders + survives a grade push within budget (extend `SliderMatrixUITests` or add an inpaint golden).
- Manual: open a RAW, paint a mask, Remove, then push exposure ±2 EV / temp ±1000 K — the patch tracks the surroundings (no seam, no band), matching the Phase-0 numeric gate now through the real Apple pipeline.
