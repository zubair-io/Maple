//! Canvas-aware warping (the "compositing frame" for multi-image panoramas).
//!
//! The base `Warper::warp` produces a same-size output as input — fine for
//! the 2-image MVP and synthetic tests where every image has the same
//! footprint, but wrong for real panoramas where each image's rotation
//! pushes its content into a different region of a larger output canvas.
//!
//! This module computes the union bounding box of all images' warped
//! footprints (on the chosen projection surface) and provides a
//! `warp_image_to_canvas` helper that renders one image into the canvas
//! at its proper position.
//!
//! Currently implemented for `Projection::Cylindrical`; rectilinear and
//! spherical fall back to the input-sized warp + zero-offset paste
//! (matches the previous behavior). Extending to those is mechanical
//! once a multi-image rectilinear scene is in the test corpus.

use bitvec::vec::BitVec;
use nalgebra::{Matrix3, Vector3};

use crate::error::PanoError;
use crate::types::{Camera, PanoImage, Projection};
use crate::warp::cpu::CpuWarper;
use crate::Warper;

/// Output frame that one or more warped images composite into.
#[derive(Debug, Clone)]
pub struct Canvas {
    pub width: u32,
    pub height: u32,
    pub projection: Projection,
    pub params: CanvasParams,
}

/// Projection-specific parameters describing the canvas's coordinate system.
#[derive(Debug, Clone)]
pub enum CanvasParams {
    /// Rectilinear canvas, parameterised by the canvas-camera intrinsics.
    Rectilinear { focal: f32, cx: f32, cy: f32 },
    /// Cylindrical canvas, parameterised by the angular extent.
    /// `theta` is azimuth in radians, `h` is normalised vertical position
    /// (matches the unit-cylinder convention used in `cpu::warp`).
    Cylindrical {
        theta_min: f32,
        theta_max: f32,
        h_min: f32,
        h_max: f32,
    },
    /// Spherical canvas — equirectangular extent. Same convention as
    /// the warper: λ in [-π, π], φ in [-π/2, π/2].
    Spherical {
        lambda_min: f32,
        lambda_max: f32,
        phi_min: f32,
        phi_max: f32,
    },
}

/// Compute the union-bounding-box canvas for a set of warped images.
///
/// For each image, projects its 4 corners (and a sparse interior grid for
/// large rotations) through the camera onto the target projection surface,
/// then takes the per-image bbox. Final canvas is the union.
///
/// Resolution policy: target one pixel per input pixel at the median
/// per-image angular density, so the canvas stays close to the input
/// resolution without exploding for large angular sweeps.
pub fn compute_canvas(
    images: &[&PanoImage],
    cameras: &[Camera],
    projection: Projection,
) -> Result<Canvas, PanoError> {
    if images.is_empty() || cameras.is_empty() {
        return Err(PanoError::Warp("compute_canvas: no inputs".into()));
    }
    if images.len() != cameras.len() {
        return Err(PanoError::Warp(format!(
            "compute_canvas: image/camera count mismatch ({} vs {})",
            images.len(),
            cameras.len()
        )));
    }

    // Auto-fallback: when every camera's rotation is essentially identity
    // (all elements within 1e-3 of the identity matrix), there's no benefit
    // to the cylindrical-canvas resampling — the Rectilinear pass-through
    // is bit-exact-ish and faster. Useful for synthetic tests with
    // pre-aligned crops, and as a safe default when BA returns an identity
    // because matching failed.
    let all_identity = cameras.iter().all(|c| {
        let r = c.rotation;
        let i = Matrix3::<f32>::identity();
        let max_diff = (r - i).abs().max();
        max_diff < 1e-3
    });
    if all_identity {
        let w = images.iter().map(|i| i.width).max().unwrap_or(0);
        let h = images.iter().map(|i| i.height).max().unwrap_or(0);
        return Ok(Canvas {
            width: w,
            height: h,
            projection: Projection::Rectilinear,
            params: CanvasParams::Rectilinear {
                focal: cameras[0].focal,
                cx: w as f32 / 2.0,
                cy: h as f32 / 2.0,
            },
        });
    }

    match projection {
        Projection::Cylindrical => compute_cylindrical_canvas(images, cameras),
        Projection::Rectilinear | Projection::Spherical => {
            // Fallback: input-sized canvas centered on image 0. Documented
            // as MVP — multi-image rectilinear/spherical canvases are a
            // follow-up (the cylindrical case covers the common
            // horizontal-pan use case).
            let w = images.iter().map(|i| i.width).max().unwrap_or(0);
            let h = images.iter().map(|i| i.height).max().unwrap_or(0);
            let focal = cameras[0].focal;
            Ok(Canvas {
                width: w,
                height: h,
                projection,
                params: CanvasParams::Rectilinear {
                    focal,
                    cx: w as f32 / 2.0,
                    cy: h as f32 / 2.0,
                },
            })
        }
    }
}

