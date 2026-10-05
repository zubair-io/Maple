//! WarpRectilinear opcode execution (DNG 1.3 spec § 7).
//!
//! Applies per-plane geometric distortion and lateral chromatic aberration
//! corrections via bicubic resample. Supports both whole-image develop and
//! bounded native tiles (#4288).

use super::cubic;
use crate::image::Image;
use crate::pipeline::pano::opcodes::{ActiveAreaRect, WarpPlaneParams, WarpRectilinearOpcode};
use rayon::prelude::*;

/// The `WarpRectilinear` coefficient set that maps every position to
/// itself: unit radial ratio, no tangential terms.
pub const IDENTITY_WARP_KR: [f64; 4] = [1.0, 0.0, 0.0, 0.0];

/// Blend one plane's warp toward the identity at the user's distortion /
/// CA strengths (#376).
pub fn blend_warp_toward_identity(
    plane: &WarpPlaneParams,
    green: &WarpPlaneParams,
    distortion: f64,
    ca: f64,
) -> WarpPlaneParams {
    let common = distortion - ca;
    let identity_weight = 1.0 - distortion;
    WarpPlaneParams {
        kr: std::array::from_fn(|i| {
            ca * plane.kr[i] + common * green.kr[i] + identity_weight * IDENTITY_WARP_KR[i]
        }),
        kt: std::array::from_fn(|i| ca * plane.kt[i] + common * green.kt[i]),
    }
}

/// The corrected→uncorrected position mapping for one plane, in
/// ActiveArea pixel coordinates (dng_sdk `GetSrcPixelPosition`, square
/// pixels): radial ratio polynomial + tangential terms in normalized
/// units, scaled back by the normalization radius.
#[inline]
pub fn warp_source(
    set: &WarpPlaneParams,
    dx: f64,
    dy: f64,
    cx: f64,
    cy: f64,
    inv_r: f64,
    norm_radius: f64,
) -> (f64, f64) {
    let dnx = dx * inv_r;
    let dny = dy * inv_r;
    let rr = (dnx * dnx + dny * dny).min(1.0);
    let [kr0, kr1, kr2, kr3] = set.kr;
    let ratio = kr0 + rr * (kr1 + rr * (kr2 + rr * kr3));
    let [kt0, kt1] = set.kt;
    if kt0 == 0.0 && kt1 == 0.0 {
        (cx + dx * ratio, cy + dy * ratio)
    } else {
        let tan_h = kt1 * (rr + 2.0 * dnx * dnx) + 2.0 * kt0 * dnx * dny;
        let tan_v = kt0 * (rr + 2.0 * dny * dny) + 2.0 * kt1 * dnx * dny;
        (
            cx + norm_radius * (dnx * ratio + tan_h),
            cy + norm_radius * (dny * ratio + tan_v),
        )
    }
}

/// Resample the active area through the rectilinear warp model on the full image.
pub fn apply_warp_rectilinear(
    image: &mut Image,
    warp: &WarpRectilinearOpcode,
    aa: ActiveAreaRect,
    distortion: f32,
    ca: f32,
) {
    apply_warp_rectilinear_windowed(image, warp, aa, distortion, ca, (0, 0));
}

