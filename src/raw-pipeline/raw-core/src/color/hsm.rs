//! DNG ProfileHueSatMap (HSM) and ProfileLookTable (PLT) — DNG 1.6 § 6.6 / § 6.7.
//!
//! Both tags ship a 3D LUT keyed on (hue, sat, val) with three outputs per
//! lattice entry: hueDelta in degrees, satScale, valScale (all multiplicative
//! except hueDelta which is additive on hue). HSM and PLT share this table
//! shape and the HSV-space correction model, but differ in two ways — the
//! pipeline stage they run at AND the interpolation kernel:
//!
//! * **HSM** runs as part of the camera-RGB → working-RGB transform, via the
//!   **trilinear** lookup in this module. The "value" axis indexes the
//!   camera-RGB max channel (in either Linear or sRGB space per
//!   `ProfileHueSatMapEncoding`). Two-illuminant profiles ship
//!   `ProfileHueSatMapData1` + `ProfileHueSatMapData2` and must be
//!   reciprocal-CCT lerped per spec § 6.6.5 — same shape as the calibration
//!   matrix interpolation in `dcp::interpolate_cm`.
//! * **PLT** runs after working-RGB is built (post-DCP, before user
//!   adjustments), via **tetrahedral** interpolation
//!   (`dcp::apply_look_table` / `lookup_tetrahedral`), not the trilinear
//!   kernel here. Single table; encoding via `ProfileLookTableEncoding`.
//!   Currently dead pending #1691 Phase 2.
//!
//! ## RGB ↔ HSV
//!
//! Standard max/min algorithm (HSV cylindrical). Hue is in degrees [0, 360);
//! saturation and value in [0, 1] for the Linear case (in [0, ∞) when an HDR
//! pixel exceeds 1.0; the spec doesn't clamp inputs but the output `val` is
//! still indexed mod the `[0, 1]` table range, with multiplicative `valScale`
//! preserving the magnitude). For the `Srgb` encoding we apply a sRGB→linear
//! decode on the per-channel value before HSV decomposition (spec § 6.6.4).
//!
//! ## Trilinear interpolation
//!
//! Hue wraps circularly; sat and val clamp. Index computation matches the DNG
//! SDK reference (`dng_hue_sat_map.cpp::Interpolate`).

use crate::image::{ColorSpace, Image};
use rayon::prelude::*;

/// Saturation at which the near-neutral hue/scale fade reaches full strength.
/// Emitted to the GPU color header by codegen (#4629).
pub const ACHROMATIC_SATURATION: f32 = 0.01;
/// Chroma and channel-tie threshold in the shared RGB-to-HSV conversion.
pub const HSV_DELTA_EPSILON: f32 = 1e-9;

/// Encoding of the value (V) axis input. Default is Linear when the
/// ProfileHueSatMapEncoding / ProfileLookTableEncoding tag is absent
/// (DNG 1.6 § 6.6.4 / § 6.7.4).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum HsmEncoding {
    /// Value axis indexed in scene-linear space.
    Linear,
    /// Value axis indexed in sRGB-encoded space. Pixel value is sRGB-encoded
    /// before HSV decomposition, then sRGB-decoded after recomposition.
    Srgb,
}

impl HsmEncoding {
    /// Map a u32 from the ProfileHueSatMapEncoding tag to a variant. Per DNG
    /// 1.6 § 6.6.4 the values are 0 = Linear, 1 = sRGB.
    pub fn from_u32(v: u32) -> Self {
        match v {
            1 => Self::Srgb,
            _ => Self::Linear,
        }
    }
}

