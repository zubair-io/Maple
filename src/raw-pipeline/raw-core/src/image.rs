use std::collections::HashMap;

use crate::color::illuminant::Illuminant;
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
    /// Camera RGB reading of a neutral patch in the scene, G-normalized so
    /// the green channel is exactly 1.0. Matches the DNG `AsShotNeutral`
    /// semantics (§ 1.4.4.1): for the neutral, `camera_rgb = AsShotNeutral`,
    /// so `inv(ColorMatrix_scene) * AsShotNeutral = XYZ_scene_white`.
    ///
    /// Note: rawler's `wb_coeffs` are the *reciprocal* — WB multipliers (gains
    /// that balance the camera reading to 1). `decode::decode_bytes` inverts
    /// rawler's values before storing them here so downstream DCP math can
    /// treat this field per DNG spec.
    pub as_shot_neutral: [f32; 3],
    /// Correlated color temperature derived from metadata, if available.
    pub as_shot_cct: Option<f32>,
    pub camera_make: String,
    pub camera_model: String,
    /// Camera color matrices by calibration illuminant. Each is XYZ→camera per
    /// DNG spec (inverse at apply-time to get camera→XYZ). Populated from rawler
    /// per-illuminant data; may contain 1-2 entries. Used by DCP for dual-
    /// illuminant reciprocal-CCT interpolation (spec § 3.4).
    pub color_matrices: HashMap<Illuminant, Matrix3>,
    /// EXIF orientation (TIFF tag 0x0112) as captured by the camera. Applied
    /// as a final rotation/flip pass on the rendered RGB buffer to match the
    /// reference viewer's display orientation. `Normal` when metadata is
    /// absent or unreadable.
    pub orientation: ExifOrientation,
    /// Per-body exposure calibration in EV. DNG spec § C.1.2 (BaselineExposure,
    /// tag 50730): "applied as a gain in a scene-linear color space prior to
    /// the color-space transform". Corrects the systematic gap between
    /// hardware-saturation-normalized sensor values and the scene-referred
    /// 0.18-mid-gray reference. For DNG files this is read from the TIFF tag;
    /// for vendor RAW it falls back to [`camera_calibration`]. Default is 0.0.
    pub baseline_exposure: f32,
}

/// EXIF orientation (TIFF tag 0x0112). Values 1-8 per the spec. `Normal` is
/// the identity; `Rotate90` means the displayed image is the sensor rotated
/// 90° clockwise, etc. See pipeline::apply_orientation for the pixel-level
/// interpretation.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum ExifOrientation {
    #[default] Normal,          // 1
    HorizontalFlip,              // 2
    Rotate180,                   // 3
    VerticalFlip,                // 4
    Transpose,                   // 5
    Rotate90,                    // 6
    Transverse,                  // 7
    Rotate270,                   // 8
}

impl ExifOrientation {
    pub fn from_u16(v: u16) -> Self {
        match v {
            2 => Self::HorizontalFlip,
            3 => Self::Rotate180,
            4 => Self::VerticalFlip,
            5 => Self::Transpose,
            6 => Self::Rotate90,
            7 => Self::Transverse,
            8 => Self::Rotate270,
            _ => Self::Normal,
        }
    }

    /// True if this orientation swaps width and height (transpose-family).
    pub fn swaps_wh(self) -> bool {
        matches!(self,
            Self::Transpose | Self::Rotate90 | Self::Transverse | Self::Rotate270
        )
    }
}

