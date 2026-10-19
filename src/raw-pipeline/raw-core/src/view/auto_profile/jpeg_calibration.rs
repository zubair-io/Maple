//! Final JPEG-band fit for the structured Auto tail. Neutral never calls this.
use super::{lut::ColorLut, preview::ExtractedPreview};
use crate::image::ExifOrientation;

/// Preserve the structured color field and calibrate its remaining channel
/// bias directly on tetrahedral LUT nodes with smooth, bounded corrections so
/// CPU and GPU hosts consume exactly the same artifact and apply order.
pub(super) fn calibrate(
    lut: &mut ColorLut,
    pixels: &[f32],
    w: usize,
    h: usize,
    orientation: ExifOrientation,
    preview: &ExtractedPreview,
) {
    let Some(design) = super::jpeg_band_design::build(lut.size, pixels, w, h, orientation, preview)
    else {
        return;
    };
    super::jpeg_band_solve::fit(lut, &design);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::auto_profile::preview::JpegColorSpace;
    #[test]
    fn final_residual_fits_jpeg_contrast_without_mutating_input() {
        let w = 256;
        let mut source = Vec::new();
        let target = image::RgbImage::from_fn(w, w, |x, _| {
            let v = 0.2 + 0.6 * x as f32 / (w - 1) as f32;
            source.extend_from_slice(&[v; 3]);
            image::Rgb([(((v - 0.5) * 1.4 + 0.5) * 255.0).round() as u8; 3])
        });
        let before = source.clone();
        let preview = ExtractedPreview {
            image: image::DynamicImage::ImageRgb8(target),
            color_space: JpegColorSpace::SRgb,
        };
        let mut lut = ColorLut::identity(33);
        calibrate(
            &mut lut,
            &source,
            w as usize,
            w as usize,
            ExifOrientation::Normal,
            &preview,
        );
        assert_eq!(source, before);
        let mut sums = [[0.0f64; 3]; 5];
        let mut counts = [0usize; 5];
        for (i, pixel) in source.chunks_exact(3).enumerate() {
            let x = i % w as usize;
            let y = i / w as usize;
            if x < 26 || x >= 230 || y < 26 || y >= 230 {
                continue;
            }
            let target = (((pixel[0] - 0.5) * 1.4 + 0.5) * 255.0).round() / 255.0;
            let b = [0.1, 0.25, 0.5, 0.75]
                .iter()
                .filter(|&&edge| target >= edge)
                .count();
            let out = lut.sample([pixel[0]; 3]);
            counts[b] += 1;
            for c in 0..3 {
                sums[b][c] += f64::from(out[c] - target);
            }
        }
        let mut previous = lut.sample([0.; 3]);
        for i in 1..=1024 {
            let current = lut.sample([i as f32 / 1024.; 3]);
            for c in 0..3 {
                assert!(
                    current[c] + 1e-6 >= previous[c],
                    "neutral ramp reversed at {i}, channel {c}"
                );
            }
            previous = current;
        }
        for b in 0..5 {
            if counts[b] >= 100 {
                for c in 0..3 {
                    assert!(
                        (sums[b][c] / counts[b] as f64).abs() < 0.01,
                        "band {b} channel {c}: {}",
                        sums[b][c] / counts[b] as f64
                    );
                }
            }
        }
    }
}
