//! Scene-linear DNG warp sampling (#3633).
//!
//! Adobe's dng_resample_bicubic uses A=-0.75, support radius two:
//! https://android.googlesource.com/platform/external/dng_sdk/+/de700ad461e35af50b28b861943a0b0753b10929/source/dng_resample.cpp
//! Its lens-warp path uses 32 fractional phases, truncating the phase index.
//! The table is generated at compile time; sampling allocates no memory.
//! Unlike the SDK's bounded stage buffer, we retain negative and >1 radiance.
const fn kernel(x: f64) -> f64 {
    let x = if x < 0.0 { -x } else { x };
    if x < 1.0 {
        (1.25 * x - 2.25) * x * x + 1.0
    } else if x < 2.0 {
        ((-0.75 * x + 3.75) * x - 6.0) * x + 3.0
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
#[allow(clippy::too_many_arguments)] // same active-area geometry as the existing bilinear sampler
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
    let x = x.clamp(0.0, (w - 1) as f64);
    let y = y.clamp(0.0, (h - 1) as f64);
    let ix = x.floor() as i32;
    let iy = y.floor() as i32;
    // SDK ConvertDoubleToInt32 truncates the positive fractional phase.
    let px = ((x - ix as f64) * PHASE_COUNT as f64) as usize;
    let py = ((y - iy as f64) * PHASE_COUNT as f64) as usize;
    let wx = PHASE_WEIGHTS[px.min(PHASE_COUNT - 1)];
    let wy = PHASE_WEIGHTS[py.min(PHASE_COUNT - 1)];
    let xs: [usize; 4] =
        std::array::from_fn(|dx| (ix + dx as i32 - 1).clamp(0, w as i32 - 1) as usize);
    let rows: [[f32; N]; 4] = std::array::from_fn(|dy| {
        let yy = (iy + dy as i32 - 1).clamp(0, h as i32 - 1) as usize;
        let offset = (top + yy) * width + left;
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
    fn half_phase_weights_match_adobe_cubic_and_preserve_constant_radiance() {
        assert_eq!(
            [kernel(1.5), kernel(0.5), kernel(-0.5), kernel(-1.5)],
            [-0.09375, 0.59375, 0.59375, -0.09375]
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
            [2.375, -0.09375, 0.0]
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
}
