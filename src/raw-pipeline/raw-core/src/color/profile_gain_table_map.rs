//! DNG ProfileGainTableMap (tag 52525) — DNG 1.6 § 6.8.
//!
//! A spatially-varying scalar gain map with an optional value ("N") axis:
//! per spatial lattice point it stores an `N`-sample 1-D curve indexed by a
//! weighted function of the pixel's `(R, G, B, min, max)`. One scalar gain is
//! interpolated (bilinearly across the spatial lattice, linearly along the N
//! axis) and applied **uniformly to R/G/B**. Apple iPhone DNGs ship a PGTM in
//! a SubIFD reachable from the Root IFD via tag 330; [`crate::dng_ifd_walker`]
//! locates it.
//!
//! ## Binary layout (DNG 1.6 § 6.8, verified against the Adobe DNG spec text)
//!
//! All numeric fields are in the file's native endianness (big-endian for
//! Apple DNGs). The header is **64 bytes**:
//!
//! ```text
//! offset  type       name              description
//! 0       uint32     MapPointsV        map height (lattice rows)
//! 4       uint32     MapPointsH        map width (lattice cols)
//! 8       float64    MapSpacingV       vertical spacing between lattice points
//! 16      float64    MapSpacingH       horizontal spacing
//! 24      float64    MapOriginV        origin offset (V axis)
//! 32      float64    MapOriginH        origin offset (H axis)
//! 40      uint32     MapPointsN        samples along the value ("N") axis
//! 44      float32[5] MapInputWeights   weights over (R, G, B, min, max)
//! 64      float32[V*H*N]  MapGains      row-major: V outer, H middle, N inner
//! ```
//!
//! The retired implementation mis-read offset 40 as a `MapPlanes ∈ {1, 3}`
//! count with a 44-byte header, applied pure spatial per-channel gain, and
//! rejected anything else. That is why a real Apple ProRAW PGTM (whose
//! `MapPointsN` is e.g. 257) parsed as an invalid plane count and silently
//! bailed to `None` — an inert missing feature. This parser matches the real
//! layout and no longer rejects that data (#1923).
//!
//! ## Value ("N") axis and MapInputWeights
//!
//! `MapPointsN == 1` is the common pure-spatial case (the value axis is a
//! single point, so the input value is irrelevant and no color-space work is
//! needed). For `N > 1`, the 1-D curve at each spatial lattice point is indexed
//! by an input value `t ∈ [0, 1]` computed as
//! `t = clamp(wR·R + wG·G + wB·B + wMin·min + wMax·max, 0, 1)` where the pixel
//! is taken in the profile's linear **RIMM/ProPhoto** space (the DNG gain-table
//! space) and `min`/`max` are over its channels.
//!
//! Because the gain is a single scalar applied uniformly to R/G/B, the
//! *application* is invariant to the working color space (a scalar multiply
//! commutes with the linear Rec.2020↔ProPhoto transform), so only the input
//! value for the N-axis lookup is computed in ProPhoto; the multiply is applied
//! to the working Rec.2020 pixel directly.
//!
//! ## Validation status
//!
//! The header parse and the interpolation math are pinned by synthetic unit
//! tests below. Final colorimetric validation against a real Apple ProRAW PGTM
//! (e.g. the gitignored `test_0013.DNG`) via the ΔE harness is required before
//! the applied gain can be trusted end-to-end on real ProRAW, and is not
//! possible in a fixture-less checkout.

use rayon::prelude::*;

use crate::image::Image;

/// Parsed ProfileGainTableMap. Gains are linear scalars applied
/// multiplicatively and uniformly to R/G/B.
#[derive(Clone, Debug)]
pub struct ProfileGainTableMap {
    /// Number of lattice rows (V axis).
    pub map_points_v: u32,
    /// Number of lattice cols (H axis).
    pub map_points_h: u32,
    /// Number of samples along the value ("N") axis (`>= 1`). 1 = pure
    /// spatial gain (no value-axis dependence).
    pub map_points_n: u32,
    /// Lattice origin in normalized image coordinates. `(MapOriginH,
    /// MapOriginV)` per spec.
    pub origin_h: f32,
    pub origin_v: f32,
    /// Lattice spacing in normalized image coordinates. Lattice point `(i, j)`
    /// is at normalized coord `(origin_h + j*spacing_h, origin_v + i*spacing_v)`.
    pub spacing_h: f32,
    pub spacing_v: f32,
    /// Weights `[wR, wG, wB, wMin, wMax]` combining the profile-space pixel
    /// into the value-axis input. Ignored when `map_points_n == 1`.
    pub input_weights: [f32; 5],
    /// Flat gain array. Length = `map_points_v * map_points_h * map_points_n`.
    /// Layout: outer = V row, middle = H col, inner = N sample.
    pub gains: Vec<f32>,
}

