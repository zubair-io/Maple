//! JPEG-pixel observations of eval-then-BOX, not LUT(mean(input)) (#5000).
use super::{
    fit_display::orient_rgb_f32_to_display,
    lut::ColorLut,
    paired_fit::corners,
    preview::{self, ExtractedPreview},
};
use crate::image::ExifOrientation;

pub(super) struct Observation {
    pub weights: Vec<(usize, f64)>,
    pub source: [f64; 3],
    pub target: [f64; 3],
    pub baseline: [f64; 3],
    pub validation: bool,
    pub region: usize,
}

fn mix(mut x: u64) -> u64 {
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
    x ^ (x >> 31)
}

fn within(seed: u64, start: usize, end: usize) -> usize {
    start + (seed % (end - start) as u64) as usize
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

pub(super) fn build(
    pixels: &[f32],
    width: usize,
    height: usize,
    orientation: ExifOrientation,
    preview: &ExtractedPreview,
    baseline: &ColorLut,
) -> Option<Vec<Observation>> {
    if width == 0 || height == 0 || pixels.len() != width.checked_mul(height)?.checked_mul(3)? {
        return None;
    }
    if pixels.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let (width, height, source) = orient_rgb_f32_to_display(pixels, width, height, orientation);
    let target = preview::orient_preview_to_display(preview.image.clone(), orientation).to_rgb8();
    let (tw, th) = (target.width() as usize, target.height() as usize);
    if tw < 16 || th < 16 {
        return None;
    }
    let aspect = tw as f64 / th as f64;
    let (cw, ch) = if (width as f64 / height as f64 - aspect).abs() <= 0.001 {
        (width, height)
    } else if width as f64 / height as f64 > aspect {
        ((height as f64 * aspect).round() as usize, height)
    } else {
        (width, (width as f64 / aspect).round() as usize)
    };
    if cw == 0 || ch == 0 || cw > width || ch > height {
        return None;
    }
    let (ox, oy) = ((width - cw) / 2, (height - ch) / 2);
    let xs = spans(cw, tw);
    let ys = spans(ch, th);
    let (nx, ny) = (tw.min(256), th.min(256));
    let mut observations = Vec::with_capacity(nx * ny);
    let mut weights = [0.; super::paired_fit::CELLS];
    let mut active = Vec::new();
    for gy in 0..ny {
        for gx in 0..nx {
            let seed = mix((gx as u64 + 1).wrapping_mul(0x9e3779b97f4a7c15) ^ (gy as u64 + 1));
            let (x0, x1) = (gx * tw / nx, (gx + 1) * tw / nx);
            let (y0, y1) = (gy * th / ny, (gy + 1) * th / ny);
            let x = within(seed, x0, x1);
            let y = within(seed >> 32, y0, y1);
            let ((sx0, sx1), (sy0, sy1)) = (xs[x], ys[y]);
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
                    let prediction = baseline.sample(rgb);
                    for c in 0..3 {
                        base[c] += f64::from(prediction[c]) / count;
                    }
                }
            }
            let rgb = target
                .get_pixel(x as u32, y as u32)
                .0
                .map(|v| v as f32 / 255.);
            let target = preview::decode_jpeg_pixel_to_srgb(rgb, preview.color_space)
                .map(|v| f64::from((v * 255.).round().clamp(0., 255.) / 255.));
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
            observations.push(Observation {
                weights: row,
                source: identity,
                target,
                baseline: base,
                validation: mix(seed ^ 0x517cc1b727220a95) % 4 == 0,
                region: (y * 8 / th) * 8 + x * 8 / tw,
            });
        }
    }
    Some(observations)
}

#[cfg(test)]
mod tests {
    use super::*;
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
