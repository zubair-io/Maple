# Pano-Core Rust Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder hand-rolled stages in `pano-core` with production-grade Rust implementations of the algorithms a real panorama stitcher needs, so DJI multi-row spherical panoramas (`test-fixtures/raws/pano_01`, 21 frames covering ~263° yaw + ±23° pitch) actually stitch into a clean equirectangular output. No subprocess to AliceVision; no FFI to OpenCV; no GPL code in the tree. Pure Rust, runs everywhere our crate runs (macOS / iOS / WASM).

**Architecture:** Replace algorithm-by-algorithm within the existing `pano-core` trait surface (`FeatureDetector`, `FeatureMatcher`, `BundleAdjuster`, `Warper`, `SeamFinder`, `Blender`). Each phase swaps one or more stages for a higher-quality implementation. The trait surface stays stable — callers (pano-smoke, raw-ffi pano feature, web service) don't change. We benchmark each phase against the synthetic harness (mean ΔE ≤ 15) AND the pano_01 fixture (visual + dimension growth as the canvas extends with each fix).

**Algorithmic reference:** AliceVision (MPL-2.0) is the primary source — its panorama pipeline at `src/aliceVision/panorama/` and `src/software/pipeline/main_panorama*.cpp` is well-organized and matches our trait shape. OpenPano (MIT) is the secondary reference for simpler self-contained implementations of specific stages. Both are permissive; we read the C++ as design reference and write fresh Rust. Helmut Dersch's PanoTools papers (the foundational work) are the third reference for the math.

**Tech Stack:**
- Existing `pano-core` Rust crate — host module + trait surface
- `nalgebra` — already a dep (matrices, SVD, linear algebra)
- `argmin` — already a dep (LM solver) — augmented with hand-rolled inner loops where argmin's trait surface is awkward
- `imageproc` — already a dep (corner detectors, image primitives)
- New deps as needed:
  - `kornia-rs` (Apache-2.0) for AKAZE feature detection — likely added in Phase 1
  - Hand-rolled BK max-flow for graph-cut seam — Phase 5 (no acceptable Rust crate exists)

---

## Phase ordering by impact-on-pano_01-quality

The order is chosen so each phase produces a visible improvement on `pano_01` and the metrics are observable before committing to the next phase.