impl ProfileGainTableMap {
    /// Parse from the raw IFD blob. `little_endian` controls byte order; pass
    /// the host DNG's TIFF endianness (rawler's `IFD::endian`).
    ///
    /// Returns `None` for any of:
    /// - blob shorter than the 64-byte header
    /// - `MapPointsV == 0`, `MapPointsH == 0`, or `MapPointsN == 0`
    /// - a `V * H * N` gain count that overflows `usize`
    /// - blob length != exact `64 + V * H * N * 4`
    /// - any gain value non-finite (NaN / inf in the file)
    pub fn from_bytes(bytes: &[u8], little_endian: bool) -> Option<Self> {
        const HEADER: usize = 64;
        if bytes.len() < HEADER {
            return None;
        }
        let read_u32 = |off: usize| -> u32 {
            let arr = [bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]];
            if little_endian {
                u32::from_le_bytes(arr)
            } else {
                u32::from_be_bytes(arr)
            }
        };
        let read_f64 = |off: usize| -> f64 {
            let mut arr = [0u8; 8];
            arr.copy_from_slice(&bytes[off..off + 8]);
            if little_endian {
                f64::from_le_bytes(arr)
            } else {
                f64::from_be_bytes(arr)
            }
        };
        let read_f32 = |off: usize| -> f32 {
            let arr = [bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]];
            if little_endian {
                f32::from_le_bytes(arr)
            } else {
                f32::from_be_bytes(arr)
            }
        };

        let map_points_v = read_u32(0);
        let map_points_h = read_u32(4);
        let map_spacing_v = read_f64(8) as f32;
        let map_spacing_h = read_f64(16) as f32;
        let map_origin_v = read_f64(24) as f32;
        let map_origin_h = read_f64(32) as f32;
        let map_points_n = read_u32(40);
        if map_points_v == 0 || map_points_h == 0 || map_points_n == 0 {
            return None;
        }
        let input_weights = [
            read_f32(44),
            read_f32(48),
            read_f32(52),
            read_f32(56),
            read_f32(60),
        ];
        if input_weights.iter().any(|w| !w.is_finite()) {
            return None;
        }
        let count = (map_points_v as usize)
            .checked_mul(map_points_h as usize)?
            .checked_mul(map_points_n as usize)?;
        let expected_len = HEADER.checked_add(count.checked_mul(4)?)?;
        if bytes.len() != expected_len {
            return None;
        }
        let mut gains = Vec::with_capacity(count);
        for i in 0..count {
            let v = read_f32(HEADER + i * 4);
            if !v.is_finite() {
                return None;
            }
            gains.push(v);
        }
        Some(Self {
            map_points_v,
            map_points_h,
            map_points_n,
            origin_h: map_origin_h,
            origin_v: map_origin_v,
            spacing_h: map_spacing_h,
            spacing_v: map_spacing_v,
            input_weights,
            gains,
        })
    }

    /// Interpolated scalar gain at normalized image coordinates `(u, v)` and
    /// value-axis input `t`. Spatial interpolation is bilinear over the
    /// lattice (out-of-lattice coords clamp to the edge); the value axis is
    /// linear over the `N` samples at `t·(N-1)` (clamped). `t` is ignored when
    /// `map_points_n == 1`.
    pub fn gain_at(&self, u: f32, v: f32, t: f32) -> f32 {
        let h_pos = if self.spacing_h > 0.0 {
            (u - self.origin_h) / self.spacing_h
        } else {
            0.0
        };
        let v_pos = if self.spacing_v > 0.0 {
            (v - self.origin_v) / self.spacing_v
        } else {
            0.0
        };
        let h_max = (self.map_points_h - 1) as f32;
        let v_max = (self.map_points_v - 1) as f32;
        let h_clamped = h_pos.clamp(0.0, h_max);
        let v_clamped = v_pos.clamp(0.0, v_max);
        let h_lo = h_clamped.floor() as usize;
        let v_lo = v_clamped.floor() as usize;
        let h_hi = (h_lo + 1).min((self.map_points_h - 1) as usize);
        let v_hi = (v_lo + 1).min((self.map_points_v - 1) as usize);
        let h_frac = h_clamped - h_lo as f32;
        let v_frac = v_clamped - v_lo as f32;

        // Value-axis fractional position and its two bracketing samples.
        let (n_lo, n_hi, n_frac) = if self.map_points_n <= 1 {
            (0, 0, 0.0)
        } else {
            let n_pos = t.clamp(0.0, 1.0) * (self.map_points_n - 1) as f32;
            let n_lo = n_pos.floor() as usize;
            let n_hi = (n_lo + 1).min((self.map_points_n - 1) as usize);
            (n_lo, n_hi, n_pos - n_lo as f32)
        };

        // Gain at one spatial lattice point, N-interpolated.
        let corner = |vc: usize, hc: usize| -> f32 {
            let lo = self.lookup(vc, hc, n_lo);
            let hi = self.lookup(vc, hc, n_hi);
            lo + n_frac * (hi - lo)
        };
        let g00 = corner(v_lo, h_lo);
        let g10 = corner(v_lo, h_hi);
        let g01 = corner(v_hi, h_lo);
        let g11 = corner(v_hi, h_hi);
        let g0 = g00 + h_frac * (g10 - g00);
        let g1 = g01 + h_frac * (g11 - g01);
        g0 + v_frac * (g1 - g0)
    }

    #[inline]
    fn lookup(&self, v: usize, h: usize, n: usize) -> f32 {
        let idx = (v * self.map_points_h as usize + h) * self.map_points_n as usize + n;
        self.gains[idx]
    }

    /// Value-axis input `t` for a working-space (linear Rec.2020) pixel: the
    /// pixel is rotated into linear ProPhoto (the DNG gain-table space) and
    /// combined via `input_weights` over `(R, G, B, min, max)`, clamped to
    /// `[0, 1]`. `rec2020_to_pro` is the cached Rec.2020→ProPhoto matrix.
    #[inline]
    fn value_input(&self, rgb: [f32; 3], rec2020_to_pro: &crate::math::Matrix3) -> f32 {
        let pro = rec2020_to_pro.mul_vec(rgb);
        let min = pro[0].min(pro[1]).min(pro[2]);
        let max = pro[0].max(pro[1]).max(pro[2]);
        let w = self.input_weights;
        (w[0] * pro[0] + w[1] * pro[1] + w[2] * pro[2] + w[3] * min + w[4] * max).clamp(0.0, 1.0)
    }
}

