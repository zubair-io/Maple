//! Gaussian scale pyramid over log luminance.
//!
//! Detection runs on `ln(Y + floor)` of the scene-linear Rec.2020 luma: a
//! linear exposure multiply becomes an additive offset that every gradient
//! ignores, so two frames bracketed differently still produce the same
//! corner responses and descriptors.

use rayon::prelude::*;

use crate::features::LinearRgbFrame;

const REC2020_LUMA: [f32; 3] = [0.2627, 0.6780, 0.0593];
/// Bounds the log's gain in deep shadow so sensor noise there does not
/// dominate the corner response (≈ 10 stops below nominal white).
const LOG_LUMA_FLOOR: f32 = 1.0 / 1024.0;
/// Blur already present in a sampled image (the usual half-texel prior).
pub(super) const INPUT_SIGMA: f32 = 0.5;

/// Row-major single-channel f32 image.
#[derive(Debug, Clone)]
pub(super) struct GrayImage {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f32>,
}

impl GrayImage {
    pub fn clamped(&self, x: isize, y: isize) -> f32 {
        let cx = x.clamp(0, self.width as isize - 1) as usize;
        let cy = y.clamp(0, self.height as isize - 1) as usize;
        self.data[cy * self.width + cx]
    }

    /// Central-difference gradient with clamp-to-edge borders.
    pub fn gradient(&self, x: usize, y: usize) -> (f32, f32) {
        let (xi, yi) = (x as isize, y as isize);
        (
            0.5 * (self.clamped(xi + 1, yi) - self.clamped(xi - 1, yi)),
            0.5 * (self.clamped(xi, yi + 1) - self.clamped(xi, yi - 1)),
        )
    }
}

/// One blurred image of an octave: `sigma` is its total blur in this
/// octave's own pixel units.
pub(super) struct ScaleLevel {
    pub image: GrayImage,
    pub sigma: f32,
}

pub(super) fn log_luma(frame: &LinearRgbFrame) -> GrayImage {
    let data = frame
        .pixels
        .par_chunks_exact(3)
        .map(|px| {
            let y = REC2020_LUMA[0] * px[0] + REC2020_LUMA[1] * px[1] + REC2020_LUMA[2] * px[2];
            (y.max(0.0) + LOG_LUMA_FLOOR).ln()
        })
        .collect();
    GrayImage {
        width: frame.width as usize,
        height: frame.height as usize,
        data,
    }
}

fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let radius = (3.0 * sigma).ceil().max(1.0) as isize;
    let raw: Vec<f32> = (-radius..=radius)
        .map(|i| (-((i * i) as f32) / (2.0 * sigma * sigma)).exp())
        .collect();
    let total: f32 = raw.iter().sum();
    raw.into_iter().map(|w| w / total).collect()
}

/// Separable Gaussian blur, clamp-to-edge.
pub(super) fn gaussian_blur(image: &GrayImage, sigma: f32) -> GrayImage {
    if sigma <= 0.0 {
        return image.clone();
    }
    let kernel = gaussian_kernel(sigma);
    let radius = (kernel.len() / 2) as isize;
    let (w, h) = (image.width, image.height);
    let mut horizontal = vec![0.0_f32; w * h];
    horizontal
        .par_chunks_mut(w)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, out) in row.iter_mut().enumerate() {
                *out = kernel
                    .iter()
                    .enumerate()
                    .map(|(i, k)| k * image.clamped(x as isize + i as isize - radius, y as isize))
                    .sum();
            }
        });
    let mut data = vec![0.0_f32; w * h];
    data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (i, k) in kernel.iter().enumerate() {
            let sy = (y as isize + i as isize - radius).clamp(0, h as isize - 1) as usize;
            let src = &horizontal[sy * w..(sy + 1) * w];
            row.iter_mut().zip(src).for_each(|(o, s)| *o += k * s);
        }
    });
    GrayImage {
        width: w,
        height: h,
        data,
    }
}

/// 2×2 box decimation: output texel `i` covers input `[2i, 2i + 2)`, so a
/// continuous coordinate `u` at the next octave is exactly `2u` here.
pub(super) fn downsample_half(image: &GrayImage) -> GrayImage {
    let (w, h) = (image.width / 2, image.height / 2);
    let data = (0..w * h)
        .into_par_iter()
        .map(|i| {
            let (x, y) = (2 * (i % w), 2 * (i / w));
            let at = |dx: usize, dy: usize| image.data[(y + dy) * image.width + x + dx];
            0.25 * (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1))
        })
        .collect();
    GrayImage {
        width: w,
        height: h,
        data,
    }
}

/// `levels_per_octave + 1` images from `base` (already at `base_sigma`),
/// each a factor `2^(1/levels_per_octave)` blurrier than the last; the
/// final one, decimated, is the next octave's base at `base_sigma` again.
pub(super) fn octave_levels(
    base: GrayImage,
    base_sigma: f32,
    levels_per_octave: usize,
) -> Vec<ScaleLevel> {
    let sigma_at = |k: usize| base_sigma * 2f32.powf(k as f32 / levels_per_octave as f32);
    (1..=levels_per_octave).fold(
        vec![ScaleLevel {
            image: base,
            sigma: base_sigma,
        }],
        |mut levels, k| {
            let previous = &levels[k - 1];
            let increment = (sigma_at(k).powi(2) - previous.sigma.powi(2)).sqrt();
            let image = gaussian_blur(&previous.image, increment);
            levels.push(ScaleLevel {
                image,
                sigma: sigma_at(k),
            });
            levels
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(width: usize, height: usize, f: impl Fn(usize, usize) -> f32) -> GrayImage {
        GrayImage {
            width,
            height,
            data: (0..width * height)
                .map(|i| f(i % width, i / width))
                .collect(),
        }
    }

    #[test]
    fn blur_preserves_a_constant_and_the_mean() {
        let flat = gaussian_blur(&image(17, 9, |_, _| 0.25), 1.7);
        assert!(flat.data.iter().all(|v| (v - 0.25).abs() < 1e-6));

        let ramp = image(40, 40, |x, y| ((x * 7 + y * 3) % 11) as f32);
        let blurred = gaussian_blur(&ramp, 1.0);
        let mean = |g: &GrayImage| g.data.iter().sum::<f32>() / g.data.len() as f32;
        assert!((mean(&ramp) - mean(&blurred)).abs() < 0.05);
    }

    #[test]
    fn downsample_averages_two_by_two_blocks() {
        let src = image(4, 2, |x, y| (x + 4 * y) as f32);
        let half = downsample_half(&src);
        assert_eq!((half.width, half.height), (2, 1));
        assert_eq!(half.data, vec![2.5, 4.5]);
    }

    #[test]
    fn log_luma_is_exposure_shift_invariant() {
        let pixels = vec![0.2, 0.3, 0.1, 0.4, 0.4, 0.4];
        let doubled = pixels.iter().map(|v| v * 2.0).collect();
        let a = log_luma(&LinearRgbFrame::new(2, 1, pixels).expect("frame"));
        let b = log_luma(&LinearRgbFrame::new(2, 1, doubled).expect("frame"));
        let diff = |g: &GrayImage| g.data[1] - g.data[0];
        assert!((diff(&a) - diff(&b)).abs() < 0.01);
    }

    #[test]
    fn octave_levels_step_sigma_by_the_octave_root() {
        let levels = octave_levels(image(32, 32, |x, _| x as f32), 1.2, 3);
        assert_eq!(levels.len(), 4);
        assert!((levels[3].sigma - 2.4).abs() < 1e-5);
    }
}
