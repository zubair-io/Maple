//! CPU warper — trilinear (mipmap-selected bilinear) resampling.
//!
//! ## Algorithm notes
//! For **Rectilinear** output the mapping is: output pixel (u, v) →
//! normalised ray d = K⁻¹ · [u, v, 1]ᵀ → rotated ray d' = R⁻¹ · d →
//! projected into the input via K · d' / (K · d')_z.  This is the
//! standard (K·R)⁻¹ homography mapping.
//!
//! For **Cylindrical** the output coordinates (u, v) represent azimuth θ
//! and normalised elevation h.  The unprojection reconstructs a 3-D ray,
//! rotates it back by R⁻¹, and then projects it into the input image via
//! the camera model.
//!
//! For **Spherical** (equirectangular) the output coordinates are
//! longitude λ and latitude φ encoded as (u, v) = (λ/π · W/2, φ/π · H/2)
//! offset to [0, W) × [0, H).
//!
//! ## Antialiasing / mipmap selection
//! A full mipmap pyramid is pre-computed inside `warp()`.  For each output
//! pixel the footprint scale is estimated from the Jacobian of the mapping
//! function evaluated at that pixel (a single forward–backward finite
//! difference step).  The mipmap level is selected as
//! `floor(log2(max(|Jx|, |Jy|)))` and bilinear interpolation is applied
//! within that level.  For upscaling (scale < 1) the level is clamped to 0.

use nalgebra::Matrix3;

use crate::error::PanoError;
use crate::traits::Warper;
use crate::types::{Camera, PanoImage, Projection};

/// CPU implementation of [`Warper`] using bilinear sampling with automatic
/// mipmap level selection (see module-level docs for the algorithm).
#[derive(Debug, Clone, Default)]
pub struct CpuWarper;

impl CpuWarper {
    pub fn new() -> Self {
        Self
    }
}

// ---------------------------------------------------------------------------
// Helper: sample a PanoImage at fractional pixel coordinates (u, v) in
// [0, width) × [0, height).  Returns (r, g, b) or (0, 0, 0) with
// valid=false when out of range.
// ---------------------------------------------------------------------------

#[inline]
fn sample_bilinear(img: &PanoImage, u: f32, v: f32) -> Option<[f32; 3]> {
    let w = img.width as f32;
    let h = img.height as f32;
    if u < 0.0 || v < 0.0 || u >= w || v >= h {
        return None;
    }
    let x0 = u.floor() as u32;
    let y0 = v.floor() as u32;
    let x1 = (x0 + 1).min(img.width - 1);
    let y1 = (y0 + 1).min(img.height - 1);
    let fx = u - u.floor();
    let fy = v - v.floor();

    // Validity: all four neighbours must be valid for interpolation.
    if !img.is_valid(x0, y0)
        || !img.is_valid(x1, y0)
        || !img.is_valid(x0, y1)
        || !img.is_valid(x1, y1)
    {
        // Fall back to nearest-valid neighbour if exactly one corner is valid.
        // For robustness we just mark it invalid if any neighbour is invalid.
        return None;
    }

    let px = |x: u32, y: u32| -> [f32; 3] {
        let base = ((y as usize) * (img.width as usize) + (x as usize)) * 3;
        [img.pixels[base], img.pixels[base + 1], img.pixels[base + 2]]
    };

    let p00 = px(x0, y0);
    let p10 = px(x1, y0);
    let p01 = px(x0, y1);
    let p11 = px(x1, y1);

    let interp = |a00: f32, a10: f32, a01: f32, a11: f32| {
        a00 * (1.0 - fx) * (1.0 - fy)
            + a10 * fx * (1.0 - fy)
            + a01 * (1.0 - fx) * fy
            + a11 * fx * fy
    };
    Some([
        interp(p00[0], p10[0], p01[0], p11[0]),
        interp(p00[1], p10[1], p01[1], p11[1]),
        interp(p00[2], p10[2], p01[2], p11[2]),
    ])
}

// ---------------------------------------------------------------------------
// Mipmap construction — half-resolution Gaussian downsample.
// The simplest 2×2 box filter is used here; the pyramid helpers in
// `blend/pyramid.rs` use the fuller [1,4,6,4,1] kernel.  Box-filtered
// mip maps are sufficient for antialiasing in the warp stage.
// ---------------------------------------------------------------------------

