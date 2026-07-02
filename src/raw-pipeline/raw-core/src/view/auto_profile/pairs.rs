//! Display-space JPEG↔Maple correspondences for the per-image color LUT fit.
//!
//! The #550 per-channel curve fit (`super::fit_display`) builds finely-weighted
//! per-band design matrices straight from the source crop — it does NOT need
//! explicit `(maple, jpeg)` pairs. The LUT fit (`super::lut`) does: it wants
//! representative RGB→RGB correspondences, for which the footprint MEAN of the
//! source pixels under each JPEG pixel is enough.
//!
//! This module shares #550's geometry exactly — same orient-to-display, same
//! aspect-crop, same 10%-border skip, same integer-span source→JPEG footprint
//! mapping (`(ox·crop)/out .. ((ox+1)·crop)/out`, each span ≥ 1px) — so the
//! source↔JPEG alignment matches the curve fit. It reuses the shared
//! `preview::decode_jpeg_pixel_to_srgb` decode and #550's
//! `fit_display::orient_rgb_f32_to_display`, so neither the decode formula nor
//! the orientation mapping can drift from #550.

use crate::image::ExifOrientation;

use super::fit_display::orient_rgb_f32_to_display;
use super::preview::{self, JpegColorSpace};

/// One display-space correspondence: the footprint-mean developed Maple RGB and
/// the decoded embedded-JPEG RGB at the same display pixel. Both are in
/// `DisplayEncodedSrgb` `[0, 1]`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplayPair {
    pub maple: [f32; 3],
    pub jpeg: [f32; 3],
}

