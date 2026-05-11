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
//! Implemented for cylindrical and spherical output. Rectilinear still uses
//! the input-sized warp + zero-offset paste path until a multi-image
//! rectilinear scene is in the test corpus.

use nalgebra::{Matrix3, Vector3};
use rayon::prelude::*;

use crate::error::PanoError;
use crate::types::{Camera, PanoImage, Projection};
use crate::warp::cpu::CpuWarper;
use crate::warp::distortion::{forward_distort_xy, inverse_distort_xy};
use crate::warp::local_mesh::LocalWarpField;
use crate::Warper;

/// Minimum forward-z component of a world-direction vector for the
/// planar-at-unit-depth back-projection (`world_pt = world_dir /
/// world_dir.z`) to be numerically stable.
///
/// At extreme phi (canvas near the spherical poles) `world_dir.z =
/// cos(phi)·cos(lambda)` can be tiny but still > 1e-9; the division
/// then produces a million-pixel `world_pt` that, after rotation by
/// the camera's `R^T`, can sample the input image's opposite side
/// via numerical drift in the projection — the "upside-down content
/// at canvas edges" artefact.
///
/// 0.10 corresponds to phi limits of roughly ±84°, well past any
/// real panorama's pitch coverage. Pixels above this rejection
/// threshold are silently invalidated by the warp; the auto-trim
/// pass downstream removes them from the canvas.
const MIN_WORLD_DIR_Z: f64 = 0.10;

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

    // Auto-fallback only for the true rectilinear no-op. Older code fell back
    // whenever rotations were identity, which accidentally disabled requested
    // spherical/cylindrical output and ignored non-zero translation/distortion.
    let all_rectilinear_noop = projection == Projection::Rectilinear
        && cameras.iter().all(|c| {
            let r = c.rotation;
            let i = Matrix3::<f32>::identity();
            let max_diff = (r - i).abs().max();
            max_diff < 1e-3 && c.translation.norm() < 1e-6 && c.distortion.is_zero()
        });
    if all_rectilinear_noop {
        let w = images.iter().map(|i| i.width).max().unwrap_or(0);
        let h = images.iter().map(|i| i.height).max().unwrap_or(0);
        let (cx, cy) = cameras[0].principal_point_or_center(w, h);
        return Ok(Canvas {
            width: w,
            height: h,
            projection: Projection::Rectilinear,
            params: CanvasParams::Rectilinear {
                focal: cameras[0].focal,
                cx,
                cy,
            },
        });
    }

    match projection {
        Projection::Cylindrical => compute_cylindrical_canvas(images, cameras),
        Projection::Spherical => compute_spherical_canvas(images, cameras),
        Projection::Rectilinear => {
            // Fallback: input-sized canvas centered on image 0. Documented
            // as MVP — multi-image rectilinear canvases are a follow-up
            // (the cylindrical and spherical cases cover the common
            // horizontal-pan and multi-row panorama use cases).
            let w = images.iter().map(|i| i.width).max().unwrap_or(0);
            let h = images.iter().map(|i| i.height).max().unwrap_or(0);
            let focal = cameras[0].focal;
            let (cx, cy) = cameras[0].principal_point_or_center(w, h);
            Ok(Canvas {
                width: w,
                height: h,
                projection,
                params: CanvasParams::Rectilinear { focal, cx, cy },
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
        let r = cam.rotation.cast::<f64>();
        let t = cam.translation.cast::<f64>();

        let mut img_theta_min = f32::INFINITY;
        let mut img_theta_max = f32::NEG_INFINITY;

        let w = img.width as f64;
        let h = img.height as f64;
        let mut prev_theta: Option<f32> = None;

        for gy in 0..=GRID {
            for gx in 0..=GRID {
                let px = (gx as f64) * w / (GRID as f64);
                let py = (gy as f64) * h / (GRID as f64);
                let ray_cam = ideal_ray_from_sensor_pixel(cam, img.width, img.height, px, py);
                // World point = R · K^-1 · uv + t (forward direction of
                // BA's planar-at-unit-depth model: the cam-space ray at
                // depth z=1, rotated into world frame, offset by camera
                // translation). For zero translation this reduces to
                // the legacy R·ray formula.
                let world = r * ray_cam + t;

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

fn compute_spherical_canvas(
    images: &[&PanoImage],
    cameras: &[Camera],
) -> Result<Canvas, PanoError> {
    use std::f32::consts::PI;

    let mut lambda_min = f32::INFINITY;
    let mut lambda_max = f32::NEG_INFINITY;
    let mut phi_min = f32::INFINITY;
    let mut phi_max = f32::NEG_INFINITY;
    let mut total_lambdas_per_pixel: f64 = 0.0;
    let mut total_samples: u64 = 0;

    // Sample a 5×5 grid of points across each image (corners + edges
    // + center), project each into spherical (λ, φ), grow the union bbox.
    const GRID: usize = 5;

    for (img, cam) in images.iter().zip(cameras.iter()) {
        let r = cam.rotation.cast::<f64>();
        let t = cam.translation.cast::<f64>();

        let mut img_lambda_min = f32::INFINITY;
        let mut img_lambda_max = f32::NEG_INFINITY;

        let w = img.width as f64;
        let h = img.height as f64;
        let mut prev_lambda: Option<f32> = None;

        for gy in 0..=GRID {
            for gx in 0..=GRID {
                let px = (gx as f64) * w / (GRID as f64);
                let py = (gy as f64) * h / (GRID as f64);
                let ray_cam = ideal_ray_from_sensor_pixel(cam, img.width, img.height, px, py);
                // World point = R · K^-1 · uv + t (planar-at-unit-depth
                // forward, matching the warp). For zero translation this
                // reduces to R · ray.
                let world = r * ray_cam + t;

                // Project to unit sphere: λ = atan2(x, z), φ = asin(y / |world|).
                let norm = world.norm();
                if norm < 1e-9 {
                    continue;
                }
                let lambda = world.x.atan2(world.z) as f32;
                let phi = (world.y / norm).clamp(-1.0, 1.0).asin() as f32;

                // Unwrap λ relative to previous sample so the bbox doesn't
                // wrap around the ±π discontinuity for an image that
                // straddles it.
                let lambda_unwrapped = if let Some(prev) = prev_lambda {
                    let d = lambda - prev;
                    if d > PI {
                        lambda - 2.0 * PI
                    } else if d < -PI {
                        lambda + 2.0 * PI
                    } else {
                        lambda
                    }
                } else {
                    lambda
                };
                prev_lambda = Some(lambda_unwrapped);

                img_lambda_min = img_lambda_min.min(lambda_unwrapped);
                img_lambda_max = img_lambda_max.max(lambda_unwrapped);
                phi_min = phi_min.min(phi);
                phi_max = phi_max.max(phi);
            }
        }

        lambda_min = lambda_min.min(img_lambda_min);
        lambda_max = lambda_max.max(img_lambda_max);

        // Track per-image angular density for the resolution policy.
        let img_lambda_span = img_lambda_max - img_lambda_min;
        if img_lambda_span > 0.0 && img.width > 0 {
            total_lambdas_per_pixel += (img_lambda_span / img.width as f32) as f64;
            total_samples += 1;
        }
    }

    if !lambda_min.is_finite() || !lambda_max.is_finite() {
        return Err(PanoError::Warp(
            "compute_canvas: failed to project any image corner (spherical)".into(),
        ));
    }

    // Resolution: pick a pixel pitch matching the median per-image density.
    let lambda_per_pixel = if total_samples > 0 {
        (total_lambdas_per_pixel / total_samples as f64) as f32
    } else {
        2.0 * PI / images[0].width as f32
    };

    let lambda_span = (lambda_max - lambda_min).max(1e-3);
    let phi_span = (phi_max - phi_min).max(1e-3);

    let canvas_w = (lambda_span / lambda_per_pixel).round() as u32;
    // Vertical pixel pitch: 1 pixel covers 1/focal radians vertically —
    // same logic as the cylindrical h_per_pixel (h = y/focal on the unit
    // cylinder; for sphere the elevation φ ≈ y/focal for small angles,
    // and we use the same approximation for consistency).
    let phi_per_pixel = 1.0 / cameras[0].focal.max(1.0);
    let canvas_h = (phi_span / phi_per_pixel).round().max(1.0) as u32;

    const MAX_W: u32 = 65_535;
    const MAX_H: u32 = 32_767;
    let canvas_w = canvas_w.clamp(1, MAX_W);
    let canvas_h = canvas_h.clamp(1, MAX_H);

    Ok(Canvas {
        width: canvas_w,
        height: canvas_h,
        projection: Projection::Spherical,
        params: CanvasParams::Spherical {
            lambda_min,
            lambda_max,
            phi_min,
            phi_max,
        },
    })
}

fn camera_k_f64(focal: f64, cx: f64, cy: f64) -> nalgebra::Matrix3<f64> {
    nalgebra::Matrix3::new(focal, 0.0, cx, 0.0, focal, cy, 0.0, 0.0, 1.0)
}

fn camera_k_for_image(cam: &Camera, width: u32, height: u32) -> nalgebra::Matrix3<f64> {
    let (cx, cy) = cam.principal_point_or_center(width, height);
    camera_k_f64(cam.focal as f64, cx as f64, cy as f64)
}

fn ideal_ray_from_sensor_pixel(
    cam: &Camera,
    width: u32,
    height: u32,
    px: f64,
    py: f64,
) -> Vector3<f64> {
    let (cx, cy) = cam.principal_point_or_center(width, height);
    let xn_d = (px - cx as f64) / cam.focal as f64;
    let yn_d = (py - cy as f64) / cam.focal as f64;
    let (xn, yn) = inverse_distort_xy(xn_d, yn_d, cam.distortion.k1, cam.distortion.k2);
    Vector3::new(xn, yn, 1.0)
}

/// Warp one image into the canvas frame. Output is a canvas-sized
/// `PanoImage`; pixels outside the image's projected footprint are
/// marked invalid.
///
/// If `mesh` is `Some`, every canvas pixel `(cx, cy)` is shifted by
/// `mesh.sample(cx, cy)` BEFORE the inverse projection back to the
/// source image. This is the single-resample composition used by
/// Stage C of the panorama pipeline: the mesh expresses
/// "where image i thinks this canvas pixel comes from", and we apply
/// it without producing an intermediate warped buffer. Source pixels
/// are sampled exactly once.
///
/// If `mesh` is `None`, behaviour is identical to the legacy two-
/// argument `warp_image_to_canvas`: pure global pose + canvas
/// projection, no mesh deformation.
pub fn warp_image_to_canvas(
    warper: &CpuWarper,
    img: &PanoImage,
    cam: &Camera,
    canvas: &Canvas,
    mesh: Option<&LocalWarpField>,
) -> Result<PanoImage, PanoError> {
    match &canvas.params {
        CanvasParams::Cylindrical {
            theta_min,
            theta_max,
            h_min,
            h_max,
        } => warp_cylindrical_canvas(
            img,
            cam,
            canvas.width,
            canvas.height,
            *theta_min,
            *theta_max,
            *h_min,
            *h_max,
            mesh,
        ),
        CanvasParams::Spherical {
            lambda_min,
            lambda_max,
            phi_min,
            phi_max,
        } => warp_spherical_canvas(
            img,
            cam,
            canvas.width,
            canvas.height,
            *lambda_min,
            *lambda_max,
            *phi_min,
            *phi_max,
            mesh,
        ),
        CanvasParams::Rectilinear { .. } => {
            // Fallback: render at input size + paste at (0, 0). Same
            // behavior as before this module landed; multi-image
            // rectilinear canvases are a follow-up. Mesh is ignored
            // on this path (rectilinear canvases are MVP and don't
            // support per-image mesh fields yet).
            let _ = mesh;
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
    mesh: Option<&LocalWarpField>,
) -> Result<PanoImage, PanoError> {
    let (iw, ih) = (img.width, img.height);
    let k_in = camera_k_for_image(cam, iw, ih);
    let r_inv = cam.rotation.transpose().cast::<f64>();
    // See `warp_spherical_canvas` for translation semantics.
    let t_cam = cam.translation.cast::<f64>();

    let theta_span = theta_max - theta_min;
    let h_span = h_max - h_min;

    let mut out = PanoImage::new(canvas_w, canvas_h, img.color);

    let cw_f = canvas_w as f32;
    let ch_f = canvas_h as f32;
    let row_pixels_len = (canvas_w as usize) * 3;

    let validity_rows: Vec<Vec<bool>> = out
        .pixels
        .par_chunks_exact_mut(row_pixels_len)
        .enumerate()
        .map(|(cy, row_chunk)| {
            let mut row_valid = vec![false; canvas_w as usize];
            for cx in 0..canvas_w {
                // Apply the mesh displacement BEFORE projecting back
                // to image coords. mesh.sample(cx, cy) returns the
                // displacement at canvas pixel (cx, cy) — the canvas
                // pixel at (cx, cy) "comes from" image i's projection
                // at the shifted position (cx - dx, cy - dy). See
                // module-level docstring on `warp_image_to_canvas`.
                let (cx_shifted, cy_shifted) = if let Some(m) = mesh {
                    match m.sample(cx as f32, cy as f32) {
                        Some(d) => (cx as f32 - d.dx, cy as f32 - d.dy),
                        None => (cx as f32, cy as f32),
                    }
                } else {
                    (cx as f32, cy as f32)
                };
                // Map canvas pixel → cylindrical (θ, h).
                let theta = theta_min + (cx_shifted / cw_f) * theta_span;
                let h = h_min + (cy_shifted / ch_f) * h_span;

                let cos_theta = theta.cos() as f64;
                // Same reasoning as the spherical guard: tiny
                // `cos_theta` makes `world_pt = (tan(theta),
                // h/cos_theta, 1)` explode and the rotated ray can
                // sample the input's opposite side. Reject canvas
                // pixels at angles past ±84° from forward.
                if cos_theta < MIN_WORLD_DIR_Z {
                    continue;
                }
                let world_pt = Vector3::new(theta.tan() as f64, h as f64 / cos_theta, 1.0);

                let cam_ray = r_inv * (world_pt - t_cam);
                if cam_ray.z <= 0.0 {
                    continue;
                }

                let xn = cam_ray.x / cam_ray.z;
                let yn = cam_ray.y / cam_ray.z;
                let (xn_d, yn_d) = forward_distort_xy(xn, yn, cam.distortion.k1, cam.distortion.k2);

                let p = k_in * Vector3::new(xn_d, yn_d, 1.0);
                let u = p.x as f32;
                let v = p.y as f32;

                if u < 0.0 || v < 0.0 || u >= (iw - 1) as f32 || v >= (ih - 1) as f32 {
                    continue;
                }

                let x0 = u.floor() as u32;
                let y0 = v.floor() as u32;
                let dx = u - x0 as f32;
                let dy = v - y0 as f32;

                let p00 = pixel_rgb(img, x0, y0);
                let p10 = pixel_rgb(img, x0 + 1, y0);
                let p01 = pixel_rgb(img, x0, y0 + 1);
                let p11 = pixel_rgb(img, x0 + 1, y0 + 1);

                let cx_base = (cx as usize) * 3;
                for c in 0..3 {
                    let top = p00[c] * (1.0 - dx) + p10[c] * dx;
                    let bot = p01[c] * (1.0 - dx) + p11[c] * dx;
                    row_chunk[cx_base + c] = top * (1.0 - dy) + bot * dy;
                }
                row_valid[cx as usize] = true;
            }
            row_valid
        })
        .collect();

    for (cy, row_valid) in validity_rows.into_iter().enumerate() {
        for (cx, valid) in row_valid.into_iter().enumerate() {
            let idx = cy * (canvas_w as usize) + cx;
            out.validity.set(idx, valid);
        }
    }

    let _ = Matrix3::<f64>::identity(); // silence import-only warning if cfg gates
    Ok(out)
}

fn warp_spherical_canvas(
    img: &PanoImage,
    cam: &Camera,
    canvas_w: u32,
    canvas_h: u32,
    lambda_min: f32,
    lambda_max: f32,
    phi_min: f32,
    phi_max: f32,
    mesh: Option<&LocalWarpField>,
) -> Result<PanoImage, PanoError> {
    let (iw, ih) = (img.width, img.height);
    let k_in = camera_k_for_image(cam, iw, ih);
    let r_inv = cam.rotation.transpose().cast::<f64>();
    // Per-camera translation in scene-unit-depth coordinates (planar-at-
    // unit-depth model, as used by BA). For scenes with no parallax
    // (sphere-at-infinity) this is zero and the warp reduces to the
    // pure-rotation case. When non-zero, it applies the parallax shift
    // BA discovered: a 3D scene point at unit depth offset by t_cam in
    // world units projects to a different sensor pixel than it would
    // for a camera at the origin.
    let t_cam = cam.translation.cast::<f64>();

    let lambda_span = lambda_max - lambda_min;
    let phi_span = phi_max - phi_min;

    let mut out = PanoImage::new(canvas_w, canvas_h, img.color);

    let cw_f = canvas_w as f32;
    let ch_f = canvas_h as f32;
    let row_pixels_len = (canvas_w as usize) * 3;

    // Parallel build over canvas rows. Each row produces (i) its
    // pixel slice (already in `out.pixels` via par_chunks_exact_mut)
    // and (ii) a Vec<bool> of validity flags, which we collect and
    // apply to the BitVec serially after parallel work completes
    // (BitVec doesn't support per-bit concurrent writes).
    let validity_rows: Vec<Vec<bool>> = out
        .pixels
        .par_chunks_exact_mut(row_pixels_len)
        .enumerate()
        .map(|(cy, row_chunk)| {
            let mut row_valid = vec![false; canvas_w as usize];

            for cx in 0..canvas_w {
                // Apply the mesh displacement BEFORE projecting back
                // to image coords. See `warp_image_to_canvas` docs.
                let (cx_shifted, cy_shifted) = if let Some(m) = mesh {
                    match m.sample(cx as f32, cy as f32) {
                        Some(d) => (cx as f32 - d.dx, cy as f32 - d.dy),
                        None => (cx as f32, cy as f32),
                    }
                } else {
                    (cx as f32, cy as f32)
                };
                // Map canvas pixel → spherical (λ, φ).
                let lambda = lambda_min + (cx_shifted / cw_f) * lambda_span;
                let phi = phi_min + (cy_shifted / ch_f) * phi_span;

                // Spherical → world direction, then scale onto the z=1
                // scene plane used by BA's planar-at-unit-depth model.
                let cos_phi = (phi as f64).cos();
                let sin_phi = (phi as f64).sin();
                let cos_lambda = (lambda as f64).cos();
                let sin_lambda = (lambda as f64).sin();
                let world_dir = Vector3::new(cos_phi * sin_lambda, sin_phi, cos_phi * cos_lambda);
                // Reject canvas pixels whose world-direction has a
                // tiny forward-z component. The division
                // `world_dir / world_dir.z` is numerically unstable
                // there, and the rotated cam_ray can pass the
                // `cam_ray.z > 0` guard while pointing at an
                // arbitrary input pixel — the "upside-down edge"
                // artefact. See MIN_WORLD_DIR_Z above. We require
                // strictly positive z (negative z is by-construction
                // back-hemisphere from a forward-facing camera at
                // world origin and has no place sampling forward
                // content).
                if world_dir.z < MIN_WORLD_DIR_Z {
                    continue;
                }
                let world_pt = world_dir / world_dir.z;

                // World → input camera frame: rotate (world_pt − t_cam)
                // into camera coords. With t_cam = 0 this is the legacy
                // pure-rotation R^T·r computation; with t_cam ≠ 0 it
                // adds the planar parallax BA optimised.
                let cam_ray = r_inv * (world_pt - t_cam);
                if cam_ray.z <= 0.0 {
                    continue;
                }

                // Apply forward radial distortion (Brown-Conrady
                // k1, k2) so we sample the input at the correct sensor
                // location.
                let xn = cam_ray.x / cam_ray.z;
                let yn = cam_ray.y / cam_ray.z;
                let (xn_d, yn_d) = forward_distort_xy(xn, yn, cam.distortion.k1, cam.distortion.k2);

                // Project into input image via K.
                let p = k_in * Vector3::new(xn_d, yn_d, 1.0);
                let u = p.x as f32;
                let v = p.y as f32;

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

                let cx_base = (cx as usize) * 3;
                for c in 0..3 {
                    let top = p00[c] * (1.0 - dx) + p10[c] * dx;
                    let bot = p01[c] * (1.0 - dx) + p11[c] * dx;
                    row_chunk[cx_base + c] = top * (1.0 - dy) + bot * dy;
                }
                row_valid[cx as usize] = true;
            }

            row_valid
        })
        .collect();

    // Apply validity flags serially (BitVec write isn't safely
    // parallelisable per bit).
    for (cy, row_valid) in validity_rows.into_iter().enumerate() {
        for (cx, valid) in row_valid.into_iter().enumerate() {
            let idx = cy * (canvas_w as usize) + cx;
            out.validity.set(idx, valid);
        }
    }

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
            principal_point: None,
            rotation: Matrix3::identity(),
            translation: Vector3::zeros(),
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
            principal_point: None,
            rotation: r_yaw,
            translation: Vector3::zeros(),
            distortion: Distortion::default(),
        };
        let single = compute_canvas(&[&img], &[cam_a.clone()], Projection::Cylindrical).unwrap();
        let dual = compute_canvas(&[&img, &img], &[cam_a, cam_b], Projection::Cylindrical).unwrap();
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
        let warped = warp_image_to_canvas(&warper, &img, &cam, &canvas, None).unwrap();
        assert_eq!(warped.width, canvas.width);
        assert_eq!(warped.height, canvas.height);
        // Most pixels should be valid (single image fills its own canvas).
        let valid_frac =
            warped.validity.count_ones() as f32 / (warped.width * warped.height) as f32;
        assert!(valid_frac > 0.5, "valid_frac={valid_frac}");
    }

    #[test]
    fn compute_canvas_spherical_two_yaw_rotated_grows_horizontally() {
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
            principal_point: None,
            rotation: r_yaw,
            translation: Vector3::zeros(),
            distortion: Distortion::default(),
        };

        let single = compute_canvas(&[&img], &[cam_a.clone()], Projection::Spherical).unwrap();
        let dual = compute_canvas(&[&img, &img], &[cam_a, cam_b], Projection::Spherical).unwrap();
        assert!(
            dual.width > single.width,
            "dual.w={} single.w={}",
            dual.width,
            single.width
        );
    }

    #[test]
    fn compute_canvas_spherical_pitch_grows_vertically() {
        let img = PanoImage::new(256, 128, ColorSpace::rec2020_d65_linear());
        let cam_a = identity_camera(256.0);
        let angle = 30.0_f32.to_radians();
        let r_pitch = Matrix3::new(
            1.0,
            0.0,
            0.0,
            0.0,
            angle.cos(),
            -angle.sin(),
            0.0,
            angle.sin(),
            angle.cos(),
        );
        let cam_b = Camera {
            focal: 256.0,
            principal_point: None,
            rotation: r_pitch,
            translation: Vector3::zeros(),
            distortion: Distortion::default(),
        };

        let single = compute_canvas(&[&img], &[cam_a.clone()], Projection::Spherical).unwrap();
        let dual = compute_canvas(&[&img, &img], &[cam_a, cam_b], Projection::Spherical).unwrap();
        assert!(
            dual.height > single.height,
            "dual.h={} single.h={}",
            dual.height,
            single.height
        );
    }

    #[test]
    fn warp_spherical_canvas_identity_returns_canvas_sized_output() {
        let mut img = PanoImage::new(64, 64, ColorSpace::rec2020_d65_linear());
        for i in 0..(64 * 64 * 3) {
            img.pixels[i] = 0.5;
        }
        let cam = identity_camera(64.0);
        let canvas = compute_canvas(&[&img], &[cam.clone()], Projection::Spherical).unwrap();
        let warper = CpuWarper::new();
        let warped = warp_image_to_canvas(&warper, &img, &cam, &canvas, None).unwrap();
        assert_eq!(warped.width, canvas.width);
        assert_eq!(warped.height, canvas.height);
        let valid_frac =
            warped.validity.count_ones() as f32 / (warped.width * warped.height) as f32;
        assert!(valid_frac > 0.5, "valid_frac={valid_frac}");
    }

    /// Regression: at extreme phi (canvas near the spherical poles)
    /// the planar-at-unit-depth back-projection is numerically
    /// unstable and could sample the *opposite side* of the input
    /// image, producing visible upside-down strips at canvas
    /// top/bottom. The `MIN_WORLD_DIR_Z` guard rejects pixels
    /// where this would happen.
    ///
    /// This test builds an artificially-extended canvas (phi from
    /// −π/2 to +π/2, full poles) and asserts that pixels at the
    /// extreme top and bottom rows are invalidated by the warp,
    /// not "valid with wrong content".
    #[test]
    fn warp_spherical_canvas_rejects_pixels_past_safe_phi() {
        // Build a 32×32 canvas where the bottom 16 rows are red and
        // the top 16 are blue. If the warp inverts content from the
        // input's top half into the canvas's bottom rows, we'll see
        // blue where red should be. The MIN_WORLD_DIR_Z guard
        // prevents that by rejecting all pixels past the safe phi.
        let mut img = PanoImage::new(32, 32, ColorSpace::rec2020_d65_linear());
        for y in 0..32 {
            for x in 0..32 {
                let i = ((y * 32 + x) * 3) as usize;
                if y < 16 {
                    img.pixels[i] = 0.9; // R
                    img.pixels[i + 1] = 0.1;
                    img.pixels[i + 2] = 0.1;
                } else {
                    img.pixels[i] = 0.1;
                    img.pixels[i + 1] = 0.1;
                    img.pixels[i + 2] = 0.9; // B
                }
                img.validity.set((y * 32 + x) as usize, true);
            }
        }
        let cam = identity_camera(32.0);

        // Manually build a Spherical canvas that extends to extreme
        // phi (just below ±π/2 so we exercise the guard but stay
        // mathematically defined). Width spans only ±π/4 lambda so
        // we exercise the phi-pole degeneracy specifically.
        let canvas = Canvas {
            width: 64,
            height: 64,
            projection: Projection::Spherical,
            params: CanvasParams::Spherical {
                lambda_min: -std::f32::consts::FRAC_PI_4,
                lambda_max: std::f32::consts::FRAC_PI_4,
                phi_min: -1.55, // ≈ -88.8°
                phi_max: 1.55,  // ≈ +88.8°
            },
        };
        let warper = CpuWarper::new();
        let warped = warp_image_to_canvas(&warper, &img, &cam, &canvas, None).unwrap();

        // The top 4 rows of the canvas correspond to phi very close
        // to π/2 — past the MIN_WORLD_DIR_Z safe band. They MUST be
        // invalid (rejected by the guard), not "valid blue mapped
        // somewhere wrong".
        let w = warped.width as usize;
        for y in 0..4 {
            for x in 0..warped.width {
                let idx = y * w + x as usize;
                assert!(
                    !warped.validity[idx],
                    "canvas pixel ({x}, {y}) at extreme phi should be rejected by the guard"
                );
            }
        }
        for y in (warped.height as usize - 4)..(warped.height as usize) {
            for x in 0..warped.width {
                let idx = y * w + x as usize;
                assert!(
                    !warped.validity[idx],
                    "canvas pixel ({x}, {y}) at extreme phi should be rejected by the guard"
                );
            }
        }
    }

    /// Stage C signature extension: when the optional mesh argument
    /// is a no-op `LocalWarpField` (all displacements zero), the warp
    /// output must equal the `mesh = None` baseline pixel-for-pixel.
    /// This guards against accidental coordinate-shift sign flips or
    /// double-applied displacements when wiring the mesh path in.
    #[test]
    fn warp_image_to_canvas_with_zero_mesh_matches_none() {
        use crate::warp::local_mesh::{LocalWarpField, LocalWarpOptions};

        // Random-ish content so a coordinate-shift would visibly
        // disagree at every pixel, not stealthily produce identical
        // output by virtue of a flat input.
        let mut img = PanoImage::new(64, 64, ColorSpace::rec2020_d65_linear());
        for y in 0..64 {
            for x in 0..64 {
                let i = ((y * 64 + x) * 3) as usize;
                img.pixels[i] = (x as f32 / 64.0) * 0.6 + 0.1;
                img.pixels[i + 1] = (y as f32 / 64.0) * 0.6 + 0.1;
                img.pixels[i + 2] = ((x ^ y) as f32 / 64.0).clamp(0.0, 1.0) * 0.5 + 0.05;
                img.validity.set((y * 64 + x) as usize, true);
            }
        }
        let cam = identity_camera(64.0);
        let canvas = compute_canvas(&[&img], &[cam.clone()], Projection::Spherical).unwrap();
        let warper = CpuWarper::new();
        let baseline = warp_image_to_canvas(&warper, &img, &cam, &canvas, None).unwrap();
        let mesh = LocalWarpField::no_op(&canvas, LocalWarpOptions::default()).unwrap();
        let with_zero_mesh = warp_image_to_canvas(&warper, &img, &cam, &canvas, Some(&mesh))
            .unwrap();
        assert_eq!(baseline.width, with_zero_mesh.width);
        assert_eq!(baseline.height, with_zero_mesh.height);
        // Pixel-for-pixel equality. We allow a small tolerance to
        // absorb any platform-dependent FMA ordering jitter the
        // compiler might introduce — but in practice the shifted
        // path with `dx = dy = 0` evaluates to the same float
        // expression as the un-shifted path.
        for i in 0..(baseline.pixels.len()) {
            let a = baseline.pixels[i];
            let b = with_zero_mesh.pixels[i];
            assert!(
                (a - b).abs() < 1e-5,
                "pixel {i} mismatch: baseline={a}, mesh=None: {b}",
            );
        }
        for i in 0..((baseline.width * baseline.height) as usize) {
            assert_eq!(baseline.validity[i], with_zero_mesh.validity[i]);
        }
    }
}
