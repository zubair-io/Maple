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

use rayon::prelude::*;

use super::placement::{TileCanvasSpec, TilePose};
use crate::ingest::{PlanarImage, ValidityMask};
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

    let inv = inverse_similarity_with_offset(&pose.sim, canvas.offset_x, canvas.offset_y);

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

/// Pre-compose the canvas offset into the inverse similarity so the
/// hot loop only calls `apply` once per pixel.
///
/// The forward map is: canvas_px = sim.apply(src_px) + offset.
/// So: src_px = sim_inv(canvas_px − offset).
/// We bake this into a single transform: sim_with_offset_inv.
///
/// Exported (pub(super)) for [`super::streaming`] which reuses the same
/// inverse without allocating a full-canvas warp buffer.
pub(super) fn inverse_similarity_with_offset(
    sim: &Similarity2d,
    offset_x: f64,
    offset_y: f64,
) -> Similarity2d {
    // Inverse of sim: s_inv = 1/s, θ_inv = -θ, t_inv = -R(-θ)·t/s.
    let inv_s = 1.0 / sim.scale.max(1e-12);
    let inv_theta = -sim.theta;
    let (sin, cos) = inv_theta.sin_cos();
    let inv_tx = inv_s * (cos * (-sim.tx) - sin * (-sim.ty));
    let inv_ty = inv_s * (sin * (-sim.tx) + cos * (-sim.ty));

    // Compose with the pre-shift by −offset:
    // p' = inv_sim(p − offset) = inv_sim.apply(p) − inv_sim.apply(offset)
    // ... actually simpler: pre-shift before the inverse:
    // let q = p − offset; result = inv_sim.apply(q)
    // = inv_sim.apply(p) − inv_sim.apply(offset) + inv_sim.t
    // Pre-compute inv_sim.apply(offset) and fold into the translation.
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
}
