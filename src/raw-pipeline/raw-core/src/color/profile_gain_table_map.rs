//! DNG ProfileGainTableMap (tag 52525) — DNG 1.6 § 6.8.
//!
//! A spatially-varying per-channel gain map. Stored as an opaque blob whose
//! header carries dimensions, then a 2D grid of `MapPlanes` gain values per
//! lattice point. Apple iPhone DNGs ship a PGTM in the SubIFD reachable from
//! the Root IFD via tag 330; the [`crate::dng_ifd_walker`] module locates it.
//!
//! ## Binary layout (DNG 1.6 § 6.8.7)
//!
//! All numeric fields are stored in the file's native endianness (big-endian
//! for Apple DNGs, little-endian for most others). The header is:
//!
//! ```text
//! offset  type     name             description
//! 0       uint32   MapPointsV       map height (lattice rows)
//! 4       uint32   MapPointsH       map width (lattice cols)
//! 8       float64  MapSpacingV      vertical spacing between lattice points
//! 16      float64  MapSpacingH      horizontal spacing
//! 24      float64  MapOriginV       origin offset (V axis)
//! 32      float64  MapOriginH       origin offset (H axis)
//! 40      uint32   MapPlanes        gain values per lattice point (1 or 3)
//! 44      float32  MapGains[V*H*P]  gain values, row-major (V outer, H inner, then plane)
//! ```
//!
//! When `MapPlanes == 1`, one gain applies to all three RGB channels.
//! When `MapPlanes == 3`, three per-pixel gains apply per channel.
//!
//! ## Parsing strategy
//!
//! Real-world Apple DNGs (e.g. `test_0013.DNG`) carry an extended layout
//! whose `MapPlanes` field reads as 257 with 5 trailing floats unaccounted
//! for in DNG 1.6's spec — these are likely a forward-compat extension that
//! the DNG 1.7 spec added in `ProfileGainTableMap2` (tag 0xCD40). Rather
//! than risk applying a misinterpreted gain map, [`from_bytes`] strictly
//! validates `MapPlanes ∈ {1, 3}` and exact-fit `len = 44 + V*H*P*4`. Any
//! mismatch returns `None` and the stage no-ops downstream — preferable
//! to applying garbage.

use rayon::prelude::*;

use crate::image::Image;

/// Parsed ProfileGainTableMap. All gains in linear space; applied
/// multiplicatively in the working color space.
#[derive(Clone, Debug)]
pub struct ProfileGainTableMap {
    /// Number of lattice rows (V axis).
    pub map_points_v: u32,
    /// Number of lattice cols (H axis).
    pub map_points_h: u32,
    /// Per-lattice-point sample count: 1 (broadcast to RGB) or 3 (per-channel).
    pub map_planes: u32,
    /// Lattice origin in normalized image coordinates [0, 1]. `(MapOriginH,
    /// MapOriginV)` per spec.
    pub origin_h: f32,
    pub origin_v: f32,
    /// Lattice spacing in normalized image coordinates. Lattice point `(i, j)`
    /// is at normalized coord `(origin_h + j*spacing_h, origin_v + i*spacing_v)`.
    pub spacing_h: f32,
    pub spacing_v: f32,
    /// Flat gain array. Length = `map_points_v * map_points_h * map_planes`.
    /// Layout: outer = V row, middle = H col, inner = plane.
    pub gains: Vec<f32>,
}