/// One ProfileHueSatMap or ProfileLookTable, fully expanded.
#[derive(Clone, Debug)]
pub struct HsmTable {
    /// `[hueDivs, satDivs, valDivs]`. valDivs == 1 means the LUT is 2D (no
    /// value-axis variation; just hue and sat). HueDivs typically 36 / 90,
    /// satDivs typically 8 / 30, valDivs 1 / 8 / 16.
    pub dims: [u32; 3],
    /// Length = `dims[0] * dims[1] * dims[2] * 3`. Per-entry layout is
    /// `[hueDeltaDeg, satScale, valScale]`. Major dimensions per DNG SDK
    /// reference: hue is most-major (slowest changing), sat next, val
    /// fastest-changing (innermost). Entry index for (h, s, v) =
    /// `((h * satDivs + s) * valDivs + v) * 3`.
    pub data: Vec<f32>,
    /// Encoding of the value axis for index computation.
    pub encoding: HsmEncoding,
}

impl HsmTable {
    /// Construct, validating `data.len() == hue * sat * val * 3`.
    pub fn new(dims: [u32; 3], data: Vec<f32>, encoding: HsmEncoding) -> Option<Self> {
        let expected = (dims[0] as usize) * (dims[1] as usize) * (dims[2] as usize) * 3;
        if data.len() != expected || dims[0] == 0 || dims[1] == 0 || dims[2] == 0 {
            return None;
        }
        Some(Self {
            dims,
            data,
            encoding,
        })
    }

    /// Fetch the (hueDelta, satScale, valScale) at lattice index `(h, s, v)`.
    /// Caller's responsibility to respect dim bounds.
    #[inline]
    fn entry(&self, h: usize, s: usize, v: usize) -> [f32; 3] {
        let sat_d = self.dims[1] as usize;
        let val_d = self.dims[2] as usize;
        let i = ((h * sat_d + s) * val_d + v) * 3;
        [self.data[i], self.data[i + 1], self.data[i + 2]]
    }
}

/// Interpolate two HSM tables of identical shape and encoding, per
/// reciprocal-CCT (spec § 6.6.5). Returns `None` if the two tables have
/// different dims or encodings (caller should fall back to whichever is
/// available).
///
/// `t` is the same lerp parameter the DCP path uses:
/// `((1/cct_target - 1/cct_cold) / (1/cct_warm - 1/cct_cold)).clamp(0,1)`.
pub fn lerp_tables(cold: &HsmTable, warm: &HsmTable, t: f32) -> Option<HsmTable> {
    if cold.dims != warm.dims || cold.encoding != warm.encoding {
        return None;
    }
    let t = t.clamp(0.0, 1.0);
    let n = cold.data.len();
    let mut data = Vec::with_capacity(n);
    // Hue lerp wraps mod 360 — pick the shorter arc so a 359° → 1° gap reads
    // as 2°, not 358°.
    for i in 0..n {
        let a = cold.data[i];
        let b = warm.data[i];
        let v = if i % 3 == 0 {
            // hueDelta channel — circular shortest-arc lerp
            let mut diff = b - a;
            if diff > 180.0 {
                diff -= 360.0;
            }
            if diff < -180.0 {
                diff += 360.0;
            }
            let mut out = a + t * diff;
            if out > 360.0 {
                out -= 360.0;
            }
            if out < -360.0 {
                out += 360.0;
            }
            out
        } else {
            (1.0 - t) * a + t * b
        };
        data.push(v);
    }
    HsmTable::new(cold.dims, data, cold.encoding)
}