/// Apply the gain map to a full-frame `Image`. Pixel `(x, y)` maps to
/// half-pixel-centered normalized coords `((x + 0.5) / w, (y + 0.5) / h)`.
/// A single scalar gain (spatial × value-axis) multiplies all three channels.
///
/// Per DNG 1.6 § 6.8 the gain multiplies the linear scene-referred signal.
/// The value-axis input is computed in linear ProPhoto (see
/// [`ProfileGainTableMap::value_input`]); the scalar multiply is applied in the
/// working Rec.2020 space, which is equivalent since a uniform scale commutes
/// with the linear primaries transform.
pub fn apply(img: &mut Image, map: &ProfileGainTableMap) {
    let w = img.width as usize;
    let h = img.height as usize;
    if w == 0 || h == 0 {
        return;
    }
    let inv_w = 1.0 / w as f32;
    let inv_h = 1.0 / h as f32;
    // Rec.2020→ProPhoto for the value-axis input, computed once. Only needed
    // when the map has a value axis (`N > 1`); pure-spatial maps skip it.
    let rec2020_to_pro = if map.map_points_n > 1 {
        Some(
            crate::color::matrices::m_pro_to_rec2020()
                .inverse()
                .expect("Rec.2020↔ProPhoto matrix is non-singular"),
        )
    } else {
        None
    };

    img.pixels.par_iter_mut().enumerate().for_each(|(i, p)| {
        let x = i % w;
        let y = i / w;
        let u = (x as f32 + 0.5) * inv_w;
        let v = (y as f32 + 0.5) * inv_h;
        let t = match &rec2020_to_pro {
            Some(m) => map.value_input(*p, m),
            None => 0.0,
        };
        let g = map.gain_at(u, v, t);
        p[0] *= g;
        p[1] *= g;
        p[2] *= g;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::ColorSpace;

    /// Build a synthetic well-formed PGTM blob (64-byte header) in big-endian
    /// (matches Apple DNG byte order). `gains.len()` must be `v * h * n`.
    #[allow(clippy::too_many_arguments)]
    fn make_blob_be(
        v: u32,
        h: u32,
        n: u32,
        spacing_v: f64,
        spacing_h: f64,
        origin_v: f64,
        origin_h: f64,
        weights: [f32; 5],
        gains: &[f32],
    ) -> Vec<u8> {
        assert_eq!(gains.len(), (v * h * n) as usize);
        let mut out = Vec::with_capacity(64 + gains.len() * 4);
        out.extend_from_slice(&v.to_be_bytes());
        out.extend_from_slice(&h.to_be_bytes());
        out.extend_from_slice(&spacing_v.to_be_bytes());
        out.extend_from_slice(&spacing_h.to_be_bytes());
        out.extend_from_slice(&origin_v.to_be_bytes());
        out.extend_from_slice(&origin_h.to_be_bytes());
        out.extend_from_slice(&n.to_be_bytes());
        for w in weights {
            out.extend_from_slice(&w.to_be_bytes());
        }
        for g in gains {
            out.extend_from_slice(&g.to_be_bytes());
        }
        assert_eq!(out.len(), 64 + gains.len() * 4);
        out
    }

    /// A pure-spatial (N=1) uniform map covering [0,1]×[0,1], all gains equal.
    fn uniform_spatial(v: u32, h: u32, gain: f32) -> Vec<u8> {
        make_blob_be(
            v,
            h,
            1,
            1.0,
            1.0,
            0.0,
            0.0,
            [0.0; 5],
            &vec![gain; (v * h) as usize],
        )
    }

    #[test]
    fn from_bytes_parses_64_byte_header_and_n_axis() {
        // 2×3 spatial × N=2, spacing/origin/weights all read back.
        let gains: Vec<f32> = (0..(2 * 3 * 2)).map(|i| 1.0 + i as f32 * 0.1).collect();
        let bytes = make_blob_be(
            2,
            3,
            2,
            0.5,
            0.25,
            0.1,
            0.2,
            [0.2, 0.3, 0.1, 0.15, 0.25],
            &gains,
        );
        let map = ProfileGainTableMap::from_bytes(&bytes, false /* big-endian */)
            .expect("PGTM with 64-byte header parses");
        assert_eq!(map.map_points_v, 2);
        assert_eq!(map.map_points_h, 3);
        assert_eq!(map.map_points_n, 2);
        assert!((map.spacing_v - 0.5).abs() < 1e-6);
        assert!((map.spacing_h - 0.25).abs() < 1e-6);
        assert!((map.origin_v - 0.1).abs() < 1e-6);
        assert!((map.origin_h - 0.2).abs() < 1e-6);
        assert!((map.input_weights[0] - 0.2).abs() < 1e-6);
        assert!((map.input_weights[4] - 0.25).abs() < 1e-6);
        assert_eq!(map.gains.len(), 2 * 3 * 2);
    }

    #[test]
    fn from_bytes_accepts_real_proraw_large_n() {
        // The #1923 regression: a real Apple ProRAW PGTM has a large
        // MapPointsN (e.g. 257) that the retired parser mis-read as an invalid
        // MapPlanes and rejected. With the correct 64-byte header + N-axis
        // layout it must now parse rather than silently bail to None.
        let (v, h, n) = (2u32, 2u32, 257u32);
        let gains = vec![1.0f32; (v * h * n) as usize];
        let bytes = make_blob_be(v, h, n, 1.0, 1.0, 0.0, 0.0, [0.0, 0.0, 0.0, 0.0, 1.0], &gains);
        let map = ProfileGainTableMap::from_bytes(&bytes, false)
            .expect("large-N Apple ProRAW PGTM must parse (#1923)");
        assert_eq!(map.map_points_n, 257);
        assert_eq!(map.gains.len(), (v * h * n) as usize);
    }

    #[test]
    fn from_bytes_rejects_short_blob() {
        assert!(ProfileGainTableMap::from_bytes(&vec![0u8; 30], false).is_none());
        // 63 bytes — one short of the 64-byte header.
        assert!(ProfileGainTableMap::from_bytes(&vec![0u8; 63], false).is_none());
    }

    #[test]
    fn from_bytes_rejects_zero_dims() {
        for (v, h, n) in [(0u32, 3u32, 1u32), (3, 0, 1), (3, 3, 0)] {
            let mut bytes = vec![0u8; 64];
            bytes[0..4].copy_from_slice(&v.to_be_bytes());
            bytes[4..8].copy_from_slice(&h.to_be_bytes());
            bytes[40..44].copy_from_slice(&n.to_be_bytes());
            assert!(
                ProfileGainTableMap::from_bytes(&bytes, false).is_none(),
                "V={v} H={h} N={n} must be rejected"
            );
        }
    }

    #[test]
    fn from_bytes_rejects_length_mismatch() {
        // Header says 3×3×1 = 9 floats (36 bytes) but only 8 supplied.
        let mut bytes = vec![0u8; 64 + 8 * 4];
        bytes[0..4].copy_from_slice(&3_u32.to_be_bytes());
        bytes[4..8].copy_from_slice(&3_u32.to_be_bytes());
        bytes[40..44].copy_from_slice(&1_u32.to_be_bytes());
        assert!(ProfileGainTableMap::from_bytes(&bytes, false).is_none());
    }

    #[test]
    fn gain_at_spatial_bilinear_n1() {
        // 2×2 lattice, N=1, corners 1,2,3,4 over [0,1]×[0,1].
        let bytes = make_blob_be(2, 2, 1, 1.0, 1.0, 0.0, 0.0, [0.0; 5], &[1.0, 2.0, 3.0, 4.0]);
        let map = ProfileGainTableMap::from_bytes(&bytes, false).unwrap();
        assert!((map.gain_at(0.0, 0.0, 0.0) - 1.0).abs() < 1e-5);
        assert!((map.gain_at(1.0, 1.0, 0.0) - 4.0).abs() < 1e-5);
        assert!((map.gain_at(0.5, 0.5, 0.0) - 2.5).abs() < 1e-5);
    }

    #[test]
    fn gain_at_value_axis_interpolates_linearly() {
        // 1×1 spatial × N=2: value axis spans gains 1.0 → 3.0.
        let bytes = make_blob_be(1, 1, 2, 1.0, 1.0, 0.0, 0.0, [0.0; 5], &[1.0, 3.0]);
        let map = ProfileGainTableMap::from_bytes(&bytes, false).unwrap();
        assert!((map.gain_at(0.5, 0.5, 0.0) - 1.0).abs() < 1e-5);
        assert!((map.gain_at(0.5, 0.5, 1.0) - 3.0).abs() < 1e-5);
        assert!((map.gain_at(0.5, 0.5, 0.5) - 2.0).abs() < 1e-5);
        // Out-of-range t clamps.
        assert!((map.gain_at(0.5, 0.5, -1.0) - 1.0).abs() < 1e-5);
        assert!((map.gain_at(0.5, 0.5, 2.0) - 3.0).abs() < 1e-5);
    }

    #[test]
    fn apply_uniform_spatial_map_scales_all_pixels() {
        let map = ProfileGainTableMap::from_bytes(&uniform_spatial(2, 2, 2.0), false).unwrap();
        let mut img = Image::new(4, 4, ColorSpace::SceneLinearRec2020);
        for p in img.pixels.iter_mut() {
            *p = [0.3, 0.4, 0.5];
        }
        apply(&mut img, &map);
        for p in &img.pixels {
            assert!((p[0] - 0.6).abs() < 1e-4, "got {}", p[0]);
            assert!((p[1] - 0.8).abs() < 1e-4);
            assert!((p[2] - 1.0).abs() < 1e-4);
        }
    }

    #[test]
    fn apply_uses_half_pixel_centered_coords() {
        // A horizontal gain ramp: 2 lattice cols over [0,1], gains 1.0 → 3.0
        // (V=1 so no vertical variation). N=1. A 2-px-wide image samples the
        // map at u = 0.25 and u = 0.75 (half-pixel centers), so the two pixels
        // get gains 1.5 and 2.5 — NOT 1.0 and 3.0 (which the old x/(w-1)
        // edge-to-edge mapping would have produced).
        let bytes = make_blob_be(1, 2, 1, 1.0, 1.0, 0.0, 0.0, [0.0; 5], &[1.0, 3.0]);
        let map = ProfileGainTableMap::from_bytes(&bytes, false).unwrap();
        let mut img = Image::new(2, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [1.0, 1.0, 1.0];
        img.pixels[1] = [1.0, 1.0, 1.0];
        apply(&mut img, &map);
        assert!((img.pixels[0][0] - 1.5).abs() < 1e-4, "left {}", img.pixels[0][0]);
        assert!((img.pixels[1][0] - 2.5).abs() < 1e-4, "right {}", img.pixels[1][0]);
    }

    #[test]
    fn apply_value_axis_gain_increases_with_pixel_brightness() {
        // 1×1 spatial × N=2, gains 1.0 → 3.0, value input = max channel
        // (weights [0,0,0,0,1]). A brighter neutral pixel indexes higher on the
        // N axis, so its effective gain multiplier is strictly larger. Neutral
        // pixels stay ~neutral through the Rec.2020→ProPhoto rotation, so the
        // ordering is robust. Compare per-pixel output/input ratios.
        let bytes = make_blob_be(1, 1, 2, 1.0, 1.0, 0.0, 0.0, [0.0, 0.0, 0.0, 0.0, 1.0], &[1.0, 3.0]);
        let map = ProfileGainTableMap::from_bytes(&bytes, false).unwrap();
        let mut img = Image::new(1, 2, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.3, 0.3, 0.3];
        img.pixels[1] = [0.7, 0.7, 0.7];
        apply(&mut img, &map);
        let ratio_dark = img.pixels[0][0] / 0.3;
        let ratio_bright = img.pixels[1][0] / 0.7;
        assert!(
            ratio_bright > ratio_dark + 0.2,
            "brighter pixel must index a higher value-axis gain: \
             dark ratio {ratio_dark}, bright ratio {ratio_bright}"
        );
        // Both gains stay within the [1, 3] table range.
        assert!((1.0..=3.0).contains(&ratio_dark) && (1.0..=3.0).contains(&ratio_bright));
    }

    #[test]
    fn apply_little_endian_blob_parses_and_scales() {
        // Same uniform 2× map, little-endian byte order.
        let v = 2u32;
        let h = 2u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&v.to_le_bytes());
        bytes.extend_from_slice(&h.to_le_bytes());
        bytes.extend_from_slice(&1.0_f64.to_le_bytes());
        bytes.extend_from_slice(&1.0_f64.to_le_bytes());
        bytes.extend_from_slice(&0.0_f64.to_le_bytes());
        bytes.extend_from_slice(&0.0_f64.to_le_bytes());
        bytes.extend_from_slice(&1_u32.to_le_bytes()); // N
        for _ in 0..5 {
            bytes.extend_from_slice(&0.0_f32.to_le_bytes());
        }
        for _ in 0..(v * h) {
            bytes.extend_from_slice(&2.0_f32.to_le_bytes());
        }
        let map = ProfileGainTableMap::from_bytes(&bytes, true).unwrap();
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in img.pixels.iter_mut() {
            *p = [0.25, 0.25, 0.25];
        }
        apply(&mut img, &map);
        for p in &img.pixels {
            assert!((p[0] - 0.5).abs() < 1e-4);
        }
    }
}