impl ProfileGainTableMap {
    /// Parse from the raw IFD blob. `little_endian` controls byte order; pass
    /// the host DNG's TIFF endianness (rawler's `IFD::endian`).
    ///
    /// Returns `None` for any of:
    /// - blob shorter than 44-byte header
    /// - `MapPointsV == 0` or `MapPointsH == 0`
    /// - `MapPlanes ∉ {1, 3}` (DNG 1.6 spec restriction)
    /// - blob length != exact `44 + V * H * Planes * 4`
    /// - any gain value non-finite (NaN / inf in the file)
    pub fn from_bytes(bytes: &[u8], little_endian: bool) -> Option<Self> {
        const HEADER: usize = 44;
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
        if map_points_v == 0 || map_points_h == 0 {
            return None;
        }
        let map_spacing_v = read_f64(8) as f32;
        let map_spacing_h = read_f64(16) as f32;
        let map_origin_v = read_f64(24) as f32;
        let map_origin_h = read_f64(32) as f32;
        let map_planes = read_u32(40);
        if map_planes != 1 && map_planes != 3 {
            // Non-canonical layout (e.g. Apple's DNG 1.7 extension). Bail
            // safely — the apply stage will no-op rather than corrupt.
            return None;
        }
        let count = (map_points_v as usize)
            .checked_mul(map_points_h as usize)?
            .checked_mul(map_planes as usize)?;
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
            map_planes,
            origin_h: map_origin_h,
            origin_v: map_origin_v,
            spacing_h: map_spacing_h,
            spacing_v: map_spacing_v,
            gains,
        })
    }

    /// Sample the map at normalized image coordinates `(u, v)` ∈ [0, 1].
    /// Returns `[gain_r, gain_g, gain_b]` per the `MapPlanes` convention
    /// (broadcast a single plane to all three channels). Bilinear interp;
    /// out-of-lattice coords clamp to the lattice edge.
    pub fn sample(&self, u: f32, v: f32) -> [f32; 3] {
        // Map normalized (u, v) into lattice index space.
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

        let mut out = [0.0_f32; 3];
        for plane in 0..3 {
            // For map_planes == 1, broadcast the single-plane sample to all 3.
            let p = if self.map_planes == 1 { 0 } else { plane };
            let g00 = self.lookup(v_lo, h_lo, p);
            let g10 = self.lookup(v_lo, h_hi, p);
            let g01 = self.lookup(v_hi, h_lo, p);
            let g11 = self.lookup(v_hi, h_hi, p);
            let g0 = g00 + h_frac * (g10 - g00);
            let g1 = g01 + h_frac * (g11 - g01);
            out[plane] = g0 + v_frac * (g1 - g0);
        }
        out
    }

    #[inline]
    fn lookup(&self, v: usize, h: usize, plane: usize) -> f32 {
        let idx = (v * self.map_points_h as usize + h) * self.map_planes as usize + plane;
        self.gains[idx]
    }
}

