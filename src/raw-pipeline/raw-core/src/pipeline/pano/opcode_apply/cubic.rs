//! Scene-linear DNG warp sampling (#3633).
//!
//! Catmull–Rom (A=-0.5) reproduces affine/quadratic samples and reduces
//! ringing at high-contrast lens-warp edges (#4650). Adobe's SDK uses A=-0.75;
//! we retain its 32 fractional phases and truncating phase index, while using
//! the polynomial-reproducing kernel for Maple's unbounded scene data.
//! The table is generated at compile time; sampling allocates no memory.
//! Unlike the SDK's bounded stage buffer, we retain negative and >1 radiance.
const fn kernel(x: f64) -> f64 {
    let x = if x < 0.0 { -x } else { x };
    if x < 1.0 {
        (1.5 * x - 2.5) * x * x + 1.0
    } else if x < 2.0 {
        ((-0.5 * x + 2.5) * x - 4.0) * x + 2.0
    } else {
        0.0
    }
}
// SDK dng_resample.h: kResampleSubsampleCount2D = 1 << 5.
// This is distinct from its 128-phase one-dimensional resizer.
const PHASE_COUNT: usize = 32;
const PHASE_WEIGHTS: [[f32; 4]; PHASE_COUNT] = phase_weights();
const fn phase_weights() -> [[f32; 4]; PHASE_COUNT] {
    let mut weights = [[0.0; 4]; PHASE_COUNT];
    let mut phase = 0;
    while phase < PHASE_COUNT {
        let t = phase as f64 / PHASE_COUNT as f64;
        let mut tap = 0;
        while tap < 4 {
            weights[phase][tap] = kernel(t - (tap as f64 - 1.0)) as f32;
            tap += 1;
        }
        phase += 1;
    }
    weights
}

// Called once per output pixel. Inlining exposes the broadcast channel
// indices so the compiler removes channel bounds checks and stack arguments.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
pub(super) fn sample_bounded<const N: usize>(
    src: &[[f32; 3]],
    stride: usize,
    min_col: usize,
    max_col: usize,
    min_row: usize,
    max_row: usize,
    x: f64,
    y: f64,
    channels: [usize; N],
) -> [f32; N] {
    let x = x.clamp(min_col as f64, max_col as f64);
    let y = y.clamp(min_row as f64, max_row as f64);
    let ix = x.floor() as i32;
    let iy = y.floor() as i32;
    // SDK ConvertDoubleToInt32 truncates the positive fractional phase.
    let px = ((x - ix as f64) * PHASE_COUNT as f64) as usize;
    let py = ((y - iy as f64) * PHASE_COUNT as f64) as usize;
    let wx = PHASE_WEIGHTS[px.min(PHASE_COUNT - 1)];
    let wy = PHASE_WEIGHTS[py.min(PHASE_COUNT - 1)];
    let xs: [usize; 4] = std::array::from_fn(|dx| {
        (ix + dx as i32 - 1).clamp(min_col as i32, max_col as i32) as usize
    });
    let rows: [[f32; N]; 4] = std::array::from_fn(|dy| {
        let yy = (iy + dy as i32 - 1).clamp(min_row as i32, max_row as i32) as usize;
        let offset = yy * stride;
        let p0 = src[offset + xs[0]];
        let p1 = src[offset + xs[1]];
        let p2 = src[offset + xs[2]];
        let p3 = src[offset + xs[3]];
        // Cubic weights sum to one. Difference form preserves a constant
        // field exactly and avoids the full sixteen-tap 2D accumulation.
        // Keep this fixed-size channel loop inline. Nested array::map can
        // leave four non-inlined try_map calls per pixel in release builds.
        let mut row = [0.0; N];
        for i in 0..N {
            let c = channels[i];
            row[i] =
                p1[c] + (p0[c] - p1[c]) * wx[0] + (p2[c] - p1[c]) * wx[2] + (p3[c] - p1[c]) * wx[3];
        }
        row
    });
    std::array::from_fn(|c| {
        rows[1][c]
            + (rows[0][c] - rows[1][c]) * wy[0]
            + (rows[2][c] - rows[1][c]) * wy[2]
            + (rows[3][c] - rows[1][c]) * wy[3]
    })
}