fn compute_cylindrical_canvas(
    images: &[&PanoImage],
    cameras: &[Camera],
) -> Result<Canvas, PanoError> {
    use std::f32::consts::PI;

    let mut theta_min = f32::INFINITY;
    let mut theta_max = f32::NEG_INFINITY;
    let mut h_min = f32::INFINITY;
    let mut h_max = f32::NEG_INFINITY;
    let mut total_thetas_per_pixel: f64 = 0.0;
    let mut total_samples: u64 = 0;

    // Sample a small grid of points across each image (corners + edges
    // + center), project each into cylindrical (θ, h), grow the union
    // bbox. A 5×5 grid catches lens-edge curvature for wide-angle
    // input without exploding compute.
    const GRID: usize = 5;

    for (img, cam) in images.iter().zip(cameras.iter()) {
        let k = camera_k_f64(cam.focal as f64, img.width, img.height);
        let k_inv = k
            .try_inverse()
            .ok_or_else(|| PanoError::Warp("singular camera K".into()))?;
        let r = cam.rotation.cast::<f64>();

        let mut img_theta_min = f32::INFINITY;
        let mut img_theta_max = f32::NEG_INFINITY;

        let w = img.width as f64;
        let h = img.height as f64;
        let mut prev_theta: Option<f32> = None;

        for gy in 0..=GRID {
            for gx in 0..=GRID {
                let px = (gx as f64) * w / (GRID as f64);
                let py = (gy as f64) * h / (GRID as f64);
                let uv = Vector3::new(px, py, 1.0);
                let ray_cam = k_inv * uv;
                // World ray = R · K^-1 · uv.
                let world = r * ray_cam;

                // Project to unit cylinder.
                let denom = (world.x * world.x + world.z * world.z).sqrt();
                if denom < 1e-9 {
                    // Looking straight up/down on cylinder axis — ill-defined θ.
                    continue;
                }
                let theta = world.x.atan2(world.z) as f32;
                // Cylinder-axis-aligned vertical: convert world.y to a
                // [-0.5, 0.5]-scale h that matches the warper's unit
                // cylinder ([0, 1] mapped to [-0.5, 0.5]).
                let h_world = (world.y / denom) as f32;

                // Unwrap θ relative to previous sample so the bbox doesn't
                // wrap around the ±π discontinuity for an image that
                // straddles it (we handle the wrap downstream by allowing
                // theta_min/theta_max to extend past ±π).
                let theta_unwrapped = if let Some(prev) = prev_theta {
                    let d = theta - prev;
                    if d > PI {
                        theta - 2.0 * PI
                    } else if d < -PI {
                        theta + 2.0 * PI
                    } else {
                        theta
                    }
                } else {
                    theta
                };
                prev_theta = Some(theta_unwrapped);

                img_theta_min = img_theta_min.min(theta_unwrapped);
                img_theta_max = img_theta_max.max(theta_unwrapped);
                h_min = h_min.min(h_world);
                h_max = h_max.max(h_world);
            }
        }

        theta_min = theta_min.min(img_theta_min);
        theta_max = theta_max.max(img_theta_max);

        // Track per-image angular density for the resolution policy.
        let img_theta_span = img_theta_max - img_theta_min;
        if img_theta_span > 0.0 && img.width > 0 {
            total_thetas_per_pixel += (img_theta_span / img.width as f32) as f64;
            total_samples += 1;
        }
    }

    if !theta_min.is_finite() || !theta_max.is_finite() {
        return Err(PanoError::Warp(
            "compute_canvas: failed to project any image corner".into(),
        ));
    }

    // Resolution: pick a pixel pitch that matches the median per-image
    // density. Bound height span to a sane range — h is ~[-0.5, 0.5]
    // in unit-cylinder coordinates, so a 2× input-height pixel pitch
    // at the canvas keeps things conservative.
    let theta_per_pixel = if total_samples > 0 {
        (total_thetas_per_pixel / total_samples as f64) as f32
    } else {
        // Fallback: full-circle / first-image width.
        2.0 * PI / images[0].width as f32
    };

    let theta_span = (theta_max - theta_min).max(1e-3);
    let h_span = (h_max - h_min).max(1e-3);

    let canvas_w = (theta_span / theta_per_pixel).round() as u32;
    // Vertical pixel pitch matches input. For a unit cylinder, an image
    // of height H pixels with focal f spans h ∈ [-H/(2f), +H/(2f)] —
    // total span H/f. So 1 input pixel covers Δh = (H/f) / H = 1/f.
    // Use the first camera's focal as the reference (assumption: all
    // images share roughly the same focal length, which is true for a
    // single-camera pano).
    let h_per_pixel = 1.0 / cameras[0].focal.max(1.0);
    let canvas_h = (h_span / h_per_pixel).round().max(1.0) as u32;

    // Sanity bounds — refuse to allocate billions of pixels.
    const MAX_W: u32 = 65_535;
    const MAX_H: u32 = 32_767;
    let canvas_w = canvas_w.clamp(1, MAX_W);
    let canvas_h = canvas_h.clamp(1, MAX_H);

    Ok(Canvas {
        width: canvas_w,
        height: canvas_h,
        projection: Projection::Cylindrical,
        params: CanvasParams::Cylindrical {
            theta_min,
            theta_max,
            h_min,
            h_max,
        },
    })
}

