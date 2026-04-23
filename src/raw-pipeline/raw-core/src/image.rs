use crate::math::Matrix3;

/// Tracks the colorspace of each `Image` at runtime. Stages `debug_assert!`
/// on this at their entry and exit. See spec docs/spec/04-color-management.md.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ColorSpace {
    /// Post-sensor-linearization, pre-demosaic. Single-channel mosaic per pixel.
    CameraNativeMosaic,
    /// Post-demosaic, pre-DCP. Three-channel camera-native linear RGB.
    CameraNativeLinearRgb,
    /// Post-DCP: scene-referred linear Rec.2020 D65, f32, **unbounded**.
    /// Main working space per spec § 04.
    SceneLinearRec2020,
    /// Post-AgX: display-linear Rec.2020, [0, 1] clamped.
    DisplayLinearRec2020,
    /// Post-gamut matrix: display-linear sRGB, [0, 1].
    DisplayLinearSrgb,
    /// Post-gamma: sRGB gamma-encoded, u8-equivalent range.
    DisplayEncodedSrgb,
}

#[derive(Clone, Debug)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<[f32; 3]>,
    pub space: ColorSpace,
}

impl Image {
    pub fn new(width: u32, height: u32, space: ColorSpace) -> Self {
        let len = (width as usize) * (height as usize);
        Self { width, height, pixels: vec![[0.0; 3]; len], space }
    }

    pub fn pixel_count(&self) -> usize {
        (self.width as usize) * (self.height as usize)
    }

    pub fn assert_space(&self, expected: ColorSpace) {
        debug_assert_eq!(self.space, expected,
            "expected colorspace {:?}, got {:?}", expected, self.space);
    }
}

/// Bayer CFA pattern. X-Trans is deferred (spec § 3.3 explicitly excludes it
/// from the slice-1 demosaic path).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum CfaPattern {
    Rggb,
    Bggr,
    Grbg,
    Gbrg,
}

impl CfaPattern {
    /// Returns the color (0=R, 1=G, 2=B) at raw-space (x, y).
    pub fn color_at(self, x: u32, y: u32) -> u8 {
        let ex = (x & 1) as u8;
        let ey = (y & 1) as u8;
        match self {
            Self::Rggb => match (ex, ey) { (0,0)=>0, (1,0)=>1, (0,1)=>1, _=>2 },
            Self::Bggr => match (ex, ey) { (0,0)=>2, (1,0)=>1, (0,1)=>1, _=>0 },
            Self::Grbg => match (ex, ey) { (0,0)=>1, (1,0)=>0, (0,1)=>2, _=>1 },
            Self::Gbrg => match (ex, ey) { (0,0)=>1, (1,0)=>2, (0,1)=>0, _=>1 },
        }
    }
}

#[derive(Clone, Debug)]
pub struct RawImage {
    pub width: u32,
    pub height: u32,
    pub cfa: CfaPattern,
    pub black_level: [u32; 4],   // per CFA position, indexed as [y_even*2 + x_even]
    pub white_level: u32,
    pub raw_data: Vec<u16>,
    /// As-shot white-balance multipliers from camera metadata.
    ///
    /// Convention: `neutralized_pixel[c] = raw_pixel[c] * as_shot_neutral[c]`.
    /// This is rawler's `wb_coeffs` convention (**multipliers**, NOT the DNG
    /// `AsShotNeutral` reciprocal). The green channel is normalized to 1.0.
    /// Consumers in WB and DCP stages must follow this multiply-to-neutralize
    /// convention.
    pub as_shot_neutral: [f32; 3],
    /// Correlated color temperature derived from metadata, if available.
    pub as_shot_cct: Option<f32>,
    pub camera_make: String,
    pub camera_model: String,
    /// Embedded camera color matrices. DNG carries these in tags; non-DNG
    /// RAWs get a synthesized profile from rawler's built-in adobe_coeff table.
    /// Full DCP with HSM/PLT lands in slice 4 per roadmap.
    pub embedded_color_matrix: Option<Matrix3>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_image_zero_initialized() {
        let img = Image::new(4, 2, ColorSpace::SceneLinearRec2020);
        assert_eq!(img.pixel_count(), 8);
        assert!(img.pixels.iter().all(|p| *p == [0.0, 0.0, 0.0]));
    }

    #[test]
    fn rggb_pattern_positions() {
        let p = CfaPattern::Rggb;
        assert_eq!(p.color_at(0, 0), 0); // R
        assert_eq!(p.color_at(1, 0), 1); // G
        assert_eq!(p.color_at(0, 1), 1); // G
        assert_eq!(p.color_at(1, 1), 2); // B
    }

    #[test]
    fn bggr_pattern_positions() {
        let p = CfaPattern::Bggr;
        assert_eq!(p.color_at(0, 0), 2);
        assert_eq!(p.color_at(1, 1), 0);
    }

    #[test]
    #[should_panic(expected = "expected colorspace")]
    fn assert_space_panics_on_mismatch() {
        let img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.assert_space(ColorSpace::DisplayLinearSrgb);
    }
}
