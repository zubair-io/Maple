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
use crate::types::adjustment::{AdjustmentModel, LensProfileEnable};

use super::opcodes::{
    ActiveAreaRect, FixVignetteRadialOpcode, GainMapOpcode, OpcodeList3, PanoOpcode,
    WarpRectilinearOpcode,
};

/// User strength for each family of lens correction the DNG carries, as a
/// `0..=1` fraction of the vendor's authored correction (#376). Mirrors
/// ACR's `crs:LensProfile{Distortion,ChromaticAberration,Vignetting}Scale`
/// trio, which is expressed `0..100` on the model.
///
/// Each field blends the corresponding opcode toward identity, and every
/// blend is written so that a full-strength scale reproduces the
/// vendor-authored math *bit-for-bit* (`1.0 * x + 0.0`), not merely to
/// within rounding — the default model applies the corrections exactly as
/// it did before this type existed, so the parity harness sees no
/// perturbation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LensCorrectionScales {
    /// Geometric distortion — the warp component common to all planes.
    pub distortion: f32,
    /// Lateral chromatic aberration — each plane's warp *deviation* from
    /// the green reference plane.
    pub ca: f32,
    /// Vignetting / lens shading — the `FixVignetteRadial` and `GainMap`
    /// gain opcodes.
    pub vignetting: f32,
}

impl LensCorrectionScales {
    /// Apply every correction at the strength the vendor authored.
    pub const FULL: Self = Self {
        distortion: 1.0,
        ca: 1.0,
        vignetting: 1.0,
    };

    /// Apply nothing — every opcode is skipped.
    pub const NONE: Self = Self {
        distortion: 0.0,
        ca: 0.0,
        vignetting: 0.0,
    };

    /// Resolve the user's `AdjustmentModel` into `0..=1` fractions.
    /// `lens_profile_enable == Off` is the master switch ACR writes as
    /// `crs:LensProfileEnable="0"` and overrides the three scales.
    pub fn from_model(model: &AdjustmentModel) -> Self {
        if model.lens_profile_enable == LensProfileEnable::Off {
            return Self::NONE;
        }
        let frac = |v: f32| v.clamp(0.0, 100.0) / 100.0;
        Self {
            distortion: frac(model.lens_correction_distortion),
            ca: frac(model.lens_correction_ca),
            vignetting: frac(model.lens_correction_vignetting),
        }
    }
}

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
/// order, at the user's per-family strength. Returns human-readable labels
/// of what ran (for the ingest report / CLI surfacing); an opcode the
/// scales reduce to a no-op is skipped and not reported.
pub fn apply_opcode_list3(
    image: &mut Image,
    list: &OpcodeList3,
    aa: ActiveAreaRect,
    scales: LensCorrectionScales,
) -> Vec<String> {
    let mut applied = Vec::with_capacity(list.opcodes.len());
    for op in &list.opcodes {
        match op {
            PanoOpcode::GainMap(gm) if scales.vignetting != 0.0 => {
                apply_gain_map(image, gm, aa, scales.vignetting);
                applied.push(format!(
                    "GainMap({}x{}x{})",
                    gm.points_v, gm.points_h, gm.map_planes
                ));
            }
            PanoOpcode::WarpRectilinear(w) if scales.distortion != 0.0 || scales.ca != 0.0 => {
                apply_warp_rectilinear(image, w, aa, scales.distortion, scales.ca);
                applied.push(format!("WarpRectilinear({} planes)", w.planes.len()));
            }
            PanoOpcode::FixVignetteRadial(v) if scales.vignetting != 0.0 => {
                apply_fix_vignette_radial(image, v, aa, scales.vignetting);
                applied.push("FixVignetteRadial".to_string());
            }
            // Scaled to zero — the correction is exactly the identity, so
            // skip the pass rather than resample/multiply by 1.
            _ => {}
        }
    }
    applied
}

