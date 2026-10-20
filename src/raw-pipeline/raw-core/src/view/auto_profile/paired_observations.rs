//! JPEG-pixel observations of eval-then-BOX, not LUT(mean(input)) (#5000).
use super::{
    fit_display::orient_rgb_f32_to_display,
    fit_registration::Warp,
    lut::ColorLut,
    paired_fit::{corners, corners_at},
    preview::{self, ExtractedPreview},
};
use crate::image::ExifOrientation;

#[cfg_attr(feature = "stage-dump", derive(serde::Serialize))]
pub(super) struct Observation {
    pub weights: Vec<(usize, f64)>,
    pub artifact_weights: Vec<(usize, f64)>,
    pub source: [f64; 3],
    pub target: [f64; 3],
    pub baseline: [f64; 3],
    pub population: usize,
    pub validation: bool,
    pub in_bias_region: bool,
    pub region: usize,
}

pub(super) struct ObservationSet {
    pub rows: Vec<Observation>,
    pub grid_width: usize,
    pub grid_height: usize,
}

fn mix(mut x: u64) -> u64 {
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
    x ^ (x >> 31)
}

fn within(seed: u64, start: usize, end: usize) -> usize {
    start + (seed % (end - start) as u64) as usize
}

fn in_bias_region(x: usize, y: usize, width: usize, height: usize) -> bool {
    let border_x = (width as f64 * 0.1).round_ties_even() as usize;
    let border_y = (height as f64 * 0.1).round_ties_even() as usize;
    x >= border_x && x < width - border_x && y >= border_y && y < height - border_y
}

fn spans(source: usize, target: usize) -> Vec<(usize, usize)> {
    let scale = source as f64 / target as f64;
    let support = scale.max(1.) * 0.5;
    (0..target)
        .map(|i| {
            let center = (i as f64 + 0.5) * scale;
            let lo = ((center - support + 0.5).max(0.) as usize).min(source - 1);
            let hi = ((center + support + 0.5).max(0.) as usize)
                .min(source)
                .max(lo + 1);
            (lo, hi)
        })
        .collect()
}

fn box_byte(sum: f64, count: usize) -> f64 {
    let coefficient = ((1u64 << 22) as f64 / count as f64).round() as i64;
    ((sum as i64 * coefficient + (1 << 21)) >> 22).clamp(0, 255) as f64
}

pub(super) fn build(
    pixels: &[f32],
    width: usize,
    height: usize,
    orientation: ExifOrientation,
    preview: &ExtractedPreview,
    baseline: &ColorLut,
) -> Option<ObservationSet> {
    build_at_scale(
        pixels,
        width,
        height,
        orientation,
        preview,
        baseline,
        None,
        None,
    )
}

pub(super) fn build_display(
    pixels: &[f32],
    width: usize,
    height: usize,
    orientation: ExifOrientation,
    preview: &ExtractedPreview,
    baseline: &ColorLut,
) -> Option<ObservationSet> {
    build_at_scale(
        pixels,
        width,
        height,
        orientation,
        preview,
        baseline,
        Some(1024),
        None,
    )
}

pub(super) fn build_aligned(
    pixels: &[f32],
    width: usize,
    height: usize,
    orientation: ExifOrientation,
    preview: &ExtractedPreview,
    baseline: &ColorLut,
    warp: Warp,
) -> Option<ObservationSet> {
    build_at_scale(
        pixels,
        width,
        height,
        orientation,
        preview,
        baseline,
        Some(1024),
        (warp != Warp::IDENTITY).then_some(warp),
    )
}

pub(super) fn build_native_aligned(
    pixels: &[f32],
    width: usize,
    height: usize,
    orientation: ExifOrientation,
    preview: &ExtractedPreview,
    baseline: &ColorLut,
    warp: Warp,
) -> Option<ObservationSet> {
    build_at_scale(
        pixels,
        width,
        height,
        orientation,
        preview,
        baseline,
        None,
        (warp != Warp::IDENTITY).then_some(warp),
    )
}

