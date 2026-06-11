//! `ground_truth.json` schema — the contract between the synthetic
//! renderer and every consumer (M1 geometry solve, the §7 acceptance
//! gates, the warp-RMSE harness).
//!
//! # Schema (version 1)
//!
//! ```json
//! {
//!   "version": 1,
//!   "convention": {
//!     "world_frame": "...", "camera_frame": "...", "rotation": "...",
//!     "longitude": "...", "latitude": "...", "pixels": "...",
//!     "distortion": "..."
//!   },
//!   "source": {
//!     "projection": "equirectangular",
//!     "kind": "synthetic" | "file",
//!     "width": 2048, "height": 1024,
//!     "lon_range_deg": [-180.0, 180.0],
//!     "lat_range_deg": [-90.0, 90.0],
//!     "seed": 7,                 // synthetic only
//!     "path": "input.png"        // file only
//!   },
//!   "render": { "supersample": 2, "seed": 7 },
//!   "cameras": [
//!     {
//!       "frame": "frame_0000.png",
//!       "axis_angle": [0.0, 0.733038, 0.0],
//!       "focal_px": 831.38446,
//!       "k1": -0.06, "k2": 0.025,
//!       "width": 960, "height": 720
//!     }
//!   ]
//! }
//! ```
//!
//! - `axis_angle` is the Rodrigues vector (radians) of the
//!   **camera-to-world** rotation: `d_world = exp([ω]×) · d_cam`. World
//!   frame: +X east, +Y down, +Z forward; camera frame: +X right, +Y down,
//!   +Z optical axis. See the crate docs for the full convention.
//! - **Exactness guarantee:** `axis_angle`, `focal_px`, `k1`, `k2` are
//!   `f32` values and are *exactly* the numbers the renderer used — camera
//!   parameters are quantized to `f32` *before* rendering, so a consumer
//!   reconstructing the camera from this file reproduces the render
//!   mapping bit-for-bit (no hidden extra precision).
//! - `source.lon_range_deg` / `lat_range_deg` document the full-sphere
//!   equirect mapping of the source image (fixed for version 1).
//! - `render.supersample` is the per-axis factor: `N` means `N × N`
//!   sub-samples per output pixel.

use serde::{Deserialize, Serialize};

/// Schema version written by this crate.
pub const GROUND_TRUTH_VERSION: u32 = 1;

/// Top-level `ground_truth.json` document.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GroundTruth {
    pub version: u32,
    pub convention: Convention,
    pub source: SourceSpec,
    pub render: RenderSpec,
    pub cameras: Vec<CameraGt>,
}

/// Human-readable statement of the geometric conventions, embedded so the
/// file is self-describing. Machine consumers should rely on `version`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Convention {
    pub world_frame: String,
    pub camera_frame: String,
    pub rotation: String,
    pub longitude: String,
    pub latitude: String,
    pub pixels: String,
    pub distortion: String,
}

impl Convention {
    pub fn current() -> Self {
        Self {
            world_frame: "right-handed; +X east, +Y down (nadir), +Z forward (lon 0, lat 0); \
                          zenith = -Y"
                .into(),
            camera_frame: "+X right, +Y down, +Z optical axis".into(),
            rotation: "camera-to-world: d_world = exp([axis_angle]x) . d_cam; axis_angle = \
                       Rodrigues vector, radians"
                .into(),
            longitude: "atan2(x, z), radians; 0 at +Z, increasing eastward (+X); equirect \
                        u_px = (lon/2pi + 0.5) * width"
                .into(),
            latitude: "asin(-y), radians; positive up; equirect v_px = (0.5 - lat/pi) * \
                       height (row 0 = zenith)"
                .into(),
            pixels: "continuous; texel (ix, iy) covers [ix, ix+1) x [iy, iy+1), center at \
                     (ix+0.5, iy+0.5); principal point = image center (width/2, height/2)"
                .into(),
            distortion: "radial polynomial on ideal normalized coords: r_d = r * (1 + k1*r^2 \
                         + k2*r^4); inverse solved by Newton iteration"
                .into(),
        }
    }
}

/// What the frames were rendered from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SourceSpec {
    /// Always `"equirectangular"` in version 1.
    pub projection: String,
    /// `"synthetic"` or `"file"`.
    pub kind: String,
    pub width: u32,
    pub height: u32,
    /// Longitude span of the source mapping, degrees (fixed full-sphere).
    pub lon_range_deg: [f64; 2],
    /// Latitude span of the source mapping, degrees (fixed full-sphere).
    pub lat_range_deg: [f64; 2],
    /// Seed of the procedural scene (synthetic sources only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
    /// Input file the source was loaded from (file sources only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Rendering parameters that affect output pixels.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RenderSpec {
    /// Per-axis supersampling factor (`N` → `N × N` taps per pixel).
    pub supersample: u32,
    /// Master seed (drives the synthetic scene and the camera jitter).
    pub seed: u64,
}

/// One rendered camera. The `f32` fields are exactly what the renderer
/// used (quantized before rendering) — see the module docs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CameraGt {
    /// Frame file name, relative to the JSON's directory.
    pub frame: String,
    /// Rodrigues vector of the camera-to-world rotation (radians).
    pub axis_angle: [f32; 3],
    /// Focal length in pixels.
    pub focal_px: f32,
    pub k1: f32,
    pub k2: f32,
    pub width: u32,
    pub height: u32,
}

impl CameraGt {
    /// Reconstruct the exact [`crate::camera::Camera`] this entry was
    /// rendered with.
    pub fn to_camera(&self) -> crate::camera::Camera {
        crate::camera::Camera::new(
            [
                self.axis_angle[0] as f64,
                self.axis_angle[1] as f64,
                self.axis_angle[2] as f64,
            ],
            self.focal_px as f64,
            self.k1 as f64,
            self.k2 as f64,
            self.width,
            self.height,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_round_trip_preserves_document() {
        let gt = GroundTruth {
            version: GROUND_TRUTH_VERSION,
            convention: Convention::current(),
            source: SourceSpec {
                projection: "equirectangular".into(),
                kind: "synthetic".into(),
                width: 256,
                height: 128,
                lon_range_deg: [-180.0, 180.0],
                lat_range_deg: [-90.0, 90.0],
                seed: Some(9),
                path: None,
            },
            render: RenderSpec {
                supersample: 2,
                seed: 9,
            },
            cameras: vec![CameraGt {
                frame: "frame_0000.png".into(),
                axis_angle: [0.0, 0.733038, 0.0],
                focal_px: 831.3844,
                k1: -0.06,
                k2: 0.025,
                width: 96,
                height: 72,
            }],
        };
        let json = serde_json::to_string_pretty(&gt).unwrap();
        let back: GroundTruth = serde_json::from_str(&json).unwrap();
        assert_eq!(gt, back);
    }

    #[test]
    fn to_camera_uses_exact_f32_values() {
        let entry = CameraGt {
            frame: "frame_0000.png".into(),
            axis_angle: [0.1, -0.2, 0.3],
            focal_px: 500.25,
            k1: -0.0625,
            k2: 0.03125,
            width: 64,
            height: 48,
        };
        let cam = entry.to_camera();
        assert_eq!(
            cam.axis_angle,
            [0.1_f32 as f64, -0.2_f32 as f64, 0.3_f32 as f64]
        );
        assert_eq!(cam.focal_px, 500.25_f32 as f64);
        assert_eq!(cam.k1, -0.0625);
        assert_eq!(cam.k2, 0.03125);
    }
}