/// Multiply the gain lattice over the opcode's area rect, in place.
///
/// `vignetting` blends each sampled gain toward 1.0 as `v·g + (1 − v)` —
/// exact at both ends (`v = 1` reproduces `g` bit-for-bit; `v = 0` yields
/// exactly 1.0). Bilinear lattice interpolation is affine, so blending the
/// interpolated gain is identical to blending the lattice up front.
pub fn apply_gain_map(image: &mut Image, gm: &GainMapOpcode, aa: ActiveAreaRect, vignetting: f32) {
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
                    let gain = sample_lattice(gm, grid_v, grid_h, map_plane);
                    px[p] *= vignetting.mul_add(gain, 1.0 - vignetting);
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

/// The `WarpRectilinear` coefficient set that maps every position to
/// itself: unit radial ratio, no tangential terms.
const IDENTITY_WARP_KR: [f64; 4] = [1.0, 0.0, 0.0, 0.0];

/// Blend one plane's warp toward the identity at the user's distortion /
/// CA strengths (#376).
///
/// The source-position displacement `Δ(K) = warp_source(K) − position` is
/// **affine in the coefficient set `K`** about the identity set (the radial
/// ratio is linear in `kr`, the tangential terms are linear in `kt`), so
/// blending coefficient sets once per plane is exactly equivalent to
/// blending the per-pixel displacements — at zero per-pixel cost.
///
/// The blend splits the vendor's warp into the part common to every plane
/// (geometric distortion, carried by the green reference set `g`) and each
/// plane's deviation from it (lateral CA):
///
/// ```text
/// Δ' = distortion·Δ(g) + ca·(Δ(p) − Δ(g))
///    = ca·Δ(p) + (distortion − ca)·Δ(g)
/// ```
///
/// The second form is the one evaluated here because it is exact at the
/// default: with `distortion == ca == 1.0` every coefficient reduces to
/// `1.0·p + 0.0·g + 0.0·identity`, i.e. `p` itself, bit-for-bit.
fn blend_warp_toward_identity(
    plane: &super::opcodes::WarpPlaneParams,
    green: &super::opcodes::WarpPlaneParams,
    distortion: f64,
    ca: f64,
) -> super::opcodes::WarpPlaneParams {
    let common = distortion - ca;
    let identity_weight = 1.0 - distortion;
    super::opcodes::WarpPlaneParams {
        kr: std::array::from_fn(|i| {
            ca * plane.kr[i] + common * green.kr[i] + identity_weight * IDENTITY_WARP_KR[i]
        }),
        // The identity set has no tangential terms, so it contributes nothing.
        kt: std::array::from_fn(|i| ca * plane.kt[i] + common * green.kt[i]),
    }
}

/// Resample the active area through the rectilinear warp model:
/// for each output pixel, evaluate the corrected→uncorrected mapping
/// per plane and bilinear-sample the input. Pixels outside the active
/// area pass through unchanged.
///
/// `distortion` and `ca` are `0..=1` strengths (see
/// [`LensCorrectionScales`]); both at 1.0 is the vendor-authored warp.
pub fn apply_warp_rectilinear(
    image: &mut Image,
    warp: &WarpRectilinearOpcode,
    aa: ActiveAreaRect,
    distortion: f32,
    ca: f32,
) {
    // Both families scaled off: the blended warp is exactly the identity
    // and the resample would be a no-op — skip the whole pass.
    if distortion == 0.0 && ca == 0.0 {
        return;
    }
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
    // Per image plane, the coefficient set (N = 1 broadcasts), blended
    // toward identity at the user's distortion / CA strengths. Plane 1
    // (green) is the reference the distortion component is carried by;
    // with N = 1 every plane already shares it, so `ca` has nothing to
    // act on and the blend collapses to a pure distortion scale.
    let set_for = |p: usize| warp.planes[p.min(warp.planes.len() - 1)];
    let green = set_for(1);
    let (d, c) = (distortion as f64, ca as f64);
    let plane_sets: [super::opcodes::WarpPlaneParams; 3] = std::array::from_fn(|p| {
        blend_warp_toward_identity(&set_for(p), &green, d, c)
    });
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

/// Apply a `FixVignetteRadial` opcode: multiply every plane by the radial
/// gain `g(t) = 1 + k0·t + k1·t² + k2·t³ + k3·t⁴ + k4·t⁵`, where `t` is the
/// squared center distance normalized so `t = 1` at the farthest corner of
/// the active area (dng_sdk `dng_vignette_radial_function::Evaluate`).
///
/// Normalization matches [`apply_warp_rectilinear`] exactly — same
/// `Lerp(0, dim, c)` center convention, same max-corner-distance radius,
/// same `t ≤ 1` clamp — so a DNG carrying both opcodes has them anchored
/// to one coordinate system.
///
/// Like [`apply_gain_map`], the multiplied result is **not** clamped:
/// nothing before the view transform may clip (see the module docs).
///
/// `vignetting` is the `0..=1` user strength; the blend `1 + v·poly` is
/// exact at both ends (`v = 1` reproduces the vendor gain bit-for-bit,
/// `v = 0` yields exactly 1.0).
pub fn apply_fix_vignette_radial(
    image: &mut Image,
    op: &FixVignetteRadialOpcode,
    aa: ActiveAreaRect,
    vignetting: f32,
) {
    if vignetting == 0.0 {
        return;
    }
    let width = image.width as usize;
    let (aa_w, aa_h) = (aa.width as f64, aa.height as f64);
    let cx = op.center_x * aa_w;
    let cy = op.center_y * aa_h;
    let norm_radius_sq = f64::hypot(
        cx.abs().max((aa_w - cx).abs()),
        cy.abs().max((aa_h - cy).abs()),
    )
    .powi(2);
    if norm_radius_sq <= 0.0 {
        return;
    }
    let inv_r2 = 1.0 / norm_radius_sq;
    let k = op.k;
    let v = vignetting as f64;
    let (aa_top, aa_left) = (aa.top as usize, aa.left as usize);
    let aa_wu = aa.width as usize;

    image
        .pixels
        .par_chunks_mut(width)
        .skip(aa_top)
        .take(aa.height as usize)
        .enumerate()
        .for_each(|(row, row_px)| {
            let dy = row as f64 - cy;
            let dy2 = dy * dy;
            for col in 0..aa_wu {
                let dx = col as f64 - cx;
                let t = ((dx * dx + dy2) * inv_r2).min(1.0);
                // Horner over t: k0·t + k1·t² + … + k4·t⁵.
                let poly = t * (k[0] + t * (k[1] + t * (k[2] + t * (k[3] + t * k[4]))));
                let gain = v.mul_add(poly, 1.0) as f32;
                let px = &mut row_px[aa_left + col];
                for lane in px.iter_mut() {
                    *lane *= gain;
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