fn transformed_span(center: f64, extent: f64, limit: usize) -> Option<(usize, usize)> {
    let support = extent.max(1.) * 0.5;
    if !center.is_finite()
        || !extent.is_finite()
        || extent <= 0.
        || center - support < -1e-9
        || center + support > limit as f64 + 1e-9
    {
        return None;
    }
    let lo = ((center - support + 0.5).max(0.) as usize).min(limit - 1);
    let hi = ((center + support + 0.5).max(0.) as usize)
        .min(limit)
        .max(lo + 1);
    Some((lo, hi))
}

fn build_at_scale(
    pixels: &[f32],
    width: usize,
    height: usize,
    orientation: ExifOrientation,
    preview: &ExtractedPreview,
    baseline: &ColorLut,
    max_edge: Option<usize>,
    warp: Option<Warp>,
) -> Option<ObservationSet> {
    if width == 0 || height == 0 || pixels.len() != width.checked_mul(height)?.checked_mul(3)? {
        return None;
    }
    if pixels.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let (width, height, source) = orient_rgb_f32_to_display(pixels, width, height, orientation);
    let target = preview::orient_preview_to_display(preview.image.clone(), orientation).to_rgb8();
    let (original_w, original_h) = (target.width() as usize, target.height() as usize);
    let scale = max_edge.map_or(1., |edge| {
        (edge as f64 / original_w.max(original_h) as f64).min(1.)
    });
    let (tw, th) = (
        (original_w as f64 * scale).round_ties_even().max(16.) as usize,
        (original_h as f64 * scale).round_ties_even().max(16.) as usize,
    );
    if original_w < 16 || original_h < 16 {
        return None;
    }
    let aspect = original_w as f64 / original_h as f64;
    let (cw, ch) = if (width as f64 / height as f64 - aspect).abs() <= 0.001 {
        (width, height)
    } else if width as f64 / height as f64 > aspect {
        ((height as f64 * aspect).round_ties_even() as usize, height)
    } else {
        (width, (width as f64 / aspect).round_ties_even() as usize)
    };
    if cw == 0 || ch == 0 || cw > width || ch > height {
        return None;
    }
    let (ox, oy) = ((width - cw) / 2, (height - ch) / 2);
    let xs = spans(cw, tw);
    let ys = spans(ch, th);
    let target_xs = spans(original_w, tw);
    let target_ys = spans(original_h, th);
    let (nx, ny) = (tw.min(256), th.min(256));
    let mut observations = Vec::with_capacity(nx * ny);
    let mut weights = [0.; super::paired_fit::CELLS];
    let mut active = Vec::new();
    let mut artifact_weights = vec![0.; baseline.size.pow(3)];
    let mut artifact_active = Vec::new();
    for gy in 0..ny {
        for gx in 0..nx {
            let seed = mix((gx as u64 + 1).wrapping_mul(0x9e3779b97f4a7c15) ^ (gy as u64 + 1));
            let (x0, x1) = (gx * tw / nx, (gx + 1) * tw / nx);
            let (y0, y1) = (gy * th / ny, (gy + 1) * th / ny);
            let x = within(seed, x0, x1);
            let y = within(seed >> 32, y0, y1);
            let ((sx0, sx1), (sy0, sy1)) = if let Some(warp) = warp {
                let center = warp.map((x as f64 + 0.5) / tw as f64, (y as f64 + 0.5) / th as f64);
                let support = warp.support(
                    cw,
                    ch,
                    tw,
                    th,
                    (x as f64 + 0.5) / tw as f64,
                    (y as f64 + 0.5) / th as f64,
                );
                let Some(sx) = transformed_span(center[0] * cw as f64, support[0], cw) else {
                    continue;
                };
                let Some(sy) = transformed_span(center[1] * ch as f64, support[1], ch) else {
                    continue;
                };
                (sx, sy)
            } else {
                (xs[x], ys[y])
            };
            let count = ((sx1 - sx0) * (sy1 - sy0)) as f64;
            let mut base = [0.; 3];
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let i = ((oy + sy) * width + ox + sx) * 3;
                    let rgb = [
                        source[i].clamp(0., 1.),
                        source[i + 1].clamp(0., 1.),
                        source[i + 2].clamp(0., 1.),
                    ];
                    for (j, w) in corners(rgb) {
                        if w > 0. {
                            if weights[j] == 0. {
                                active.push(j);
                            }
                            weights[j] += w / count;
                        }
                    }
                    for (j, w) in corners_at(rgb, baseline.size) {
                        if w > 0. {
                            if artifact_weights[j] == 0. {
                                artifact_active.push(j);
                            }
                            artifact_weights[j] += w / count;
                        }
                    }
                }
            }
            let ((tx0, tx1), (ty0, ty1)) = (target_xs[x], target_ys[y]);
            let mut average = [0.; 3];
            for ty in ty0..ty1 {
                let mut horizontal = [0.; 3];
                for tx in tx0..tx1 {
                    let rgb = target
                        .get_pixel(tx as u32, ty as u32)
                        .0
                        .map(|v| v as f32 / 255.);
                    let normalized = preview::decode_jpeg_pixel_to_srgb(rgb, preview.color_space);
                    for c in 0..3 {
                        horizontal[c] += f64::from((normalized[c] * 255.).round().clamp(0., 255.));
                    }
                }
                for c in 0..3 {
                    average[c] += box_byte(horizontal[c], tx1 - tx0);
                }
            }
            let target = average.map(|v| box_byte(v, ty1 - ty0) / 255.);
            let mut row = Vec::with_capacity(active.len());
            let mut identity = [0.; 3];
            for &j in &active {
                let w = weights[j];
                row.push((j, w));
                weights[j] = 0.;
                let rgb = [
                    j % super::paired_fit::GRID,
                    (j / super::paired_fit::GRID) % super::paired_fit::GRID,
                    j / (super::paired_fit::GRID * super::paired_fit::GRID),
                ];
                for c in 0..3 {
                    identity[c] += w * rgb[c] as f64 / (super::paired_fit::GRID - 1) as f64;
                }
            }
            active.clear();
            let mut artifact_row = Vec::with_capacity(artifact_active.len());
            for &j in &artifact_active {
                let w = artifact_weights[j];
                artifact_row.push((j, w));
                artifact_weights[j] = 0.;
                for c in 0..3 {
                    base[c] += w * f64::from(baseline.data[j * 3 + c]);
                }
            }
            artifact_active.clear();
            observations.push(Observation {
                weights: row,
                artifact_weights: artifact_row,
                source: identity,
                target,
                baseline: base,
                population: (x1 - x0) * (y1 - y0),
                validation: mix(seed ^ 0x517cc1b727220a95) % 4 == 0,
                in_bias_region: in_bias_region(x, y, tw, th),
                region: (y * 8 / th) * 8 + x * 8 / tw,
            });
        }
    }
    Some(ObservationSet {
        rows: observations,
        grid_width: nx,
        grid_height: ny,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aligned_training_samples_corresponding_pixels_without_changing_identity_observations() {
        let image = image::RgbImage::from_fn(64, 64, |x, y| {
            image::Rgb([(x * 3) as u8, (y * 3) as u8, 64])
        });
        let pixels: Vec<_> = image.as_raw().iter().map(|v| *v as f32 / 255.).collect();
        let target = image::RgbImage::from_fn(64, 64, |x, y| *image.get_pixel((x + 3).min(63), y));
        let preview = ExtractedPreview {
            image: image::DynamicImage::ImageRgb8(target),
            color_space: preview::JpegColorSpace::SRgb,
        };
        let prior = ColorLut::identity(33);
        let plain = build(&pixels, 64, 64, ExifOrientation::Normal, &preview, &prior).unwrap();
        let identity = build_aligned(
            &pixels,
            64,
            64,
            ExifOrientation::Normal,
            &preview,
            &prior,
            Warp::IDENTITY,
        )
        .unwrap();
        for (a, b) in plain.rows.iter().zip(&identity.rows) {
            assert_eq!(a.weights, b.weights);
            assert_eq!(a.artifact_weights, b.artifact_weights);
            assert_eq!(a.baseline, b.baseline);
            assert_eq!(a.target, b.target);
        }
        let aligned = build_aligned(
            &pixels,
            64,
            64,
            ExifOrientation::Normal,
            &preview,
            &prior,
            Warp {
                radial: 0.,
                coefficients: [1., 0., 3. / 64., 0., 1., 0.],
            },
        )
        .unwrap();
        assert_eq!(aligned.rows.len(), 61 * 64);
        for row in aligned.rows {
            for c in 0..3 {
                assert!((row.source[c] - row.target[c]).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn legacy_bias_window_uses_exact_native_pixel_bounds_and_ties_even() {
        for (width, height, bx, by) in [(1616, 1080, 162, 108), (25, 35, 2, 4), (35, 25, 4, 2)] {
            assert!(in_bias_region(bx, by, width, height));
            assert!(in_bias_region(
                width - bx - 1,
                height - by - 1,
                width,
                height
            ));
            assert!(!in_bias_region(bx - 1, by, width, height));
            assert!(!in_bias_region(width - bx, by, width, height));
            assert!(!in_bias_region(bx, by - 1, width, height));
            assert!(!in_bias_region(bx, height - by, width, height));
        }
    }

    #[test]
    fn display_target_matches_pillow_box_after_srgb_quantization() {
        let examples: [(usize, usize, usize, &[u8]); 3] = [
            (
                128,
                64,
                32,
                include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../../test-fixtures/auto-jpeg-quality/box-target-32x16.png"
                )),
            ),
            (
                128,
                64,
                57,
                include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../../test-fixtures/auto-jpeg-quality/box-target-57x28.png"
                )),
            ),
            (
                384,
                192,
                32,
                include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../../test-fixtures/auto-jpeg-quality/box-target-32x16-factor12.png"
                )),
            ),
        ];
        for (width, height, edge, png) in examples {
            let image = image::RgbImage::from_fn(width as u32, height as u32, |x, y| {
                image::Rgb([
                    ((13 * x + 11 * y) % 256) as u8,
                    ((7 * x + 5 * y) % 256) as u8,
                    ((x * x + 3 * y) % 256) as u8,
                ])
            });
            let preview = ExtractedPreview {
                image: image::DynamicImage::ImageRgb8(image),
                color_space: preview::JpegColorSpace::SRgb,
            };
            let pixels = vec![0.5; width * height * 3];
            let expected = image::load_from_memory(png).unwrap().to_rgb8();
            let rows = build_at_scale(
                &pixels,
                width,
                height,
                ExifOrientation::Normal,
                &preview,
                &ColorLut::identity(33),
                Some(edge),
                None,
            )
            .unwrap()
            .rows;
            assert_eq!(rows.len(), (expected.width() * expected.height()) as usize);
            for (row, pixel) in rows.iter().zip(expected.pixels()) {
                for c in 0..3 {
                    assert_eq!(row.target[c], f64::from(pixel.0[c]) / 255.);
                }
            }
        }
    }
    #[test]
    fn aspect_crop_rounds_half_to_even_like_the_comparator() {
        let image = image::RgbImage::from_fn(17, 16, |x, y| image::Rgb([x as u8, y as u8, 0]));
        let preview = ExtractedPreview {
            image: image::DynamicImage::ImageRgb8(image),
            color_space: preview::JpegColorSpace::SRgb,
        };
        let mut pixels = vec![0.; 44 * 40 * 3];
        for y in 0..40 {
            for x in 0..44 {
                pixels[(y * 44 + x) * 3] = x as f32 / 43.;
            }
        }
        let rows = build(
            &pixels,
            44,
            40,
            ExifOrientation::Normal,
            &preview,
            &ColorLut::identity(33),
        )
        .unwrap()
        .rows;
        let bounds = spans(42, 17);
        for row in rows {
            let x = (row.target[0] * 255.).round() as usize;
            let (lo, hi) = bounds[x];
            let expected = (1. + (lo + hi - 1) as f64 * 0.5) / 43.;
            assert!((row.source[0] - expected).abs() < 1e-6);
        }
    }
    #[test]
    fn sample_coordinates_do_not_depend_on_pointer_width() {
        assert_eq!(within(0xfedcba9876543210, 10, 58), 10);
        assert_eq!(within(0xfedcba9876543210u64 as u32 as u64, 10, 58), 26);
    }
    #[test]
    fn box_spans_follow_pixel_centers_for_resize_in_both_directions() {
        assert_eq!(spans(5, 3), vec![(0, 2), (2, 3), (3, 5)]);
        assert_eq!(spans(3, 5), vec![(0, 1), (0, 1), (1, 2), (2, 3), (2, 3)]);
    }
}
