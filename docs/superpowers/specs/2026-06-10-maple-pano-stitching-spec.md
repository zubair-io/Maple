# Maple Pano — Panorama Stitching Pipeline Tech Spec

**Status:** Draft v2 (supersedes the approach in Maple PR #17)
**Component:** `maple_pano` (Rust core) → MaplePano.xcframework (Swift) / WASM (Just Maple)
**Author:** Zubair Lawrence

---

## 1. Problem

The current stitcher (PR #17) produces subpar results. The failure pattern is consistent with three structural defects, not tuning issues:

1. **Pairwise homography chaining with no global refinement.** Adjacent pairs align; the panorama as a whole drifts, bows, and accumulates scale error across the strip. A planar homography is also the wrong model past ~40° FOV — drone panos routinely exceed 180°.
2. **No principled projection model.** Compositing in the reference frame's plane stretches the strip ends and makes wide panos geometrically impossible.
3. **Naive blending.** Feathered or hard seams in display-referred space produce visible exposure steps and ghosting.

This spec defines the replacement pipeline: a **rotation-model, globally bundle-adjusted, seam-optimized, multi-band-blended** stitcher operating entirely in scene-referred linear float, with linear DNG output.

## 2. Goals

- Geometrically correct panoramas up to full 360°×180° from DJI drone DNG and iPhone ProRAW input.
- No visible seams or exposure steps at 100% zoom on static scenes; bounded ghosting on scenes with motion.
- Mean reprojection error after bundle adjustment ≤ 1.5 px on 24 MP input.
- Single Rust core, identical results across macOS/iOS (Metal via wgpu) and WASM (WebGPU).
- Linear DNG output preserving ≥ 16-bit effective precision; no tone mapping inside the pipeline.

## 3. Non-Goals

- **Bayer-mosaic-level stitching.** Demosaic first; stitch in linear RGB; output linear DNG. Mosaic-level alignment at seams is a research problem with negligible quality benefit over linear DNG.
- **Full SfM / 3D reconstruction.** We assume near-pure rotation (drone gimbal pano, handheld pivot). Translation-dominant input is out of scope; we detect and warn, not solve (AliceVision exists for that).
- **Video / real-time preview stitching.** Batch pipeline only in this version; a low-res fast preview is P1.
- **Generative fill of sky/nadir holes.** Optional rescue mode later, never default.

## 4. Pipeline Overview

```
DNG/ProRAW ─► Decode + Demosaic ─► Linear f32 RGB (+ validity mask)
                                        │
                                        ▼
                          ALIKED keypoints + descriptors (ort)
                                        │
                                        ▼
                     LightGlue pairwise matching ─► Match graph
                                        │
                                        ▼
              Rotation-model estimation (focal + R per camera, RANSAC init)
                                        │
                                        ▼
              GLOBAL BUNDLE ADJUSTMENT  (rotation + focal + k1,k2; LM)
                                        │
                                        ▼
              Projection selection (spherical / cylindrical / equirect)
                                        │
                                        ▼
              Gain compensation (per-image, linear space)
                                        │
                                        ▼
              GPU warp to canvas (wgpu/WGSL, bicubic, validity-aware)
                                        │
                                        ▼
              Graph-cut seam finding (low-res, upsampled masks)
                                        │
                                        ▼
              Multi-band Laplacian blend (linear f32, GPU)
                                        │
                                        ▼
              Export: Linear DNG (primary) | 16-bit TIFF | HEIF/JPEG preview
```

Every stage reads and writes `Image<f32>` in scene-referred linear with explicit primaries/white point; tone transforms exist only at the preview-export boundary.

## 5. Stage Specs

### 5.1 Ingest & Decode

- `rawler` for DNG/ProRAW decode. Demosaic to linear RGB at native bit depth → f32, normalized to scene-referred linear with the camera's `ColorMatrix`/`ForwardMatrix` applied to a common working space (Rec.2020 primaries, D65, linear).
- Apply per-image black level, white level, and vignette correction (DNG `OpcodeList` if present; otherwise estimated radial gain) **before** matching — vignetting corrupts both descriptors and gain compensation.
- Attach DJI/Apple gimbal yaw/pitch/roll from XMP when present as the **initialization prior** for camera rotations. Prior is advisory: it seeds RANSAC and BA, never constrains the solution.

### 5.2 Feature Detection & Matching

- ALIKED-t16 keypoints/descriptors, LightGlue matcher, both via `ort` (CoreML EP on Apple, WebGPU/WASM EP in browser). Already built — carried over from current code.
- **Change from PR #17:** match a graph, not a chain. Build candidate pairs from (a) capture-order adjacency, (b) gimbal-prior angular proximity < 1.5× per-image FOV, (c) for unordered input, top-k retrieval by mean descriptor similarity. Verify each pair with MAGSAC++ on the rotation model (not homography); keep pairs with ≥ 30 inliers.
- Output: connected match graph. If the graph is disconnected, stitch the largest component and report the orphans — never silently drop or force-align.

### 5.3 Camera Model & Global Bundle Adjustment

This is the core fix.

- **Camera model:** per-image rotation `R_i ∈ SO(3)`, shared (or per-image, configurable) focal `f`, principal point fixed at center, radial distortion `k1, k2`. Pairwise relation: `x_j ≈ K_j R_j R_iᵀ K_i⁻¹ x_i`.
- **Initialization:** focal from EXIF (fallback: estimate from pairwise homography decomposition); rotations from gimbal prior or spanning-tree propagation of pairwise relative rotations from the match graph.
- **Global BA:** Levenberg-Marquardt over all `R_i` (axis-angle local parameterization), `f`, `k1`, `k2`, minimizing symmetric reprojection error over all inlier matches in the graph, Huber loss (δ = 2 px). `argmin` + `nalgebra` with analytic Jacobians, residuals parallelized with rayon (decision §9.1 — no Ceres FFI). Shared focal with automatic per-image fallback per decision §9.2.
- **Up-vector correction:** after BA, solve for the global rotation that levels the horizon (minimize tilt of camera x-axes; use gimbal prior if available). Kills the "banana" artifact.
- **Acceptance gate:** mean reprojection error ≤ 1.5 px, max ≤ 6 px. Failing images are dropped from compositing with a per-image diagnostic, not blended in misaligned.

### 5.4 Projection

- Default selection by angular extent: < 60° → rectilinear (plane), 60–130° → cylindrical, > 130° → spherical/equirectangular. User-overridable.
- Canvas resolution chosen to preserve the maximum input angular pixel density (no implicit downsampling); cap configurable for memory.

### 5.5 Gain Compensation

- Per-image scalar gain (optionally per-channel) solved as least squares over mean intensities in pairwise overlap regions — Brown-Lowe style, but **in linear space**, where it's physically a single multiplier. This is cheap and correct only because we never left linear.
- Drone panos with locked AE will solve to ~1.0; bracketed/auto-exposure inputs get correct relative scaling. HDR merge of bracketed sets per position is P1 (reuse existing Maple HDR merge before this stage).

### 5.6 Warp

- wgpu/WGSL compute: inverse-map per output tile, bicubic (Catmull-Rom) sampling, validity-mask aware (no smearing at frame edges). f32 throughout. Tiled to bound peak memory (target ≤ 6× input).

### 5.7 Seam Finding

- Graph-cut seams on ~1–2 MP downsampled overlaps; data term = gradient-domain difference (penalizes cutting through misaligned or moving content), smoothness term = local contrast. Masks upsampled to full res with feather of one blend-band width.
- Rationale vs. PR #17's center-weighted/feather masks: graph-cut routes seams around parallax and motion instead of averaging across them — this is the ghosting fix.

### 5.8 Blending

- Multi-band Laplacian pyramid blend, **linear f32, on GPU**, band count = `log2(min overlap width)` capped at 7. Validity masks propagate through the pyramid.
- Explicitly not feathering, not gradient-domain Poisson (cost/benefit poor at 120 MP).

### 5.9 Export

- **Primary:** Linear DNG — demosaiced `LinearRaw`, 16-bit integer with headroom convention for bracketed input (scene white ≈ 1/4 full scale; decision §9.3), working-space-to-XYZ matrices in `ColorMatrix1/2`, embedded preview, stitch metadata in XMP (projection, FOV, per-camera rotations). f16 HDR DNG as an explicit opt-in export with compatibility warning.
- Secondary: 16-bit TIFF (linear or with transfer), display-referred HEIF/JPEG preview through the Maple/AgX house transform — the **only** place tone mapping happens.
- 360° outputs get GPano XMP so Photos/Files/Google viewers recognize them as spherical.

## 6. Data Model

Carried unchanged from the Maple Pano pipeline spec: planar `Image<f32>` with explicit `ColorSpace { primaries, white_point, transfer: Linear }`, validity masks on every buffer, `palette`-based color math, no sRGB assumptions anywhere in core. UniFFI `Pipeline` API gains:

```rust
pub struct StitchReport {
    pub cameras: Vec<CameraPose>,        // R, f, k1, k2 per image
    pub mean_reproj_error_px: f32,
    pub max_reproj_error_px: f32,
    pub dropped_images: Vec<DropReason>, // disconnected, high residual, low overlap
    pub projection: Projection,
    pub fov_deg: (f32, f32),
}
```

`StitchReport` is returned alongside the output buffer so Aperture/RedSunsetMaple can surface _why_ a result looks the way it does instead of failing opaquely.

## 7. Quality & Performance Acceptance Criteria

Geometric and visual gates, measured on a fixed regression set (DJI Mini/Mavic pano sets, iPhone handheld sweeps, a synthetic ground-truth set rendered from an equirect source):

- [ ] Synthetic set: recovered rotations within 0.1° of ground truth; warp RMSE vs. ground-truth canvas < 0.5% of full scale.
- [ ] Mean reprojection error ≤ 1.5 px on all real sets post-BA.
- [ ] No seam visible at 100% on static-scene sets (checked via seam-line gradient energy metric + eyeball).
- [ ] Horizon level within 0.3° on gimbal-prior sets.
- [ ] No drift: closure error on full 360° loops ≤ 2 px at canvas scale.
- [ ] 6× 24 MP DNG → 120 MP pano: < 12 s M-series Mac, < 30 s iPhone 15 Pro, peak memory ≤ 6× input (targets carried from pipeline spec; BA budget within them is < 1 s for ≤ 30 images).
- [ ] Identical output (within f32 tolerance) between Metal and WebGPU backends on the regression set.

## 8. Failure Modes

| Condition                               | Detection                                                                                 | Behavior                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Translation-dominant capture (parallax) | High BA residuals concentrated at depth edges; homography fits better than rotation model | Warn; proceed with seam-routing around parallax; suggest re-capture   |
| Disconnected match graph                | Graph components > 1                                                                      | Stitch largest component; list orphans in `StitchReport`              |
| Low-texture frames (sky-only)           | < 30 verified matches to any neighbor                                                     | Fall back to gimbal-prior placement for that frame, flagged in report |
| Moving subjects in overlap              | Graph-cut data term spikes                                                                | Seam routes around; no extra handling in v1                           |
| Mixed exposure without brackets         | Gain solve produces large spread                                                          | Apply gains; warn if spread > 2 EV                                    |

## 9. Decisions

1. **BA solver: `argmin` LM, no Ceres FFI.** A rotation-only pano BA is ~3 params/camera + 3 global — ~453 params even at 150 images. Ceres's advantage (sparse Schur on 3D point structure) doesn't apply; we have no points in the state vector. Cost is residual/Jacobian evaluation over matches, parallelized with rayon. Ceres FFI would also drag a C++ toolchain into the build and break WASM parity, which is near-disqualifying on its own. The residual risk is convergence robustness, not speed — mitigated by gimbal-prior + spanning-tree initialization. The step-4 benchmark verifies the **convergence basin** (perturb init by 5–15°), not just wall time; passing closes this permanently.
2. **Focal: shared, with automatic per-image fallback — no user toggle.** After the shared-focal solve, frames whose residuals are systematically radial (signature of wrong focal) and whose median residual drops materially when their focal is freed get a per-image focal; everything else stays shared. Shared focal is a deliberate regularizer: free per-image focals let BA absorb parallax error into fake focal variation, improving residuals while degrading geometry. Single-lens drone and iPhone sets — the dominant input — never trigger the fallback.
3. **Export precision: 16-bit integer LinearRaw default with documented headroom; f16 is an explicit HDR export option.** For bracketed/merged input, scene white maps to ~1/4 full scale (2 stops highlight headroom — the stacked-DNG convention). f16 DNG reader support in the wild is inconsistent and Apple Photos compatibility is non-negotiable for the ecosystem; f16 only wins past ~14 stops post-merge. **Action before step 9:** half-day compatibility survey of f16 DNG across Photos.app, Quick Look, Lightroom, Capture One, darktable, and DJI tooling to set the warning copy on the HDR option.
4. **`StitchReport`: actionable notices in UI, numbers in debug log.** v1 surfaces only plain-language, user-actionable items — "2 photos couldn't be matched and were left out," "movement detected, some areas may show ghosting," "sideways motion detected; pivot in place for best results" — mapped from `dropped_images`, the parallax warning, and the gain-spread warning. Reprojection errors and per-camera poses go to a debug log / hidden inspector. Per-camera pose visualization is a v2 debug-view candidate.

## 9a. Open Questions

1. **Final wording and placement of the v1 user-facing notices in Aperture** (toast vs. result-sheet banner vs. both), and whether the debug inspector ships hidden-but-present or log-only. (Product/UI — non-blocking; resolve during step 10.)

## 10. Build Steps

1. Regression harness first: assemble fixed input sets + synthetic ground-truth renderer; wire the §7 metrics into CI. Nothing else lands without this measuring it.
2. Replace pairwise homography chain with match graph + rotation-model MAGSAC++ verification.
3. Rotation/focal initialization: EXIF focal, gimbal prior ingestion, spanning-tree rotation propagation.
4. Global bundle adjustment (LM, analytic Jacobians) + up-vector correction + per-image focal fallback. Run the convergence-basin benchmark (perturb init 5–15°) to confirm decision §9.1.
5. Projection selection + canvas sizing; port warp shader to spherical/cylindrical inverse maps.
6. Linear-space gain compensation.
7. Graph-cut seam finder (CPU at low res is fine; masks to GPU).
8. Multi-band blend WGSL pass with validity-mask pyramid.
9. f16 DNG reader-compatibility survey (half day; sets warning copy per decision §9.3), then linear DNG writer (LinearRaw + headroom, matrices, XMP stitch metadata, GPano for 360°, f16 opt-in).
10. UniFFI surface for `StitchReport` + the v1 user-facing notices in Aperture (resolving open question §9a.1); wire into RedSunsetMaple; WASM build parity check.
11. Run full regression set; close acceptance gates; delete the PR #17 path.
