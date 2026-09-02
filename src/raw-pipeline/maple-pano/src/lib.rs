//! # maple-pano — panorama stitching core (epic #1094)
//!
//! M0a (#1119) ships the geometry foundation and the synthetic
//! ground-truth renderer (`pano-gt-render`). The renderer produces frame
//! sets with *exactly known* camera parameters, which the §7 acceptance
//! gates of the stitching spec measure against ("recovered rotations
//! within 0.1°; warp RMSE < 0.5% of full scale") — so the conventions
//! below are the contract every later milestone solves in.
//!
//! ## Geometric conventions (binding)
//!
//! - **World frame:** right-handed; **+X east, +Y down (nadir), +Z
//!   forward** (longitude 0, latitude 0). The zenith ("up") is **−Y**.
//!   Cameras share the world origin — pure rotation, no translation (the
//!   rotation-model pano assumption).
//! - **Camera frame:** +X right, +Y down, **+Z optical axis**.
//! - **Rotation:** stored as a Rodrigues axis-angle vector `ω` (radians)
//!   of the **camera-to-world** rotation: `d_world = exp([ω]×) · d_cam`
//!   ([`math::axis_angle_to_matrix`]). The pattern poses compose as
//!   `R = R_y(yaw) · R_x(pitch) · exp([jitter]×)`: **positive yaw** turns
//!   the view eastward (+X, right-hand rule about the down axis), and
//!   **positive pitch** tilts it up (toward −Y).
//! - **Longitude/latitude:** `λ = atan2(x, z) ∈ (−π, π]`, increasing
//!   eastward; `φ = asin(−y) ∈ [−π/2, π/2]`, positive up. Inverse:
//!   `dir = (cos φ sin λ, −sin φ, cos φ cos λ)`.
//! - **Pixels:** continuous coordinates, origin at the top-left corner;
//!   texel `(ix, iy)` covers `[ix, ix+1) × [iy, iy+1)` with center
//!   `(ix + 0.5, iy + 0.5)`. Camera principal point fixed at the image
//!   center `(width/2, height/2)`.
//! - **Equirect mapping:** `u_px = (λ/2π + 0.5)·W`, `v_px = (0.5 −
//!   φ/π)·H`; row 0 is the zenith; horizontal wrap, vertical clamp.
//! - **Distortion:** radial polynomial in ideal normalized coordinates,
//!   `r_d = r·(1 + k1·r² + k2·r⁴)`; inverse via Newton ([`distortion`]).
//! - **Light:** all pixel values are scene-linear; PNG inputs are
//!   normalized without transfer decode, outputs are 16-bit linear PNGs.
//!
//! The `ground_truth.json` schema is documented in [`gt`]; the rendering
//! model (supersampling, f32 parameter quantization, determinism) in
//! [`render`].
//!
//! ## Module map
//!
//! | Module         | Contents                                              |
//! | -------------- | ----------------------------------------------------- |
//! | [`math`]       | Hand-rolled `Vec3`/`Mat3`, axis-angle exp/log         |
//! | [`distortion`] | k1/k2 radial polynomial, forward + Newton inverse     |
//! | [`project`]    | Rectilinear/cylindrical/spherical forward+inverse     |
//! | [`camera`]     | Posed pinhole camera, pixel ↔ world-direction         |
//! | [`prng`]       | SplitMix64 (pinned in-tree for byte determinism)      |
//! | [`synthetic`]  | Procedural equirect test scene                        |
//! | [`source`]     | Equirect loading + bilinear sampling                  |
//! | [`render`]     | Camera-set builder, frame renderer, output writing    |
//! | [`gt`]         | `ground_truth.json` schema types                      |
//! | [`eigen`]      | Jacobi symmetric eigensolver (q-method backend)       |
//! | [`twoview`]    | Bearings + closed-form relative rotation (Wahba)      |
//! | [`robust`]     | MAGSAC-style robust two-view verification             |
//! | [`graph`]      | Match-graph builder, candidate providers, components  |
//! | [`testkit`]    | Synthetic correspondences (cargo feature `testkit`)   |

pub mod camera;
pub mod distortion;
pub mod error;
pub mod exif_embed;
pub mod gt;
pub mod math;
pub mod prng;
pub mod project;
pub mod render;
pub mod source;
pub mod synthetic;

pub use camera::Camera;
pub use error::PanoError;
pub use project::Projection;

// M1a (#1138): match graph + rotation-model two-view estimation. Appended
// after the M0a block (not interleaved) to stay merge-friendly with
// concurrently landing module additions.
pub mod eigen;
pub mod graph;
pub mod robust;
#[cfg(feature = "testkit")]
pub mod testkit;
pub mod twoview;

