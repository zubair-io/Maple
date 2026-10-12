//! Validity-aware affine warp for the tile strategy: warps a source frame
//! onto the planar canvas using the frame's absolute 2D similarity pose
//! (spec §8, ticket #1226).
//!
//! The per-pixel chain:
//!
//! 1. For each canvas pixel `(cx, cy)`, compute the inverse similarity
//!    (canvas → source frame):
//!    `(fx, fy) = T^{-1}(cx − offset_x, cy − offset_y)`
//! 2. If `(fx, fy)` lands inside the source frame, sample the source
//!    with bicubic Catmull-Rom (same kernel as `warp.rs`).
//! 3. Fold in the per-frame gain multiplier.
//!
//! Rows are rayon-parallel; per-pixel work is pure and deterministic.
//!
//! ## Region-restricted variant
//!
//! [`warp_to_tile_region`] warps only the sub-rectangle
//! `[rx0, rx1) × [ry0, ry1)` of the canvas — pixel-for-pixel identical
//! to taking that crop out of `warp_to_tile_canvas`, but without
//! allocating the full canvas buffer. Used by the tiled multiband
//! composite (#1291) to bound peak memory.

use rayon::prelude::*;

use super::photometry::FramePhotometry;
use super::placement::{TileCanvasSpec, TilePose};
use crate::ingest::{PlanarImage, ValidityMask};
use crate::local_align::LocalCorrection;
use crate::similarity::Similarity2d;

/// The canvas offset is applied inside the inverse similarity so the
/// warp operates entirely in source-pixel coordinates.
pub fn warp_to_tile_canvas(
    src: &PlanarImage,
    pose: &TilePose,
    canvas: &TileCanvasSpec,
    gain: [f32; 3],
) -> PlanarImage {
    let cw = canvas.width as usize;
    let ch = canvas.height as usize;
    let n = cw * ch;
    let src_w = src.width() as f64;
    let src_h = src.height() as f64;

    let inv = inverse_similarity(&pose.sim, canvas.offset_x, canvas.offset_y);

    let mut r = vec![0.0_f32; n];
    let mut g = vec![0.0_f32; n];
    let mut b = vec![0.0_f32; n];
    let mut valid = vec![false; n];

    r.par_chunks_mut(cw)
        .zip(g.par_chunks_mut(cw))
        .zip(b.par_chunks_mut(cw))
        .zip(valid.par_chunks_mut(cw))
        .enumerate()
        .for_each(|(row, (((row_r, row_g), row_b), row_v))| {
            let cy = row as f64 + 0.5;
            for col in 0..cw {
                let cx = col as f64 + 0.5;
                let (fx, fy) = inv.apply(cx, cy);

                if fx < 0.0 || fx > src_w || fy < 0.0 || fy > src_h {
                    continue;
                }
                if let Some([sr, sg, sb]) = sample_bicubic(src, fx - 0.5, fy - 0.5) {
                    row_r[col] = (sr * gain[0]).max(0.0);
                    row_g[col] = (sg * gain[1]).max(0.0);
                    row_b[col] = (sb * gain[2]).max(0.0);
                    row_v[col] = true;
                }
            }
        });

    let mut mask = ValidityMask::new_filled(canvas.width, canvas.height, false);
    for (i, &v) in valid.iter().enumerate() {
        if v {
            let x = (i % cw) as u32;
            let y = (i / cw) as u32;
            mask.set(x, y, true);
        }
    }

    PlanarImage::from_planes(canvas.width, canvas.height, r, g, b, mask)
}