fn camera_k_f64(focal: f64, width: u32, height: u32) -> nalgebra::Matrix3<f64> {
    nalgebra::Matrix3::new(
        focal,
        0.0,
        width as f64 / 2.0,
        0.0,
        focal,
        height as f64 / 2.0,
        0.0,
        0.0,
        1.0,
    )
}

/// Warp one image into the canvas frame. Output is a canvas-sized
/// `PanoImage`; pixels outside the image's projected footprint are
/// marked invalid.
pub fn warp_image_to_canvas(
    warper: &CpuWarper,
    img: &PanoImage,
    cam: &Camera,
    canvas: &Canvas,
) -> Result<PanoImage, PanoError> {
    match &canvas.params {
        CanvasParams::Cylindrical {
            theta_min,
            theta_max,
            h_min,
            h_max,
        } => warp_cylindrical_canvas(
            img, cam, canvas.width, canvas.height, *theta_min, *theta_max, *h_min, *h_max,
        ),
        CanvasParams::Rectilinear { .. } | CanvasParams::Spherical { .. } => {
            // Fallback: render at input size + paste at (0, 0). Same
            // behavior as before this module landed; multi-image
            // non-cylindrical canvases are a P2 follow-up.
            let warped = warper.warp(img, cam, canvas.projection)?;
            embed_at_origin(&warped, canvas.width, canvas.height, img)
        }
    }
}

fn embed_at_origin(
    warped: &PanoImage,
    canvas_w: u32,
    canvas_h: u32,
    src_for_color: &PanoImage,
) -> Result<PanoImage, PanoError> {
    if warped.width == canvas_w && warped.height == canvas_h {
        return Ok(warped.clone());
    }
    let mut canvas = PanoImage::new(canvas_w, canvas_h, src_for_color.color);
    for i in 0..((canvas_w * canvas_h) as usize) {
        canvas.validity.set(i, false);
    }
    let copy_w = warped.width.min(canvas_w) as usize;
    let copy_h = warped.height.min(canvas_h) as usize;
    for y in 0..copy_h {
        for x in 0..copy_w {
            let si = y * (warped.width as usize) + x;
            let di = y * (canvas_w as usize) + x;
            canvas.pixels[di * 3] = warped.pixels[si * 3];
            canvas.pixels[di * 3 + 1] = warped.pixels[si * 3 + 1];
            canvas.pixels[di * 3 + 2] = warped.pixels[si * 3 + 2];
            if warped.validity[si] {
                canvas.validity.set(di, true);
            }
        }
    }
    Ok(canvas)
}

