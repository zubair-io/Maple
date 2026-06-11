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

// --- `ml` feature (#1139): ALIKED + LightGlue via ONNX Runtime ----------
//
// Native-only detector/matcher stack per the eng design spec §2.2/§5.
// `features` owns detection (keypoints/descriptors/scores), `matching`
// owns LightGlue and the `MlMatch` contract records the #1138 geometry
// side consumes, `models` owns the models.toml manifest, SHA-256
// verification, and the onnxruntime pre-flight.
#[cfg(feature = "ml")]
pub mod features;
#[cfg(feature = "ml")]
pub mod matching;
#[cfg(feature = "ml")]
pub mod models;