/// Apply the gain map to a full-frame `Image`. Pixel `(x, y)` maps to
/// normalized coords `(x / (w-1), y / (h-1))`. Per-channel multiplication.
///
/// Per DNG 1.6 § 6.8: positive gain values multiply the linear scene-referred
/// signal in the camera profile's working space. Negative pixels (the same
/// out-of-gamut wide-gamut tail HSM/PLT bypass) are passed through unchanged.
pub fn apply(img: &mut Image, map: &ProfileGainTableMap) {
    let w = img.width as usize;
    let h = img.height as usize;
    if w == 0 || h == 0 {
        return;
    }
    let inv_w = if w > 1 { 1.0 / (w - 1) as f32 } else { 0.0 };
    let inv_h = if h > 1 { 1.0 / (h - 1) as f32 } else { 0.0 };

    img.pixels.par_iter_mut().enumerate().for_each(|(i, p)| {
        // Spec-mandated negative-component bypass (matches HSM/PLT).
        if p[0] < 0.0 || p[1] < 0.0 || p[2] < 0.0 {
            return;
        }
        let x = i % w;
        let y = i / w;
        let u = x as f32 * inv_w;
        let v = y as f32 * inv_h;
        let g = map.sample(u, v);
        p[0] *= g[0];
        p[1] *= g[1];
        p[2] *= g[2];
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::ColorSpace;

    /// Build a synthetic well-formed PGTM blob with the given parameters
    /// in big-endian (matches Apple DNG byte order).
    fn make_blob_be(v: u32, h: u32, planes: u32, gains: &[f32]) -> Vec<u8> {
        assert_eq!(gains.len(), (v * h * planes) as usize);
        let mut out = Vec::with_capacity(44 + gains.len() * 4);
        out.extend_from_slice(&v.to_be_bytes());
        out.extend_from_slice(&h.to_be_bytes());
        out.extend_from_slice(&(0.5_f64).to_be_bytes()); // spacing V
        out.extend_from_slice(&(0.5_f64).to_be_bytes()); // spacing H
        out.extend_from_slice(&(0.0_f64).to_be_bytes()); // origin V
        out.extend_from_slice(&(0.0_f64).to_be_bytes()); // origin H
        out.extend_from_slice(&planes.to_be_bytes());
        for g in gains {
            out.extend_from_slice(&g.to_be_bytes());
        }
        out
    }

    #[test]
    fn from_bytes_parses_canonical_3x3_planes_1() {
        // 3×3 lattice, one plane, all gains = 1.0 (no-op).
        let gains: Vec<f32> = vec![1.0; 9];
        let bytes = make_blob_be(3, 3, 1, &gains);
        let map = ProfileGainTableMap::from_bytes(&bytes, false /* big-endian */)
            .expect("canonical PGTM parses");
        assert_eq!(map.map_points_v, 3);
        assert_eq!(map.map_points_h, 3);
        assert_eq!(map.map_planes, 1);
        assert_eq!(map.gains.len(), 9);
        assert!(map.gains.iter().all(|&g| (g - 1.0).abs() < 1e-6));
    }

    #[test]
    fn from_bytes_parses_per_channel_planes_3() {
        // 2×2 lattice, RGB-distinct gains (R=1.1, G=1.0, B=0.9 everywhere).
        let mut gains: Vec<f32> = Vec::new();
        for _ in 0..(2 * 2) {
            gains.extend_from_slice(&[1.1, 1.0, 0.9]);
        }
        let bytes = make_blob_be(2, 2, 3, &gains);
        let map = ProfileGainTableMap::from_bytes(&bytes, false).unwrap();
        assert_eq!(map.map_planes, 3);
        let s = map.sample(0.5, 0.5);
        assert!((s[0] - 1.1).abs() < 1e-5);
        assert!((s[1] - 1.0).abs() < 1e-5);
        assert!((s[2] - 0.9).abs() < 1e-5);
    }

    #[test]
    fn from_bytes_rejects_non_canonical_planes() {
        // MapPlanes=257 (test_0013's actual quirk) — strict parser bails.
        let mut bytes = vec![0u8; 44 + 6 * 8 * 257 * 4];
        bytes[0..4].copy_from_slice(&6_u32.to_be_bytes()); // V
        bytes[4..8].copy_from_slice(&8_u32.to_be_bytes()); // H
        bytes[40..44].copy_from_slice(&257_u32.to_be_bytes()); // bogus planes
        let map = ProfileGainTableMap::from_bytes(&bytes, false);
        assert!(
            map.is_none(),
            "MapPlanes=257 must be rejected as non-canonical"
        );
    }

    #[test]
    fn from_bytes_rejects_short_blob() {
        let bytes = vec![0u8; 30];
        assert!(ProfileGainTableMap::from_bytes(&bytes, false).is_none());
    }

    #[test]
    fn from_bytes_rejects_zero_dims() {
        // V=0, H=3, planes=1 — must reject before length check.
        let mut bytes = vec![0u8; 44];
        bytes[4..8].copy_from_slice(&3_u32.to_be_bytes());
        bytes[40..44].copy_from_slice(&1_u32.to_be_bytes());
        assert!(ProfileGainTableMap::from_bytes(&bytes, false).is_none());
    }

    #[test]
    fn from_bytes_rejects_length_mismatch() {
        // Header says 3×3×1 = 9 floats (36 bytes), but only 8 supplied.
        let mut bytes = vec![0u8; 44 + 8 * 4];
        bytes[0..4].copy_from_slice(&3_u32.to_be_bytes());
        bytes[4..8].copy_from_slice(&3_u32.to_be_bytes());
        bytes[40..44].copy_from_slice(&1_u32.to_be_bytes());
        assert!(ProfileGainTableMap::from_bytes(&bytes, false).is_none());
    }

    #[test]
    fn sample_returns_constant_for_uniform_map() {
        let bytes = make_blob_be(2, 2, 1, &[1.5, 1.5, 1.5, 1.5]);
        let map = ProfileGainTableMap::from_bytes(&bytes, false).unwrap();
        for &(u, v) in &[(0.0_f32, 0.0_f32), (0.5, 0.5), (1.0, 1.0)] {
            let s = map.sample(u, v);
            assert!((s[0] - 1.5).abs() < 1e-5);
            assert!((s[1] - 1.5).abs() < 1e-5);
            assert!((s[2] - 1.5).abs() < 1e-5);
        }
    }

    #[test]
    fn sample_bilinear_interpolates_corners() {
        // 2×2 lattice with corners 1.0, 2.0, 3.0, 4.0 (row-major: (0,0)=1, (0,1)=2, (1,0)=3, (1,1)=4).
        // Spacing 1.0, origin 0 — lattice covers [0, 1] × [0, 1].
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2_u32.to_be_bytes()); // V
        bytes.extend_from_slice(&2_u32.to_be_bytes()); // H
        bytes.extend_from_slice(&(1.0_f64).to_be_bytes()); // spacing V
        bytes.extend_from_slice(&(1.0_f64).to_be_bytes()); // spacing H
        bytes.extend_from_slice(&(0.0_f64).to_be_bytes()); // origin V
        bytes.extend_from_slice(&(0.0_f64).to_be_bytes()); // origin H
        bytes.extend_from_slice(&1_u32.to_be_bytes()); // planes
        for g in [1.0_f32, 2.0, 3.0, 4.0] {
            bytes.extend_from_slice(&g.to_be_bytes());
        }
        let map = ProfileGainTableMap::from_bytes(&bytes, false).unwrap();
        // Center (0.5, 0.5) → average = 2.5
        let s = map.sample(0.5, 0.5);
        assert!((s[0] - 2.5).abs() < 1e-5, "got {}", s[0]);
        // (0, 0) → 1.0
        let s = map.sample(0.0, 0.0);
        assert!((s[0] - 1.0).abs() < 1e-5);
        // (1, 1) → 4.0
        let s = map.sample(1.0, 1.0);
        assert!((s[0] - 4.0).abs() < 1e-5);
    }

    #[test]
    fn apply_uniform_map_scales_pixels() {
        let bytes = make_blob_be(2, 2, 1, &[2.0; 4]);
        let map = ProfileGainTableMap::from_bytes(&bytes, false).unwrap();
        let mut img = Image::new(4, 4, ColorSpace::SceneLinearRec2020);
        for p in img.pixels.iter_mut() {
            *p = [0.3, 0.4, 0.5];
        }
        apply(&mut img, &map);
        for p in &img.pixels {
            assert!((p[0] - 0.6).abs() < 1e-4);
            assert!((p[1] - 0.8).abs() < 1e-4);
            assert!((p[2] - 1.0).abs() < 1e-4);
        }
    }

    #[test]
    fn apply_bypasses_negative_components() {
        let bytes = make_blob_be(2, 2, 1, &[2.0; 4]);
        let map = ProfileGainTableMap::from_bytes(&bytes, false).unwrap();
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [-0.1, 0.2, 0.3];
        apply(&mut img, &map);
        // Untouched: any negative component → bypass.
        assert_eq!(img.pixels[0], [-0.1, 0.2, 0.3]);
    }

    #[test]
    fn apply_per_channel_planes_3_uses_separate_gains() {
        // R-only boost.
        let mut gains = Vec::new();
        for _ in 0..(2 * 2) {
            gains.extend_from_slice(&[1.5, 1.0, 1.0]);
        }
        let bytes = make_blob_be(2, 2, 3, &gains);
        let map = ProfileGainTableMap::from_bytes(&bytes, false).unwrap();
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.4, 0.4, 0.4];
        apply(&mut img, &map);
        assert!((img.pixels[0][0] - 0.6).abs() < 1e-4);
        assert!((img.pixels[0][1] - 0.4).abs() < 1e-4);
        assert!((img.pixels[0][2] - 0.4).abs() < 1e-4);
    }
}
