//! Convert a `PanoImage` (scene-linear RGB f32) to an 8-bit grayscale image
//! suitable for use with `imageproc` corner detection and BRIEF descriptors.
//!
//! Luminance formula: ITU-R BT.709 (Rec709) coefficients applied to the
//! scene-linear working space.  The result is clamped to [0, 255] and
//! converted to u8 before packing.

use imageproc::image::{GrayImage, ImageBuffer};

use crate::types::PanoImage;

/// Rec.709 luma coefficients applied to linear-light RGB.
///
/// Y = 0.2126·R + 0.7152·G + 0.0722·B
const LUM_R: f32 = 0.2126;
const LUM_G: f32 = 0.7152;
const LUM_B: f32 = 0.0722;

/// Convert `PanoImage` (scene-linear Rec.2020 D65 f32) to an 8-bit
/// `GrayImage` by computing Rec.709 luma and mapping [0, 1] to [0, 255].
///
/// Values above 1.0 are clamped to 255.  The luminance formula treats the
/// three channels as roughly perceptually weighted even though the primaries
/// are Rec.2020; the slight error is inconsequential for keypoint detection.
pub fn to_gray(img: &PanoImage) -> GrayImage {
    let w = img.width;
    let h = img.height;
    let mut buf: Vec<u8> = Vec::with_capacity((w * h) as usize);

    for i in 0..(w * h) as usize {
        let r = img.pixels[i * 3];
        let g = img.pixels[i * 3 + 1];
        let b = img.pixels[i * 3 + 2];
        let luma = LUM_R * r + LUM_G * g + LUM_B * b;
        let byte = (luma * 255.0).clamp(0.0, 255.0) as u8;
        buf.push(byte);
    }

    ImageBuffer::from_vec(w, h, buf).expect("pano-core: gray buffer size mismatch; this is a bug")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;

    #[test]
    fn gray_all_zeros_is_black() {
        let img = PanoImage::new(2, 2, ColorSpace::rec2020_d65_linear());
        let g = to_gray(&img);
        assert!(g.pixels().all(|p| p[0] == 0));
    }

    #[test]
    fn gray_pure_white_is_255() {
        let mut img = PanoImage::new(1, 1, ColorSpace::rec2020_d65_linear());
        img.pixels[0] = 1.0;
        img.pixels[1] = 1.0;
        img.pixels[2] = 1.0;
        let g = to_gray(&img);
        assert_eq!(g.get_pixel(0, 0)[0], 255);
    }

    #[test]
    fn gray_rec709_coefficients() {
        // Pure green at 1.0 should give floor(0.7152 * 255) = 182
        let mut img = PanoImage::new(1, 1, ColorSpace::rec2020_d65_linear());
        img.pixels[0] = 0.0;
        img.pixels[1] = 1.0;
        img.pixels[2] = 0.0;
        let g = to_gray(&img);
        let expected = (0.7152_f32 * 255.0) as u8;
        assert_eq!(g.get_pixel(0, 0)[0], expected);
    }
}
