//! The band means are linear in actual tetrahedral LUT node values.
//! Match the physical JPEG gate's crop, BOX footprint centers and band masks.
use super::{
    fit_display::orient_rgb_f32_to_display,
    preview::{self, ExtractedPreview, JpegColorSpace},
};
use crate::image::ExifOrientation;

pub(super) struct Design {
    pub rows: [Vec<f64>; 5],
    pub targets: [[f64; 3]; 5],
    pub counts: [usize; 5],
}

/// Same four corners and nonnegative weights as ColorLut::sample_grid.
fn corners(n: usize, rgb: [f32; 3]) -> [(usize, f64); 4] {
    let mut lo = [0usize; 3];
    let mut f = [0.; 3];
    for c in 0..3 {
        let p = rgb[c].clamp(0., 1.) * (n - 1) as f32;
        let l = p.floor().min((n - 2) as f32);
        lo[c] = l as usize;
        f[c] = p - l;
    }
    let mut axes = [0, 1, 2];
    axes.sort_by(|&a, &b| f[b].total_cmp(&f[a]));
    let stride = [1, n, n * n];
    let start = (lo[2] * n + lo[1]) * n + lo[0];
    [
        (start, f64::from(1. - f[axes[0]])),
        (start + stride[axes[0]], f64::from(f[axes[0]] - f[axes[1]])),
        (
            start + stride[axes[0]] + stride[axes[1]],
            f64::from(f[axes[1]] - f[axes[2]]),
        ),
        (start + 1 + n + n * n, f64::from(f[axes[2]])),
    ]
}

/// Pillow BOX uses pixel centers, including nearest-center mapping on upscale.
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
    n: usize,
    pixels: &[f32],
    w: usize,
    h: usize,
    orientation: ExifOrientation,
    p: &ExtractedPreview,
) -> Option<Design> {
    let target = preview::orient_preview_to_display(p.image.clone(), orientation).to_rgb8();
    let (tw, th) = (target.width() as usize, target.height() as usize);
    if tw < 256 || th < 256 {
        return None;
    }
    let mut histogram = [0usize; 64];
    for &v in target.as_raw() {
        histogram[(usize::from(v) * 63) / 255] += 1;
    }
    if histogram.iter().copied().max().unwrap_or(0) as f64 > target.as_raw().len() as f64 * 0.99 {
        return None;
    }
    let (sw, sh, source) = orient_rgb_f32_to_display(pixels, w, h, orientation);
    if sw == 0 || sh == 0 {
        return None;
    }
    let ratio = tw as f64 / th as f64;
    let (cw, ch) = if (sw as f64 / sh as f64 - ratio).abs() <= 0.001 {
        (sw, sh)
    } else if sw as f64 / sh as f64 > ratio {
        ((sh as f64 * ratio).round_ties_even() as usize, sh)
    } else {
        (sw, (sw as f64 / ratio).round_ties_even() as usize)
    };
    if cw == 0 || ch == 0 {
        return None;
    }
    let (x0, y0) = ((sw - cw) / 2, (sh - ch) / 2);
    let xs = spans(cw, tw);
    let ys = spans(ch, th);
    let bx = (tw as f64 * 0.1).round_ties_even() as usize;
    let by = (th as f64 * 0.1).round_ties_even() as usize;
    let mut design = Design {
        rows: std::array::from_fn(|_| vec![0.; n * n * n]),
        targets: [[0.; 3]; 5],
        counts: [0; 5],
    };
    for y in by..th - by {
        for x in bx..tw - bx {
            let byte = target.get_pixel(x as u32, y as u32).0;
            let mut rgb = byte.map(|v| f64::from(v) / 255.);
            if p.color_space == JpegColorSpace::AdobeRgb {
                // The extracted reference PNG quantizes its normalized sRGB.
                rgb = preview::decode_jpeg_pixel_to_srgb(
                    byte.map(|v| f32::from(v) / 255.),
                    p.color_space,
                )
                .map(|v| f64::from((v * 255.).round().clamp(0., 255.)) / 255.);
            }
            let luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
            let b = [0.1, 0.25, 0.5, 0.75]
                .iter()
                .filter(|&&e| luma >= e)
                .count();
            design.counts[b] += 1;
            for c in 0..3 {
                design.targets[b][c] += rgb[c];
            }
            let (xl, xh) = xs[x];
            let (yl, yh) = ys[y];
            let weight = 1. / ((xh - xl) * (yh - yl)) as f64;
            for sy in yl..yh {
                for sx in xl..xh {
                    let i = ((y0 + sy) * sw + x0 + sx) * 3;
                    let v = [source[i], source[i + 1], source[i + 2]];
                    if !v.iter().all(|v| v.is_finite()) {
                        return None;
                    }
                    for (node, coefficient) in corners(n, v) {
                        design.rows[b][node] += coefficient * weight;
                    }
                }
            }
        }
    }
    for b in 0..5 {
        if design.counts[b] < 100 {
            continue;
        }
        let divisor = design.counts[b] as f64;
        for v in &mut design.rows[b] {
            *v /= divisor;
        }
        for v in &mut design.targets[b] {
            *v /= divisor;
        }
    }
    Some(design)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::auto_profile::lut::ColorLut;
    #[test]
    fn weights_match_actual_tetrahedral_interpolator() {
        let mut lut = ColorLut::identity(9);
        for (i, v) in lut.data.iter_mut().enumerate() {
            *v = ((i * 31 % 997) as f32) / 996.;
        }
        for i in 0..1000 {
            let rgb = [
                (i % 17) as f32 / 16.,
                (i % 23) as f32 / 22.,
                (i % 31) as f32 / 30.,
            ];
            let actual = lut.sample(rgb);
            let weights = corners(lut.size, rgb);
            assert!((weights.iter().map(|v| v.1).sum::<f64>() - 1.).abs() < 2e-7);
            for c in 0..3 {
                let expected = weights
                    .iter()
                    .map(|&(idx, w)| w * f64::from(lut.data[idx * 3 + c]))
                    .sum::<f64>();
                assert!((expected - f64::from(actual[c])).abs() < 2e-7);
            }
        }
    }
    #[test]
    fn box_footprints_match_independent_pillow_witnesses() {
        assert_eq!(spans(5, 3), vec![(0, 2), (2, 3), (3, 5)]);
        assert_eq!(spans(3, 5), vec![(0, 1), (0, 1), (1, 2), (2, 3), (2, 3)]);
        assert_eq!(spans(7, 4), vec![(0, 2), (2, 4), (4, 5), (5, 7)]);
    }
}