/// Region-restricted warp: fills only the `[rx0, rx1) × [ry0, ry1)` sub-
/// rectangle of the full canvas, returning a `PlanarImage` of size
/// `(rx1 − rx0) × (ry1 − ry0)`. Pixel values are identical to the
/// corresponding crop of `warp_to_tile_canvas` — same inverse similarity,
/// same bicubic kernel, same gain application. Nothing outside the region
/// is computed or allocated.
///
/// `local` is the frame's Stage-F mesh (#4577): it shifts the source
/// sample point after the inverse similarity, inside the same resample.
#[allow(clippy::too_many_arguments)]
pub(super) fn warp_to_tile_region(
    src: &PlanarImage,
    pose: &TilePose,
    local: Option<&LocalCorrection>,
    canvas: &TileCanvasSpec,
    phot: &FramePhotometry,
    rx0: usize,
    ry0: usize,
    rx1: usize,
    ry1: usize,
) -> PlanarImage {
    debug_assert!(rx1 <= canvas.width as usize && ry1 <= canvas.height as usize);
    debug_assert!(rx0 < rx1 && ry0 < ry1);

    let rw = rx1 - rx0;
    let rh = ry1 - ry0;
    let n = rw * rh;
    let src_w = src.width() as f64;
    let src_h = src.height() as f64;

    let inv = inverse_similarity_with_offset(&pose.sim, canvas.offset_x, canvas.offset_y);
    let gain = phot.gain;
    // The ramp + field corrections are log-domain and channel-shared:
    // out = v · gain · exp(−(slope_x·(ξ−½) + slope_y·(η−½) + field)) · V(r).
    let has_ramp = phot.slope_x != 0.0 || phot.slope_y != 0.0 || phot.field.is_some();

    let mut r = vec![0.0_f32; n];
    let mut g = vec![0.0_f32; n];
    let mut b = vec![0.0_f32; n];
    let mut valid = vec![false; n];

    r.par_chunks_mut(rw)
        .zip(g.par_chunks_mut(rw))
        .zip(b.par_chunks_mut(rw))
        .zip(valid.par_chunks_mut(rw))
        .enumerate()
        .for_each(|(row, (((row_r, row_g), row_b), row_v))| {
            let cy = (ry0 + row) as f64 + 0.5;
            for col in 0..rw {
                let cx = (rx0 + col) as f64 + 0.5;
                let (px, py) = inv.apply(cx, cy);
                let (fx, fy) = local.map_or((px, py), |c| c.apply(px, py));
                if fx < 0.0 || fx > src_w || fy < 0.0 || fy > src_h {
                    continue;
                }
                if let Some([sr, sg, sb]) = sample_bicubic(src, fx - 0.5, fy - 0.5) {
                    let corr = if has_ramp {
                        let log_corr = phot.slope_x * (fx / src_w - 0.5) as f32
                            + phot.slope_y * (fy / src_h - 0.5) as f32
                            + phot.field.as_ref().map_or(0.0, |f| f.eval(cx, cy));
                        (-log_corr).exp()
                    } else {
                        1.0
                    };
                    let falloff = phot.falloff_at(fx, fy, src_w, src_h);
                    row_r[col] = (sr * gain[0] * corr * falloff).max(0.0);
                    row_g[col] = (sg * gain[1] * corr * falloff).max(0.0);
                    row_b[col] = (sb * gain[2] * corr * falloff).max(0.0);
                    row_v[col] = true;
                }
            }
        });

    let mut mask = ValidityMask::new_filled(rw as u32, rh as u32, false);
    for (i, &v) in valid.iter().enumerate() {
        if v {
            mask.set((i % rw) as u32, (i / rw) as u32, true);
        }
    }
    PlanarImage::from_planes(rw as u32, rh as u32, r, g, b, mask)
}

/// Pre-compose the canvas offset into the inverse similarity so the
/// hot loop only calls `apply` once per pixel.
///
/// The forward map is: canvas_px = sim.apply(src_px) + offset.
/// So: src_px = sim_inv(canvas_px − offset).
/// We bake this into a single transform: sim_with_offset_inv.
/// Exported (pub(super)) for [`super::gain_solve`] and
/// [`warp_to_tile_region`].
pub(super) fn inverse_similarity_with_offset(
    sim: &Similarity2d,
    offset_x: f64,
    offset_y: f64,
) -> Similarity2d {
    inverse_similarity(sim, offset_x, offset_y)
}