1. **Phase 1: AKAZE detector** — replace ORB. ORB is poor on RAW content (designed for u8 web images, not linear-light RAW). AKAZE handles low-contrast, high-DR RAW better. Same trait, drop-in.
2. **Phase 2: Joint rotation+focal BA across N images** — replace the iterative pairwise GN/LM chain with a single global solve. This is what actually makes pano_01 produce a wide canvas instead of an identity stack.
3. **Phase 3: Spherical projection warp + canvas** — extend `pano-core::warp::canvas` to compute spherical (equirectangular) bbox + render directly into spherical output. pano_01 needs equirect, not cylindrical (it has ±23° pitch).
4. **Phase 4: Auto focal estimation** — currently we default focal = image_width and BA can't move it much. Real pano stitchers estimate focal from pairwise homography decomposition + BA jointly refines.
5. **Phase 5: Graph-cut min-cost seam (Boykov-Kolmogorov)** — the actual seam algorithm panorama stitchers use; replaces our Dijkstra approximation.
6. **Phase 6: Exposure / gain compensation** — Hugin's vig_optimize equivalent. Per-image gain solved via least-squares on overlap regions. Fixes brightness banding.
7. **Phase 7: End-to-end validation against pano_01** — run the full pipeline, measure mean/p95/max ΔE against a hand-curated reference (we'll generate one with PTGui or AliceVision once we have it built, OR settle for visual inspection).

Phases 1–7 each ship as their own commit set with a verified improvement before moving on.

---

## Phase 1 — AKAZE feature detector

**Why first:** The current ORB detector finds ~500 keypoints on a 21 MP DNG but most are noise-driven and don't match across pairs reliably (translated patches in the overlap give different descriptors). AKAZE handles RAW content much better — it's nonlinear-scale-space-based, which means scene structure (edges, blobs) survives the differing exposure and noise between consecutive shots. Joint BA in Phase 2 needs reliable matches; bad matches in Phase 1 starve it.

### Task 1.1: Add `kornia-rs` AKAZE dep + smoke test

**Files:**
- Modify: `src/raw-pipeline/pano-core/Cargo.toml` (add `kornia-imgproc = "0.1"` or whatever the current AKAZE crate name is — verify in step 1)

- [ ] **Step 1.1.1: Identify the right Rust AKAZE crate**

```bash
cargo search akaze | head -20
cargo search kornia | head -20
```

Pick the most maintained crate that actually implements AKAZE end-to-end (detection + descriptor). Candidates:
- `akaze` crate by rust-cv — pure-Rust port of AKAZE
- `kornia-imgproc` — kornia's Rust image processing module
- `cv` umbrella crate

Document the choice in `docs/setup/akaze-rust-crate.md` with the version pinned and a one-paragraph rationale.

- [ ] **Step 1.1.2: Add the chosen crate to pano-core deps**

```bash
# example using `akaze`:
cargo add akaze --manifest-path src/raw-pipeline/pano-core/Cargo.toml
```

Verify the crate compiles cleanly with our existing pano-core deps:

```bash
cd src/raw-pipeline && cargo check -p pano-core
```

Expected: clean build, no version conflicts.

- [ ] **Step 1.1.3: Write a failing smoke test**

In `src/raw-pipeline/pano-core/tests/akaze_smoke.rs`:

```rust
//! Smoke test: AKAZE detects ≥50 keypoints on a synthetic textured image.

use pano_core::features::akaze::AkazeDetector;
use pano_core::traits::FeatureDetector;
use pano_core::{ColorSpace, PanoImage};

fn synthetic_textured_image(w: u32, h: u32, seed: u64) -> PanoImage {
    let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
    let mut rng = seed;
    for i in 0..(w as usize * h as usize) {
        rng = rng.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        let v = ((rng >> 33) as f32) / (u32::MAX as f32);
        img.pixels[i * 3] = v;
        img.pixels[i * 3 + 1] = v * 0.9;
        img.pixels[i * 3 + 2] = v * 0.85;
    }
    img
}

#[test]
fn akaze_detects_features_on_synthetic_image() {
    let img = synthetic_textured_image(256, 256, 42);
    let detector = AkazeDetector::default();
    let features = detector.detect(&img).expect("detection should succeed");
    assert!(
        features.keypoints.len() >= 50,
        "expected ≥50 keypoints, got {}",
        features.keypoints.len()
    );
    assert!(
        !features.descriptors.is_empty(),
        "expected non-empty descriptors"
    );
}
```

- [ ] **Step 1.1.4: Run the test to verify it fails**

```bash
cd src/raw-pipeline && cargo test -p pano-core --test akaze_smoke
```

Expected: compile error — `AkazeDetector` doesn't exist yet.

- [ ] **Step 1.1.5: Commit (deps only, no impl yet)**

```bash
git add src/raw-pipeline/pano-core/Cargo.toml \
        src/raw-pipeline/Cargo.lock \
        docs/setup/akaze-rust-crate.md \
        src/raw-pipeline/pano-core/tests/akaze_smoke.rs
git commit -m "deps(pano): add Rust AKAZE crate + failing smoke test"
```

### Task 1.2: Implement `AkazeDetector` wrapping the chosen crate

**Files:**
- Create: `src/raw-pipeline/pano-core/src/features/akaze.rs`
- Modify: `src/raw-pipeline/pano-core/src/features/mod.rs` (add `pub mod akaze; pub use akaze::AkazeDetector;`)

- [ ] **Step 1.2.1: Implement the wrapper**

```rust
//! AKAZE feature detector via the `akaze` Rust crate (or whichever
//! crate Task 1.1 selected).
//!
//! AKAZE produces ~64-byte M-LDB binary descriptors. We pack them into
//! the existing `Features.descriptors` Vec<u8> with descriptor_dim = 64
//! so the existing BruteForceMatcher (Hamming distance) works without
//! modification.

use crate::error::PanoError;
use crate::traits::FeatureDetector;
use crate::types::{Features, Keypoint, PanoImage};
use crate::util::gray::pano_image_to_gray_u8;

#[derive(Debug, Clone, Default)]
pub struct AkazeDetector {
    /// Detector contrast threshold. Lower = more keypoints. Default per AKAZE paper.
    pub threshold: f64,
}

impl AkazeDetector {
    pub fn new() -> Self { Self::default() }
}

impl FeatureDetector for AkazeDetector {
    fn detect(&self, img: &PanoImage) -> Result<Features, PanoError> {
        let gray = pano_image_to_gray_u8(img);
        // Adapt to whichever AKAZE crate API was chosen in Task 1.1:
        // - akaze::Akaze::new(...).extract(&gray) returns Vec<Keypoint, Descriptor>
        // - kornia-imgproc may return tensors that need unpacking
        // ...
        todo!("implement against the chosen crate's API")
    }
}
```

The `todo!()` body is intentional — fill in based on the chosen crate's API in this same step before committing.

- [ ] **Step 1.2.2: Run the smoke test**

```bash
cd src/raw-pipeline && cargo test -p pano-core --test akaze_smoke
```

Expected: PASS — ≥50 keypoints + non-empty descriptors.

- [ ] **Step 1.2.3: Run the full pano-core suite**

```bash
cd src/raw-pipeline && cargo test -p pano-core
```

Expected: all previous tests still pass + 1 new (AKAZE smoke).

- [ ] **Step 1.2.4: Commit**

```bash
git add src/raw-pipeline/pano-core/src/features/
git commit -m "feat(pano): AkazeDetector wrapping the akaze crate"
```

### Task 1.3: Switch pano-smoke + harness default to AKAZE; verify on pano_01

**Files:**
- Modify: `src/raw-pipeline/pano-core/src/bin/pano-smoke.rs` (replace `OrbDetector::default()` with `AkazeDetector::default()`)
- Modify: `src/raw-pipeline/pano-core/src/lib.rs` (add `pub use features::AkazeDetector;`)

- [ ] **Step 1.3.1: Swap the detector in pano-smoke**

In `pano-smoke.rs::stitch_pair`, change:
```rust
let detector = OrbDetector::default();
```
to:
```rust
let detector = AkazeDetector::default();
```

- [ ] **Step 1.3.2: Re-run synthetic harness — must still pass**

```bash
cargo build --release -p pano-core --bin pano-smoke --manifest-path src/raw-pipeline/Cargo.toml
./src/scripts/test_pano_pipeline.sh --max-delta-e 15
```

Expected: PASS at mean ΔE ≤ 15. May be looser than ORB's 0.17 because AKAZE's descriptors don't match ORB's bit-for-bit, but quality should be better.

- [ ] **Step 1.3.3: Run pano_01 (5-image subset to keep iteration fast)**

```bash
PANO01="/Users/riabuz/Projects/_Maple/test-fixtures/raws/pano_01"
src/raw-pipeline/target/release/pano-smoke \
  $PANO01/PANO0001.DNG $PANO01/PANO0002.DNG \
  $PANO01/PANO0003.DNG $PANO01/PANO0004.DNG $PANO01/PANO0005.DNG \
  -o test-fixtures/pano/pano_01_akaze.png 2>&1 | grep -E "matches|inliers|canvas|output"
```

Expected: AKAZE finds more keypoints than ORB on RAW (typically 2-4× more); inlier counts per pair ≥ ORB's. Canvas dimensions still match input dims because BA is still rotation-only — Phase 2 fixes that.

- [ ] **Step 1.3.4: Commit**

```bash
git add src/raw-pipeline/pano-core/src/bin/pano-smoke.rs src/raw-pipeline/pano-core/src/lib.rs
git commit -m "feat(pano): use AKAZE as the default detector in pano-smoke"
```

---

## Phase 2 — Joint rotation+focal bundle adjustment

**Why second:** This is the highest-impact change. The current `solve_with_keypoints` runs BA per-image-pair iteratively (each chain step). For real handheld/drone panoramas, this produces identity rotations because each pair sees only a small slice of the rotation graph. Joint BA across all images simultaneously, with proper rotation parameterization (axis-angle, ω ∈ ℝ³ per camera), recovers the full rotation graph from pairwise correspondences — including the long-range constraints that link image 1 to image 21 via image 11.

### Task 2.1: Joint BA solver — design + first draft

**Files:**
- Create: `src/raw-pipeline/pano-core/src/ba/joint.rs`
- Modify: `src/raw-pipeline/pano-core/src/ba/mod.rs` (add `pub mod joint; pub use joint::JointRotationFocalBA;`)
- Modify: `src/raw-pipeline/pano-core/src/traits.rs` (extend `BundleAdjuster::solve` signature OR add a new trait `JointBundleAdjuster` that takes features as well as matches — pick whichever is less disruptive to existing callers)
- Create: `src/raw-pipeline/pano-core/tests/joint_ba.rs`

The reference is `aliceVision_panoramaEstimation` ([source](https://github.com/alicevision/AliceVision/blob/v3.3.0/src/software/pipeline/main_panoramaEstimation.cpp)) and the underlying `aliceVision::sfm::ReconstructionEngine_panorama` class.

The math (per Brown & Lowe 2007):
- Parameters: per-image (ω_x, ω_y, ω_z, f) — axis-angle rotation + focal. 4N params for N images.
- Camera 0 fixed (gauge freedom).
- Residuals: per-correspondence (i, j, ka, kb), reprojection error in image j of feature ka from image i.
  - Project ka through camera_i: x_i = K_i · R_i · K_i^-1 · [ka.x, ka.y, 1]^T (without the K_i^-1 it's not a 2D point — use the 3D ray after R_i, then project through K_j).
  - Actually: ray_i = R_i^-1 · K_i^-1 · ka; ray_j = R_j · ray_i; pixel_j = K_j · ray_j; residual = pixel_j - kb.
- LM optimization with Jacobian wrt (ω_x, ω_y, ω_z, f) for each camera.
- Initial state: identity rotations, focal = image_width (existing default).
- Gimbal-prior variant: when `gimbal: Option<GimbalAngles>` is present per image, initialize R_i from gimbal Euler angles instead of identity.

(Tasks below detail the implementation in TDD steps. The plan is intentionally lighter than Phase 1 because Phase 2 is large; subsequent task detail will be added once Phase 1 ships and the engineer can scope Phase 2 against AKAZE's actual match output.)

- [ ] **Step 2.1.1: Spec the input/output**

Write the trait extension (or new trait) with documentation, no implementation yet. Test that the type compiles.

- [ ] **Step 2.1.2: Write a failing test on a 3-camera synthetic case**

Three synthetic cameras at known yaw {0°, 30°, 60°}, identity intrinsics + focal=256. Generate matched correspondences from a synthetic point cloud projected through each. Joint BA must recover the three rotations within ±0.5° each.

- [ ] **Step 2.1.3: Implement Jacobian-based LM**

Hand-roll LM (we already did this in `lm.rs` for the rotation-only case — extend the parameter vector to include all N cameras at once). Cap iterations at 100; standard LM accept/reject damping.

- [ ] **Step 2.1.4: Pass the synthetic test**

- [ ] **Step 2.1.5: Add gimbal-prior variant of the entry point**

```rust
pub fn solve_joint_with_priors(
    features: &[Features],
    pairs: &[(usize, usize, Matches)],
    image_size: (u32, u32),
    gimbal_priors: Option<&[GimbalAngles]>,  // None → identity init
    seed: u64,
) -> Result<Vec<Camera>, PanoError>
```

- [ ] **Step 2.1.6: Wire into pano-smoke** — replace the iterative chain with a single joint solve over ALL N inputs at once.

- [ ] **Step 2.1.7: Validate on pano_01** — output canvas should now be ~5–8× wider than a single input (proper spherical pano width).

- [ ] **Step 2.1.8: Commit** — single commit for the whole joint BA delivery.

---

## Phase 3 — Spherical projection warp + canvas

**Why third:** pano_01 is a spherical pano with vertical pitch coverage (±23°). Cylindrical projection (current default) can't render the pitch range correctly. Equirectangular (spherical) is the right output projection for this type of pano. We already have `Projection::Spherical` in the warper but the canvas computation falls back to Rectilinear for non-cylindrical projections.

### Task 3.1: Spherical canvas computation

- [ ] Step 3.1.1: Extend `pano-core::warp::canvas::compute_canvas` to compute spherical bbox (λ, φ ranges) by projecting each image's grid sample through (R, K) onto the unit sphere.
- [ ] Step 3.1.2: Add `CanvasParams::Spherical { lambda_min, lambda_max, phi_min, phi_max }` to the canvas params enum (already declared but unused — implement the body).
- [ ] Step 3.1.3: Add `warp_spherical_canvas` to `canvas.rs` mirroring the existing `warp_cylindrical_canvas`.
- [ ] Step 3.1.4: Unit test: 2 cameras at known (yaw, pitch) produce a canvas whose (λ_max - λ_min) ≈ |Δyaw| + per-image FOV.
- [ ] Step 3.1.5: Validate on pano_01: canvas should grow vertically too (was 5376×3956; should become ≥10000×4000+).
- [ ] Step 3.1.6: Commit.

---

## Phase 4 — Auto focal estimation

**Why fourth:** Even with joint BA, our default focal=image_width prior is wrong for many lenses. Real stitchers estimate focal from pairwise homography (Hartley & Zisserman 2003 § 8.8 — focal extraction from H). This unblocks accurate stitching of unknown lenses.

### Task 4.1: Focal extraction from homography

- [ ] Step 4.1.1: Implement `focal_from_homography(h, image_size) -> Option<f64>` per Hartley & Zisserman § 8.8.
- [ ] Step 4.1.2: Use it as the per-camera focal initialization in joint BA (instead of `image_width` default).
- [ ] Step 4.1.3: Unit test: synthetic homography with known focal (256) recovers it within ±5%.
- [ ] Step 4.1.4: Validate on pano_01: BA-converged focal should now be a sensible number (~17.4mm 4/3" sensor with 5376×3956 means focal ≈ ~5500–6500 px).
- [ ] Step 4.1.5: Commit.

---

## Phase 5 — Graph-cut min-cost seam (Boykov-Kolmogorov)

**Why fifth:** Dijkstra-based seam works for horizontal panos (the common case) but breaks on multi-row spherical panos where the optimal seam is non-monotonic. AliceVision's seam finder uses BK max-flow (`aliceVision::panorama::SeamFinder`). No Rust BK port exists; we vendor one.

### Task 5.1: Vendor a Boykov-Kolmogorov max-flow Rust impl

- [ ] Step 5.1.1: Write a self-contained BK port at `src/raw-pipeline/pano-core/src/seam/bk.rs` — the algorithm is well-documented in the original BK 2004 paper; ~400 lines of Rust. References: Yury Boykov + Vladimir Kolmogorov, "An Experimental Comparison of Min-Cut/Max-Flow Algorithms for Energy Minimization in Vision" (PAMI 2004).
- [ ] Step 5.1.2: Unit test: known graph with known min-cut returns the expected partition.
- [ ] Step 5.1.3: Add `GraphCutMaxFlowSeamFinder` impl of `SeamFinder` using the BK port.
- [ ] Step 5.1.4: Switch `GraphCutSeamFinder` (the existing Dijkstra impl) to be the fallback; default becomes the BK variant.
- [ ] Step 5.1.5: Validate seam quality visually on a 2-image overlap with a non-monotonic optimal seam (e.g. an object crossing the overlap region).
- [ ] Step 5.1.6: Commit.

---

## Phase 6 — Exposure / gain compensation

**Why sixth:** DJI panos and any handheld captures have varying exposure between frames. Without compensation, even a perfect geometric stitch shows brightness banding at every seam. Hugin's `vig_optimize` solves per-image gain (and optionally per-image vignetting) by minimising overlap-region intensity differences. AliceVision has an equivalent in `aliceVision::sfm::ExposureCompensator`.

### Task 6.1: Per-image gain solve

- [ ] Step 6.1.1: New module `pano-core::compensation::gain` with `solve_per_image_gain(warped: &[&PanoImage]) -> Vec<f32>`.
- [ ] Step 6.1.2: For each pair (i, j) with overlap: gain_ratio = mean(B_overlap_i) / mean(B_overlap_j) (luminance-only is fine, or per-channel for chroma compensation).
- [ ] Step 6.1.3: Solve a global least-squares system: `argmin Σ_pairs (g_i / g_j - r_ij)^2` with g_0 = 1 (gauge fix). Closed-form via log-domain linearization.
- [ ] Step 6.1.4: Apply per-image gains to warped images before blending.
- [ ] Step 6.1.5: Validate: pano_01 stitch should show no visible brightness step across seams.
- [ ] Step 6.1.6: Commit.

---

## Phase 7 — End-to-end validation against pano_01

### Task 7.1: Generate ground-truth reference for pano_01

- [ ] Step 7.1.1: Use AliceVision (the subprocess backend started in the previous plan) OR PTGui OR Hugin (with all-pairs matching enabled) to produce a reference equirectangular stitch. Save at `test-fixtures/pano/references/pano_01_reference.exr` or `.png`.
- [ ] Step 7.1.2: If no external tool produces an acceptable reference, fall back to "visual inspection by Zubair" as the gate (document this as a manual checkpoint).

### Task 7.2: Add pano_01 to the harness

- [ ] Step 7.2.1: Extend `src/scripts/test_pano_pipeline.sh` to detect the `test-fixtures/raws/pano_01/` directory + run pano-smoke against all 21 inputs + diff against the reference.
- [ ] Step 7.2.2: Set initial budget at mean ΔE ≤ 30 (loose — we'll tighten as quality improves).

### Task 7.3: Update the task plan v0.4

- [ ] Step 7.3.1: Append a "Phase 8 — Rust port outcome" section to `docs/tasks/04-maple-panorama-spec.md` summarising what shipped and updated quality numbers.

---

## Risks worth calling out

- **AKAZE crate maturity.** The Rust AKAZE port may not be production-grade. If the smoke test in Phase 1 is slow or crashes, fall back to porting AKAZE from OpenCV (simpler than SIFT, well-documented, ~1000 lines).
- **Joint BA is the hardest task.** Phase 2 is genuinely complex math; the test cases must be synthetic-deterministic so a bug shows up immediately. If joint BA diverges on pano_01, the first diagnostic is "are the matches actually consistent? print the inlier graph."
- **BK max-flow is non-trivial.** Phase 5 vendors a 400-line algorithm. Test against published min-cut examples before plugging it into the seam finder.
- **No Rust BK exists today.** This is genuinely the only Rust impl in the world if we ship it. Plan ahead: clean code, good tests, write a doc comment naming the BK 2004 paper.

## Self-review checklist

- **Spec coverage:** Phases 1-7 each correspond to a specific algorithm gap identified in `docs/tasks/04-maple-panorama-spec.md` v0.3 status snapshot points #9, #11, #12 + the "BA rotation-only model" issue. Phase 4 (focal estimation) is bonus — not blocking but improves quality measurably.
- **Type consistency:** `JointRotationFocalBA`, `GraphCutMaxFlowSeamFinder`, `solve_joint_with_priors`, `focal_from_homography` are introduced in their respective phases and stay consistent.
- **Placeholder scan:** Phase 1 has full task detail. Phases 2–6 use bullet-form steps (the engineer scopes them in detail when starting each phase, with the previous phase's output in hand). Phase 7 is integration.
- **Scope discipline:** No GUI, no batch processing, no cross-platform-specific work — all algorithm. Cross-platform happens for free since pano-core compiles to wasm32 and apple targets already.