// --- `ml` / `ml-static` features (#1139, M6 #1244): ALIKED + LightGlue --
//
// Native-only detector/matcher stack per the eng design spec §2.2/§5.
// `features` owns detection (keypoints/descriptors/scores), `matching`
// owns LightGlue and the `MlMatch` contract records the #1138 geometry
// side consumes, `models` owns the models.toml manifest, SHA-256
// verification, and the onnxruntime pre-flight.
//
// `ml`        = macOS/host: `ort` with `load-dynamic` (dlopen at runtime).
// `ml-static` = iOS (M6 #1244): `ort` WITHOUT `load-dynamic` (ORT
//               statically linked via the official iOS xcframework at
//               `ORT_LIB_LOCATION`). Both features use the same `dep:ort`
//               workspace entry — no separate alias needed.
#[cfg(any(feature = "ml", feature = "ml-static"))]
pub mod features;
#[cfg(any(feature = "ml", feature = "ml-static"))]
pub mod matching;
#[cfg(any(feature = "ml", feature = "ml-static"))]
pub mod models;

// --- Ingest (#1156, spec §5.1): real-frame decode via raw-core ----------
//
// `ingest` wraps `raw_core::decode_for_pano` into the planar f32 +
// validity buffer shape the compositing stages consume, derives the
// EXIF-focal / DJI-gimbal priors, and provides the long-edge-capped
// proxy downscale features run on. Appended after the ml block — keep
// lib.rs additions append-only (concurrent module ownership).
pub mod ingest;

// --- M1b (#1154, spec §5.3): global bundle adjustment -------------------
//
// `ba` owns the LM solve over all camera rotations + shared focal +
// k1/k2 (in-tree dense normal equations per decision §9.1's no-Ceres
// intent), spanning-tree / gimbal-prior initialization, the per-image
// focal fallback (decision §9.2), up-vector leveling, and the
// acceptance-gate frame dropping. Appended after the ingest block.
pub mod ba;

// --- M1b (#1154): leveling + ML→geometry glue ----------------------------
//
// `leveling` solves the post-BA up-vector correction (spec §5.3 —
// the banana fix); `glue` adapts `matching::MlMatch` records into the
// verifier's `PixelCorrespondence` input. Appended after the ba block.
pub mod leveling;

#[cfg(any(feature = "ml", feature = "ml-static"))]
pub mod glue;

// --- M2-CPU compositing (#1155, spec §5.4–§5.8): canvas → warp → gain →
// seam → blend, orchestrated by `composite`. CPU reference path; the
// later WGSL passes are gated against these modules (eng design D6).
// Appended after the ingest block — keep lib.rs additions append-only.
pub mod blend;
pub mod canvas;
pub mod composite;
pub mod gain;
pub mod warp;

// --- Coarse-to-fine refinement (#1210): full-resolution ZNCC
// re-localization of verified proxy matches, between graph verification
// and bundle adjustment. Closes the proxy accuracy floor so the §5.3
// budgets gate at the resolution the spec wrote them for. Appended after
// the compositing block — keep lib.rs additions append-only.
pub mod refine;

// --- Stage F local alignment (#1218, spec §8): per-frame regularized
// bilinear mesh correction that absorbs cm-level camera position drift
// (the parallax floor); fit during gating (corrected stats are the
// end-of-chain gate measurement) and applied at composite time.
// Appended after the refine block — keep lib.rs append-only.
pub mod local_align;

// --- Multi-strategy alignment (#1226, spec §8): auto / rotation / tile.
// `similarity` provides the 2D similarity solver (RANSAC-style, for tile
// edge verification and auto-selection evidence). `tile` provides the
// planar-canvas placement, warp, and tile composite orchestrator.
// `strategy` provides the auto-selection logic and StrategyReport.
// Appended after local_align — keep lib.rs append-only.
pub mod similarity;
pub mod strategy;
pub mod tile;

// --- Shared stitch orchestration (M3, #1235): the single authoritative
// rotation-strategy pipeline that both `maple-cli pano stitch` and the
// `maple_pano_stitch` C-FFI entry call. Keeping one copy closes the
// Apple↔CLI parity gap (CLAUDE.md principle #4). Requires `ml` or
// `ml-static` (M6 #1244 — iOS static-link path).
// Appended after tile — keep lib.rs append-only.
#[cfg(any(feature = "ml", feature = "ml-static"))]
pub mod stitch;

// --- Content-aware seam finding (M2b, #1179, spec §5.7): a graph-cut
// (Boykov-Kolmogorov max-flow) seam finder over downsampled overlap
// regions between neighbouring warped frames, selectable alongside the
// M2a Voronoi seam via `crate::seam::SeamStrategy`. No platform deps (pure
// Rust, no `ml`/`ml-static` gate) so it builds on every target the crate
// does, including iOS. Appended after stitch — keep lib.rs append-only.
pub mod seam;
