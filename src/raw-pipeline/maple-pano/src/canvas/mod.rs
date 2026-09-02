//! Projection canvas: the output pixel grid a panorama composites into
//! (M2-CPU, #1155; stitching spec §5.4).
//!
//! A [`CanvasSpec`] is an affine window onto one of the three
//! [`Projection`] surfaces plus an optional canvas-to-world rotation:
//!
//! ```text
//! u(px) = u0 + px · du          v(py) = v0 + py · dv
//! dir(px, py) = rotation · projection.inverse(u, v)
//! ```
//!
//! `px`/`py` are continuous pixel coordinates in the crate convention
//! (texel `(ix, iy)` covers `[ix, ix+1) × [iy, iy+1)`, center at
//! `(ix + 0.5, iy + 0.5)`). For the angular projections `dv` is negative
//! (`v` increases up, rows increase down — row 0 is the top of the
//! canvas); rectilinear keeps the image-plane convention (`dv > 0`).
//!
//! [`CanvasSpec::full_sphere`] reproduces the equirect pixel mapping of
//! [`crate::source::EquirectSource`] exactly (`u_px = (λ/2π + 0.5)·W`,
//! `v_px = (0.5 − φ/π)·H`), which is what the §7 warp gate composites
//! onto.
//!
//! [`auto_canvas`] implements the spec §5.4 policy: projection selected
//! by the camera set's angular extent (< 60° rectilinear, 60–130°
//! cylindrical, > 130° spherical), canvas resolution preserving the
//! maximum input angular pixel density, with a configurable total-pixel
//! cap. The canvas keeps the world's vertical axis for the angular
//! projections (leveling is the solver's job, not the canvas's); a
//! rectilinear canvas is yawed/pitched toward the content centroid with
//! zero roll.

use crate::error::PanoError;
use crate::math::{Mat3, Vec3};
use crate::project::Projection;

use std::f64::consts::{FRAC_PI_2, PI, TAU};

/// Projection selection policy for [`auto_canvas`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ProjectionMode {
    /// Select by angular extent per spec §5.4.
    #[default]
    Auto,
    /// Force a specific projection (user override).
    Force(Projection),
}

/// Options for [`auto_canvas`].
#[derive(Debug, Clone)]
pub struct CanvasOptions {
    pub projection: ProjectionMode,
    /// Total-pixel cap (memory bound, spec §5.4). The auto canvas is
    /// uniformly downscaled (aspect preserved) to fit under it.
    pub max_pixels: usize,
    /// Extra canvas margin around the projected content, in output
    /// pixels per side (not applied along a fully-wrapped axis).
    pub margin_px: f64,
}

impl Default for CanvasOptions {
    fn default() -> Self {
        Self {
            projection: ProjectionMode::Auto,
            max_pixels: 256_000_000,
            margin_px: 2.0,
        }
    }
}

/// Pick the output projection from the camera set's angular extent
/// (degrees): < 60° rectilinear, 60–130° cylindrical, > 130° spherical.
pub fn select_projection(extent_deg: f64) -> Projection {
    if extent_deg < 60.0 {
        Projection::Rectilinear
    } else if extent_deg <= 130.0 {
        Projection::Cylindrical
    } else {
        Projection::Spherical
    }
}

/// A concrete output canvas: a pixel grid over a projection surface.
#[derive(Debug, Clone)]
pub struct CanvasSpec {
    pub projection: Projection,
    pub width: u32,
    pub height: u32,
    u0: f64,
    v0: f64,
    du: f64,
    dv: f64,
    /// Canvas-to-world rotation (identity for the angular projections
    /// built by [`auto_canvas`] — they keep the world vertical).
    rotation: Mat3,
    rotation_inv: Mat3,
    /// `true` when the u axis tiles the full circle (du · width = 2π).
    full_wrap: bool,
}

