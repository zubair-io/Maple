//! Black-toe curvature limit for the baked Auto residual LUT (#5690).
//!
//! The LUT interpolates linearly in sRGB-encoded space, while the banding gate
//! reads the neutral ramp in linear light. A strong shadow lift in the first
//! cells above black is therefore a steep line in encoded space that the sRGB
//! EOTF bends into a second-difference spike: at an encoded slope `s` the
//! spike grows with `s²`. The embedded JPEG can ask for a lift of 5-6× in the
//! first cell, which on test_0005/0009/0010/0012 put the 1,024-step neutral
//! ramp over its second-difference budget.
//!
//! [`soften_black_toe`] scales the lift (output minus input) of the first
//! shells of nodes (shell `m` = nodes whose largest grid index is `m`) only as
//! far as the neutral ramp needs. A LUT whose ramp is already within the limit
//! is untouched.

use super::lut::ColorLut;
use crate::view::agx_inverse::srgb_gamma_inv;
use crate::view::encode::srgb_gamma;

/// Shells above black that may be rescaled; shell 0 (black itself) stays put.
const SHELLS: usize = 8;
/// Ramp width the second-difference budget is defined on.
const RAMP_STEPS: usize = 1024;
/// Target for the neutral ramp's worst second difference: under the 0.004007
/// ceiling in `banding_budgets.json`, with room for the solver's tolerance.
const SECOND_DIFFERENCE_LIMIT: f64 = 0.0035;
/// Rec.2020 luma weights, as `banding_check.py` applies them.
const LUMA: [f64; 3] = [0.2627, 0.6780, 0.0593];
/// Cost of moving a shell's scale off 1, relative to a one-limit overshoot.
const SCALE_COST: f64 = 0.1;
const SWEEPS: usize = 12;
const BRACKET_STEPS: usize = 24;

/// Where one ramp sample falls on the neutral diagonal: the lower node and the
/// fraction toward the next.
struct Sample {
    node: usize,
    fraction: f64,
}

fn ramp_samples(size: usize, shells: usize) -> Vec<Sample> {
    let top = (shells + 1) as f64;
    let mut samples = Vec::new();
    let mut past = 0;
    for step in 0..RAMP_STEPS {
        let encoded = f64::from(srgb_gamma(step as f32 / (RAMP_STEPS - 1) as f32));
        let position = encoded * (size - 1) as f64;
        let node = (position.floor() as usize).min(size - 2);
        samples.push(Sample {
            node,
            fraction: position - node as f64,
        });
        if position >= top {
            past += 1;
            if past == 2 {
                break;
            }
        }
    }
    samples
}

/// Second differences above the limit, squared and summed, for the neutral
/// diagonal `nodes` of a `size`-node LUT with shell `m`'s lift scaled by
/// `scale[m - 1]`.
fn overshoot(nodes: &[[f64; 3]], size: usize, scale: &[f64], samples: &[Sample]) -> f64 {
    let node = |i: usize| {
        let identity = i as f64 / (size - 1) as f64;
        let s = if (1..=scale.len()).contains(&i) {
            scale[i - 1]
        } else {
            1.
        };
        nodes[i].map(|v| identity + s * (v - identity))
    };
    let luma: Vec<f64> = samples
        .iter()
        .map(|s| {
            let (a, b) = (node(s.node), node(s.node + 1));
            (0..3)
                .map(|c| {
                    let encoded = a[c] + s.fraction * (b[c] - a[c]);
                    LUMA[c] * f64::from(srgb_gamma_inv(encoded as f32))
                })
                .sum::<f64>()
        })
        .collect();
    luma.windows(3)
        .map(|w| {
            let excess = ((w[2] - 2. * w[1] + w[0]).abs() - SECOND_DIFFERENCE_LIMIT).max(0.);
            (excess / SECOND_DIFFERENCE_LIMIT).powi(2)
        })
        .sum()
}

fn cost(nodes: &[[f64; 3]], size: usize, scale: &[f64], samples: &[Sample]) -> f64 {
    overshoot(nodes, size, scale, samples)
        + SCALE_COST * scale.iter().map(|s| (1. - s).powi(2)).sum::<f64>()
}

/// Rescale the lift of the first shells of `lut` so its neutral ramp keeps a
/// bounded second difference. No-op when the ramp is already within the limit.
pub(super) fn soften_black_toe(lut: &mut ColorLut) {
    let n = lut.size;
    if n < 4 {
        return;
    }
    let shells = SHELLS.min(n - 3);
    let samples = ramp_samples(n, shells);
    let nodes: Vec<[f64; 3]> = (0..=shells + 2)
        .map(|i| {
            let at = ((i * n + i) * n + i) * 3;
            std::array::from_fn(|c| f64::from(lut.data[at + c]))
        })
        .collect();
    let mut scale = vec![1.; shells];
    if overshoot(&nodes, n, &scale, &samples) == 0. {
        return;
    }
    for _ in 0..SWEEPS {
        for shell in 0..shells {
            let (mut low, mut high) = (0., 1.);
            for _ in 0..BRACKET_STEPS {
                let a = low + (high - low) * 0.381_966;
                let b = low + (high - low) * 0.618_034;
                let at = |value: f64, scale: &mut Vec<f64>| {
                    scale[shell] = value;
                    cost(&nodes, n, scale, &samples)
                };
                if at(a, &mut scale) < at(b, &mut scale) {
                    high = b;
                } else {
                    low = a;
                }
            }
            scale[shell] = (low + high) * 0.5;
        }
    }
    for (index, node) in lut.data.chunks_exact_mut(3).enumerate() {
        let shell = (index % n).max(index / n % n).max(index / (n * n));
        if (1..=shells).contains(&shell) {
            let coordinates = [index % n, index / n % n, index / (n * n)];
            for (value, coordinate) in node.iter_mut().zip(coordinates) {
                let identity = coordinate as f32 / (n - 1) as f32;
                *value = identity + scale[shell - 1] as f32 * (*value - identity);
            }
        }
    }
}

#[cfg(test)]
#[path = "toe_tests.rs"]
mod tests;