/// Build display-space JPEG↔Maple correspondences.
///
/// `source_rgb` is the developed `DisplayEncodedSrgb` buffer (sensor-oriented,
/// interleaved RGB f32 in `[0, 1]`, `source_w × source_h`); `preview` is the
/// embedded JPEG (sensor-oriented). Both are oriented to the DISPLAY frame via
/// `orientation`, aspect-matched by centre-crop, and 10%-border-cropped. Each
/// kept output pixel pairs the footprint-MEAN source RGB (mean of the source
/// pixels the JPEG pixel downscales from, each channel clamped to `[0, 1]`)
/// with the JPEG pixel decoded via [`preview::decode_jpeg_pixel_to_srgb`].
///
/// This is pure geometry — it applies no quality gate. Returns an empty `Vec`
/// only when the aspect-crop collapses to zero area. The "too few pairs to
/// fit" rejection (and any preview-size / degenerate-histogram heuristics) live
/// in the LUT fit entry points above, which fall back to identity on `None`.
pub fn sample_display_pairs(
    source_rgb: &[f32],
    source_w: usize,
    source_h: usize,
    preview: image::DynamicImage,
    cs: JpegColorSpace,
    orientation: ExifOrientation,
) -> Vec<DisplayPair> {
    // Orient the embedded JPEG into the DISPLAY frame, matching #550 (the source
    // buffer arrives sensor-oriented and the render applies orientation AFTER
    // this stage, so both must be rotated into display before pairing).
    let preview = preview::orient_preview_to_display(preview, orientation);
    let preview_rgb = preview.to_rgb8();
    let target_w_px = preview_rgb.width() as usize;
    let target_h_px = preview_rgb.height() as usize;
    let jpeg = preview_rgb.as_raw();

    // Orient the source buffer into the DISPLAY frame (reuses #550's exact
    // per-pixel mapping; `Normal` borrows without a clone).
    let (source_w, source_h, oriented) =
        orient_rgb_f32_to_display(source_rgb, source_w, source_h, orientation);
    let source_rgb: &[f32] = &oriented;

    // Match aspect by centre-cropping the wider axis (verbatim from #550's
    // `fit_curve_from_preview_display`) so both buffers share a coordinate frame.
    let target_aspect = target_w_px as f64 / target_h_px as f64;
    let source_aspect = source_w as f64 / source_h as f64;
    let (crop_x_start, crop_x_end, crop_y_start, crop_y_end) =
        if (source_aspect - target_aspect).abs() < 0.01 {
            (0, source_w, 0, source_h)
        } else if source_aspect > target_aspect {
            let new_w = (source_h as f64 * target_aspect).round() as usize;
            let crop_x = (source_w - new_w) / 2;
            (crop_x, crop_x + new_w, 0, source_h)
        } else {
            let new_h = (source_w as f64 / target_aspect).round() as usize;
            let crop_y = (source_h - new_h) / 2;
            (0, source_w, crop_y, crop_y + new_h)
        };
    let crop_w = crop_x_end - crop_x_start;
    let crop_h = crop_y_end - crop_y_start;
    if crop_w == 0 || crop_h == 0 {
        return Vec::new();
    }

    // 10% border skip, matching #550 (the gate ignores the outer 10% frame to
    // avoid lens/letterbox edge mismatch).
    let border_w = (target_w_px as f64 * 0.1).round() as usize;
    let border_h = (target_h_px as f64 * 0.1).round() as usize;

    let mut pairs = Vec::new();
    for oy in 0..target_h_px {
        if oy < border_h || oy >= target_h_px - border_h {
            continue;
        }
        // Source row span for this output row (verbatim from
        // `solve::build_design_matrices`: `(oy·crop_h)/out_h .. ((oy+1)·…)`,
        // span ≥ 1px). The same integer mapping `footprint_sizes` uses.
        let sy0 = (oy * crop_h) / target_h_px;
        let mut sy1 = ((oy + 1) * crop_h) / target_h_px;
        if sy1 <= sy0 {
            sy1 = sy0 + 1;
        }
        let jrow = oy * target_w_px;
        for ox in 0..target_w_px {
            if ox < border_w || ox >= target_w_px - border_w {
                continue;
            }
            let sx0 = (ox * crop_w) / target_w_px;
            let mut sx1 = ((ox + 1) * crop_w) / target_w_px;
            if sx1 <= sx0 {
                sx1 = sx0 + 1;
            }

            // Footprint mean of the developed source RGB over this span (each
            // channel clamped to `[0, 1]`, matching the design-matrix clamp).
            let mut acc = [0.0f64; 3];
            let mut count = 0u32;
            for sy in sy0..sy1 {
                let srow = (crop_y_start + sy) * source_w + crop_x_start;
                for sx in sx0..sx1 {
                    let idx = (srow + sx) * 3;
                    acc[0] += source_rgb[idx].clamp(0.0, 1.0) as f64;
                    acc[1] += source_rgb[idx + 1].clamp(0.0, 1.0) as f64;
                    acc[2] += source_rgb[idx + 2].clamp(0.0, 1.0) as f64;
                    count += 1;
                }
            }
            if count == 0 {
                continue;
            }
            let inv = 1.0 / count as f64;
            let maple = [
                (acc[0] * inv) as f32,
                (acc[1] * inv) as f32,
                (acc[2] * inv) as f32,
            ];

            // Decode the JPEG pixel (byte/255 → shared color-space decode).
            let j = (jrow + ox) * 3;
            let jpeg = preview::decode_jpeg_pixel_to_srgb(
                [
                    jpeg[j] as f32 / 255.0,
                    jpeg[j + 1] as f32 / 255.0,
                    jpeg[j + 2] as f32 / 255.0,
                ],
                cs,
            );

            pairs.push(DisplayPair { maple, jpeg });
        }
    }
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 4×4 source paired against a 2×2 preview (matching aspect, `Normal`
    /// orientation, sRGB): the 10% border rounds to 0 (`(2·0.1).round() == 0`),
    /// so every output pixel is kept → 4 pairs. Each output pixel's footprint is
    /// the top-left / etc. 2×2 source block, so its `maple` is that block's mean.
    #[test]
    fn footprint_mean_pairs() {
        // 4×4 interleaved RGB. Encode a known per-pixel value into the red lane
        // (`pixel_index / 100`) and constants in green/blue so the footprint mean
        // is easy to predict.
        let (w, h) = (4usize, 4usize);
        let mut source = vec![0.0f32; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                let pixel_index = (y * w + x) as f32;
                source[i] = pixel_index / 100.0; // red: distinct per pixel
                source[i + 1] = 0.4; // green: constant
                source[i + 2] = 0.6; // blue: constant
            }
        }

        // 2×2 preview, sRGB, arbitrary byte values.
        let preview = image::DynamicImage::ImageRgb8(
            image::RgbImage::from_raw(
                2,
                2,
                vec![
                    10, 20, 30, // (0,0)
                    40, 50, 60, // (1,0)
                    70, 80, 90, // (0,1)
                    100, 110, 120, // (1,1)
                ],
            )
            .unwrap(),
        );

        let pairs = sample_display_pairs(
            &source,
            w,
            h,
            preview,
            JpegColorSpace::SRgb,
            ExifOrientation::Normal,
        );

        // No border skipped → one pair per 2×2 output pixel.
        assert_eq!(pairs.len(), 4, "expected 4 pairs, got {}", pairs.len());

        // Output (0,0) gathers the top-left 2×2 source block: pixel indices
        // 0, 1, 4, 5 → red mean = (0 + 1 + 4 + 5) / 4 / 100 = 10/400 = 0.025.
        let p00 = pairs[0];
        let expected_red = (0.0 + 1.0 + 4.0 + 5.0) / 4.0 / 100.0;
        assert!(
            (p00.maple[0] - expected_red).abs() < 1e-6,
            "footprint-mean red: got {}, want {expected_red}",
            p00.maple[0]
        );
        // Green/blue are constant across the block → mean equals the constant.
        assert!((p00.maple[1] - 0.4).abs() < 1e-6, "green {}", p00.maple[1]);
        assert!((p00.maple[2] - 0.6).abs() < 1e-6, "blue {}", p00.maple[2]);

        // sRGB preview decodes via byte/255 passthrough.
        assert!(
            (p00.jpeg[0] - 10.0 / 255.0).abs() < 1e-6,
            "jpeg red {}",
            p00.jpeg[0]
        );
        assert!(
            (p00.jpeg[1] - 20.0 / 255.0).abs() < 1e-6,
            "jpeg green {}",
            p00.jpeg[1]
        );
        assert!(
            (p00.jpeg[2] - 30.0 / 255.0).abs() < 1e-6,
            "jpeg blue {}",
            p00.jpeg[2]
        );
    }
}
