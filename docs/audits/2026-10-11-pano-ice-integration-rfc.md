# RFC: What `maple-pano` should take from Microsoft ICE, and how

**Status**: Proposed
**Date**: 2026-10-11
**Scope**: `src/raw-pipeline/maple-pano` (rotation and tile strategies), `raw-core::decode_for_pano`
**Reference**: `ice-stitch-core`, the clean-room Rust reconstruction of ICE 2.0 / `StitchEngine.DLL` at `~/Projects/Image Composite Editor` (`RECONSTRUCTION.md`, `src/*.rs`), read against the binaries' string tables where the Rust port stops short.
**Related**: `docs/pano.md`, `docs/lens-profiles.md`, `test-fixtures/pano-budgets.json`, `src/scripts/pano_metrics.py`

---

## 0. Summary

ICE is a 2015 display-referred stitcher built around one in-memory canvas. Maple is a scene-linear, memory-bounded stitcher with learned matching and a parallax mesh. Most of what ICE does, Maple already does better. Four things are worth taking, and one thing the review found in Maple itself matters more than anything in ICE.

**The finding that reorders the plan.** The rotation strategy, which is the production path for every pivot-in-place panorama, does not multi-band blend. Both tiled compositors hard-copy the owning frame (Voronoi) or accumulate bilinearly-upsampled feathered masks (graph-cut) and report `blend_levels: 1` (`composite/tiled.rs:338,476`, `composite/tiled/graph_cut.rs:315`). `blend_multiband` is reached only from the non-tiled test path and from the tile strategy. `docs/pano.md` describes Burt–Adelson as if it ran everywhere. Every "residual low-frequency seam" observed on a rotation pano is first and foremost this, not a missing Poisson stage. Fixing it is P0 and it is not an ICE import.

**Three premises in the brief that the code does not support**, stated up front so the plan is built on what is actually there:

1. ICE's "fast Poisson" is not seam-band Poisson. The native-derived path (`blend.rs:296-439`, `native_poisson.rs`) solves a **coarse per-view additive offset field** on an 8 px (or coarser) grid from pairwise overlap colour differences, with a Laplacian smoothness prior, then bilinearly upsamples it. That is structurally what Maple's tile strategy already does in `tile/exposure_field.rs`. The full-resolution Dirichlet seam-band solve in `blend.rs:1523-1668` is a Rust-side addition, explicitly marked in `RECONSTRUCTION.md:88` as not recovered from the DLL.
2. `StructuredPanoramaInfo` (rows/columns, Serpentine/Zigzag, start corner, overlap, `FeatureMatchingSearchRadius`) and `STITCH_VIDEO_FRAME_INFO` / `VideoRectangles` exist only as symbol strings in `ICE.exe` and `StitchEngine.DLL`. The Rust reconstruction has no code for either, and `RECONSTRUCTION.md:27` says the search radius never reaches native alignment on any observed path. Sections 5 and 6 below are therefore designs from first principles that borrow ICE's _product_ ideas, not ports.
3. ICE's additive bias and its clamps (`|b| ≤ 0.15`, `g ∈ [0.25, 4]`) are tuned for display-referred 0..1 JPEGs. Maple's frames are unbounded scene-linear f32 with measured gain spreads of 4.76× on `pano_01`. The _method_ (robust per-pair affine fit, residual-weighted edges, clip rejection) ports; the _constants_ do not.

### Prioritised plan

| Tier   | Item                                                                                                                                       | Target modules                                                                        | Size |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ---- |
| **P0** | Multi-band blend on the tiled rotation path (streaming pyramid accumulation per strip)                                                     | `composite/tiled.rs`, `composite/tiled/graph_cut.rs`, `blend.rs`                      | M    |
| **P0** | Bundled lens-profile vignette correction in pano ingest (resolves the "dark sky corners" on bodies without `OpcodeList3`)                  | `raw-core/src/pipeline/pano/mod.rs`                                                   | S    |
| **P0** | Gain solve hardening from ICE: clip window, robust per-pair affine fit, residual-variance edge weights                                     | `gain/mod.rs`, `gain/streaming.rs`                                                    | S–M  |
| **P1** | Transverse cylindrical and spherical projections, sweep-axis detection, roll-only leveling for vertical sweeps                             | `project.rs`, `canvas/auto.rs`, `canvas/mod.rs`, `leveling.rs`, `warp/mod.rs`         | M    |
| **P1** | Coarse per-frame offset field on the rotation branch (port of `tile/exposure_field.rs`; ICE mechanism A corroborates the design)           | `gain/field.rs` (new), `seam/masks.rs`, `composite/tiled/graph_cut.rs`, `warp/mod.rs` | M    |
| **P1** | Seam ROI constraints: include / exclude rectangles as hard terminal pins                                                                   | `seam/pairwise.rs`, `seam/labels.rs`, `seam/masks.rs`, CLI args, FFI                  | M    |
| **P1** | Spatial neighbourhood provider (GPS footprint, chain-inferred grid) plus a triangle-consistency filter on prior-less edges                 | `graph/mod.rs`, `graph/grid_prior.rs` (new), `ingest/priors.rs`, `raw-core` metadata  | M    |
| **P2** | Blind shared-lens vignette estimation when neither opcodes nor a profile exist                                                             | `gain/vignette.rs` (new)                                                              | M    |
| **P2** | Classical detector/matcher behind a `classical` feature, only if a product decision requires pano where ONNX Runtime cannot run (Web/WASM) | `features/classical/` (new)                                                           | L    |

The brief asks for bias and vignette inside the gain solve; §2 explains why the vignette belongs upstream at ingest first, and why the bias term is accepted only with a significance gate.

---

## 1. Projections and geometry

### What ICE has

