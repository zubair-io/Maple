//! DNG OpcodeList3 application for the pano ingest path (#1159).
//!
//! Pixel-domain companions to the [`super::opcodes`] parser: `GainMap`
//! (id 9) as an in-place multiply, `WarpRectilinear` (id 1) as a
//! full-image inverse-map resample. Both run on the **demosaiced
//! linear camera-RGB** image — the DNG processing-model stage for
//! OpcodeList3 — and execute **in list order** as the spec mandates.
//!
//! ## Coordinate system
//!
//! Opcode coordinates are relative to the `ActiveArea` origin and
//! normalized over the ActiveArea dims: dng_sdk applies List3 to its
//! stage-3 image, which *is* the active-area crop. raw-core demosaics
//! the full sensor and applies DefaultCrop later, so both stages here
//! offset into the [`ActiveAreaRect`] instead; pixels outside it are
//! untouched (they are masked sensor columns that DefaultCrop discards).
//!
//! ## dng_sdk parity notes (verified against `dng_gain_map.cpp` /
//! `dng_lens_correction.cpp`)
//!
//! * GainMap samples the lattice at **pixel centers** normalized over
//!   the image bounds: `v = (row + 0.5) / H`, then lattice index
//!   `(v − MapOriginV) / MapSpacingV`, bilinear with edge clamp, and
//!   plane `p` reads lattice plane `min(p, MapPlanes − 1)`.
//! * dng_sdk clamps the multiplied result to 1.0 (its stage buffers are
//!   bounded). **We deliberately do not**: the pano working space is
//!   unbounded scene-linear ("nothing before the view transform
//!   clips"), and clamping would undo the correction exactly where two
//!   overlapping frames disagree most (bright sky in one frame's corner
//!   vs another's center) — the disagreement gain compensation exists
//!   to remove.
//! * The warp model maps **corrected (output) → uncorrected (input)**
//!   positions (dng_sdk `GetSrcPixelPosition`): per output pixel we
//!   evaluate the polynomial and gather-sample the input. Normalization
//!   matches dng_sdk: center at `Lerp(0, dim, c)`, radii scaled so the
//!   max center→corner distance is 1.0, and `r² = min(r², 1.0)`.
//! * Source positions outside the active area **clamp to the edge**
//!   (sticky-edge, exactly dng_sdk's behavior — no black fill; the DNG
//!   spec leaves it to the reader and the reference clamps). dng_sdk
//!   resamples bicubic; we bilinear-sample — identical geometry, only a
//!   marginal sharpness difference, irrelevant to descriptors at proxy
//!   scale.

use rayon::prelude::*;

use crate::image::Image;

use super::opcodes::{
    ActiveAreaRect, GainMapOpcode, OpcodeList3, PanoOpcode, WarpRectilinearOpcode,
};

/// Scale an `ActiveAreaRect` from raw-sensor coordinates into the
/// coordinate space of a demosaiced buffer that may be a different
/// resolution. `scale` is `buffer_dim / raw_dim`; every resize path
/// here preserves aspect ratio, so one scalar covers both axes.
///
/// Both call sites compute `scale` from the *post-demosaic* buffer, not
/// the eventual render target: the standard develop chain
/// (`develop::geometry::effective_quality_divisor`) and `develop_sized`
/// (which runs this stage *before* its later `max_long_edge` downsample
/// — see that call site) each only ever land on 1.0 (Full/Amaze) or 0.5
/// (Preview quality, or `develop_sized`'s #1637 demosaic-half fallback
/// for a small target) — not an arbitrary viewport-cap ratio. A future
/// caller passing a genuinely arbitrary scale is still safe: the
/// trailing clamp below holds regardless.
///
/// Each field rounds independently, which can — at odd rounding
/// boundaries — push `left + width` or `top + height` one past the
/// buffer's actual extent. The trailing clamp against `image_width` /
/// `image_height` is defense-in-depth so a caller's `aa` always fits the
/// buffer `apply_opcode_list3` is about to walk, instead of indexing out
/// of bounds (see the regression this fixes: an unscaled full-raw-width
/// `ActiveArea` applied to a Preview-quality half-res buffer).
pub fn scale_active_area(
    aa: ActiveAreaRect,
    scale: f32,
    image_width: u32,
    image_height: u32,
) -> ActiveAreaRect {
    let scaled = if (scale - 1.0).abs() <= 1e-4 {
        aa
    } else {
        ActiveAreaRect {
            top: ((aa.top as f32) * scale).round() as u32,
            left: ((aa.left as f32) * scale).round() as u32,
            width: ((aa.width as f32) * scale).round() as u32,
            height: ((aa.height as f32) * scale).round() as u32,
        }
    };
    let top = scaled.top.min(image_height);
    let left = scaled.left.min(image_width);
    ActiveAreaRect {
        top,
        left,
        width: scaled.width.min(image_width.saturating_sub(left)),
        height: scaled.height.min(image_height.saturating_sub(top)),
    }
}

