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
pub fn apply(img: &mut Image, table: &HsmTable) {
    img.pixels.par_iter_mut().for_each(|p| {
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
        let w_chroma = (s / 0.01).clamp(0.0, 1.0);
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
            *p = [out[0] - lift, out[1] - lift, out[2] - lift];
        } else {
            *p = out;
        }
    });
}

/// Apply with an explicit input/output color-space assertion. Used by call
/// sites that want the safety net at the type boundary.
pub fn apply_with_space(img: &mut Image, table: &HsmTable, expected: ColorSpace) {
    img.assert_space(expected);
    apply(img, table);
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

    let h = if s <= 0.0 || delta < 1e-9 {
        0.0
    } else if (max - r).abs() < 1e-9 {
        60.0 * ((g - b) / delta).rem_euclid(6.0)
    } else if (max - g).abs() < 1e-9 {
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

        out[c] = if fx >= fy {
            if fy >= fz {
                val000 * (1.0 - fx) + val100 * (fx - fy) + val110 * (fy - fz) + val111 * fz
            } else if fx >= fz {
                val000 * (1.0 - fx) + val100 * (fx - fz) + val101 * (fz - fy) + val111 * fy
            } else {
                val000 * (1.0 - fz) + val001 * (fz - fx) + val101 * (fx - fy) + val111 * fy
            }
        } else {
            if fx >= fz {
                val000 * (1.0 - fy) + val010 * (fy - fx) + val110 * (fx - fz) + val111 * fz
            } else if fy >= fz {
                val000 * (1.0 - fy) + val010 * (fy - fz) + val011 * (fz - fx) + val111 * fx
            } else {
                val000 * (1.0 - fz) + val001 * (fz - fy) + val011 * (fy - fx) + val111 * fx
            }
        };
    }

    // `out[0]` is the interpolated hueDelta (an *additive*, signed hue offset
    // in degrees). Return it in a signed `[-180, 180]` range rather than the
    // wrapped `[0, 360)` (#1924): the caller (`apply`) *scales* this delta by
    // the achromatic low-saturation fade weight (`hd * w_chroma`), and scaling
    // is not invariant under modular wrap — a `-10°` delta wrapped to `350°`
    // and scaled by 0.5 would give `175°` instead of the correct `-5°`.
    // Additive use downstream (`h + hd`, then `rem_euclid`) is unaffected by
    // the signed form.
    let wrapped = out[0].rem_euclid(360.0);
    let signed_hue_delta = if wrapped > 180.0 {
        wrapped - 360.0
    } else {
        wrapped
    };
    (signed_hue_delta, out[1], out[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32, eps: f32) -> bool {
        (a - b).abs() < eps
    }

    fn approx_rgb(a: [f32; 3], b: [f32; 3], eps: f32) -> bool {
        approx(a[0], b[0], eps) && approx(a[1], b[1], eps) && approx(a[2], b[2], eps)
    }

    // ── HSV ↔ RGB round-trips ─────────────────────────────────────────────────

    #[test]
    fn rgb_to_hsv_pure_red() {
        let (h, s, v) = rgb_to_hsv([1.0, 0.0, 0.0]);
        assert!(approx(h, 0.0, 1e-3));
        assert!(approx(s, 1.0, 1e-3));
        assert!(approx(v, 1.0, 1e-3));
    }

    #[test]
    fn rgb_to_hsv_pure_green() {
        let (h, s, v) = rgb_to_hsv([0.0, 1.0, 0.0]);
        assert!(approx(h, 120.0, 1e-3));
        assert!(approx(s, 1.0, 1e-3));
        assert!(approx(v, 1.0, 1e-3));
    }

    #[test]
    fn rgb_to_hsv_pure_blue() {
        let (h, s, v) = rgb_to_hsv([0.0, 0.0, 1.0]);
        assert!(approx(h, 240.0, 1e-3));
        assert!(approx(s, 1.0, 1e-3));
        assert!(approx(v, 1.0, 1e-3));
    }

    #[test]
    fn rgb_to_hsv_neutral() {
        let (h, s, v) = rgb_to_hsv([0.5, 0.5, 0.5]);
        assert!(
            approx(s, 0.0, 1e-6),
            "neutral has zero saturation; got s={}",
            s
        );
        assert!(approx(v, 0.5, 1e-6));
        let _ = h; // hue is undefined when s == 0
    }

    #[test]
    fn hsv_round_trip_reproduces_rgb() {
        let cases: &[[f32; 3]] = &[
            [0.7, 0.2, 0.1],
            [0.2, 0.6, 0.4],
            [0.05, 0.05, 0.5],
            [0.18, 0.18, 0.18],
            [1.5, 0.3, 0.7], // HDR pixel
        ];
        for &rgb in cases {
            let (h, s, v) = rgb_to_hsv(rgb);
            let back = hsv_to_rgb(h, s, v);
            assert!(
                approx_rgb(back, rgb, 1e-4),
                "round trip fail for {:?}: got {:?}",
                rgb,
                back
            );
        }
    }

    // ── Identity table is a no-op ────────────────────────────────────────────

    fn identity_table(dims: [u32; 3], encoding: HsmEncoding) -> HsmTable {
        let n = (dims[0] * dims[1] * dims[2] * 3) as usize;
        // [0, 1, 1] per entry — no hue shift, no sat scale, no value scale.
        let mut data = Vec::with_capacity(n);
        for _ in 0..(dims[0] * dims[1] * dims[2]) {
            data.push(0.0);
            data.push(1.0);
            data.push(1.0);
        }
        HsmTable::new(dims, data, encoding).expect("identity table dims valid")
    }

    #[test]
    fn identity_2x2x2_is_no_op() {
        let table = identity_table([2, 2, 2], HsmEncoding::Linear);
        let mut img = Image::new(4, 4, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = [
                (i as f32) * 0.05,
                0.5 - (i as f32) * 0.02,
                0.3 + (i as f32) * 0.01,
            ];
        }
        let before = img.pixels.clone();
        apply(&mut img, &table);
        for (b, a) in before.iter().zip(img.pixels.iter()) {
            assert!(
                approx_rgb(*b, *a, 1e-4),
                "identity table mutated pixel: before={:?} after={:?}",
                b,
                a
            );
        }
    }

    #[test]
    fn identity_36x10x1_is_no_op() {
        // Spec-typical DNG HSM table shape.
        let table = identity_table([36, 10, 1], HsmEncoding::Linear);
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.7, 0.2, 0.4];
        img.pixels[1] = [0.18, 0.5, 0.9];
        img.pixels[2] = [0.0, 0.0, 0.0];
        img.pixels[3] = [1.2, 0.3, 0.05];
        let before = img.pixels.clone();
        apply(&mut img, &table);
        for (b, a) in before.iter().zip(img.pixels.iter()) {
            assert!(
                approx_rgb(*b, *a, 1e-3),
                "identity mutated: before={:?} after={:?}",
                b,
                a
            );
        }
    }

    // ── Known-output 2x2x2 LUT ──────────────────────────────────────────────

    #[test]
    fn pure_hue_shift_on_red_at_lattice_point() {
        // 2x2x2 table with all entries = (90° hue shift, 1, 1). Red @ hue 0
        // should land on hue 90°, which is yellow-green.
        let n = 2 * 2 * 2;
        let mut data = Vec::with_capacity(n * 3);
        for _ in 0..n {
            data.push(90.0);
            data.push(1.0);
            data.push(1.0);
        }
        let table = HsmTable::new([2, 2, 2], data, HsmEncoding::Linear).unwrap();
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [1.0, 0.0, 0.0];
        apply(&mut img, &table);
        // Hue 90° at sat 1, val 1 → green-yellow at (0.5, 1, 0).
        let (h, s, v) = rgb_to_hsv(img.pixels[0]);
        assert!(approx(h, 90.0, 0.5), "expected hue ≈90, got {}", h);
        assert!(approx(s, 1.0, 0.01));
        assert!(approx(v, 1.0, 0.01));
    }

    #[test]
    fn pure_sat_scale_halves_chroma() {
        // 2x2x2 with all entries = (0, 0.5, 1) → halves saturation everywhere.
        let n = 2 * 2 * 2;
        let mut data = Vec::with_capacity(n * 3);
        for _ in 0..n {
            data.push(0.0);
            data.push(0.5);
            data.push(1.0);
        }
        let table = HsmTable::new([2, 2, 2], data, HsmEncoding::Linear).unwrap();
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.8, 0.2, 0.2];
        let (_, s_in, _) = rgb_to_hsv(img.pixels[0]);
        apply(&mut img, &table);
        let (_, s_out, _) = rgb_to_hsv(img.pixels[0]);
        assert!(
            approx(s_out, s_in * 0.5, 1e-3),
            "expected sat halved from {} to {}, got {}",
            s_in,
            s_in * 0.5,
            s_out
        );
    }

    #[test]
    fn pure_value_scale_doubles_brightness() {
        // 2x2x2 with all entries = (0, 1, 2) → doubles V everywhere.
        let n = 2 * 2 * 2;
        let mut data = Vec::with_capacity(n * 3);
        for _ in 0..n {
            data.push(0.0);
            data.push(1.0);
            data.push(2.0);
        }
        let table = HsmTable::new([2, 2, 2], data, HsmEncoding::Linear).unwrap();
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.4, 0.1, 0.1];
        apply(&mut img, &table);
        // V was 0.4, sat-preserved → expected RGB (0.8, 0.2, 0.2).
        assert!(
            approx_rgb(img.pixels[0], [0.8, 0.2, 0.2], 1e-3),
            "expected (0.8, 0.2, 0.2), got {:?}",
            img.pixels[0]
        );
    }

    // ── Trilinear interp halfway between identity & 2x ──────────────────────

    #[test]
    fn trilinear_interp_at_h_midpoint_blends_corners() {
        // 2x1x1 table: hue 0 cell entry = (0, 1, 1), hue 1 cell entry = (180, 1, 1).
        // Between them, pure red (hue 0) sits AT lattice 0 (no interp).
        // A pixel with hue 90° is halfway, lerp_hue(0, 180, 0.5) = 90°.
        // Wait — it's a 2-cell table, so hue 90 / 360 * 2 = 0.5 → between 0 & 1.
        let mut data = Vec::with_capacity(2 * 3);
        data.extend_from_slice(&[0.0, 1.0, 1.0]);
        data.extend_from_slice(&[180.0, 1.0, 1.0]);
        let table = HsmTable::new([2, 1, 1], data, HsmEncoding::Linear).unwrap();
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.5, 0.5, 0.5]; // neutral — hue 0, sat 0
        apply(&mut img, &table);
        // Neutral has sat 0; HSV→RGB returns the same neutral regardless of hue.
        assert!(approx_rgb(img.pixels[0], [0.5, 0.5, 0.5], 1e-4));
    }

    #[test]
    fn trilinear_blends_sat_scale_at_midpoint() {
        // 1x2x1 table: sat 0 → scale 1.0, sat 1 → scale 0.0. Halfway sat = 0.5
        // should yield scale 0.5.
        let mut data = Vec::with_capacity(2 * 3);
        data.extend_from_slice(&[0.0, 1.0, 1.0]); // s=0 entry
        data.extend_from_slice(&[0.0, 0.0, 1.0]); // s=1 entry (zero out sat)
        let table = HsmTable::new([1, 2, 1], data, HsmEncoding::Linear).unwrap();
        // Construct a pixel with sat exactly 0.5: (1.0, 0.5, 0.5) has
        // delta=0.5, max=1.0, sat=0.5.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [1.0, 0.5, 0.5];
        let (_, s_in, _) = rgb_to_hsv(img.pixels[0]);
        assert!(approx(s_in, 0.5, 1e-4));
        apply(&mut img, &table);
        let (_, s_out, _) = rgb_to_hsv(img.pixels[0]);
        // Scale at sat=0.5 lerps lattice scales 1.0 and 0.0 → 0.5. New sat = 0.5 * 0.5 = 0.25.
        assert!(
            approx(s_out, 0.25, 1e-3),
            "expected sat 0.25 after lerped sat scale, got {}",
            s_out
        );
    }

    // ── Hue dimension wraps circularly ──────────────────────────────────────

    #[test]
    fn hue_index_wraps_at_seam() {
        // 4-cell hue table: cell 0 = (0,1,1), cell 1 = (90,1,1),
        // cell 2 = (180,1,1), cell 3 = (270,1,1).
        // A pixel at hue 359° lies between cell 3 (h=270 at lattice point hue 270)
        // and cell 0 (h=0 at lattice point hue 360 / wrap). h_pos = 359/360*4
        // ≈ 3.989, h_lo = 3, h_frac ≈ 0.989. hueDelta lerp_hue(270, 0, 0.989)
        // ≈ shortest-arc → goes the "+90°" way across the seam → result ≈ 359°.
        let mut data = Vec::with_capacity(4 * 3);
        data.extend_from_slice(&[0.0, 1.0, 1.0]);
        data.extend_from_slice(&[90.0, 1.0, 1.0]);
        data.extend_from_slice(&[180.0, 1.0, 1.0]);
        data.extend_from_slice(&[270.0, 1.0, 1.0]);
        let table = HsmTable::new([4, 1, 1], data, HsmEncoding::Linear).unwrap();
        // A pixel at hue 90° (at lattice 1 exactly) should get hueDelta = 90°
        // → shifted hue = 180° (cyan).
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        // Hue 90° at sat 1, val 1 → (0.5, 1, 0).
        img.pixels[0] = hsv_to_rgb(90.0, 1.0, 1.0);
        apply(&mut img, &table);
        let (h, _, _) = rgb_to_hsv(img.pixels[0]);
        assert!(approx(h, 180.0, 0.5), "expected hue ≈180°, got {}", h);
    }

    #[test]
    fn hue_lerp_takes_short_arc_across_seam() {
        // Cell 0: hueDelta = -10° (i.e. 350°). Cell 1: hueDelta = +10°.
        // At midpoint, naive lerp of 350 and 10 = 180°; shortest-arc → 0°.
        let mut data = Vec::with_capacity(2 * 3);
        data.extend_from_slice(&[350.0, 1.0, 1.0]);
        data.extend_from_slice(&[10.0, 1.0, 1.0]);
        let table = HsmTable::new([2, 1, 1], data, HsmEncoding::Linear).unwrap();
        // A pixel at hue 90° lies at h_pos = 90/360*2 = 0.5 → midpoint of cells.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = hsv_to_rgb(90.0, 1.0, 1.0);
        apply(&mut img, &table);
        let (h, _, _) = rgb_to_hsv(img.pixels[0]);
        // Shortest-arc lerp at midpoint of (350°, 10°) = 0°. 90° + 0° = 90°.
        assert!(
            approx(h, 90.0, 0.5),
            "expected hue ≈90° (no shift via short arc), got {}",
            h
        );
    }

    // ── Achromatic fade scales a SIGNED hue delta (#1924) ───────────────────

    #[test]
    fn lookup_returns_signed_hue_delta_not_wrapped() {
        // A table whose every entry carries hueDelta = -10° must be looked up
        // as a signed -10°, not the wrapped 350°. Pre-#1924 `lookup` returned
        // `rem_euclid(360)` = 350°, which only stays correct while it is *added*
        // to hue — `apply` scales it first, where wrap is not invariant.
        let n = 2 * 2 * 2;
        let mut data = Vec::with_capacity(n * 3);
        for _ in 0..n {
            data.push(-10.0);
            data.push(1.0);
            data.push(1.0);
        }
        let table = HsmTable::new([2, 2, 2], data, HsmEncoding::Linear).unwrap();
        let (hd, _, _) = lookup(&table, 30.0, 0.5, 0.5);
        assert!(
            (hd - (-10.0)).abs() < 1e-3,
            "expected signed hueDelta ≈ -10, got {hd}"
        );
    }

    #[test]
    fn achromatic_fade_scales_signed_hue_delta() {
        // Saturation in the (0, 0.01) achromatic fade band with a NEGATIVE
        // hueDelta. At s = 0.005, w_chroma = 0.5, so the applied delta must be
        // -10 * 0.5 = -5° → output hue 355°. The pre-#1924 wrap made `lookup`
        // return 350°, so `apply` computed 350 * 0.5 = 175° — a wildly wrong
        // hue. This is the only band where the bug manifests (at s ≥ 0.01,
        // w_chroma = 1 and the scale is a no-op).
        let n = 2 * 2 * 2;
        let mut data = Vec::with_capacity(n * 3);
        for _ in 0..n {
            data.push(-10.0);
            data.push(1.0);
            data.push(1.0);
        }
        let table = HsmTable::new([2, 2, 2], data, HsmEncoding::Linear).unwrap();
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        // max=1, min=0.995, delta=0.005 → sat 0.005, hue 0, val 1.
        img.pixels[0] = [1.0, 0.995, 0.995];
        let (h_in, s_in, _) = rgb_to_hsv(img.pixels[0]);
        assert!(approx(h_in, 0.0, 1e-3) && approx(s_in, 0.005, 1e-4));
        apply(&mut img, &table);
        let (h_out, _, _) = rgb_to_hsv(img.pixels[0]);
        // Expected 355° (= -5° mod 360). Shortest-arc distance to 355 must be
        // tiny; distance to the buggy 175° must be large.
        let dist = |a: f32, b: f32| {
            let mut d = (a - b).abs();
            if d > 180.0 {
                d = 360.0 - d;
            }
            d
        };
        assert!(
            dist(h_out, 355.0) < 2.0,
            "expected output hue ≈ 355° (signed -5° fade), got {h_out}"
        );
        assert!(
            dist(h_out, 175.0) > 20.0,
            "output hue {h_out} landed near the buggy wrapped 175°"
        );
    }

    // ── Two-table reciprocal-CCT lerp ──────────────────────────────────────

    #[test]
    fn lerp_tables_at_t_zero_returns_cold() {
        let cold = identity_table([2, 2, 2], HsmEncoding::Linear);
        let mut warm_data = cold.data.clone();
        for i in 0..warm_data.len() {
            if i % 3 == 1 {
                warm_data[i] = 2.0;
            } // warm has 2x sat scale
        }
        let warm = HsmTable::new([2, 2, 2], warm_data, HsmEncoding::Linear).unwrap();
        let merged = lerp_tables(&cold, &warm, 0.0).unwrap();
        for (a, b) in cold.data.iter().zip(merged.data.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn lerp_tables_at_t_one_returns_warm() {
        let cold = identity_table([2, 2, 2], HsmEncoding::Linear);
        let mut warm_data = cold.data.clone();
        for i in 0..warm_data.len() {
            if i % 3 == 1 {
                warm_data[i] = 2.0;
            }
        }
        let warm = HsmTable::new([2, 2, 2], warm_data.clone(), HsmEncoding::Linear).unwrap();
        let merged = lerp_tables(&cold, &warm, 1.0).unwrap();
        for (a, b) in warm_data.iter().zip(merged.data.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn lerp_tables_at_midpoint_blends() {
        let cold = identity_table([2, 2, 2], HsmEncoding::Linear);
        let mut warm_data = cold.data.clone();
        for i in 0..warm_data.len() {
            if i % 3 == 2 {
                warm_data[i] = 3.0;
            } // warm valScale = 3
        }
        let warm = HsmTable::new([2, 2, 2], warm_data, HsmEncoding::Linear).unwrap();
        let merged = lerp_tables(&cold, &warm, 0.5).unwrap();
        // ValScale at midpoint = 0.5 * 1 + 0.5 * 3 = 2.
        for i in 0..merged.data.len() {
            if i % 3 == 2 {
                assert!(
                    (merged.data[i] - 2.0).abs() < 1e-6,
                    "valScale at idx {} = {}, expected 2.0",
                    i,
                    merged.data[i]
                );
            }
        }
    }

    #[test]
    fn lerp_tables_rejects_dim_mismatch() {
        let a = identity_table([2, 2, 2], HsmEncoding::Linear);
        let b = identity_table([4, 2, 2], HsmEncoding::Linear);
        assert!(lerp_tables(&a, &b, 0.5).is_none());
    }

    #[test]
    fn lerp_tables_rejects_encoding_mismatch() {
        let a = identity_table([2, 2, 2], HsmEncoding::Linear);
        let b = identity_table([2, 2, 2], HsmEncoding::Srgb);
        assert!(lerp_tables(&a, &b, 0.5).is_none());
    }

    // ── Construction safety ────────────────────────────────────────────────

    #[test]
    fn new_rejects_data_length_mismatch() {
        // dims claim 2*2*2*3 = 24 floats; pass 23.
        let bad = vec![0.0; 23];
        assert!(HsmTable::new([2, 2, 2], bad, HsmEncoding::Linear).is_none());
    }

    #[test]
    fn new_rejects_zero_dim() {
        let zero = vec![];
        assert!(HsmTable::new([0, 2, 2], zero, HsmEncoding::Linear).is_none());
    }

    #[test]
    fn encoding_from_u32_defaults_to_linear() {
        assert_eq!(HsmEncoding::from_u32(0), HsmEncoding::Linear);
        assert_eq!(HsmEncoding::from_u32(1), HsmEncoding::Srgb);
        assert_eq!(HsmEncoding::from_u32(99), HsmEncoding::Linear);
    }
}