fn build_mip(level: &PanoImage) -> PanoImage {
    let w = (level.width / 2).max(1);
    let h = (level.height / 2).max(1);
    let mut out = PanoImage::new(w, h, level.color);
    for y in 0..h {
        for x in 0..w {
            let sx = (x * 2).min(level.width - 1);
            let sy = (y * 2).min(level.height - 1);
            let sx1 = (sx + 1).min(level.width - 1);
            let sy1 = (sy + 1).min(level.height - 1);

            let valid = level.is_valid(sx, sy)
                && level.is_valid(sx1, sy)
                && level.is_valid(sx, sy1)
                && level.is_valid(sx1, sy1);
            if !valid {
                out.set_invalid(x, y);
                continue;
            }
            let px = |ix: u32, iy: u32| -> [f32; 3] {
                let base = ((iy as usize) * (level.width as usize) + (ix as usize)) * 3;
                [
                    level.pixels[base],
                    level.pixels[base + 1],
                    level.pixels[base + 2],
                ]
            };
            let p00 = px(sx, sy);
            let p10 = px(sx1, sy);
            let p01 = px(sx, sy1);
            let p11 = px(sx1, sy1);
            let base = ((y as usize) * (w as usize) + (x as usize)) * 3;
            out.pixels[base] = (p00[0] + p10[0] + p01[0] + p11[0]) * 0.25;
            out.pixels[base + 1] = (p00[1] + p10[1] + p01[1] + p11[1]) * 0.25;
            out.pixels[base + 2] = (p00[2] + p10[2] + p01[2] + p11[2]) * 0.25;
        }
    }
    out
}

fn build_mipmap(img: &PanoImage) -> Vec<PanoImage> {
    let max_levels = {
        let max_dim = img.width.max(img.height);
        // Number of halving steps until we reach 1×1.
        (32 - max_dim.leading_zeros()) as usize
    };
    let mut levels = Vec::with_capacity(max_levels + 1);
    levels.push(img.clone());
    while levels
        .last()
        .map(|l: &PanoImage| l.width > 1 || l.height > 1)
        .unwrap_or(false)
    {
        let next = build_mip(levels.last().unwrap());
        levels.push(next);
    }
    levels
}

/// Sample the mipmap at (u, v) choosing the appropriate level.
/// `scale` is `max(|Jx|, |Jy|)` — the number of input pixels per output pixel.
#[inline]
fn sample_mipmap(mip: &[PanoImage], u: f32, v: f32, scale: f32) -> Option<[f32; 3]> {
    if scale <= 1.0 {
        return sample_bilinear(&mip[0], u, v);
    }
    let level = (scale.log2().floor() as usize).min(mip.len() - 1);
    let lf = 1u32.checked_shl(level as u32).unwrap_or(1) as f32;
    sample_bilinear(&mip[level], u / lf, v / lf)
}

// ---------------------------------------------------------------------------
// Camera / projection helpers
// ---------------------------------------------------------------------------

/// Build K (intrinsic matrix) from focal length and image dimensions.
/// Principal point is assumed to be the image centre.
fn camera_k(focal: f32, width: u32, height: u32) -> Matrix3<f32> {
    let cx = width as f32 * 0.5;
    let cy = height as f32 * 0.5;
    Matrix3::new(focal, 0.0, cx, 0.0, focal, cy, 0.0, 0.0, 1.0)
}

/// Undistort a normalised image coordinate (x, y) using radial distortion
/// coefficients k1, k2.  The model is the standard Brown–Conrady model:
/// r² = x²+y²; x' = x(1 + k1·r² + k2·r⁴).
#[inline]
fn undistort(x: f32, y: f32, k1: f32, k2: f32) -> (f32, f32) {
    if k1 == 0.0 && k2 == 0.0 {
        return (x, y);
    }
    let r2 = x * x + y * y;
    let factor = 1.0 + k1 * r2 + k2 * r2 * r2;
    (x * factor, y * factor)
}

