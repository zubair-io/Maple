//! Camera sampling, angular-extent measurement, and automatic
//! canvas construction. Split from `canvas.rs` for the file budget.

use std::f64::consts::{FRAC_PI_2, PI, TAU};

use super::{select_projection, CameraSamples, CanvasOptions, CanvasSpec, ProjectionMode};
use crate::camera::Camera;
use crate::error::PanoError;
use crate::math::{Mat3, Vec3};
use crate::project::Projection;

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
