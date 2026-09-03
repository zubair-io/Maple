//! A host-supplied bitmap mask raster (#3271, spec §5.3): an R8 raster
//! sampled bilinearly in the same oriented, uncropped, normalized frame the
//! linear and radial masks use. Stored as f32 so the GPU plane is a straight
//! copy — no per-tick u8-to-f32 conversion on the render path.

#[derive(Clone, Debug)]
pub struct MaskRaster {
    /// The flat-wire id a `Mask::Bitmap` record refers to (`0` = unresolved).
    pub id: u32,
    /// 16 lowercase hex chars, the host-computed recipe digest.
    pub digest: String,
    pub width: u32,
    pub height: u32,
    /// Row-major, `width * height` entries, each 0.0..=1.0.
    pub data: Vec<f32>,
}

impl MaskRaster {
    /// Build from R8 bytes (0 = weight 0, 255 = weight 1), row-major.
    pub fn from_u8(id: u32, digest: &str, width: u32, height: u32, bytes: &[u8]) -> Self {
        debug_assert_eq!(bytes.len(), (width as usize) * (height as usize));
        Self {
            id,
            digest: digest.to_string(),
            width,
            height,
            data: bytes.iter().map(|b| *b as f32 / 255.0).collect(),
        }
    }

    /// Bilinear sample at normalized `(nx, ny)`, both clamped to `[0, 1]`,
    /// mapping 0 to the first texel's centre and 1 to the last texel's
    /// centre — the same `(dim − 1)` convention the geometric masks use.
    /// An empty or zero-dimension raster reads as weight 0 everywhere.
    #[inline]
    pub fn sample(&self, nx: f32, ny: f32) -> f32 {
        if self.width == 0 || self.height == 0 || self.data.is_empty() {
            return 0.0;
        }
        let fx = nx.clamp(0.0, 1.0) * (self.width as f32 - 1.0).max(0.0);
        let fy = ny.clamp(0.0, 1.0) * (self.height as f32 - 1.0).max(0.0);
        let x0 = fx.floor() as usize;
        let y0 = fy.floor() as usize;
        let x1 = (x0 + 1).min(self.width as usize - 1);
        let y1 = (y0 + 1).min(self.height as usize - 1);
        let tx = fx - x0 as f32;
        let ty = fy - y0 as f32;
        let w = self.width as usize;
        let at = |x: usize, y: usize| self.data[y * w + x];
        let top = at(x0, y0) * (1.0 - tx) + at(x1, y0) * tx;
        let bottom = at(x0, y1) * (1.0 - tx) + at(x1, y1) * tx;
        top * (1.0 - ty) + bottom * ty
    }
}

/// Identity by `(id, digest, width, height)` — deliberately NOT by pixel
/// content: two `LocalAdjustment`s that reference the "same" raster (same
/// id resolved from the registry) must compare equal even if a caller built
/// two separately-allocated `MaskRaster` values with identical bytes, and a
/// content compare would be an expensive false negative on a large raster.
impl PartialEq for MaskRaster {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.digest == other.digest
            && self.width == other.width
            && self.height == other.height
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_by_two() -> MaskRaster {
        MaskRaster::from_u8(7, "0123456789abcdef", 2, 2, &[0, 255, 255, 0])
    }

    #[test]
    fn corners_sample_exactly() {
        let r = two_by_two();
        assert_eq!(r.sample(0.0, 0.0), 0.0);
        assert_eq!(r.sample(1.0, 0.0), 1.0);
        assert_eq!(r.sample(0.0, 1.0), 1.0);
        assert_eq!(r.sample(1.0, 1.0), 0.0);
    }

    #[test]
    fn centre_is_the_bilinear_mean() {
        assert!((two_by_two().sample(0.5, 0.5) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn out_of_range_coordinates_clamp() {
        let r = two_by_two();
        assert_eq!(r.sample(-3.0, -3.0), 0.0);
        assert_eq!(r.sample(9.0, -1.0), 1.0);
    }

    #[test]
    fn empty_raster_is_weight_zero() {
        let r = MaskRaster {
            id: 1,
            digest: "x".into(),
            width: 0,
            height: 0,
            data: vec![],
        };
        assert_eq!(r.sample(0.5, 0.5), 0.0);
    }

    #[test]
    fn a_single_pixel_raster_is_uniform() {
        let r = MaskRaster::from_u8(2, "0123456789abcdef", 1, 1, &[128]);
        assert!((r.sample(0.0, 0.0) - 128.0 / 255.0).abs() < 1e-6);
        assert!((r.sample(1.0, 1.0) - 128.0 / 255.0).abs() < 1e-6);
    }

    #[test]
    fn equality_is_by_identity_not_pixel_content() {
        let a = two_by_two();
        let mut b = two_by_two();
        b.data[0] = 0.5; // different pixels, same (id, digest, dims)
        assert_eq!(a, b);
        let mut c = two_by_two();
        c.id = 8;
        assert_ne!(a, c);
    }
}