/// Windowed rectilinear warp resample for both full-frame and tile buffers (#4288).
///
/// `origin` is the buffer's top-left position `(ox, oy)` in the full demosaiced image space.
pub fn apply_warp_rectilinear_windowed(
    image: &mut Image,
    warp: &WarpRectilinearOpcode,
    aa: ActiveAreaRect,
    distortion: f32,
    ca: f32,
    origin: (u32, u32),
) {
    if distortion == 0.0 && ca == 0.0 {
        return;
    }
    let (aa_w, aa_h) = (aa.width as f64, aa.height as f64);
    let cx = warp.center_x * aa_w;
    let cy = warp.center_y * aa_h;
    let norm_radius = f64::hypot(
        cx.abs().max((aa_w - cx).abs()),
        cy.abs().max((aa_h - cy).abs()),
    );
    if norm_radius <= 0.0 {
        return;
    }
    let inv_r = 1.0 / norm_radius;

    let set_for = |p: usize| warp.planes[p.min(warp.planes.len() - 1)];
    let green = set_for(1);
    let (d, c) = (distortion as f64, ca as f64);
    let plane_sets: [WarpPlaneParams; 3] =
        std::array::from_fn(|p| blend_warp_toward_identity(&set_for(p), &green, d, c));
    let all_same = plane_sets[1] == plane_sets[0] && plane_sets[2] == plane_sets[0];

    let src = image.pixels.clone();
    let tile_w = image.width as usize;
    let tile_h = image.height as usize;
    let (ox, oy) = (origin.0 as i32, origin.1 as i32);
    let (aa_left, aa_top) = (aa.left as i32, aa.top as i32);
    let (aa_right, aa_bottom) = (aa_left + aa.width as i32, aa_top + aa.height as i32);

    let min_col = (aa_left - ox).max(0) as usize;
    let max_col = ((aa_right - 1 - ox).max(0) as usize).min(tile_w.saturating_sub(1));
    let min_row = (aa_top - oy).max(0) as usize;
    let max_row = ((aa_bottom - 1 - oy).max(0) as usize).min(tile_h.saturating_sub(1));

    if min_col > max_col || min_row > max_row {
        return;
    }

    image
        .pixels
        .par_chunks_mut(tile_w)
        .enumerate()
        .for_each(|(row_idx, row_px)| {
            let gy = oy + row_idx as i32;
            if gy < aa_top || gy >= aa_bottom {
                return;
            }
            let row = (gy - aa_top) as f64;
            let dy = row - cy;

            for col_idx in 0..tile_w {
                let gx = ox + col_idx as i32;
                if gx < aa_left || gx >= aa_right {
                    continue;
                }
                let col = (gx - aa_left) as f64;
                let dx = col - cx;
                let out = &mut row_px[col_idx];

                if all_same {
                    let (sx, sy) = warp_source(&plane_sets[0], dx, dy, cx, cy, inv_r, norm_radius);
                    let local_x = (aa_left as f64 + sx) - ox as f64;
                    let local_y = (aa_top as f64 + sy) - oy as f64;
                    *out = cubic::sample_bounded(
                        &src,
                        tile_w,
                        min_col,
                        max_col,
                        min_row,
                        max_row,
                        local_x,
                        local_y,
                        [0, 1, 2],
                    );
                } else {
                    for (p, set) in plane_sets.iter().enumerate() {
                        let (sx, sy) = warp_source(set, dx, dy, cx, cy, inv_r, norm_radius);
                        let local_x = (aa_left as f64 + sx) - ox as f64;
                        let local_y = (aa_top as f64 + sy) - oy as f64;
                        out[p] = cubic::sample_bounded(
                            &src,
                            tile_w,
                            min_col,
                            max_col,
                            min_row,
                            max_row,
                            local_x,
                            local_y,
                            [p],
                        )[0];
                    }
                }
            }
        });
}

/// Compute the maximum radial displacement (in demosaiced pixels) of a
/// radial `WarpRectilinearOpcode` across the image for dimensions `full_demosaic_dims`
/// (which should reflect the demosaiced buffer size after any quality divisor scaling).
/// Includes the bicubic stencil radius (2 pixels).
///
/// Invariant: In the supported tile path, all planes have identical coefficients
/// (`kt == [0, 0]` and equal `kr`), so chromatic aberration scaling does not
/// diverge per-plane and `blend_warp_toward_identity` collapses to the single
/// `distortion` scale.
pub fn warp_rectilinear_reach_px(
    warp: &WarpRectilinearOpcode,
    full_demosaic_dims: (u32, u32),
    distortion: f32,
) -> usize {
    if distortion.abs() < 1e-3 || warp.planes.is_empty() {
        return 0;
    }
    let (w, h) = (full_demosaic_dims.0 as f64, full_demosaic_dims.1 as f64);
    let cx = warp.center_x * w;
    let cy = warp.center_y * h;
    let norm_radius = f64::hypot(cx.abs().max((w - cx).abs()), cy.abs().max((h - cy).abs()));
    if norm_radius <= 0.0 {
        return 0;
    }
    let d = distortion.clamp(0.0, 1.0) as f64;
    let plane = &warp.planes[0];
    let kr_eff = [
        d * plane.kr[0] + (1.0 - d) * 1.0,
        d * plane.kr[1],
        d * plane.kr[2],
        d * plane.kr[3],
    ];

    let candidates = find_radial_extrema_u(kr_eff);
    let mut max_disp = 0.0f64;
    for u in candidates {
        let rr = u * u;
        let ratio = kr_eff[0] + rr * (kr_eff[1] + rr * (kr_eff[2] + rr * kr_eff[3]));
        let disp = norm_radius * u * (ratio - 1.0).abs();
        if disp > max_disp {
            max_disp = disp;
        }
    }
    max_disp.ceil() as usize + 2
}