impl Warper for CpuWarper {
    fn warp(
        &self,
        img: &PanoImage,
        cam: &Camera,
        target: Projection,
    ) -> Result<PanoImage, PanoError> {
        let (iw, ih) = (img.width, img.height);
        let (ow, oh) = (iw, ih); // output same size as input (MVP — caller owns canvas layout)

        let k_in = camera_k(cam.focal, iw, ih);
        let _k_in_inv = k_in
            .try_inverse()
            .ok_or_else(|| PanoError::Warp("singular camera K".into()))?;
        let r_inv = cam.rotation.transpose(); // R⁻¹ = Rᵀ for rotation matrices

        let mip = build_mipmap(img);
        let mut out = PanoImage::new(ow, oh, img.color);

        // Mark all output pixels invalid initially; they become valid only if
        // the back-projection lands inside the input image.
        for i in 0..((ow * oh) as usize) {
            out.validity.set(i, false);
        }

        let ow_f = ow as f32;
        let oh_f = oh as f32;
        let iw_f = iw as f32;
        let ih_f = ih as f32;

        for oy in 0..oh {
            for ox in 0..ow {
                // 1. Map output pixel to a 3-D ray depending on target projection.
                let ray: [f32; 3] = match target {
                    Projection::Rectilinear => {
                        // Output is flat plane.  (K_out = K_in for same-size)
                        let k_out = camera_k(cam.focal, ow, oh);
                        let k_out_inv = k_out.try_inverse().unwrap_or_else(Matrix3::identity);
                        let uv = nalgebra::Vector3::new(ox as f32, oy as f32, 1.0);
                        let ray_cam = k_out_inv * uv;
                        [ray_cam.x, ray_cam.y, ray_cam.z]
                    }
                    Projection::Cylindrical => {
                        // θ in [−π, π), h = normalised elevation.
                        let theta = (ox as f32 / ow_f - 0.5) * 2.0 * std::f32::consts::PI;
                        let h = oy as f32 / oh_f - 0.5; // ~[-0.5, 0.5]
                                                        // Ray on unit cylinder: x = sin(θ), y = h, z = cos(θ).
                        [theta.sin(), h, theta.cos()]
                    }
                    Projection::Spherical => {
                        // Equirectangular: u∈[0,W)→λ, v∈[0,H)→φ.
                        let lambda = (ox as f32 / ow_f - 0.5) * 2.0 * std::f32::consts::PI;
                        let phi = (oy as f32 / oh_f - 0.5) * std::f32::consts::PI;
                        // Cartesian on unit sphere.
                        [
                            phi.cos() * lambda.sin(),
                            phi.sin(),
                            phi.cos() * lambda.cos(),
                        ]
                    }
                };

                // 2. Apply R⁻¹ to rotate the ray back into the input camera frame.
                let ray_v = nalgebra::Vector3::new(ray[0], ray[1], ray[2]);
                let cam_ray = r_inv * ray_v;

                if cam_ray.z <= 0.0 {
                    // Behind the camera — stays invalid.
                    continue;
                }

                // 3. Project into the input image via K and distortion.
                let xn = cam_ray.x / cam_ray.z;
                let yn = cam_ray.y / cam_ray.z;
                let (xd, yd) = undistort(xn, yn, cam.distortion.k1, cam.distortion.k2);

                let p = k_in * nalgebra::Vector3::new(xd, yd, 1.0);
                let u = p.x;
                let v = p.y;

                // 4. Estimate footprint size via a finite-difference step in x.
                let step = 1.0_f32;
                let ox2 = (ox as f32 + step).min(ow_f - 1.0);
                let (u2, v2) = {
                    let ray2 = match target {
                        Projection::Rectilinear => {
                            let k_out = camera_k(cam.focal, ow, oh);
                            let k_out_inv = k_out.try_inverse().unwrap_or_else(Matrix3::identity);
                            let uv2 = nalgebra::Vector3::new(ox2, oy as f32, 1.0);
                            let r2 = k_out_inv * uv2;
                            [r2.x, r2.y, r2.z]
                        }
                        Projection::Cylindrical => {
                            let theta = (ox2 / ow_f - 0.5) * 2.0 * std::f32::consts::PI;
                            let h = oy as f32 / oh_f - 0.5;
                            [theta.sin(), h, theta.cos()]
                        }
                        Projection::Spherical => {
                            let lambda = (ox2 / ow_f - 0.5) * 2.0 * std::f32::consts::PI;
                            let phi = (oy as f32 / oh_f - 0.5) * std::f32::consts::PI;
                            [
                                phi.cos() * lambda.sin(),
                                phi.sin(),
                                phi.cos() * lambda.cos(),
                            ]
                        }
                    };
                    let rv2 = nalgebra::Vector3::new(ray2[0], ray2[1], ray2[2]);
                    let cr2 = r_inv * rv2;
                    if cr2.z <= 0.0 {
                        (u, v) // degenerate: no scale estimate
                    } else {
                        let xn2 = cr2.x / cr2.z;
                        let yn2 = cr2.y / cr2.z;
                        let (xd2, yd2) = undistort(xn2, yn2, cam.distortion.k1, cam.distortion.k2);
                        let p2 = k_in * nalgebra::Vector3::new(xd2, yd2, 1.0);
                        (p2.x, p2.y)
                    }
                };
                let scale = ((u2 - u).hypot(v2 - v) / step).max(1.0);

                // 5. Sample the mipmap.
                if let Some(rgb) = sample_mipmap(&mip, u, v, scale) {
                    let base = ((oy as usize) * (ow as usize) + (ox as usize)) * 3;
                    out.pixels[base] = rgb[0];
                    out.pixels[base + 1] = rgb[1];
                    out.pixels[base + 2] = rgb[2];
                    out.validity
                        .set((oy as usize) * (ow as usize) + (ox as usize), true);
                }

                let _ = iw_f;
                let _ = ih_f;
            }
        }

        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;
    use crate::types::{Distortion, PanoImage};

    fn identity_camera(focal: f32, w: u32, h: u32) -> Camera {
        Camera {
            focal,
            rotation: Matrix3::identity(),
            translation: nalgebra::Vector3::zeros(),
            distortion: Distortion { k1: 0.0, k2: 0.0 },
        }
    }

    #[test]
    fn sample_bilinear_exact_pixel() {
        let mut img = PanoImage::new(4, 4, ColorSpace::rec2020_d65_linear());
        // Set pixel (1,2) to [1, 0.5, 0.25]
        let base = (2 * 4 + 1) * 3;
        img.pixels[base] = 1.0;
        img.pixels[base + 1] = 0.5;
        img.pixels[base + 2] = 0.25;
        let rgb = sample_bilinear(&img, 1.0, 2.0).unwrap();
        // At exactly an integer coordinate the bilinear sample is the pixel itself.
        assert!((rgb[0] - 1.0).abs() < 1e-5);
        assert!((rgb[1] - 0.5).abs() < 1e-5);
        assert!((rgb[2] - 0.25).abs() < 1e-5);
    }

    #[test]
    fn sample_bilinear_out_of_range_returns_none() {
        let img = PanoImage::new(4, 4, ColorSpace::rec2020_d65_linear());
        assert!(sample_bilinear(&img, -1.0, 0.0).is_none());
        assert!(sample_bilinear(&img, 4.0, 0.0).is_none());
        assert!(sample_bilinear(&img, 0.0, 4.0).is_none());
    }

    #[test]
    fn cpu_warper_rectilinear_identity_is_noop() {
        // An identity camera + Rectilinear warp should reproduce the input pixels
        // in the central region (the corners may fall outside for focal < w/2).
        let w = 16u32;
        let h = 16u32;
        let focal = w as f32; // 16px focal → central pixels stay in-frame
        let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
        // Fill with a simple gradient.
        for y in 0..h {
            for x in 0..w {
                let base = ((y as usize) * (w as usize) + (x as usize)) * 3;
                img.pixels[base] = x as f32 / w as f32;
                img.pixels[base + 1] = y as f32 / h as f32;
                img.pixels[base + 2] = 0.5;
            }
        }
        let cam = identity_camera(focal, w, h);
        let warper = CpuWarper::new();
        let out = warper.warp(&img, &cam, Projection::Rectilinear).unwrap();

        // Central pixels should be close to the original.
        let margin = 4u32;
        let mut max_err = 0.0_f32;
        for y in margin..(h - margin) {
            for x in margin..(w - margin) {
                if !out.is_valid(x, y) {
                    continue;
                }
                let base = ((y as usize) * (w as usize) + (x as usize)) * 3;
                let err = (out.pixels[base] - x as f32 / w as f32).abs();
                max_err = max_err.max(err);
            }
        }
        assert!(
            max_err < 0.1,
            "central pixel error {max_err} exceeded threshold"
        );
    }
}