/// Apply the table to an `Image` in-place. The image's color space is
/// preserved — HSM/PLT operate on the channels they receive without
/// re-tagging.
///
/// Per DNG 1.6 § 6.6.4: when `encoding == Srgb`, the per-channel pixel
/// value is sRGB-encoded before HSV decomposition and sRGB-decoded after
/// HSV recomposition. We use the standard piecewise sRGB transfer.
///
/// Per DNG 1.6 § 6.6.2, HSV decomposition isn't well-defined for negative
/// R/G/B components (saturation drops out of [0, 1]). Rather than bypass
/// such pixels unchanged — which left a discontinuity/banding seam at the
/// gamut boundary (#1682) — the body applies a *soft lift* (#1703): the
/// most-negative component is offset up to zero before decomposition and
/// the same offset is subtracted back afterward, keeping the out-of-gamut
/// wide-gamut tail intact without a hard branch.
#[inline]
pub fn apply_one(p: [f32; 3], table: &HsmTable) -> [f32; 3] {
    // 0. Perform a soft lift for negative components instead of an abrupt bypass
    let min_original = p[0].min(p[1]).min(p[2]);
    let lift = if min_original < 0.0 {
        -min_original
    } else {
        0.0
    };
    let mut rgb = [p[0] + lift, p[1] + lift, p[2] + lift];

    // 1. Pre-encode if sRGB (operates on each channel independently).
    if matches!(table.encoding, HsmEncoding::Srgb) {
        rgb[0] = linear_to_srgb_one(rgb[0]);
        rgb[1] = linear_to_srgb_one(rgb[1]);
        rgb[2] = linear_to_srgb_one(rgb[2]);
    }
    // 2. RGB → HSV.
    let (h, s, v) = rgb_to_hsv(rgb);
    // 3. Lookup (hueDelta, satScale, valScale) via trilinear interp.
    let (hd, ss, vs) = lookup(table, h, s, v);

    // Achromatic singularity blend: smoothly fade shifts to identity near zero saturation.
    // This prevents wild hue swings from introducing step discontinuities in brightness.
    let w_chroma = (s / ACHROMATIC_SATURATION).clamp(0.0, 1.0);
    let hd = hd * w_chroma;
    let ss = 1.0 + (ss - 1.0) * w_chroma;
    let vs = 1.0 + (vs - 1.0) * w_chroma;
    // 4. Apply.
    let mut new_h = h + hd;
    // Wrap mod 360.
    new_h = new_h.rem_euclid(360.0);
    let new_s = (s * ss).clamp(0.0, 1.0);
    let new_v = (v * vs).max(0.0);
    // 5. HSV → RGB.
    let mut out = hsv_to_rgb(new_h, new_s, new_v);
    // 6. Post-decode if sRGB.
    if matches!(table.encoding, HsmEncoding::Srgb) {
        out[0] = srgb_to_linear_one(out[0]);
        out[1] = srgb_to_linear_one(out[1]);
        out[2] = srgb_to_linear_one(out[2]);
    }

    // 7. Restore original negative offset to preserve original out-of-gamut coordinate
    if lift > 0.0 {
        [out[0] - lift, out[1] - lift, out[2] - lift]
    } else {
        out
    }
}

pub fn apply(img: &mut Image, table: &HsmTable) {
    img.pixels.par_iter_mut().for_each(|p| {
        *p = apply_one(*p, table);
    });
}

/// Apply with an explicit input/output color-space assertion. Used by call
/// sites that want the safety net at the type boundary.
pub fn apply_with_space(img: &mut Image, table: &HsmTable, expected: ColorSpace) {
    img.assert_space(expected);
    apply(img, table);
}

/// Invert HSM on a single ProPhoto D50 RGB pixel.
/// Finds `orig` such that applying `table` to `orig` yields `rgb`.
pub fn invert_one(rgb: [f32; 3], table: &HsmTable) -> [f32; 3] {
    let mut x = rgb;
    for _ in 0..4 {
        let y = apply_one(x, table);
        x[0] += rgb[0] - y[0];
        x[1] += rgb[1] - y[1];
        x[2] += rgb[2] - y[2];
    }
    x
}

// ── HSV ↔ RGB ────────────────────────────────────────────────────────────────

/// Convert an [r, g, b] triple to (hue°, sat, val). Standard cylindrical
/// algorithm (max/min). Hue ∈ [0, 360), sat ∈ [0, 1] when val > 0, val ∈ [0, ∞).
#[inline]
pub fn rgb_to_hsv(rgb: [f32; 3]) -> (f32, f32, f32) {
    let r = rgb[0];
    let g = rgb[1];
    let b = rgb[2];
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    let v = max;

    let s = if max > 0.0 { delta / max } else { 0.0 };

    let h = if s <= 0.0 || delta < HSV_DELTA_EPSILON {
        0.0
    } else if (max - r).abs() < HSV_DELTA_EPSILON {
        60.0 * ((g - b) / delta).rem_euclid(6.0)
    } else if (max - g).abs() < HSV_DELTA_EPSILON {
        60.0 * (((b - r) / delta) + 2.0)
    } else {
        60.0 * (((r - g) / delta) + 4.0)
    };
    let h = if h < 0.0 {
        h + 360.0
    } else if h >= 360.0 {
        h - 360.0
    } else {
        h
    };
    (h, s, v)
}