/// Apply EXIF orientation to a packed-u8-RGB buffer. Returns `(new_w, new_h,
/// rotated_bytes)`. The input buffer is unchanged; caller substitutes the
/// returned triple. `Normal` is a cheap clone of the input.
///
/// The per-orientation source mapping is derived so that applying the
/// operation rotates the sensor frame into display orientation — the
/// displayed-image convention used by ACR and EXIF-aware viewers.
pub fn apply_orientation(
    rgb: &[u8], w: u32, h: u32, orient: ExifOrientation,
) -> (u32, u32, Vec<u8>) {
    let (sw, sh) = (w as usize, h as usize);
    debug_assert_eq!(rgb.len(), sw * sh * 3, "RGB buffer size mismatch");

    if orient == ExifOrientation::Normal {
        return (w, h, rgb.to_vec());
    }

    let (new_w, new_h) = if orient.swaps_wh() { (h, w) } else { (w, h) };
    let (dw, dh) = (new_w as usize, new_h as usize);
    let mut out = vec![0u8; dw * dh * 3];

    for yp in 0..dh {
        for xp in 0..dw {
            let (sx, sy) = match orient {
                ExifOrientation::Normal          => (xp, yp),
                ExifOrientation::HorizontalFlip  => (sw - 1 - xp, yp),
                ExifOrientation::Rotate180       => (sw - 1 - xp, sh - 1 - yp),
                ExifOrientation::VerticalFlip    => (xp, sh - 1 - yp),
                ExifOrientation::Transpose       => (yp, xp),
                ExifOrientation::Rotate90        => (yp, sh - 1 - xp),
                ExifOrientation::Transverse      => (sw - 1 - yp, sh - 1 - xp),
                ExifOrientation::Rotate270       => (sw - 1 - yp, xp),
            };
            let si = (sy * sw + sx) * 3;
            let di = (yp * dw + xp) * 3;
            out[di]     = rgb[si];
            out[di + 1] = rgb[si + 1];
            out[di + 2] = rgb[si + 2];
        }
    }
    (new_w, new_h, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2×3 RGB fixture: each pixel's R channel encodes a unique tag letter
    /// (ASCII); G = 0, B = 0. After orientation, we can read out the tag
    /// sequence to verify the pixel mapping. The image looks like:
    ///
    ///   A B
    ///   C D
    ///   E F
    fn tag_fixture_2x3() -> (u32, u32, Vec<u8>) {
        let tags = [b'A', b'B', b'C', b'D', b'E', b'F'];
        let mut v = Vec::with_capacity(18);
        for t in tags { v.extend_from_slice(&[t, 0, 0]); }
        (2, 3, v)
    }

    fn read_tags(rgb: &[u8]) -> Vec<char> {
        rgb.chunks_exact(3).map(|c| c[0] as char).collect()
    }

    #[test]
    fn apply_orientation_normal_is_identity() {
        let (w, h, rgb) = tag_fixture_2x3();
        let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::Normal);
        assert_eq!((nw, nh), (w, h));
        assert_eq!(read_tags(&out), vec!['A','B','C','D','E','F']);
    }

    #[test]
    fn apply_orientation_rotate90_cw_2x3_to_3x2() {
        // 2×3 source →[90° CW]→ 3×2 result:
        //   A B             E C A
        //   C D       ⇒     F D B
        //   E F
        let (w, h, rgb) = tag_fixture_2x3();
        let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::Rotate90);
        assert_eq!((nw, nh), (3, 2));
        assert_eq!(read_tags(&out), vec!['E','C','A','F','D','B']);
    }

    #[test]
    fn apply_orientation_rotate180_flips_both() {
        let (w, h, rgb) = tag_fixture_2x3();
        let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::Rotate180);
        assert_eq!((nw, nh), (w, h));
        // Reverse of A B C D E F → F E D C B A
        assert_eq!(read_tags(&out), vec!['F','E','D','C','B','A']);
    }

    #[test]
    fn apply_orientation_horizontal_flip() {
        let (w, h, rgb) = tag_fixture_2x3();
        let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::HorizontalFlip);
        assert_eq!((nw, nh), (w, h));
        //   A B → B A
        //   C D → D C
        //   E F → F E
        assert_eq!(read_tags(&out), vec!['B','A','D','C','F','E']);
    }

    #[test]
    fn apply_orientation_rotate270_ccw_2x3_to_3x2() {
        // 2×3 source →[270° CW = 90° CCW]→ 3×2 result:
        //   A B             B D F
        //   C D       ⇒     A C E
        //   E F
        let (w, h, rgb) = tag_fixture_2x3();
        let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::Rotate270);
        assert_eq!((nw, nh), (3, 2));
        assert_eq!(read_tags(&out), vec!['B','D','F','A','C','E']);
    }

    #[test]
    fn apply_orientation_rotate90_then_rotate270_round_trips() {
        let (w, h, rgb) = tag_fixture_2x3();
        let (w1, h1, rgb1) = apply_orientation(&rgb, w, h, ExifOrientation::Rotate90);
        let (w2, h2, rgb2) = apply_orientation(&rgb1, w1, h1, ExifOrientation::Rotate270);
        assert_eq!((w2, h2), (w, h));
        assert_eq!(rgb2, rgb);
    }

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
