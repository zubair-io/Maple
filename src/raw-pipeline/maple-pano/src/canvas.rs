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

use crate::camera::Camera;
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
}

// ---------------------------------------------------------------------
// Auto canvas
// ---------------------------------------------------------------------

/// Per-camera direction samples used by the auto-canvas analysis.
struct CameraSamples {
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

fn sample_camera(cam: &Camera) -> Result<CameraSamples, PanoError> {
    let w = cam.width as f64;
    let h = cam.height as f64;
    let at = |px: f64, py: f64| cam.pixel_to_world_dir(px, py);

    // Sparse extremes: corners, edge midpoints, center.
    let sparse_px = [
        (0.0, 0.0),
        (w, 0.0),
        (0.0, h),
        (w, h),
        (w * 0.5, 0.0),
        (w * 0.5, h),
        (0.0, h * 0.5),
        (w, h * 0.5),
        (w * 0.5, h * 0.5),
    ];
    let mut sparse = Vec::with_capacity(sparse_px.len());
    let mut max_density = 0.0_f64;
    for &(px, py) in &sparse_px {
        let Some(d) = at(px, py) else { continue };
        sparse.push(d);
        // Numeric local density: 1 px step toward the frame interior
        // (so the probe stays inside the distortion model's domain).
        let sx = if px > w * 0.5 { -1.0 } else { 1.0 };
        let sy = if py > h * 0.5 { -1.0 } else { 1.0 };
        for (qx, qy) in [(px + sx, py), (px, py + sy)] {
            if let Some(q) = at(qx, qy) {
                let ang = d.dot(q).clamp(-1.0, 1.0).acos();
                if ang > 1e-12 {
                    max_density = max_density.max(1.0 / ang);
                }
            }
        }
    }
    if sparse.is_empty() {
        return Err(PanoError::InvalidOptions(format!(
            "camera (f = {} px, k1 = {}, k2 = {}) has no invertible frame samples",
            cam.focal_px, cam.k1, cam.k2
        )));
    }

    // Dense border ring (16 samples per edge) + 5×5 interior grid.
    let mut dirs = Vec::with_capacity(4 * 16 + 25);
    const EDGE: usize = 16;
    for i in 0..=EDGE {
        let t = i as f64 / EDGE as f64;
        for (px, py) in [(t * w, 0.0), (t * w, h), (0.0, t * h), (w, t * h)] {
            if let Some(d) = at(px, py) {
                dirs.push(d);
            }
        }
    }
    for gy in 0..5 {
        for gx in 0..5 {
            let px = (gx as f64 + 0.5) * w / 5.0;
            let py = (gy as f64 + 0.5) * h / 5.0;
            if let Some(d) = at(px, py) {
                dirs.push(d);
            }
        }
    }

    let sees_zenith = sees_dir(cam, Vec3::new(0.0, -1.0, 0.0));
    let sees_nadir = sees_dir(cam, Vec3::new(0.0, 1.0, 0.0));

    // Longitude window: unwrap border longitudes around the frame
    // center's longitude. Frames containing a pole cover everything.
    let lon_window = if sees_zenith || sees_nadir {
        None
    } else {
        let center = at(w * 0.5, h * 0.5).and_then(|d| Projection::Spherical.forward(d));
        match center {
            None => None,
            Some((lc, _)) => {
                let mut lo = lc;
                let mut hi = lc;
                for d in &dirs {
                    if let Some((l, _)) = Projection::Spherical.forward(*d) {
                        let rel = wrap_pi(l - lc);
                        lo = lo.min(lc + rel);
                        hi = hi.max(lc + rel);
                    }
                }
                Some((lo, hi))
            }
        }
    };

    Ok(CameraSamples {
        dirs,
        sparse,
        max_density,
        lon_window,
        sees_zenith,
        sees_nadir,
    })
}

fn sees_dir(cam: &Camera, dir: Vec3) -> bool {
    cam.world_dir_to_pixel(dir)
        .is_some_and(|(px, py)| cam.pixel_in_bounds(px, py, 0.0))
}

/// Wrap an angle to `(−π, π]`.
fn wrap_pi(a: f64) -> f64 {
    let r = (a + PI).rem_euclid(TAU);
    if r == 0.0 {
        PI
    } else {
        r - PI
    }
}

/// Angular extent of a camera set, degrees: the maximum pairwise angle
/// between frame-extreme directions (the angular diameter of the union
/// footprint). This is the quantity spec §5.4's projection thresholds
/// are defined over.
pub fn angular_extent_deg(cameras: &[Camera]) -> Result<f64, PanoError> {
    let samples: Result<Vec<_>, _> = cameras.iter().map(sample_camera).collect();
    Ok(extent_deg_of(&samples?))
}

fn extent_deg_of(samples: &[CameraSamples]) -> f64 {
    let dirs: Vec<Vec3> = samples
        .iter()
        .flat_map(|s| s.sparse.iter().copied())
        .collect();
    let mut max_angle = 0.0_f64;
    for i in 0..dirs.len() {
        for j in (i + 1)..dirs.len() {
            let ang = dirs[i].dot(dirs[j]).clamp(-1.0, 1.0).acos();
            max_angle = max_angle.max(ang);
        }
    }
    max_angle.to_degrees()
}

/// Merge longitude windows on the circle. Returns `None` when the
/// union covers the full circle, else the smallest window `[lo, hi]`
/// (with `hi − lo ≤ 2π`) containing every input window.
fn circular_window(windows: &[(f64, f64)]) -> Option<(f64, f64)> {
    debug_assert!(!windows.is_empty());
    // Normalize starts into [0, 2π); keep lengths.
    let mut iv: Vec<(f64, f64)> = windows
        .iter()
        .map(|&(lo, hi)| (lo.rem_euclid(TAU), (hi - lo).min(TAU)))
        .collect();
    if iv.iter().any(|&(_, len)| len >= TAU - 1e-9) {
        return None;
    }
    iv.sort_by(|a, b| a.0.partial_cmp(&b.0).expect("finite longitudes"));
    // Merge overlapping intervals along the unrolled line.
    let mut merged: Vec<(f64, f64)> = Vec::new(); // (start, end), end may exceed 2π
    for &(s, len) in &iv {
        let e = s + len;
        match merged.last_mut() {
            Some(last) if s <= last.1 + 1e-12 => last.1 = last.1.max(e),
            _ => merged.push((s, e)),
        }
    }
    // Wrap-merge: last interval reaching past 2π may absorb the first.
    while merged.len() > 1 {
        let last = *merged.last().expect("non-empty");
        if last.1 - TAU >= merged[0].0 - 1e-12 {
            let first = merged.remove(0);
            let last = merged.last_mut().expect("non-empty");
            last.1 = last.1.max(first.1 + TAU);
        } else {
            break;
        }
    }
    if merged.len() == 1 && merged[0].1 - merged[0].0 >= TAU - 1e-9 {
        return None;
    }
    // Largest circular gap between consecutive merged intervals; the
    // window is its complement.
    let n = merged.len();
    let mut best_gap = f64::NEG_INFINITY;
    let mut window = (merged[0].0, merged[0].1);
    for i in 0..n {
        let end_i = merged[i].1;
        let next_start = if i + 1 < n {
            merged[i + 1].0
        } else {
            merged[0].0 + TAU
        };
        let gap = next_start - end_i;
        if gap > best_gap {
            best_gap = gap;
            // Window = complement of the gap: from the gap's end around
            // the circle to the gap's start (one turn later).
            window = (next_start, end_i + TAU);
        }
    }
    if best_gap <= 1e-9 {
        return None;
    }
    Some(window)
}

/// Build the output canvas for a camera set per spec §5.4. See the
/// module docs for the policy.
pub fn auto_canvas(cameras: &[Camera], opts: &CanvasOptions) -> Result<CanvasSpec, PanoError> {
    if cameras.is_empty() {
        return Err(PanoError::InvalidOptions(
            "auto_canvas: camera set is empty".into(),
        ));
    }
    if opts.max_pixels == 0 {
        return Err(PanoError::InvalidOptions(
            "auto_canvas: max_pixels must be >= 1".into(),
        ));
    }
    let samples: Result<Vec<_>, _> = cameras.iter().map(sample_camera).collect();
    let samples = samples?;

    let projection = match opts.projection {
        ProjectionMode::Force(p) => p,
        ProjectionMode::Auto => select_projection(extent_deg_of(&samples)),
    };
    let density = samples
        .iter()
        .map(|s| s.max_density)
        .fold(0.0_f64, f64::max);
    if !(density.is_finite() && density > 0.0) {
        return Err(PanoError::InvalidOptions(
            "auto_canvas: could not measure input angular density".into(),
        ));
    }
    let step = 1.0 / density; // target per-pixel surface step

    match projection {
        Projection::Rectilinear => rectilinear_canvas(&samples, step, opts),
        Projection::Cylindrical | Projection::Spherical => {
            angular_canvas(projection, &samples, step, opts)
        }
    }
}

fn rectilinear_canvas(
    samples: &[CameraSamples],
    step: f64,
    opts: &CanvasOptions,
) -> Result<CanvasSpec, PanoError> {
    // Orient the canvas toward the content centroid: yaw + pitch only
    // (zero roll — the world vertical stays vertical on the canvas).
    let mut c = Vec3::new(0.0, 0.0, 0.0);
    for s in samples {
        for d in &s.dirs {
            c = c + *d;
        }
    }
    let c = c.normalized().ok_or_else(|| {
        PanoError::InvalidOptions(
            "rectilinear canvas: content centroid is degenerate (extent too wide)".into(),
        )
    })?;
    let yaw = c.x.atan2(c.z);
    let pitch = (-c.y).clamp(-1.0, 1.0).asin();
    let rotation = Mat3::rotation_y(yaw).mul_mat(&Mat3::rotation_x(pitch));
    let rot_inv = rotation.transpose();

    let mut u_min = f64::INFINITY;
    let mut u_max = f64::NEG_INFINITY;
    let mut v_min = f64::INFINITY;
    let mut v_max = f64::NEG_INFINITY;
    for s in samples {
        for d in &s.dirs {
            let dc = rot_inv.mul_vec(*d);
            let (u, v) = Projection::Rectilinear.forward(dc).ok_or_else(|| {
                PanoError::InvalidOptions(
                    "rectilinear canvas cannot represent directions >= 90 degrees off-axis \
                     — use a cylindrical or spherical projection"
                        .into(),
                )
            })?;
            u_min = u_min.min(u);
            u_max = u_max.max(u);
            v_min = v_min.min(v);
            v_max = v_max.max(v);
        }
    }
    let margin = opts.margin_px * step;
    let (u_min, u_max) = (u_min - margin, u_max + margin);
    let (v_min, v_max) = (v_min - margin, v_max + margin);
    let (width, height, du, dv) =
        fit_under_cap(u_max - u_min, v_max - v_min, step, step, opts.max_pixels);
    CanvasSpec::with_window(
        Projection::Rectilinear,
        width,
        height,
        u_min,
        v_min,
        du,
        dv,
        rotation,
        false,
    )
}

fn angular_canvas(
    projection: Projection,
    samples: &[CameraSamples],
    step: f64,
    opts: &CanvasOptions,
) -> Result<CanvasSpec, PanoError> {
    // Longitude window (shared by both angular projections).
    let any_pole_frame = samples.iter().any(|s| s.lon_window.is_none());
    let windows: Vec<(f64, f64)> = samples.iter().filter_map(|s| s.lon_window).collect();
    let lon_window = if any_pole_frame || windows.is_empty() {
        None
    } else {
        circular_window(&windows)
    };

    // Vertical range from every sample direction.
    let mut v_min = f64::INFINITY;
    let mut v_max = f64::NEG_INFINITY;
    for s in samples {
        for d in &s.dirs {
            if let Some((_, v)) = projection.forward(*d) {
                v_min = v_min.min(v);
                v_max = v_max.max(v);
            }
        }
        // Pole visibility pushes the vertical range to the projection's
        // representable limit (cylindrical v = tan φ is clamped at 85°).
        let v_limit = match projection {
            Projection::Spherical => FRAC_PI_2,
            _ => 85.0_f64.to_radians().tan(),
        };
        if s.sees_zenith {
            v_max = v_limit;
        }
        if s.sees_nadir {
            v_min = -v_limit;
        }
    }
    if !(v_min.is_finite() && v_max.is_finite()) {
        return Err(PanoError::InvalidOptions(
            "auto_canvas: no representable directions for the angular canvas".into(),
        ));
    }

    let margin = opts.margin_px * step;
    let (full_wrap, u_lo, u_range) = match lon_window {
        None => (true, -PI, TAU),
        Some((lo, hi)) => {
            let lo = lo - margin;
            let hi = hi + margin;
            if hi - lo >= TAU {
                (true, -PI, TAU)
            } else {
                (false, lo, hi - lo)
            }
        }
    };
    let mut v_lo = v_min - margin;
    let mut v_hi = v_max + margin;
    if projection == Projection::Spherical {
        v_lo = v_lo.max(-FRAC_PI_2);
        v_hi = v_hi.min(FRAC_PI_2);
    }

    let (width, height, mut du, dv) =
        fit_under_cap(u_range, v_hi - v_lo, step, step, opts.max_pixels);
    if full_wrap {
        // Exact tiling: the wrap seam must close (du · width ≡ 2π).
        du = TAU / width as f64;
    }
    CanvasSpec::with_window(
        projection,
        width,
        height,
        u_lo,
        v_hi, // v0 = top row; dv negative (v increases up, rows down)
        du,
        -dv,
        Mat3::identity(),
        full_wrap,
    )
}

/// Round ranges to pixel counts at the target steps, then uniformly
/// downscale (aspect preserved) until `width · height <= max_pixels`.
/// Returns `(width, height, du, dv)` with steps recomputed from the
/// final dimensions so the window is covered exactly.
fn fit_under_cap(
    u_range: f64,
    v_range: f64,
    u_step: f64,
    v_step: f64,
    max_pixels: usize,
) -> (u32, u32, f64, f64) {
    let w = (u_range / u_step).ceil().max(1.0);
    let h = (v_range / v_step).ceil().max(1.0);
    let total = w * h;
    let scale = if total > max_pixels as f64 {
        (max_pixels as f64 / total).sqrt()
    } else {
        1.0
    };
    let width = ((w * scale).floor() as u32).max(1);
    let height = ((h * scale).floor() as u32).max(1);
    (
        width,
        height,
        u_range / width as f64,
        v_range / height as f64,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::focal_px_for_hfov;
    use crate::prng::SplitMix64;
    use crate::render::{build_camera_set, CameraSetOptions, Pattern};

    fn ring(count: u32, fov_deg: f64, full: bool, overlap: f64) -> Vec<Camera> {
        let opts = CameraSetOptions {
            count,
            pattern: Pattern::Ring { full },
            fov_deg,
            overlap,
            pitch_deg: 0.0,
            jitter_deg: 0.0,
            k1: 0.0,
            k2: 0.0,
            width: 192,
            height: 144,
        };
        build_camera_set(&opts, &mut SplitMix64::new(7))
            .expect("valid options")
            .iter()
            .map(|c| c.to_camera())
            .collect()
    }

    #[test]
    fn full_sphere_matches_equirect_source_mapping() {
        let c = CanvasSpec::full_sphere(64).unwrap();
        assert_eq!((c.width, c.height), (128, 64));
        assert!(c.is_full_wrap());
        // λ = 0, φ = 0 → pixel (W/2, H/2).
        let (px, py) = c.dir_to_pixel(Vec3::new(0.0, 0.0, 1.0)).unwrap();
        assert!((px - 64.0).abs() < 1e-9 && (py - 32.0).abs() < 1e-9);
        // East (λ = π/2) → 3/4 W.
        let (px, _) = c.dir_to_pixel(Vec3::new(1.0, 0.0, 0.0)).unwrap();
        assert!((px - 96.0).abs() < 1e-9);
        // Round trip on a grid of texel centers.
        for iy in (0..64).step_by(7) {
            for ix in (0..128).step_by(11) {
                let (px, py) = (ix as f64 + 0.5, iy as f64 + 0.5);
                let d = c.pixel_to_dir(px, py).expect("in-domain");
                let (qx, qy) = c.dir_to_pixel(d).expect("representable");
                assert!(
                    (qx - px).abs() < 1e-9 && (qy - py).abs() < 1e-9,
                    "({px}, {py}) → ({qx}, {qy})"
                );
            }
        }
        // Top row center latitude approaches the zenith: φ = π/2 · (1 − 1/H).
        let d = c.pixel_to_dir(0.5, 0.5).unwrap();
        let (_, phi) = Projection::Spherical.forward(d).unwrap();
        assert!((phi - FRAC_PI_2 * (1.0 - 1.0 / 64.0)).abs() < 1e-9);
    }

    /// A rectilinear canvas aligned with a distortion-free camera maps
    /// pixels identically to the camera — the convention cross-check
    /// between canvas and camera mappings.
    #[test]
    fn identity_rect_canvas_matches_camera_mapping() {
        let cam = Camera::new([0.15, -0.6, 0.05], 300.0, 0.0, 0.0, 200, 150);
        let f = cam.focal_px;
        let c = CanvasSpec::with_window(
            Projection::Rectilinear,
            cam.width,
            cam.height,
            -(cam.width as f64 * 0.5) / f,
            -(cam.height as f64 * 0.5) / f,
            1.0 / f,
            1.0 / f,
            cam.rotation,
            false,
        )
        .unwrap();
        for (px, py) in [(0.5, 0.5), (100.5, 75.5), (199.5, 0.5), (37.0, 148.0)] {
            let dc = c.pixel_to_dir(px, py).unwrap();
            let dcam = cam.pixel_to_world_dir(px, py).unwrap();
            assert!((dc - dcam).norm() < 1e-12, "dir mismatch at ({px}, {py})");
            let (qx, qy) = c.dir_to_pixel(dcam).unwrap();
            assert!((qx - px).abs() < 1e-9 && (qy - py).abs() < 1e-9);
        }
    }

    #[test]
    fn projection_thresholds_per_spec() {
        assert_eq!(select_projection(45.0), Projection::Rectilinear);
        assert_eq!(select_projection(60.0), Projection::Cylindrical);
        assert_eq!(select_projection(130.0), Projection::Cylindrical);
        assert_eq!(select_projection(131.0), Projection::Spherical);
    }

    #[test]
    fn auto_selects_by_extent() {
        // Single 40° camera → diagonal extent ~49° → rectilinear.
        // (50° hfov on 4:3 already has a > 60° diagonal.)
        let single = ring(1, 40.0, false, 0.0);
        let c = auto_canvas(&single, &CanvasOptions::default()).unwrap();
        assert_eq!(c.projection, Projection::Rectilinear);

        // Three 45° cameras spanning ~103° → cylindrical.
        let mid = ring(3, 45.0, false, 0.35);
        let c = auto_canvas(&mid, &CanvasOptions::default()).unwrap();
        assert_eq!(c.projection, Projection::Cylindrical);
        assert!(!c.is_full_wrap());

        // Full 360° ring → spherical, full wrap, du·W = 2π.
        let full = ring(10, 60.0, true, 0.0);
        let c = auto_canvas(&full, &CanvasOptions::default()).unwrap();
        assert_eq!(c.projection, Projection::Spherical);
        assert!(c.is_full_wrap());
        assert!((c.du * c.width as f64 - TAU).abs() < 1e-9);

        // Override wins.
        let c = auto_canvas(
            &mid,
            &CanvasOptions {
                projection: ProjectionMode::Force(Projection::Spherical),
                ..CanvasOptions::default()
            },
        )
        .unwrap();
        assert_eq!(c.projection, Projection::Spherical);
    }

    /// Canvas density preserves the maximum input angular density:
    /// the canvas never samples coarser than the densest input pixel.
    #[test]
    fn resolution_preserves_max_input_density() {
        let cams = ring(4, 55.0, false, 0.3);
        let c = auto_canvas(&cams, &CanvasOptions::default()).unwrap();
        // The densest input pixels live at the frame corners (pinhole
        // density f·sec²θ ≥ f); the canvas must be at least that dense.
        let f = cams[0].focal_px;
        assert!(
            c.pixels_per_radian() >= f,
            "canvas density {} < center density {f}",
            c.pixels_per_radian()
        );
        // And it shouldn't over-allocate beyond corner density + margin.
        let corner =
            (f * f + (cams[0].width as f64 * 0.5).powi(2) + (cams[0].height as f64 * 0.5).powi(2))
                / f;
        assert!(
            c.pixels_per_radian() <= corner * 1.05,
            "canvas density {} > corner density {corner}",
            c.pixels_per_radian()
        );
    }

    #[test]
    fn max_pixels_cap_shrinks_canvas_preserving_aspect() {
        let cams = ring(6, 60.0, true, 0.0);
        let unbounded = auto_canvas(&cams, &CanvasOptions::default()).unwrap();
        let capped = auto_canvas(
            &cams,
            &CanvasOptions {
                max_pixels: 10_000,
                ..CanvasOptions::default()
            },
        )
        .unwrap();
        assert!(capped.pixel_count() <= 10_000);
        let a0 = unbounded.width as f64 / unbounded.height as f64;
        let a1 = capped.width as f64 / capped.height as f64;
        assert!((a0 - a1).abs() / a0 < 0.05, "aspect drifted: {a0} vs {a1}");
    }

    /// A partial ring whose frames straddle the ±180° meridian must
    /// still get a contiguous (non-wrapped) window containing every
    /// frame direction.
    #[test]
    fn window_centers_on_content_across_antimeridian() {
        // Three cameras looking around 180°: yaws 160°, 180°, 200°.
        let mk = |yaw_deg: f64| {
            Camera::new(
                [0.0, yaw_deg.to_radians(), 0.0],
                focal_px_for_hfov(50.0, 192),
                0.0,
                0.0,
                192,
                144,
            )
        };
        let cams = vec![mk(160.0), mk(180.0), mk(-160.0)];
        let c = auto_canvas(&cams, &CanvasOptions::default()).unwrap();
        assert!(!c.is_full_wrap());
        // Every frame center must land strictly inside the canvas.
        for cam in &cams {
            let d = cam
                .pixel_to_world_dir(96.0, 72.0)
                .expect("center invertible");
            let (px, py) = c.dir_to_pixel(d).expect("representable");
            assert!(
                px > 0.0 && px < c.width as f64 && py > 0.0 && py < c.height as f64,
                "frame center off-canvas at ({px}, {py}) of {}x{}",
                c.width,
                c.height
            );
        }
    }

    #[test]
    fn empty_or_invalid_options_error() {
        assert!(matches!(
            auto_canvas(&[], &CanvasOptions::default()),
            Err(PanoError::InvalidOptions(_))
        ));
        let cams = ring(1, 40.0, false, 0.0);
        assert!(matches!(
            auto_canvas(
                &cams,
                &CanvasOptions {
                    max_pixels: 0,
                    ..CanvasOptions::default()
                }
            ),
            Err(PanoError::InvalidOptions(_))
        ));
        assert!(CanvasSpec::full_sphere(0).is_err());
    }

    /// Forcing rectilinear on a hemisphere-wide set must fail loudly,
    /// not produce a folded canvas.
    #[test]
    fn rectilinear_force_rejects_wide_sets() {
        let cams = ring(8, 60.0, true, 0.0);
        let r = auto_canvas(
            &cams,
            &CanvasOptions {
                projection: ProjectionMode::Force(Projection::Rectilinear),
                ..CanvasOptions::default()
            },
        );
        assert!(matches!(r, Err(PanoError::InvalidOptions(_))));
    }
}