fn inverse_similarity(sim: &Similarity2d, offset_x: f64, offset_y: f64) -> Similarity2d {
    // Inverse of sim: s_inv = 1/s, θ_inv = -θ, t_inv = -R(-θ)·t/s.
    let inv_s = 1.0 / sim.scale.max(1e-12);
    let inv_theta = -sim.theta;
    let (sin, cos) = inv_theta.sin_cos();
    let inv_tx = inv_s * (cos * (-sim.tx) - sin * (-sim.ty));
    let inv_ty = inv_s * (sin * (-sim.tx) + cos * (-sim.ty));

    // Compose with the pre-shift by −offset: pre-compute inv_sim.apply(offset) and fold into the translation.
    let (ox_mapped, oy_mapped) = {
        let rx = cos * offset_x - sin * offset_y;
        let ry = sin * offset_x + cos * offset_y;
        (inv_s * rx, inv_s * ry)
    };

    Similarity2d {
        scale: inv_s,
        theta: inv_theta,
        tx: inv_tx - ox_mapped,
        ty: inv_ty - oy_mapped,
    }
}

/// Bicubic Catmull-Rom interpolation (same implementation as `warp.rs`).
fn catmull_rom(f: f64) -> [f64; 4] {
    let f2 = f * f;
    let f3 = f2 * f;
    [
        -0.5 * f3 + f2 - 0.5 * f,
        1.5 * f3 - 2.5 * f2 + 1.0,
        -1.5 * f3 + 2.0 * f2 + 0.5 * f,
        0.5 * f3 - 0.5 * f2,
    ]
}

/// Bicubic Catmull-Rom interpolation. Exported pub(super) for
/// [`super::gain_solve`].
pub(super) fn sample_bicubic(src: &PlanarImage, x_px: f64, y_px: f64) -> Option<[f32; 3]> {
    let sw = src.width() as i64;
    let sh = src.height() as i64;
    let ix = x_px.floor() as i64;
    let iy = y_px.floor() as i64;
    let fx = x_px - ix as f64;
    let fy = y_px - iy as f64;
    let wx = catmull_rom(fx);
    let wy = catmull_rom(fy);

    let mut acc = [0.0_f64; 3];
    let mut w_total = 0.0_f64;

    for dy in 0..4_i64 {
        let row = iy + dy - 1;
        if row < 0 || row >= sh {
            continue;
        }
        for dx in 0..4_i64 {
            let col = ix + dx - 1;
            if col < 0 || col >= sw {
                continue;
            }
            if !src.validity.get(col as u32, row as u32) {
                continue;
            }
            let w = wx[dx as usize] * wy[dy as usize];
            let idx = (row as usize) * (sw as usize) + col as usize;
            acc[0] += w * src.r[idx] as f64;
            acc[1] += w * src.g[idx] as f64;
            acc[2] += w * src.b[idx] as f64;
            w_total += w;
        }
    }

    if w_total.abs() < 0.01 {
        return None;
    }
    let inv_w = 1.0 / w_total;
    Some([
        (acc[0] * inv_w) as f32,
        (acc[1] * inv_w) as f32,
        (acc[2] * inv_w) as f32,
    ])
}

#[cfg(test)]
mod tests {
    use super::super::placement::{TileCanvasSpec, TilePose};
    use super::*;
    use crate::ingest::{PlanarImage, ValidityMask};
    use crate::similarity::Similarity2d;

    fn solid_frame(w: u32, h: u32, val: f32) -> PlanarImage {
        let n = (w * h) as usize;
        PlanarImage::from_planes(
            w,
            h,
            vec![val; n],
            vec![val; n],
            vec![val; n],
            ValidityMask::new_filled(w, h, true),
        )
    }