/// Apply a parsed `OpcodeList3` to a demosaiced linear image, in list
/// order. Returns human-readable labels of what ran (for the ingest
/// report / CLI surfacing).
pub fn apply_opcode_list3(
    image: &mut Image,
    list: &OpcodeList3,
    aa: ActiveAreaRect,
) -> Vec<String> {
    let mut applied = Vec::with_capacity(list.opcodes.len());
    for op in &list.opcodes {
        match op {
            PanoOpcode::GainMap(gm) => {
                apply_gain_map(image, gm, aa);
                applied.push(format!(
                    "GainMap({}x{}x{})",
                    gm.points_v, gm.points_h, gm.map_planes
                ));
            }
            PanoOpcode::WarpRectilinear(w) => {
                apply_warp_rectilinear(image, w, aa);
                applied.push(format!("WarpRectilinear({} planes)", w.planes.len()));
            }
        }
    }
    applied
}

/// Multiply the gain lattice over the opcode's area rect, in place.
pub fn apply_gain_map(image: &mut Image, gm: &GainMapOpcode, aa: ActiveAreaRect) {
    let width = image.width as usize;
    // Area rect ∩ active area, in ActiveArea-relative coordinates.
    let row_end = gm.bottom.min(aa.height) as usize;
    let col_end = gm.right.min(aa.width) as usize;
    let row_start = gm.top as usize;
    let col_start = gm.left as usize;
    if row_start >= row_end || col_start >= col_end {
        return;
    }
    // Image planes covered: [plane, plane + planes) ∩ [0, 3).
    let plane_start = gm.plane.min(3) as usize;
    let plane_end = (gm.plane.saturating_add(gm.planes)).min(3) as usize;
    if plane_start >= plane_end {
        return;
    }
    let inv_h = 1.0 / aa.height as f64;
    let inv_w = 1.0 / aa.width as f64;
    let (aa_top, aa_left) = (aa.top as usize, aa.left as usize);
    let row_pitch = gm.row_pitch as usize;
    let col_pitch = gm.col_pitch as usize;

    image
        .pixels
        .par_chunks_mut(width)
        .skip(aa_top + row_start)
        .take(row_end - row_start)
        .enumerate()
        .for_each(|(i, row_px)| {
            let row = row_start + i; // ActiveArea-relative row index
            if (row - row_start) % row_pitch != 0 {
                return;
            }
            let map_v = (row as f64 + 0.5) * inv_h;
            let grid_v = (map_v - gm.origin_v) / gm.spacing_v;
            for col in (col_start..col_end).step_by(col_pitch) {
                let map_h = (col as f64 + 0.5) * inv_w;
                let grid_h = (map_h - gm.origin_h) / gm.spacing_h;
                let px = &mut row_px[aa_left + col];
                for p in plane_start..plane_end {
                    let map_plane = (p as u32).min(gm.map_planes - 1);
                    px[p] *= sample_lattice(gm, grid_v, grid_h, map_plane);
                }
            }
        });
}

/// Bilinear lattice lookup at fractional grid coords, edge-clamped
/// (dng_sdk `dng_gain_map_interpolator` semantics).
fn sample_lattice(gm: &GainMapOpcode, grid_v: f64, grid_h: f64, map_plane: u32) -> f32 {
    let max_v = (gm.points_v - 1) as f64;
    let max_h = (gm.points_h - 1) as f64;
    let v = grid_v.clamp(0.0, max_v);
    let h = grid_h.clamp(0.0, max_h);
    let v0 = v.floor() as usize;
    let h0 = h.floor() as usize;
    let v1 = (v0 + 1).min((gm.points_v - 1) as usize);
    let h1 = (h0 + 1).min((gm.points_h - 1) as usize);
    let fv = (v - v0 as f64) as f32;
    let fh = (h - h0 as f64) as f32;
    let at = |vv: usize, hh: usize| -> f32 {
        gm.gains[(vv * gm.points_h as usize + hh) * gm.map_planes as usize + map_plane as usize]
    };
    let top = at(v0, h0) + (at(v0, h1) - at(v0, h0)) * fh;
    let bot = at(v1, h0) + (at(v1, h1) - at(v1, h0)) * fh;
    top + (bot - top) * fv
}