impl CanvasSpec {
    /// General constructor. `du`/`dv` are the per-pixel steps of the
    /// affine pixel→surface map (`dv < 0` puts larger `v` at the top).
    /// `full_wrap` declares that `width · |du| == 2π` (the caller
    /// guarantees it; [`auto_canvas`] and [`full_sphere`] do).
    ///
    /// [`full_sphere`]: CanvasSpec::full_sphere
    #[allow(clippy::too_many_arguments)]
    pub fn with_window(
        projection: Projection,
        width: u32,
        height: u32,
        u0: f64,
        v0: f64,
        du: f64,
        dv: f64,
        rotation: Mat3,
        full_wrap: bool,
    ) -> Result<Self, PanoError> {
        if width == 0 || height == 0 {
            return Err(PanoError::InvalidOptions(
                "canvas dimensions must be >= 1".into(),
            ));
        }
        if !(du.is_finite() && dv.is_finite()) || du == 0.0 || dv == 0.0 {
            return Err(PanoError::InvalidOptions(
                "canvas pixel steps must be finite and non-zero".into(),
            ));
        }
        Ok(Self {
            projection,
            width,
            height,
            u0,
            v0,
            du,
            dv,
            rotation,
            rotation_inv: rotation.transpose(),
            full_wrap,
        })
    }

    /// Full-sphere equirectangular canvas of `2·height × height`,
    /// matching [`crate::source::EquirectSource`]'s pixel mapping
    /// exactly: `u_px = (λ/2π + 0.5)·W`, `v_px = (0.5 − φ/π)·H`.
    pub fn full_sphere(height: u32) -> Result<Self, PanoError> {
        let width = height
            .checked_mul(2)
            .filter(|_| height >= 1)
            .ok_or_else(|| {
                PanoError::InvalidOptions("full-sphere canvas height out of range".into())
            })?;
        let du = TAU / width as f64;
        let dv = -(PI / height as f64);
        Self::with_window(
            Projection::Spherical,
            width,
            height,
            -PI,
            FRAC_PI_2,
            du,
            dv,
            Mat3::identity(),
            true,
        )
    }

    /// `true` when the canvas u axis tiles the full circle (columns 0
    /// and `width − 1` are angular neighbors).
    pub fn is_full_wrap(&self) -> bool {
        self.full_wrap
    }

    /// Output pixels per radian along u at the window reference (the
    /// inverse of the per-pixel step; for rectilinear this is the
    /// center-of-canvas angular density).
    pub fn pixels_per_radian(&self) -> f64 {
        1.0 / self.du.abs()
    }

    /// Surface coordinates of a continuous pixel position.
    #[inline]
    pub fn pixel_to_uv(&self, px: f64, py: f64) -> (f64, f64) {
        (self.u0 + px * self.du, self.v0 + py * self.dv)
    }

    /// World direction of a continuous pixel position. `None` when the
    /// surface coordinate is outside the projection's domain (spherical
    /// `|φ| > π/2` — only reachable through margins/rounding).
    #[inline]
    pub fn pixel_to_dir(&self, px: f64, py: f64) -> Option<Vec3> {
        let (u, v) = self.pixel_to_uv(px, py);
        let d = self.projection.inverse(u, v)?;
        Some(self.rotation.mul_vec(d))
    }

    /// Continuous pixel position of a world direction. `None` when the
    /// projection cannot represent the direction (rectilinear: behind
    /// the canvas plane; cylindrical: at the poles).
    ///
    /// For the angular projections the longitude-like `u` is wrapped
    /// into `[u0, u0 + 2π)` so any canvas window placement works; the
    /// returned pixel may lie outside `[0, width] × [0, height]` —
    /// callers decide what "on the canvas" means.
    #[inline]
    pub fn dir_to_pixel(&self, dir: Vec3) -> Option<(f64, f64)> {
        let d = self.rotation_inv.mul_vec(dir);
        let (u, v) = self.projection.forward(d)?;
        let px = match self.projection {
            Projection::Rectilinear => (u - self.u0) / self.du,
            Projection::Cylindrical | Projection::Spherical => {
                (u - self.u0).rem_euclid(TAU) / self.du
            }
        };
        let py = (v - self.v0) / self.dv;
        Some((px, py))
    }