Eleven output projections in `blend.rs:1286-1522`. The transverse variants are the standard ones with the roles of the two axes exchanged _in the formula_; the code inlines mirrored expressions rather than rotating the frame. In ICE's convention (`z` forward, `x` right, `y` down, image coordinates), with `h = u/f`, `w = v/f`:

| Projection            | forward `ray → (u, v)`                   | inverse `(u, v) → ray`                           |
| --------------------- | ---------------------------------------- | ------------------------------------------------ | --- | ------ |
| CylindricalTransverse | `(f·x/hypot(y,z), f·atan2(y,z))`         | `s = 1/√(1+h²)`; `(h·s, s·sin w, s·cos w)`       |
| SphericalTransverse   | `(f·atan2(x, hypot(y,z)), f·atan2(y,z))` | `(sin h, cos h·sin w, cos h·cos w)`, `None` if ` | h   | ≥ π/2` |
| MercatorTransverse    | `(f·asinh(x/hypot(y,z)), f·atan2(y,z))`  | `s = 1/cosh h`; `(tanh h, s·sin w, s·cos w)`     |

`RECONSTRUCTION.md:101` confirms these were read from the native `*VerticalProjection` vtables. ICE has **no automatic projection choice** (`StitchOptions::projection` defaults to Perspective and is used verbatim), no horizon or up-vector estimation, and a 16 MP canvas cap. Two numerical traps: the transverse across-axis coordinate (`x/hypot(y,z)`, `asinh(...)`) is unclamped, so one border sample near the transverse pole inflates the canvas to `CanvasTooLarge`; and the bounding-box routine silently drops samples that return `None`, under-estimating coverage near poles.

### What Maple has

`project.rs:33-40` has `Rectilinear | Cylindrical | Spherical`, world frame +X east, +Y down, +Z forward, angular `v` positive-up. `CanvasSpec` carries a `rotation: Mat3` (`canvas/mod.rs:84-98`) that is used only for rectilinear (yaw/pitch toward the content centroid, `canvas/auto.rs:270-272`); angular canvases always get `Mat3::identity()`. `select_projection(extent_deg)` (`canvas/mod.rs:72-80`) is `< 60° → Rectilinear, ≤ 130° → Cylindrical, else Spherical`, where extent is the diagonal angular diameter of the union footprint. There is no notion of sweep direction. `leveling.rs` estimates up as the least-eigenvalue eigenvector of the solved camera x-axes, which is correct for a horizontal sweep and _declines_ for a vertical one (parallel x-axes, `parallel_x_axes_decline`), so a vertical sweep today gets neither leveling nor re-orientation and is rendered as a tall slice of a standard cylinder, with the characteristic bow in the verticals. No test exercises a pitched set.

### Proposal

**Add two variants, not a canvas roll.** Expressing a transverse cylinder as `Cylindrical` plus a 90° roll in `CanvasSpec.rotation` works for the warp but breaks `angular_canvas` (`canvas/auto.rs:313-394`), whose longitude-window and pole logic assume the world Y axis is the cylinder axis, and would produce the vertical pano lying on its side, requiring a full-canvas transpose that the strip compositor cannot do. Explicit variants keep every site a one-arm change. In Maple's convention, with elevation `ψ = atan2(−y, z)` (positive up, 0 at +Z, range `(−π, π]`) and `ρ = hypot(y, z)`:

```
CylindricalTransverse  (cylinder axis = world X)
  forward:  u = x/ρ,        v = ψ                        None if ρ < 1e-12
  inverse:  s = 1/√(1+u²);  dir = (u·s, −s·sin v, s·cos v)

SphericalTransverse    (poles on ±X)
  forward:  u = asin(x),    v = ψ                        None if ρ < 1e-12
  inverse:  dir = (sin u, −cos u·sin v, cos u·cos v)     None if |u| > π/2
```

These are exactly ICE's formulas after the `y → −y` sign flip. `v` is the angular sweep coordinate (wraps mod 2π for a full vertical ring); `u` is the across coordinate. Clamp `|u| ≤ tan 85°` for the cylindrical variant at canvas-extent time, the same guard `angular_canvas` applies to `v` for the standard cylinder, which closes ICE's blow-up trap.

**Match sites to touch** (from the survey): `project.rs` forward/inverse and the `ALL` test array; `canvas/mod.rs:209-214` wrap rule (`v` wraps for transverse, `u` does not); `canvas/auto.rs:244-249` dispatch; `canvas/auto.rs:340-343` and `490-493` pole limits (poles are now ±X, so `sees_zenith/nadir` become `sees_east/west` computed from `sees_dir((±1,0,0))`); `canvas/auto.rs:432-513` `natural_canvas_pixel_ratio`; `warp/mod.rs:103-106` bbox unwrap period moves to the `v` axis. Rather than duplicate `angular_canvas`, parameterise it by an `(along, across)` axis pair so the standard and transverse branches share the window, cap, and wrap code; the per-frame longitude window in `sample_camera` (`auto.rs:78-99`) becomes a per-frame along-axis window.

**Sweep-axis detection** goes in `canvas/auto.rs` next to `extent_deg_of`, consuming the solved cameras it already samples:

1. Form the scatter `S = Σ ẑᵢ ẑᵢᵀ` of camera optical axes. The sweep axis `a` is its least-eigenvalue eigenvector (the same construction `leveling.rs:50-101` uses on x-axes). Require a relative eigen-gap (reuse leveling's `1e-9` floor scaled to the camera count) and at least three cameras; otherwise fall back to today's horizontal behaviour.
2. Measure the angular extents along and across the sweep: `along = extent of atan2 of ẑᵢ projected onto the plane ⊥ a`, `across = max |asin(ẑᵢ·a)|·2` plus half the per-frame FOV in that direction.
3. Classify: `transverse` when `|a · (0,−1,0)| < cos 60°` (the sweep axis is within 30° of horizontal) **and** `along ≥ 60°` **and** `along ≥ 1.5 × across`. Anything else is a standard sweep or a 2-D mosaic; 2-D mosaics (both extents above 60°) stay on the standard sphere.
4. The existing extent thresholds then pick cylindrical vs spherical within the chosen family.

Gimbal pitch, when present on every frame, is recorded in the report as corroboration (`sweep_axis_source`), the same advisory-only rule `strategy.rs` applies to gimbal attitude.

**Leveling for vertical sweeps.** When the sweep is transverse, the x-axes are parallel, so the current up estimator has nothing to work with. Replace the decline with a roll-only level: `n = normalize(Σ x̂ᵢ)`, rotate minimally so that `n ⊥ WORLD_UP` (project `n` onto the horizontal plane and apply `rotation_between`). This removes the "leaning tower" without inventing a horizon; the pitch of the whole set is unobservable from geometry alone and is left at the gauge frame, or taken from gimbal pitch when every frame carries it. Record `horizon_tilt_deg = None` and `roll_leveled = true` in the report.

**Surface.** `ProjectionMode::Auto` stays the only production behaviour; add `--projection auto|rectilinear|cylindrical|spherical|cylindrical-transverse|spherical-transverse` to the CLI as `Force(..)` for the harness and for diagnosing a misclassified set. Do not add it to the FFI until the Apple UI has a control for it.

**Tests.** Synthetic ring fixtures already exist (`canvas/tests.rs:10-28`); add a pitch ring (10 × 60° frames sweeping −60°..+90° at fixed yaw) asserting the transverse classification, `v` full-wrap closure `dv · H = 2π` when a pole is crossed, and warp round-trip RMSE under the spec's 0.5 % against `pano-gt-render`. Add a tilted-pitch-ring case for the roll-only level asserting the recovered roll within 0.1°. A real waterfall or tower fixture is needed before a `pano-budgets.json` entry; none exists today.

---

## 2. Photometry: gain, bias, vignette

### What ICE has (`exposure.rs`, `vignette.rs`)

Per channel, linear light:

```
corrected_i(p) = I_i(p) · g_i · V_i(r) + b_i
V_i(r) = (1 + k_i² r²)²           r² = ((x−w/2)² + (y−h/2)²) / (w/2)²     (half-width, r > 1 in corners)
```

The pipeline: for every overlapping pair, ~6000 grid samples over the overlap bbox, both values in `[0.025, 0.95)`, at least 24 per channel; a **robust affine fit** `I_j ≈ s·I_i + o` by IRLS (5 iterations, MAD scale `1.4826·median|r|` floored at `0.001`, Huber limit `1.5σ`); edge weight `w = min(n, 3000)/(σ_res² + 0.0004)`. Then a graph solve in two decoupled stages, image 0 pinned:

```
gains:  min Σ w_ij (L_i − L_j − ln s_ij)²,   g_i = exp(L_i),  clamp [0.25, 4]
bias:   d_ij = −g_j · o_ij;  min Σ w_ij (b_i − b_j + d_ij)²,  clamp |b_i| ≤ 0.15
```

Vignette: one coefficient `k_i` **per image** per channel (the `r⁴` slot is dead), Gauss–Newton over per-edge-centred log ratios, 10 iterations, Tikhonov `1e-4`, `k ∈ [0, 1.5]`, seeded at 0.2 because the derivative vanishes at `k = 0`. Gain/bias and vignette alternate 2 rounds. All corrections are applied to warped source samples (multiply gain, multiply vignette, add bias), never clamped.

### What Maple has

Rotation branch (`gain/mod.rs`): one multiplicative gain per frame (scalar by default, per-channel optional), Brown–Lowe least squares over **pair means** weighted by sample count, unity prior `σ_g = 1`, geomean-1 gauge. No robust loss, no clip rejection: the only guard is "skip the pair if a mean is non-finite or below `1e-9`" (`mod.rs:194-196`). Highlight-recovered pixels enter at full weight. Gain is folded into the warp sampling loop (`warp/mod.rs:257-275`). `gain/streaming.rs` holds one decoded frame at a time and resolves forward samples through a 12-byte pending-coordinate buffer (~228 MB on `pano_01` at stride 4).

Tile branch (`tile/photometry.rs`, `tile/exposure_field.rs`): log-domain per-frame gain plus one shared within-frame linear slope, then a per-frame residual field on a canvas/128 grid solved as screened Poisson by CG. Richer than ICE, but it lives only on the planar strategy.

Vignette: `decode_for_pano` applies DNG `OpcodeList3` GainMap at full strength when the file carries it (`raw-core/src/pipeline/pano/mod.rs:314-333`). It **never consults the bundled Lensfun registry** (`lens_profile::auto::resolve_auto` is not called anywhere under `pipeline/pano/`). So the L2D-20c (`pano_01`) is flattened by its opcodes, but any body that ships `WarpRectilinear` only, or no opcodes at all, arrives with raw falloff, which the scalar gain then integrates along the chain exactly as `tile/photometry.rs:9-18` describes for the planar strip (the 19× / 4.2 EV ramp).

### Proposal

**2a (P0). Correct vignetting where Maple already knows the lens.** In `decode_for_pano_unguarded`, immediately after the `OpcodeList3` stage and before `DefaultCrop`, call `lens_profile::auto::resolve_auto(&raw)`; it already returns `None` when the RAW carries its own corrections, so the opcode path is untouched. Apply with `LensCorrectionScales::FULL`, vignette only (distortion from the profile is a separate decision because BA solves `k1, k2` itself and a double correction would bias it; chromatic aberration is harmless to include). Report `vignette_corrected: Opcode | Profile | None` on `PanoIngest` so the gain solver and the report know whether falloff remains. The Lensfun falloff model is `1 + k₁r² + k₂r⁴ + k₃r⁶` with `r` normalised to the half-diagonal (`lens_profile/model.rs:26-29`), already on the canonical develop path; this is deterministic and needs no overlap statistics. It is the fix for dark sky corners on most bodies, and it is small.

**2b (P0). Harden the scalar gain solve with ICE's sampling and fit.** Keep Maple's linear-domain model and geomean gauge (ICE's image-0 pin propagates image 0's error into every frame). Change three things in `gain/mod.rs` and `gain/streaming.rs`:

- _Clip window._ Reject a sample when either frame's value in any channel exceeds `clip_i = 0.98 × white_i` or falls below `floor = 1e-3 × median_i`, where `white_i` is the frame's scene-linear white point after `BaselineExposure` (ingest knows it; add it to `FrameMeta`) and `median_i` is the proxy luma median. This is ICE's `[0.025, 0.95)` window re-expressed for unbounded data; the fixed 0.95 cannot be used because highlight recovery reconstructs above white.
- _Robust per-pair affine fit instead of a mean ratio._ Accumulate per pair a reservoir of at most 3000 `(I_i, I_j)` luma pairs (≈ 24 KB per pair; `pano_01` has 79 edges). Fit `I_j = s·I_i + o` by IRLS exactly as `exposure.rs:498-563` (5 iterations, MAD-scaled Huber at 1.5σ). Weight the pair row by `w = n/(σ_res² + ε)` with `ε = (1e-3 × median scene level)²`, replacing today's raw count weight. A moving subject or a misaligned region now down-weights the pair instead of poisoning its mean. The streaming variant keeps its one-frame-resident contract: the reservoir replaces the running sums, and the pending-coordinate resolve step fills `I_j`.
- _Bias as a gated second stage._ Solve `b_i` from `o_ij` exactly as ICE's bias stage with the same geomean-style gauge (`Σ b_i = 0`). Accept the bias vector only if it is significant: `|b_i| > 3 × σ_b,i` (from the normal-equation covariance) for at least one frame **and** `max|b_i| ≤ 0.05 × median scene level`; otherwise set every `b_i = 0` and report `bias_rejected: reason`. Physically, a nonzero `b` in zero-referenced scene-linear data is veiling flare or a black-level error; both are real on long lenses into the sun, but an unconstrained additive term also fits a residual exposure ramp as "bias", which is the failure the significance gate prevents. Apply as `g_i·I + b_i` in the warp sampling loop next to the existing gain multiply; the seam cost and blend then see corrected layers as they do today.

ICE's vignette alternation is deliberately **not** ported here; see 2c.

**2c (P2). Blind vignette estimation only as a last resort.** When `vignette_corrected == None`, estimate **one** shared coefficient pair `(k₁, k₂)` across all frames (same body and lens for the whole set; ICE's per-image `k_i` is over-parameterised and is why it needs a 0.2 seed and `k ≥ 0` clamps). Use the Lensfun form `V(r) = 1/(1 + k₁r² + k₂r⁴)` on the half-diagonal so that a solved coefficient can be compared against, and later replaced by, a bundled profile. Observations are ICE's per-edge-centred log ratios `t = ln(I_j g_j / (I_i g_i)) − mean_edge`, which cancel the residual exposure offset and leave only the radial term; solve by Gauss–Newton with Huber IRLS and a Tikhonov `1e-4` as ICE does, alternating twice with the gain solve. Gate on identifiability: at least `8 × (n − 1)` observations and a spread of `r²` across samples of at least 0.3, else leave `k = 0` and report. This earns its place only once a fixture without opcodes or a profile shows the stepping; file it, do not build it on spec.

**Tests.** `gain/tests.rs` renders analytic scenes through synthetic cameras; add a frame with a clipped highlight patch asserting the gain is unchanged by it, a pair with a 20 % moving blob asserting the robust fit recovers the gain within 1 % where the mean fit does not, and a +2 % flare offset case asserting the bias stage recovers it and the gate accepts it, with a sibling case where a pure gain ramp is rejected as bias. The real-data gate is `pano_metrics.py seam_energy`; expect the `pano_01` budget to ratchet down after 2a lands on a body it applies to (it will not move for the L2D-20c, which is already opcode-flattened).

---

## 3. Gradient-domain and Poisson seam smoothing

### What ICE actually does

Mechanism A, the native-derived one (`blend.rs:296-439`, `native_poisson.rs:519-750`): unknown offsets `f_n ∈ ℝ³` on a regular canvas-space grid at `scale = 2^L` (start `L = 3`, coarsened until the node count fits 512 for LDLᵀ or 2048 for CG), one grid per view. Energy:

```
E = Σ_n d·|f_n|²                      d = 4^L·1e-10 (fixes the constant null space)
  + Σ_(a,b) |f_a − f_b|²              4-neighbour smoothness, unit weight, same view
  + Σ_k w_k |α·f_A − β·f_B − r_k|²    one constraint per grid edge where both views are confident

r = ½(v₀ + v₁ − u₀ − u₁)                                    mean(B) − mean(A) along the edge
m = max_c |(u₀−u₁) − (v₀−v₁)|                               gradient mismatch
t = max(|Δ ln(R/G)|, |Δ ln(B/G)|)                            chroma mismatch
w = 1 / ((1 + 16·min(m, 0.5))⁹ · eᵗ)
```

Mismatch-weighted constraints mean a moving subject or misalignment contributes almost nothing. The solution is a per-view RGB offset, bilinearly upsampled and **added** to each warped layer before the pyramid blend. The system is independent of canvas resolution (≤ 2048 unknowns). The native record defaults are level 3, `1e-10`, exponent 9.0, scale 1.0, LDLᵀ.

Mechanism B (`blend.rs:1523-1668`) is a full-resolution Dirichlet Poisson solve over a 3-cell band around every label change, with full-canvas `active_lookup` and `original` buffers and a 160-iteration unpreconditioned CG. It is Rust-only, not ICE, and is the thing not to port.

### What Maple has

Rotation path: labels at ≤ 1 MP seam-canvas resolution (`seam/masks.rs`, `SEAM_CANVAS_MAX_PX`), Gaussian feather of 3 seam px, bilinear upsample of the weight planes, single-band accumulation (`graph_cut.rs:256-284`). On a 256 MP canvas that is a 16× linear upsample, so a seam is a ~48 px bilinear ramp and nothing else hides a residual gain or vignette mismatch. Tile path: `tile/exposure_field.rs` already solves a per-frame log-offset field on a canvas/128 grid (data term tying overlapping frames, gradient smoothness, weak anchor, matrix-free CG, 300 iterations), evaluated by edge-clamped bilinear `CoarseField::eval` during the warp.

### Proposal

**3a (P0). Multi-band on the rotation strips.** This is the real gap. The streaming contract (one decoded frame resident per strip pass) is compatible with Burt–Adelson if the pyramid is accumulated rather than built from all layers at once. Per strip of `tile_rows + 2·halo` rows, `halo = 2 × max(16, next_pow2(2·(2^levels − 1)))` as `tile/composite.rs:37-42` already computes:

1. For each frame touching the strip: warp the haloed strip, build its Laplacian pyramid `L_ℓ` and the Gaussian pyramid of its weight `w_ℓ` (validity-aware, as `WeightedPlane` in `blend.rs:54-148` does), accumulate `A_ℓ += w_ℓ·L_ℓ` and `W_ℓ += w_ℓ`, free the frame.
2. Collapse `Σ_ℓ A_ℓ / W_ℓ` and copy the interior `tile_rows` into the output.

Resident memory is one frame plus two strip pyramids, which at `canvas_width × (512 + 2·512)` f32 RGB is ~96 MB on a 14 k-wide canvas. Band count follows `levels_for_overlap_width` as today (`blend.rs:33-38`); the Voronoi path needs its ownership mask feathered by one band width to have anything to blend across, which `seam::labels::feather` already provides at seam resolution. The tile strategy documents byte-identity between haloed-per-tile and full-canvas blending (`tile/composite.rs:96-103`); reuse that test shape against the non-tiled `composite()`.

**3b (P1). Coarse per-frame offset field on the rotation branch.** Only after 3a, measure what remains with `pano_metrics.py seam_energy`. If low-frequency steps persist, port `tile/exposure_field.rs` rather than ICE: it is already in the codebase, already log-domain and screened-Poisson, and the ICE analysis corroborates every design choice (coarse grid, per-view field, additive application, pairwise overlap constraints, bilinear upsample). Two ICE details are worth adopting into the port:

- The mismatch weight `w = 1/((1 + 16·min(m, 0.5))⁹ · eᵗ)` on each cell constraint, so moving water, people, and misaligned regions do not drive the field. `exposure_field.rs` weights by sample count only.
- A per-edge centring of residuals before the field solve so the field absorbs spatial drift and never re-fits the global gains.

Insertion point: the end of `seam::masks::finish` (`masks.rs:113-129`), where every frame is already warped, gain-applied, and locally corrected onto the ≤ 1 MP seam canvas, and labels are known. Build cell accumulators from those layers on a seam-canvas/8 grid (the ICE starting level, giving a few thousand cells), solve, and carry the fields inside `SeamMasks` next to the existing `scale_x/scale_y`. Apply in `accumulate_strip_weighted` (`graph_cut.rs:269-283`) and in the new multi-band path as `strip + offset_i(x, y)`, bilinear, before pyramid decomposition. Memory is the coarse planes only; no new global pass, because the seam pre-pass already exists. The Voronoi path has no pixel pre-pass; gate the field on `SeamStrategy::GraphCut` first, and only add a Voronoi pre-pass if a real set needs it.

Do not add a full-resolution seam-band Poisson. In the tiled model it would need the band on both sides of every strip boundary and a global linear system, which is exactly the full-canvas allocation the architecture exists to avoid, and the multi-band pyramid already performs that diffusion at every band.

---

## 4. Drone nadir grids and structured layouts

### What ICE has

Only product surface: the structured import asks the user for primary direction (Horizontal/Vertical), ordering (Serpentine/Zigzag), start corner, horizontal and vertical overlap, angular range, and a `FeatureMatchingSearchRadius` persisted in `StructuredPanoramaInfo`. None of that reaches the Rust reconstruction, and the DLL analysis found no path from the radius into native alignment. The idea to keep is: a known layout turns matching from retrieval into a neighbourhood lookup and removes cross-grid false matches by construction.

### What Maple has

`build_match_graph` (`graph/mod.rs:296-353`) unions three providers: capture order (`(i−1, i)` by filename sort; no timestamps are parsed), gimbal prior (`angle < 1.5 × ½(hfov_i + hfov_j)`, only when both frames have gimbal attitude), and descriptor top-6 by mean-pooled ALIKED cosine. Candidate count is already linear in N, so the "O(N²) explosion" is not the problem. The problem is **false loop closure**: acceptance is per-edge inlier count (`min_inliers 30`, MAGSAC σ-marginalised) with no cycle test and no prior-contradiction test, so a repetitive-texture edge (rooftops, cropland rows, water) with 30 self-consistent inliers enters BA unchallenged. On nadir sets the gimbal provider is useless (identical attitude on every frame, as `pano_00` showed), so the only cross-row edges come from descriptor retrieval, which is precisely the edge class most prone to repetition. The tile branch rebuilds the graph with the same providers and no gimbal (`stitch/tile_stitch.rs:184-220`). No GPS, altitude, or timestamp is read from EXIF; `FramePriors` has four fields.

### Proposal

Two additive `CandidateProvider` implementations and one filter. Providers stay advisory, as the crate's rule requires.

**4a. `GpsFootprintProvider`** (`graph/grid_prior.rs`). Extend `raw_core::PanoSourceMetadata` with EXIF `GPSLatitude/Longitude/Altitude` and the DJI XMP `RelativeAltitude`, `FlightYawDegree`; extend `FramePriors` accordingly. Footprint half-width on the ground `h_i = alt_i · tan(hfov_i/2)` (nadir; for oblique gimbal pitch `θ`, scale by `1/cos θ`). Nominate `(i, j)` when the planar ground distance `‖p_i − p_j‖ < 1.5 × (h_i + h_j)` and `|yaw_i − yaw_j| < 30°` when flight yaw exists. This is the spatial neighbourhood graph; consumer-GPS error of a few metres is far below a footprint of tens of metres at mapping altitude. Record `nominated_by: gps` on the edge.

**4b. `GridInferenceProvider`**, for sets without GPS. After the capture-order chain is verified (it always is, first), fit the 2-D similarity per chain edge (`similarity::estimate_similarity` already runs on every edge in `strategy.rs`) and look at the translation direction sequence. A serpentine lawn-mower pattern shows a reversal of the dominant translation component every `L` frames with a perpendicular step at each turn; a raster pattern shows a long return translation that fails to verify (no overlap), leaving a chain break every `L` frames. Infer `L` as the mode of turn spacings (require at least two turns); then nominate `(i, i+L)` and `(i, i+L±1)` for raster, and the mirrored index `(i, 2kL − 1 − i)` with its ±1 neighbours for serpentine. This is the Serpentine/Zigzag knowledge ICE asks the user for, inferred from the data the pipeline already has. Expose nothing on the CLI until a set defeats the inference.

**4c. Triangle-consistency filter** between `build_match_graph` and `select_strategy` (`stitch/mod.rs:286-318`). For every verified edge with **no** supporting prior (not nominated by capture order, gimbal, GPS, or grid), find triangles `(i, j, k)` where the other two edges are prior-supported; compute the cycle residual `ρ = angle(R_ij · R_jk · R_ki)` for the rotation graph, or `‖t_ij + t_jk + t_ki‖` in pixels for the planar graph. Reject the prior-less edge when `ρ > 3 × σ_pair` (with `σ_pair` the pair's MAGSAC σ lifted to an angle, `robust.rs:304-306`) on a majority of its triangles, and move it to `MatchGraph::rejected` with reason `CycleInconsistent`. Edges with no triangle at all stay (a bridge edge cannot be tested and is better than an orphan). This is the loop-closure guard the repository lacks; BA's Huber and the §5.3 residual gates are not a substitute because they act after the bad edge has already pulled the spanning-tree initialisation.

**Tests.** `graph/descriptor_topk_tests.rs:238-251` already has a synthetic grid pattern; extend it to a 4×6 serpentine with repetitive texture that produces a planted false edge, asserting 4b nominates the row-neighbour pairs and 4c rejects the plant while keeping every true edge. `pano_00` (3 nadir frames, identical gimbal) is the smallest real set; it needs a GPS-carrying fixture before 4a has a real-data gate.

---

## 5. User-constrained seams

### What ICE has

The symbol table has `VideoRectangles`, `SelectedVideoRectangles`, `STITCH_VIDEO_FRAME_INFO` with a `vector<vt::CRect>`, and the UI commands around them. The reconstruction's seam solver (`seam.rs:1083-1372`) has no constraint input of any kind: the data term is 0 inside every footprint, the only cost is the colour-difference smoothness term, and labels are applied with a 2 % weight leak to losing images. The feature to borrow is the user model (draw a rectangle, choose the frame, the cut must honour it), not any code.

### What Maple has

`seam/pairwise.rs` builds a Boykov–Kolmogorov graph whose only terminal connections are validity pins: an overlap pixel bordering an A-only pixel gets `add_terminal(nid, INF_CAP, 0)`, a B-only neighbour gets `(0, INF_CAP)` (`pairwise.rs:245-267`, `INF_CAP = i64::MAX/4`). `BkGraph::add_terminal` keeps one signed net capacity per node (`seam/bk/mod.rs:214-218`), so a forced label is literally the pattern already in use. `seam/labels.rs` runs pairwise cuts as alpha-expansion moves over all overlapping pairs until < 0.1 % of pixels change. The seam canvas is ≤ 1 MP, so a canvas-pixel rectangle maps through `scale_x/scale_y`. `pano-seam-evidence` already defines an ROI JSON (`test-fixtures/pano-motion-rois/pano_01.json`) with two breaking-wave rectangles in native canvas pixels.

### Proposal

```rust
pub enum SeamConstraintKind { Include { frame: usize }, Exclude { frame: usize } }
pub struct SeamConstraint { pub rect: CanvasRectPx, pub kind: SeamConstraintKind }
```

Resolve constraints to two per-pixel planes at seam-canvas resolution in `seam::masks::build_from_paths`: `forced: Vec<Option<u16>>` and `forbidden: Vec<u64>` (a bitmask over frames; cap the frame count at 64 for the mask, which is far above any real set). Validate before solving: an `Include` rectangle not fully covered by the named frame's validity is an error naming the uncovered fraction; an `Exclude` that leaves a pixel with no allowed frame is an error. Overlapping `Include`s for different frames are an error.

Then:

- `labels.rs` initialisation (`81-91`): pixels with a `forced` label start there; pixels with `forbidden` bits choose the lowest-index allowed valid frame.
- `pairwise::cut(a, b, pins)`: for pair `(i, j)` the pins translate per pixel to `forced == i → (INF_CAP, 0)`, `forced == j → (0, INF_CAP)`, `forbidden ∋ i → (0, INF_CAP)`, `forbidden ∋ j → (INF_CAP, 0)`. Pixels forced to a third frame are not nodes for this pair. Apply pins **after** the validity pins and let them override: a pixel that is both "border of B-only" and "forced to A" must be A, and summing two `INF_CAP`s of opposite sign would cancel to zero; set the net capacity directly for pinned nodes.
- `labels.rs` move application (`100-117`): never relabel a forced pixel; never assign a forbidden frame.
- Feathering (`labels.rs:151-198`) blurs 3 seam px across the rectangle edge, which at a 16× upsample is ~48 canvas px of soft handoff. That is the intended look at the boundary of an action subject; document that the rectangle must enclose the subject with that margin, and have the CLI print the effective margin.

**Product mappings.** Action multi-exposure: one `Include { frame: k }` per position of the subject, each rectangle from the frame in which the subject is there. Tourist removal: `Exclude { frame: k }` over the person in the frame that has them; the solver picks any other covering frame, and the cut cost, which is the gradient of the difference image, already prefers a clean handoff.

**Surface.** CLI `--seam-constraint include:3:x,y,w,h` and `exclude:3:x,y,w,h` (repeatable), coordinates in output canvas pixels, which requires a two-pass workflow (stitch once, inspect, stitch again with constraints) that the report's canvas dimensions make possible. Record the constraints and their validation outcome in `CompositeReport`. Add a `MaplePanoSeamConstraint` array to the FFI only when the Apple merge dialog gains a rectangle tool; the web merge modal (`mui-panorama-merge-modal`) is the natural first UI since the preview is already a `<canvas>`. Constraints force `SeamStrategy::GraphCut`; the Voronoi path has no solver to pin.

**Tests.** `pairwise.rs` already has a moving-checkerboard-blob test; add its forced twin asserting the blob is in the output when the cheaper cut would exclude it, and the exclude twin. `pano_01` with its two wave ROIs is the real-data case: assert both ROIs reproduce the named frame's crop bit-exactly, which `pano-seam-evidence` can already verify.

---

## 6. Zero-ML offline fallback detector

### What ICE has (`features.rs`, `native_descriptor.rs`)

Harris on a 3-level-per-octave Gaussian pyramid (base σ 1.0, step 2^(1/3), point decimation at octave boundaries, stop below 32 px), **harmonic-mean response** `(AC − B²)/(A + C + 1e-5)` with no `k`, gradient σ `3.5·s`, integration σ `1.5·s`; strict 3×3 NMS; quadratic sub-pixel refinement rejecting `|offset|² > 1`; curvature gate `|λ_small|·10 ≤ |λ_large| → reject`; rank score `|λ_small|`; top 2000 across all levels with no per-level cap and no scale-extremum test. Descriptor: 18×18 bilinear patch spanning 10σ, axis-aligned, one pointwise gradient orientation, four steered rectified gradient channels → eight, 13 Gaussian pools → 104-D, projected by a learned 32×104 matrix loaded from `native_descriptor_profile.bin`, L2-normalised, quantised `u8 = trunc(clamp(v·179.2 + 128, 0, 255))`, squared-Euclidean distance. Matching: approximate KD-tree (10-leaf check limit, 5-NN) with a squared ratio test `d² < 0.16·d₅²`, no mutual check; 2-point similarity RANSAC, 250 iterations, 8 px, ≥ 8 inliers. Pure Rust, `std` only. Luma is computed on **clamped, sRGB-encoded** values, so blown regions lose all features.

### Assessment

Against ALIKED + LightGlue this loses on low texture (no absolute response threshold, so sky and snow fill the top-2000 with noise), on repeated structure (the strict ratio test removes exactly the matches façades have), on exposure extremes (clamped sRGB luma), and on viewpoint (axis-aligned patch, 5°-quantised pooling). It would produce a visibly worse stitch and a second quality tier across surfaces that already have a well-defined "not provisioned" state (`StitchError::MlUnavailable`, FFI −6).

**Legal.** The 32×104 projection matrix and the mean vector in `native_descriptor_profile.bin` are data extracted from Microsoft's binary. They cannot ship in Maple under any reading. The same applies to any constant table that is a copy rather than a derivation (the 72-bin pooling records, the quantisation constants). Only the algorithm shape may be reused.

### Recommendation

P2, gated on a product decision, not a quality fallback. The one real requirement a classical path would serve is **Web**, where `ort` has no WASM story (`Cargo.toml` feature notes, `docs/pano.md`). If pano-on-web is required, build `features/classical/` behind a `classical` Cargo feature producing the existing `FeatureSet` and the `fetch_matches` closure `build_match_graph` consumes (`graph/mod.rs:296-301`), so graph, robust verification, BA, and compositing are untouched. Take from ICE: the pyramid schedule, the harmonic-mean Harris, strict NMS plus quadratic refinement, and the curvature gate. Replace: run on log-luma of the scene-linear proxy (not sRGB-clamped), add an absolute response floor and a scale-extremum test, use a scale-adapted, orientation-normalised binary descriptor with mutual nearest neighbour plus ratio, and reuse `robust::verify_pair` as the acceptance test instead of ICE's 2-point similarity. Until that decision exists, the right behaviour is the current one: fail typed, tell the operator what to provision.

---

## 7. What Maple should not take from ICE

| ICE pattern                                                                                                                         | Why not                                                                 | Maple's answer                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| One `WarpedLayer` per image at full canvas (20 B/px × N) plus full pyramids; 16 MP canvas cap                                       | Memory grows with N × canvas; the whole reason `composite_tiled` exists | Strips, one frame resident, 256 MP cap                         |
| Alpha-expansion graph at full canvas resolution (~69 B/px per expansion, 17 B/px/image layers, 3 fixed sweeps, no convergence test) | ~1 GB per expansion at 16 MP × 5 images; no stopping rule               | ≤ 1 MP seam canvas, converge on < 0.1 % change                 |
| Full-resolution seam-band Dirichlet Poisson with full-canvas buffers                                                                | Not even ICE; a Rust-side addition; incompatible with strips            | Multi-band on strips (§3a), coarse field (§3b)                 |
| Seam weights with a 2 % leak to losing images (`ownership 0.02`)                                                                    | Ghosts every moving subject by 2 %                                      | Hard labels + band-width feather                               |
| Per-image vignette coefficient, `k ≥ 0` clamp, 0.2 seed                                                                             | Over-parameterised; same lens across the set                            | Profile first (§2a); one shared `(k₁, k₂)` if ever blind (§2c) |
| Gain clamp `[0.25, 4]`, bias clamp `±0.15`, sample window `[0.025, 0.95)`                                                           | Display-referred constants; `pano_01` legitimately spans 4.76×          | White-point-relative clip window, significance-gated bias      |
| Image-0 gauge for gain and bias                                                                                                     | Propagates image 0's error to every frame                               | Geomean / Σ = 0 gauge                                          |
| Features on clamped sRGB-encoded luma                                                                                               | Discards highlight texture                                              | Scene-linear proxies                                           |
| No parallax model; motion model chosen per set (homography vs rotation)                                                             | Position drift shows as misalignment that seams must hide               | Stage F bilinear mesh                                          |
| User-entered grid layout (rows, order, start corner, search radius)                                                                 | Puts the burden on the user; never reached native alignment anyway      | Infer from GPS or chain geometry (§4); priors advisory         |
| Unclamped transverse across-axis coordinate; silent drop of `None` border samples in the canvas bbox                                | Canvas blow-up near poles; under-estimated coverage                     | Clamp at `tan 85°`; `sees_dir` pole handling (§1)              |
| Learned descriptor matrix and constant tables lifted from the DLL                                                                   | Not Maple's to ship                                                     | Clean-room derivation only (§6)                                |
| Mercator and the other eight projections                                                                                            | No request for them; YAGNI                                              | Two transverse variants only                                   |

---

## 8. Proposed tickets

In landing order; each is one PR against the file-size budget and the pano harness.

1. **Multi-band blend on the tiled rotation path** (§3a). Gate: `composite_gates.rs` byte-identity against non-tiled `composite()` at `levels > 1`; `pano_01 seam_energy` ratchet.
2. **Bundled lens-profile vignette in `decode_for_pano`** (§2a). Gate: ingest test on a profile-matched fixture asserting corner/centre ratio flattens; opcode fixture unchanged bit-for-bit.
3. **Gain solve hardening** (§2b): clip window, robust affine fit, residual weights, gated bias. Gate: new `gain/tests.rs` cases; `gain_spread_ev` unchanged on `pano_01`.
4. **Transverse projections, sweep detection, roll-only leveling** (§1). Gate: synthetic pitch ring; `pano-gt-render` warp RMSE < 0.5 %.
5. **Seam ROI constraints** (§5). Gate: forced-blob tests; `pano_01` wave ROIs reproduce bit-exactly.
6. **GPS footprint provider, grid inference provider, triangle filter** (§4). Gate: synthetic serpentine grid with a planted false edge.
7. **Coarse offset field on the rotation branch** (§3b). Opened only if `seam_energy` after (1) and (3) still shows low-frequency steps on a real set.
8. **Blind shared vignette** (§2c) and **classical detector** (§6): filed as P2 with their gating conditions in the description; not scheduled.

---

## Appendix A. ICE constants worth keeping at hand

| Constant                         | Value                                                                                    | Where                          |
| -------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------ | ----- | --- | --------- | --- | --- | ---------- |
| Exposure sample window           | `[0.025, 0.95)`                                                                          | `exposure.rs:96-97`            |
| Min samples per channel edge     | 24                                                                                       | `:112`                         |
| Edge weight                      | `min(n, 3000)/(σ² + 0.0004)`                                                             | `:124-125`                     |
| Robust affine IRLS               | 5 iters; MAD `1.4826`, floor `0.001`; Huber `1.5σ`                                       | `:503, :547-548`               |
| Gain / bias clamps               | `[0.25, 4.0]`, `±0.15`                                                                   | `lib.rs:96-98`                 |
| Vignette model                   | `(1 + k²r²)²`, `r` on half-width, `k ∈ [0, 1.5]`, seed 0.2, GN 10 iters, Tikhonov `1e-4` | `exposure.rs:289-304, 389-440` |
| Poisson grid start / node budget | level 3 (8 px); 512 LDLᵀ / 2048 CG                                                       | `blend.rs:307-310`             |
| Poisson constraint weight        | `1/((1 + 16·min(m, .5))⁹ · eᵗ)`                                                          | `native_poisson.rs:597-605`    |
| Poisson diagonal                 | `4^L · 1e-10`                                                                            | `:607-612`                     |
| Harris response                  | `(AC − B²)/(A + C + 1e-5)`, gradient σ `3.5s`, integration σ `1.5s`                      | `features.rs:180-237`          |
| Pyramid                          | base σ 1.0, 3 levels/octave, stop < 32 px, cap 1024 px                                   | `:73-130`                      |
| Curvature gate / rank            | reject `                                                                                 | λ_s                            | ·10 ≤ | λ_l | `; rank ` | λ_s | `   | `:283-287` |
| Ratio test                       | `d² < 0.16·d₅²`, 5-NN, 10-leaf KD limit                                                  | `:1386-1407`                   |
| Seam smoothness                  | `Σ_c [(I_a(p)−I_b(p))² + (I_a(q)−I_b(q))²] + 1/64`                                       | `seam.rs:1167-1194`            |
| Transverse inverse (cyl.)        | `s = 1/√(1+h²)`; `(h·s, s·sin w, s·cos w)`                                               | `blend.rs:1487`                |
| Transverse inverse (sph.)        | `(sin h, cos h·sin w, cos h·cos w)`                                                      | `blend.rs:1497`                |