/// Resample the active area through the rectilinear warp model:
/// for each output pixel, evaluate the corrected→uncorrected mapping
/// per plane and bilinear-sample the input. Pixels outside the active
/// area pass through unchanged.
pub fn apply_warp_rectilinear(image: &mut Image, warp: &WarpRectilinearOpcode, aa: ActiveAreaRect) {
    let width = image.width as usize;
    let (aa_w, aa_h) = (aa.width as f64, aa.height as f64);
    // Optical center in ActiveArea pixel coordinates: Lerp(0, dim, c),
    // dng_sdk convention (integer pixel indices as positions).
    let cx = warp.center_x * aa_w;
    let cy = warp.center_y * aa_h;
    // Normalization radius: max distance from the center to the four
    // corners of the active bounds (dng_sdk `MaxDistancePointToRect`,
    // square pixels).
    let norm_radius = f64::hypot(
        cx.abs().max((aa_w - cx).abs()),
        cy.abs().max((aa_h - cy).abs()),
    );
    if norm_radius <= 0.0 {
        return;
    }
    let inv_r = 1.0 / norm_radius;
    // Per image plane, the coefficient set (N = 1 broadcasts).
    let set_for = |p: usize| warp.planes[p.min(warp.planes.len() - 1)];
    let plane_sets: [super::opcodes::WarpPlaneParams; 3] = [set_for(0), set_for(1), set_for(2)];
    let all_same = plane_sets[1] == plane_sets[0] && plane_sets[2] == plane_sets[0];

    let src = image.pixels.clone(); // gather source (warp can't run in place)
    let (aa_top, aa_left) = (aa.top as usize, aa.left as usize);
    let (aa_wu, aa_hu) = (aa.width as usize, aa.height as usize);

    image
        .pixels
        .par_chunks_mut(width)
        .skip(aa_top)
        .take(aa_hu)
        .enumerate()
        .for_each(|(row, row_px)| {
            let dy = row as f64 - cy;
            for col in 0..aa_wu {
                let dx = col as f64 - cx;
                let out = &mut row_px[aa_left + col];
                if all_same {
                    let (sx, sy) = warp_source(&plane_sets[0], dx, dy, cx, cy, inv_r, norm_radius);
                    *out = bilinear_aa(&src, width, aa_top, aa_left, aa_wu, aa_hu, sx, sy);
                } else {
                    for (p, set) in plane_sets.iter().enumerate() {
                        let (sx, sy) = warp_source(set, dx, dy, cx, cy, inv_r, norm_radius);
                        out[p] =
                            bilinear_aa_ch(&src, width, aa_top, aa_left, aa_wu, aa_hu, sx, sy, p);
                    }
                }
            }
        });
}

/// The corrected→uncorrected position mapping for one plane, in
/// ActiveArea pixel coordinates (dng_sdk `GetSrcPixelPosition`, square
/// pixels): radial ratio polynomial + tangential terms in normalized
/// units, scaled back by the normalization radius.
#[inline]
fn warp_source(
    set: &super::opcodes::WarpPlaneParams,
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

/// Bilinear sample at continuous ActiveArea coords, sticky-edge clamped
/// to the active rect (dng_sdk boundary behavior).
#[inline]
fn bilinear_aa(
    src: &[[f32; 3]],
    width: usize,
    aa_top: usize,
    aa_left: usize,
    aa_w: usize,
    aa_h: usize,
    x: f64,
    y: f64,
) -> [f32; 3] {
    let x = x.clamp(0.0, (aa_w - 1) as f64);
    let y = y.clamp(0.0, (aa_h - 1) as f64);
    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;
    let x1 = (x0 + 1).min(aa_w - 1);
    let y1 = (y0 + 1).min(aa_h - 1);
    let fx = (x - x0 as f64) as f32;
    let fy = (y - y0 as f64) as f32;
    let at = |yy: usize, xx: usize| src[(aa_top + yy) * width + aa_left + xx];
    let (p00, p01, p10, p11) = (at(y0, x0), at(y0, x1), at(y1, x0), at(y1, x1));
    let mut out = [0.0f32; 3];
    for c in 0..3 {
        let top = p00[c] + (p01[c] - p00[c]) * fx;
        let bot = p10[c] + (p11[c] - p10[c]) * fx;
        out[c] = top + (bot - top) * fy;
    }
    out
}

/// Single-channel variant of [`bilinear_aa`] for the per-plane (lateral
/// CA) warp path, where each channel samples a different position.
#[inline]
#[allow(clippy::too_many_arguments)] // mirrors bilinear_aa's geometry args + channel
fn bilinear_aa_ch(
    src: &[[f32; 3]],
    width: usize,
    aa_top: usize,
    aa_left: usize,
    aa_w: usize,
    aa_h: usize,
    x: f64,
    y: f64,
    c: usize,
) -> f32 {
    let x = x.clamp(0.0, (aa_w - 1) as f64);
    let y = y.clamp(0.0, (aa_h - 1) as f64);
    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;
    let x1 = (x0 + 1).min(aa_w - 1);
    let y1 = (y0 + 1).min(aa_h - 1);
    let fx = (x - x0 as f64) as f32;
    let fy = (y - y0 as f64) as f32;
    let at = |yy: usize, xx: usize| src[(aa_top + yy) * width + aa_left + xx][c];
    let top = at(y0, x0) + (at(y0, x1) - at(y0, x0)) * fx;
    let bot = at(y1, x0) + (at(y1, x1) - at(y1, x0)) * fx;
    top + (bot - top) * fy
}

#[cfg(test)]
mod tests;