    /// Total pixel count.
    pub fn pixel_count(&self) -> usize {
        self.width as usize * self.height as usize
    }

    /// A copy of this canvas uniformly shrunk (aspect preserved) so its
    /// pixel count is at or under `max_pixels`, covering the exact same
    /// angular window (`u0`/`v0` unchanged; `du`/`dv` recomputed from the
    /// new dimensions so `width · du` and `height · dv` — the covered
    /// extent — stay exactly what they were, which is what keeps
    /// [`Self::is_full_wrap`]'s `width · |du| == 2π` invariant exact
    /// regardless of the integer rounding on `width`/`height`).
    ///
    /// A no-op (clones `self`) when already at or under the cap. Used by
    /// the graph-cut seam finder (#1179) to build a cheap low-resolution
    /// "seam canvas" for content-aware mask computation ahead of the
    /// memory-bounded full-resolution tiled composite.
    pub fn downscaled(&self, max_pixels: usize) -> Self {
        let total = self.pixel_count();
        if total <= max_pixels || max_pixels == 0 {
            return self.clone();
        }
        let scale = (max_pixels as f64 / total as f64).sqrt();
        let width = ((self.width as f64 * scale).floor() as u32).max(1);
        let height = ((self.height as f64 * scale).floor() as u32).max(1);
        let du = self.du * (self.width as f64 / width as f64);
        let dv = self.dv * (self.height as f64 / height as f64);
        Self {
            projection: self.projection,
            width,
            height,
            u0: self.u0,
            v0: self.v0,
            du,
            dv,
            rotation: self.rotation,
            rotation_inv: self.rotation_inv,
            full_wrap: self.full_wrap,
        }
    }
}

// ---------------------------------------------------------------------
// Auto canvas
// ---------------------------------------------------------------------

/// Per-camera direction samples used by the auto-canvas analysis.
pub(super) struct CameraSamples {
    /// Dense border ring + interior grid (world directions).
    dirs: Vec<Vec3>,
    /// Sparse extreme set (corners, edge midpoints, center) for the
    /// O(n²) extent computation.
    sparse: Vec<Vec3>,
    /// Maximum local angular pixel density (px per radian), measured
    /// numerically at the sparse sample positions.
    max_density: f64,
    /// World longitude window `[lo, hi]` covered by the frame
    /// (`hi − lo < 2π`), unwrapped around the frame center. `None`
    /// when the frame contains a pole (it then covers all longitudes).
    lon_window: Option<(f64, f64)>,
    sees_zenith: bool,
    sees_nadir: bool,
}

mod auto;
pub use auto::{angular_extent_deg, auto_canvas, natural_canvas_pixel_ratio};

/// Natural-canvas-to-cap pixel-ratio above which a rotation BA solution is
/// treated as degenerate and rejected fail-fast (see the guard in
/// `stitch::stitch`, #1269). A small multiple of `max_canvas_px`: a legit
/// 21-frame DJI rotation pano measures ~1.08×, while the ~317 GB blowup
/// back-of-envelopes to ~26–103× natural — 8× clears legit content yet fires
/// before the blowup. Single-sourced here so the guard and its unit tests
/// cannot drift.
///
/// Small-pano safety (#1276): a 2–3 frame overlapping set is safe at any
/// realistic sensor size. A DJI L3D-100c-like camera (11 648 × 8 736,
/// 74° HFOV, ~7 700 px focal) measures only ~1.42× for 2 frames and
/// ~2.01× for 3 frames — far below 8×. The 61× value observed during #1254
/// verification was two non-adjacent frames from pano_01 (PANO0001 +
/// PANO0002) forced through the rotation path, not a legitimate small pano.
pub(crate) const DEGENERATE_CANVAS_RATIO: f64 = 8.0;

#[cfg(test)]
mod tests;