/// Find all candidate radii `u in [0, 1]` where the degree-seven displacement
/// polynomial `p(u) = u * (ratio(u) - 1.0)` can attain an extremum.
///
/// Since `p(u) = (kr[0] - 1)*u + kr[1]*u^3 + kr[2]*u^5 + kr[3]*u^7`, its
/// derivative `p'(u)` is a cubic in `t = u^2 in [0, 1]`. Extrema occur only
/// at endpoints or roots of `p'(u) = 0`.
fn find_radial_extrema_u(kr_eff: [f64; 4]) -> Vec<f64> {
    let mut candidates = vec![0.0, 1.0];
    for i in 1..256 {
        candidates.push(i as f64 / 256.0);
    }

    let a = 7.0 * kr_eff[3];
    let b = 5.0 * kr_eff[2];
    let c = 3.0 * kr_eff[1];
    let d = kr_eff[0] - 1.0;

    let eval_q = |t: f64| ((a * t + b) * t + c) * t + d;

    if a.abs() < 1e-12 {
        if b.abs() < 1e-12 {
            if c.abs() > 1e-12 {
                let t = -d / c;
                if (0.0..=1.0).contains(&t) {
                    candidates.push(t.sqrt());
                }
            }
        } else {
            let disc = c * c - 4.0 * b * d;
            if disc >= 0.0 {
                let s = disc.sqrt();
                for t in [(-c - s) / (2.0 * b), (-c + s) / (2.0 * b)] {
                    if (0.0..=1.0).contains(&t) {
                        candidates.push(t.sqrt());
                    }
                }
            }
        }
    } else {
        // Monotonicity intervals of q(t) bounded by roots of q'(t) = 3*a*t^2 + 2*b*t + c
        let disc = b * b - 3.0 * a * c;
        let mut pts = vec![0.0f64];
        if disc > 0.0 {
            let s = disc.sqrt();
            let t1 = (-b - s) / (3.0 * a);
            let t2 = (-b + s) / (3.0 * a);
            if t1 > 0.0 && t1 < 1.0 {
                pts.push(t1);
            }
            if t2 > 0.0 && t2 < 1.0 {
                pts.push(t2);
            }
        }
        pts.push(1.0);
        pts.sort_by(|x, y| x.partial_cmp(y).unwrap());

        for w in pts.windows(2) {
            let (t_lo, t_hi) = (w[0], w[1]);
            let (q_lo, q_hi) = (eval_q(t_lo), eval_q(t_hi));
            if q_lo.abs() < 1e-12 {
                candidates.push(t_lo.sqrt());
            }
            if q_hi.abs() < 1e-12 {
                candidates.push(t_hi.sqrt());
            }
            if q_lo * q_hi < 0.0 {
                let mut lo = t_lo;
                let mut hi = t_hi;
                for _ in 0..24 {
                    let mid = 0.5 * (lo + hi);
                    if eval_q(lo) * eval_q(mid) <= 0.0 {
                        hi = mid;
                    } else {
                        lo = mid;
                    }
                }
                let root_t = 0.5 * (lo + hi);
                candidates.push(root_t.sqrt());
            }
        }
    }

    candidates
}