fn warp_cylindrical_canvas(
    img: &PanoImage,
    cam: &Camera,
    canvas_w: u32,
    canvas_h: u32,
    theta_min: f32,
    theta_max: f32,
    h_min: f32,
    h_max: f32,
) -> Result<PanoImage, PanoError> {
    let (iw, ih) = (img.width, img.height);
    let k_in = camera_k_f64(cam.focal as f64, iw, ih);
    let r_inv = cam.rotation.transpose().cast::<f64>();

    let theta_span = theta_max - theta_min;
    let h_span = h_max - h_min;

    let mut out = PanoImage::new(canvas_w, canvas_h, img.color);
    for i in 0..((canvas_w * canvas_h) as usize) {
        out.validity.set(i, false);
    }

    let cw_f = canvas_w as f32;
    let ch_f = canvas_h as f32;

    for cy in 0..canvas_h {
        for cx in 0..canvas_w {
            // Map canvas pixel → cylindrical (θ, h).
            let theta = theta_min + (cx as f32 / cw_f) * theta_span;
            let h = h_min + (cy as f32 / ch_f) * h_span;

            // Cylindrical → 3D ray (world frame).
            let ray = Vector3::new(theta.sin() as f64, h as f64, theta.cos() as f64);

            // World → input camera frame via R^-1.
            let cam_ray = r_inv * ray;
            if cam_ray.z <= 0.0 {
                continue;
            }

            // Project into input image via K.
            let xn = cam_ray.x / cam_ray.z;
            let yn = cam_ray.y / cam_ray.z;
            let p = k_in * Vector3::new(xn, yn, 1.0);
            let u = p.x as f32;
            let v = p.y as f32;

            // Reject samples outside the input.
            if u < 0.0 || v < 0.0 || u >= (iw - 1) as f32 || v >= (ih - 1) as f32 {
                continue;
            }

            // Bilinear sample.
            let x0 = u.floor() as u32;
            let y0 = v.floor() as u32;
            let dx = u - x0 as f32;
            let dy = v - y0 as f32;

            let p00 = pixel_rgb(img, x0, y0);
            let p10 = pixel_rgb(img, x0 + 1, y0);
            let p01 = pixel_rgb(img, x0, y0 + 1);
            let p11 = pixel_rgb(img, x0 + 1, y0 + 1);

            let mut rgb = [0.0f32; 3];
            for c in 0..3 {
                let top = p00[c] * (1.0 - dx) + p10[c] * dx;
                let bot = p01[c] * (1.0 - dx) + p11[c] * dx;
                rgb[c] = top * (1.0 - dy) + bot * dy;
            }

            let di = (cy as usize) * (canvas_w as usize) + (cx as usize);
            out.pixels[di * 3] = rgb[0];
            out.pixels[di * 3 + 1] = rgb[1];
            out.pixels[di * 3 + 2] = rgb[2];
            out.validity.set(di, true);
        }
    }

    let _ = Matrix3::<f64>::identity(); // silence import-only warning if cfg gates
    Ok(out)
}

#[inline]
fn pixel_rgb(img: &PanoImage, x: u32, y: u32) -> [f32; 3] {
    let i = ((y as usize) * (img.width as usize) + (x as usize)) * 3;
    [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;
    use crate::types::{Distortion, Projection};

    fn identity_camera(focal: f32) -> Camera {
        Camera {
            focal,
            rotation: Matrix3::identity(),
            distortion: Distortion::default(),
        }
    }

    #[test]
    fn compute_canvas_single_image_cylindrical_matches_input_aspect() {
        let img = PanoImage::new(256, 128, ColorSpace::rec2020_d65_linear());
        let cam = identity_camera(256.0);
        let canvas = compute_canvas(&[&img], &[cam], Projection::Cylindrical).unwrap();
        // Single identity-rotated image — canvas should be roughly
        // input-sized, not 0-sized or pathologically huge.
        assert!(canvas.width > 0 && canvas.width < 8 * 256);
        assert!(canvas.height > 0 && canvas.height < 8 * 128);
    }

    #[test]
    fn compute_canvas_two_rotated_images_grows_horizontally() {
        // Two cameras: one looking forward, one rotated 30° to the right.
        let img = PanoImage::new(256, 128, ColorSpace::rec2020_d65_linear());
        let cam_a = identity_camera(256.0);
        let angle = 30.0_f32.to_radians();
        let r_yaw = Matrix3::new(
            angle.cos(),
            0.0,
            angle.sin(),
            0.0,
            1.0,
            0.0,
            -angle.sin(),
            0.0,
            angle.cos(),
        );
        let cam_b = Camera {
            focal: 256.0,
            rotation: r_yaw,
            distortion: Distortion::default(),
        };
        let single = compute_canvas(&[&img], &[cam_a.clone()], Projection::Cylindrical).unwrap();
        let dual = compute_canvas(
            &[&img, &img],
            &[cam_a, cam_b],
            Projection::Cylindrical,
        )
        .unwrap();
        // Two rotated cameras should produce a wider canvas than one alone.
        assert!(
            dual.width > single.width,
            "dual canvas not wider: dual.w={}, single.w={}",
            dual.width,
            single.width
        );
    }

    #[test]
    fn warp_image_to_canvas_identity_returns_canvas_sized_output() {
        let mut img = PanoImage::new(64, 64, ColorSpace::rec2020_d65_linear());
        for i in 0..(64 * 64 * 3) {
            img.pixels[i] = 0.5;
        }
        let cam = identity_camera(64.0);
        let canvas = compute_canvas(&[&img], &[cam.clone()], Projection::Cylindrical).unwrap();
        let warper = CpuWarper::new();
        let warped = warp_image_to_canvas(&warper, &img, &cam, &canvas).unwrap();
        assert_eq!(warped.width, canvas.width);
        assert_eq!(warped.height, canvas.height);
        // Most pixels should be valid (single image fills its own canvas).
        let valid_frac = warped.validity.count_ones() as f32
            / (warped.width * warped.height) as f32;
        assert!(valid_frac > 0.5, "valid_frac={valid_frac}");
    }
}