    #[test]
    fn identity_pose_reproduces_source() {
        let src = solid_frame(64, 64, 0.5);
        let pose = TilePose {
            sim: Similarity2d {
                scale: 1.0,
                theta: 0.0,
                tx: 0.0,
                ty: 0.0,
            },
            frame_idx: 0,
        };
        let canvas = TileCanvasSpec {
            width: 64,
            height: 64,
            offset_x: 0.0,
            offset_y: 0.0,
        };
        let out = warp_to_tile_canvas(&src, &pose, &canvas, [1.0, 1.0, 1.0]);
        // Centre pixel should be covered.
        assert!(out.validity.get(32, 32));
        // Value should be 0.5.
        let idx = 32 * 64 + 32;
        assert!((out.r[idx] - 0.5).abs() < 0.01, "r={}", out.r[idx]);
    }

    #[test]
    fn translation_shifts_content() {
        let src = solid_frame(32, 32, 1.0);
        let pose = TilePose {
            sim: Similarity2d {
                scale: 1.0,
                theta: 0.0,
                tx: 10.0,
                ty: 0.0,
            },
            frame_idx: 0,
        };
        let canvas = TileCanvasSpec {
            width: 50,
            height: 32,
            offset_x: 0.0,
            offset_y: 0.0,
        };
        let out = warp_to_tile_canvas(&src, &pose, &canvas, [1.0, 1.0, 1.0]);
        // Pixel at (5, 16) should be empty (shifted beyond frame).
        assert!(!out.validity.get(5, 16), "expected invalid at (5,16)");
        // Pixel at (20, 16) should be covered.
        assert!(out.validity.get(20, 16), "expected valid at (20,16)");
    }

    /// The warp and the residual report must agree on where a corrected
    /// frame puts its content — the sign of the mesh shift (#4577).
    #[test]
    fn mesh_shift_lands_where_the_residual_model_says() {
        let (w, h) = (96u32, 64u32);
        let blob = (40.5, 30.5);
        let plane: Vec<f32> = (0..h)
            .flat_map(|y| (0..w).map(move |x| (x, y)))
            .map(|(x, y)| {
                let (dx, dy) = (x as f64 + 0.5 - blob.0, y as f64 + 0.5 - blob.1);
                (-(dx * dx + dy * dy) / 18.0).exp() as f32
            })
            .collect();
        let src = PlanarImage::from_planes(
            w,
            h,
            plane.clone(),
            plane.clone(),
            plane,
            ValidityMask::new_filled(w, h, true),
        );
        let pose = TilePose {
            sim: Similarity2d {
                scale: 1.0,
                theta: 0.0,
                tx: 0.0,
                ty: 0.0,
            },
            frame_idx: 0,
        };
        let canvas = TileCanvasSpec {
            width: w,
            height: h,
            offset_x: 0.0,
            offset_y: 0.0,
        };
        let mut corr = LocalCorrection::identity(f64::from(w), f64::from(h));
        corr.nodes.iter_mut().for_each(|n| *n = [3.0, -2.0]);
        let phot = super::super::photometry::FramePhotometry::neutral();
        let out = warp_to_tile_region(
            &src,
            &pose,
            Some(&corr),
            &canvas,
            &phot,
            0,
            0,
            w as usize,
            h as usize,
        );

        let (sum, sx, sy) = (0..h as usize)
            .flat_map(|y| (0..w as usize).map(move |x| (x, y)))
            .fold((0.0, 0.0, 0.0), |(s, sx, sy), (x, y)| {
                let v = f64::from(out.r[y * w as usize + x]);
                (s + v, sx + v * (x as f64 + 0.5), sy + v * (y as f64 + 0.5))
            });
        let expected = crate::local_align::planar::corrected_canvas_point(&pose, Some(&corr), blob);
        assert!(
            (sx / sum - expected.0).abs() < 0.05 && (sy / sum - expected.1).abs() < 0.05,
            "blob at ({:.3}, {:.3}), model says ({:.3}, {:.3})",
            sx / sum,
            sy / sum,
            expected.0,
            expected.1
        );
    }
}