#[inline(always)]
#[allow(dead_code, clippy::too_many_arguments)] // same active-area geometry as the existing bilinear sampler
pub(super) fn sample<const N: usize>(
    src: &[[f32; 3]],
    width: usize,
    top: usize,
    left: usize,
    w: usize,
    h: usize,
    x: f64,
    y: f64,
    channels: [usize; N],
) -> [f32; N] {
    sample_bounded(
        src,
        width,
        left,
        left + w - 1,
        top,
        top + h - 1,
        left as f64 + x,
        top as f64 + y,
        channels,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fractional_phase_is_truncated_at_sdk_boundaries() {
        let pixels = [[0.0; 3], [0.0; 3], [1.0; 3], [0.0; 3]];
        let at = |x| sample(&pixels, 4, 0, 0, 4, 1, x, 0.0, [0])[0];
        for phase in 0..32 {
            let x = 1.0 + phase as f64 / 32.0;
            assert_eq!(at(x), kernel(1.0 - phase as f64 / 32.0) as f32);
            assert_eq!(at(x + 1.0 / 64.0), at(x));
            if phase > 0 {
                assert_eq!(at(x - 1e-8), at(x - 1.0 / 32.0));
            }
        }
    }

    #[test]
    fn half_phase_weights_match_catmull_rom_and_preserve_constant_radiance() {
        assert_eq!(
            [kernel(1.5), kernel(0.5), kernel(-0.5), kernel(-1.5)],
            [-0.0625, 0.5625, 0.5625, -0.0625]
        );
        let pixels = vec![[2.5, -0.25, 0.75]; 36];
        for phase in 0..128 {
            let x = 2.0 + phase as f64 / 128.0;
            assert_eq!(
                sample(&pixels, 6, 0, 0, 6, 6, x, 2.25, [0, 1, 2]),
                pixels[0]
            );
        }
    }

    #[test]
    fn integer_positions_reproduce_each_channel_exactly() {
        let pixels: Vec<_> = (0..36)
            .map(|i| [i as f32 * 0.125, -(i as f32), i as f32 * 3.0])
            .collect();
        for y in 0..6 {
            for x in 0..6 {
                assert_eq!(
                    sample(&pixels, 6, 0, 0, 6, 6, x as f64, y as f64, [0, 1, 2]),
                    pixels[y * 6 + x]
                );
                for c in 0..3 {
                    assert_eq!(
                        sample(&pixels, 6, 0, 0, 6, 6, x as f64, y as f64, [c])[0],
                        pixels[y * 6 + x][c]
                    );
                }
            }
        }
    }

    #[test]
    fn cubic_lobes_are_not_clipped_before_the_view_transform() {
        let pixels = [
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
        ];
        assert_eq!(
            sample(&pixels, 4, 0, 0, 4, 1, 1.5, 0.0, [0, 1, 2]),
            [2.25, -0.0625, 0.0]
        );
    }

    #[test]
    fn sticky_edges_never_read_masked_sensor_borders() {
        let mut pixels = vec![[100.0; 3]; 36];
        for y in 2..4 {
            for x in 2..4 {
                pixels[y * 6 + x] = [2.0, -0.5, 0.25];
            }
        }
        for (x, y) in [(-10.0, -10.0), (0.25, 0.75), (10.0, 10.0)] {
            assert_eq!(
                sample(&pixels, 6, 2, 2, 2, 2, x, y, [0, 1, 2]),
                [2.0, -0.5, 0.25]
            );
        }
    }

    fn polynomial(x: f32, y: f32) -> [f32; 3] {
        [
            2.0 + x * 0.125 - y * 0.25,
            x * x * 0.0625 - y * y * 0.03125,
            -2.0 + x * y * 0.015625,
        ]
    }

    #[test]
    fn every_phase_reconstructs_affine_quadratic_and_mixed_samples() {
        let (w, h) = (20usize, 18usize);
        let pixels: Vec<_> = (0..w * h)
            .map(|i| polynomial((i % w) as f32, (i / w) as f32))
            .collect();
        for py in 0..32 {
            for px in 0..32 {
                let (x, y) = (7.0 + px as f64 / 32.0, 8.0 + py as f64 / 32.0);
                let actual = sample(&pixels, w, 0, 0, w, h, x, y, [0, 1, 2]);
                let expected = polynomial(x as f32, y as f32);
                for c in 0..3 {
                    assert!(
                        (actual[c] - expected[c]).abs() <= 4e-6,
                        "phase {px}/{py}, channel {c}: {actual:?} != {expected:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn translating_a_source_window_preserves_every_sample_bit() {
        let (w, h) = (20usize, 18usize);
        let pixels: Vec<_> = (0..w * h)
            .map(|i| polynomial((i % w) as f32, (i / w) as f32))
            .collect();
        let tile: Vec<_> = (3..15)
            .flat_map(|y| (4..17).map(move |x| polynomial(x as f32, y as f32)))
            .collect();
        for py in 0..32 {
            for px in 0..32 {
                let (x, y) = (9.0 + px as f64 / 32.0, 9.0 + py as f64 / 32.0);
                assert_eq!(
                    sample(&pixels, w, 0, 0, w, h, x, y, [0, 1, 2]),
                    sample(&tile, 13, 0, 0, 13, 12, x - 4.0, y - 3.0, [0, 1, 2])
                );
            }
        }
    }

    #[test]
    fn unit_step_ringing_follows_the_analytic_negative_lobe() {
        let pixels = [[0.; 3], [1., 0., 0.], [1., 0., 0.], [1., 1., 0.]];
        for phase in 0..32 {
            let actual = sample(
                &pixels,
                4,
                0,
                0,
                4,
                1,
                1.0 + phase as f64 / 32.0,
                0.0,
                [0, 1],
            );
            // The minimum of the A=-0.5 outer polynomial is -2/27 at 4/3.
            assert!(actual[0] <= 1.0 + 2.0 / 27.0 + f32::EPSILON);
            assert!(actual[1] >= -2.0 / 27.0 - f32::EPSILON);
        }
        let middle = sample(&pixels, 4, 0, 0, 4, 1, 1.5, 0.0, [0, 1]);
        assert!(
            middle[0] > 1.0 && middle[1] < 0.0,
            "ringing is reduced, never clipped"
        );
    }
}