/// Convert (hue°, sat, val) back to [r, g, b]. Inverse of `rgb_to_hsv`.
#[inline]
pub fn hsv_to_rgb(h: f32, s: f32, v: f32) -> [f32; 3] {
    if s <= 0.0 {
        return [v, v, v];
    }
    let h = h.rem_euclid(360.0);
    let c = v * s;
    let h6 = h / 60.0;
    let x = c * (1.0 - ((h6 % 2.0) - 1.0).abs());
    let (r1, g1, b1) = if h6 < 1.0 {
        (c, x, 0.0)
    } else if h6 < 2.0 {
        (x, c, 0.0)
    } else if h6 < 3.0 {
        (0.0, c, x)
    } else if h6 < 4.0 {
        (0.0, x, c)
    } else if h6 < 5.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    let m = v - c;
    [r1 + m, g1 + m, b1 + m]
}

// ── sRGB transfer (piecewise) ───────────────────────────────────────────────
// Used only when HsmEncoding::Srgb. IEC 61966-2-1.

#[inline]
fn srgb_to_linear_one(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

#[inline]
fn linear_to_srgb_one(v: f32) -> f32 {
    let v = v.max(0.0);
    if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

// ── Trilinear lookup ────────────────────────────────────────────────────────

/// Look up (hueDelta, satScale, valScale) via trilinear interpolation.
/// Hue dimension wraps circularly; sat and val clamp at the edges.
fn lookup(table: &HsmTable, hue: f32, sat: f32, val: f32) -> (f32, f32, f32) {
    let hd = table.dims[0] as i32;
    let sd = table.dims[1] as i32;
    let vd = table.dims[2] as i32;

    // Hue: full 360° range maps onto `hd` cells (each cell is 360/hd wide),
    // wrapping at the seam. Index space is `hue * hd / 360`.
    let h_pos = (hue / 360.0) * hd as f32;
    let h_lo = h_pos.floor() as i32;
    let h_frac = h_pos - h_lo as f32;
    // Wrap into [0, hd).
    let h0 = h_lo.rem_euclid(hd);
    let h1 = (h_lo + 1).rem_euclid(hd);

    // Sat: clamp into [0, sd-1]. Last lattice point sits at sat=1.0.
    let s_pos = sat.clamp(0.0, 1.0) * (sd - 1) as f32;
    let s_lo = s_pos.floor() as i32;
    let s_frac = s_pos - s_lo as f32;
    let s0 = s_lo.clamp(0, sd - 1);
    let s1 = (s_lo + 1).clamp(0, sd - 1);

    // Val: same clamp as sat. valDivs == 1 collapses the val axis (no lerp).
    let (v0, v1, v_frac) = if vd <= 1 {
        (0, 0, 0.0)
    } else {
        let v_pos = val.clamp(0.0, 1.0) * (vd - 1) as f32;
        let v_lo = v_pos.floor() as i32;
        let v_frac = v_pos - v_lo as f32;
        let v0 = v_lo.clamp(0, vd - 1);
        let v1 = (v_lo + 1).clamp(0, vd - 1);
        (v0, v1, v_frac)
    };

    // Eight-corner entries.
    let c000 = table.entry(h0 as usize, s0 as usize, v0 as usize);
    let c100 = table.entry(h1 as usize, s0 as usize, v0 as usize);
    let c010 = table.entry(h0 as usize, s1 as usize, v0 as usize);
    let c110 = table.entry(h1 as usize, s1 as usize, v0 as usize);
    let c001 = table.entry(h0 as usize, s0 as usize, v1 as usize);
    let c101 = table.entry(h1 as usize, s0 as usize, v1 as usize);
    let c011 = table.entry(h0 as usize, s1 as usize, v1 as usize);
    let c111 = table.entry(h1 as usize, s1 as usize, v1 as usize);

    // Unwrap hue coordinates relative to c000[0] so standard linear combination preserves shortest-arc.
    let unwrap_hue = |val: f32, ref_val: f32| -> f32 {
        let mut diff = val - ref_val;
        if diff > 180.0 {
            diff -= 360.0;
        }
        if diff < -180.0 {
            diff += 360.0;
        }
        ref_val + diff
    };

    let h000_u = c000[0];
    let h100_u = unwrap_hue(c100[0], h000_u);
    let h010_u = unwrap_hue(c010[0], h000_u);
    let h110_u = unwrap_hue(c110[0], h000_u);
    let h001_u = unwrap_hue(c001[0], h000_u);
    let h101_u = unwrap_hue(c101[0], h000_u);
    let h011_u = unwrap_hue(c011[0], h000_u);
    let h111_u = unwrap_hue(c111[0], h000_u);

    let fx = h_frac;
    let fy = s_frac;
    let fz = v_frac;

    let mut out = [0.0f32; 3];
    for c in 0..3 {
        let (val000, val100, val010, val110, val001, val101, val011, val111) = if c == 0 {
            (
                h000_u, h100_u, h010_u, h110_u, h001_u, h101_u, h011_u, h111_u,
            )
        } else {
            (
                c000[c], c100[c], c010[c], c110[c], c001[c], c101[c], c011[c], c111[c],
            )
        };

        // DNG RefBaselineHueSatMap interpolates along each axis (#4631).
        // Preserve constant hue exactly (#4629): a weighted sum can round
        // +180 above the signed-wrap boundary, reversing the subsequent
        // achromatic fade. Difference-form interpolation has zero correction
        // for equal endpoints. Keep the existing scale-channel arithmetic.
        let lerp = |a: f32, b: f32, t: f32| {
            if c == 0 {
                a + (b - a) * t
            } else {
                a * (1.0 - t) + b * t
            }
        };
        let lo0 = lerp(val000, val100, fx);
        let lo1 = lerp(val010, val110, fx);
        let hi0 = lerp(val001, val101, fx);
        let hi1 = lerp(val011, val111, fx);
        let low = lerp(lo0, lo1, fy);
        let high = lerp(hi0, hi1, fy);
        out[c] = lerp(low, high, fz);
    }

    // `out[0]` is the interpolated hueDelta (an *additive*, signed hue offset
    // in degrees). Return it in a signed `[-180, 180]` range rather than the
    // wrapped `[0, 360)` (#1924): the caller (`apply`) *scales* this delta by
    // the achromatic low-saturation fade weight (`hd * w_chroma`), and scaling
    // is not invariant under modular wrap — a `-10°` delta wrapped to `350°`
    // and scaled by 0.5 would give `175°` instead of the correct `-5°`.
    // Additive use downstream (`h + hd`, then `rem_euclid`) is unaffected by
    // the signed form.
    //
    // Use the sign-preserving remainder `%` (range `(-360, 360)`), NOT
    // `rem_euclid` (range `[0, 360)`): `rem_euclid` maps an exact `-180` to
    // `+180`, a boundary sign flip that the `hd * w_chroma` scale would then
    // propagate (`-180·0.5 = -90` vs the wrong `+180·0.5 = +90`). A single
    // ±360 fold then lands any magnitude in `[-180, 180]`, mapping `-180 → -180`
    // and `+180 → +180` while still wrapping `350 → -10`, `-350 → 10`.
    let m = out[0] % 360.0;
    let signed_hue_delta = if m > 180.0 {
        m - 360.0
    } else if m < -180.0 {
        m + 360.0
    } else {
        m
    };
    (signed_hue_delta, out[1], out[2])
}

#[cfg(test)]
#[path = "hsm_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "hsm_interpolation_tests.rs"]
mod hsm_interpolation_tests;
