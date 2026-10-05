//! Post-demosaic false-colour suppression (value-vs-hue chroma blend).
//!
//! AMaZE reconstructs the non-sampled channels by constant-hue interpolation
//! of the colour-difference (chroma−green) field. That is the right tool
//! almost everywhere, but it collapses at isolated high-frequency colour
//! edges: a 1-px bright-blue line crossing a near-neutral region has a
//! *flat* (B−G) field, so the reconstruction sets B≈G and the line's colour
//! is lost. Value-domain interpolation from the nearest sensor samples
//! preserves it. Reconstructed green guides bounded interpolation between
//! those samples so luminance ramps do not invent false chroma (#4123).
//! ACR's renderer keeps such edges, so AMaZE's constant-hue result drifts
//! far from the reference precisely there
//! (test_0007 baseline_auto, the cluster of ΔE≈50 yellow-vs-magenta pixels).
//!
//! This stage blends each *reconstructed* channel toward its value-domain
//! estimate, with a weight that is non-zero ONLY where (a) the green plane
//! has a steep local gradient (high-frequency edge) and (b) the hue and
//! value estimates disagree. In smooth regions both terms vanish and the
//! stage is an exact no-op.

use crate::image::{CfaPattern, Image};
use rayon::prelude::*;

/// Strength of the suppression. Tuned to the minimum that clears the
/// test_0007 baseline_auto 1-px-edge artifacts (max ΔE 50.4 → 37.5, under
/// the 38.9 budget) while keeping every other reference case within budget —
/// in particular test_0009 baseline_auto, which over-suppresses above this
/// strength.
pub(super) const FALSE_COLOUR_SUPPRESS_STRENGTH: f32 = 5.0;

/// `green` is the final reconstructed green plane; `cfa_flat` the flattened
/// mosaic (raw sensor sample per site). Operates in place on the
/// camera-native RGB.
pub(super) fn suppress_false_colour(
    out: &mut Image,
    cfa_flat: &[f32],
    green: &[f32],
    w: usize,
    h: usize,
    pattern: CfaPattern,
    strength: f32,
) {
    if strength <= 0.0 || w < 9 || h < 9 {
        return;
    }
    const EPS: f32 = 1e-6;
    let color_at = |x: usize, y: usize| pattern.color_at(x as u32, y as u32) as usize;

    // Use only the nearest same-colour sensor sites. A luminance guide
    // must interpolate colour at the centre, rather than favour the nearer
    // guide value and distort an affine colour ramp (#4123). The fixed
    // four-site scratch is local: no image allocation or distant sample.
    let value_estimate = |x: usize, y: usize, t: usize| -> Option<f32> {
        let mut samples = [(0.0_f32, 0.0_f32); 4];
        let mut count = 0;
        for offsets in [
            [(-1_isize, 0_isize), (1, 0), (0, -1), (0, 1)],
            [(-1_isize, -1_isize), (1, -1), (-1, 1), (1, 1)],
        ] {
            for (dx, dy) in offsets {
                let nx = x as isize + dx;
                let ny = y as isize + dy;
                if nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize {
                    continue;
                }
                let (nx, ny) = (nx as usize, ny as usize);
                if color_at(nx, ny) == t {
                    samples[count] = (green[ny * w + nx], cfa_flat[ny * w + nx]);
                    count += 1;
                }
            }
            if count > 0 {
                break;
            }
        }
        if count == 0 {
            return None;
        }
        let samples = &samples[..count];
        let mean_green = samples.iter().map(|&(g, _)| g).sum::<f32>() / count as f32;
        let mean_colour = samples.iter().map(|&(_, c)| c).sum::<f32>() / count as f32;
        let covariance = samples
            .iter()
            .map(|&(g, c)| (g - mean_green) * (c - mean_colour))
            .sum::<f32>();
        let variance = samples
            .iter()
            .map(|&(g, _)| (g - mean_green).powi(2))
            .sum::<f32>();
        // Flat or opposing colour evidence is a colour edge, not a
        // positive luminance ramp. Preserve the existing value-domain mean.
        if covariance <= 0.0 || variance == 0.0 {
            return Some(mean_colour);
        }
        let min_green = samples
            .iter()
            .map(|&(g, _)| g)
            .fold(f32::INFINITY, f32::min);
        let max_green = samples
            .iter()
            .map(|&(g, _)| g)
            .fold(f32::NEG_INFINITY, f32::max);
        let center_green = green[y * w + x];
        // No sensor evidence supports extrapolation: keep the reconstructed
        // hue instead of manufacturing a colour beyond the measured range.
        if center_green < min_green || center_green > max_green {
            return None;
        }
        let min_colour = samples
            .iter()
            .map(|&(_, c)| c)
            .fold(f32::INFINITY, f32::min);
        let max_colour = samples
            .iter()
            .map(|&(_, c)| c)
            .fold(f32::NEG_INFINITY, f32::max);
        let interpolated = mean_colour + covariance / variance * (center_green - mean_green);
        Some(interpolated.clamp(min_colour, max_colour))
    };

    // Local green high-frequency content: how much the centre green departs
    // from the mean of its 4 cardinal greens, normalised by the local green
    // magnitude. ~0 on smooth gradients, large at a 1-px luminance spike.
    let green_hf = |x: usize, y: usize| -> f32 {
        if x == 0 || y == 0 || x + 1 >= w || y + 1 >= h {
            return 0.0;
        }
        let i = y * w + x;
        let gc = green[i];
        let gl = green[i - 1];
        let gr = green[i + 1];
        let gu = green[i - w];
        let gd = green[i + w];
        let mean = 0.25 * (gl + gr + gu + gd);
        let mag = gc.abs() + mean.abs() + EPS;
        ((gc - mean).abs() / mag).min(1.0)
    };

    // Reads only touch the immutable `green`/`cfa_flat` planes, so the
    // in-place write to each output pixel is independent of every other.
    out.pixels
        .par_chunks_mut(w)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..w {
                if x < 3 || y < 3 || x + 3 >= w || y + 3 >= h {
                    continue;
                }
                let c = color_at(x, y);
                let ghf = green_hf(x, y);
                if ghf <= 0.0 {
                    continue;
                }
                let mut px = row[x];
                for t in 0..3usize {
                    // Only reconstructed channels; the sampled channel and
                    // the (reliable) green plane are left as AMaZE produced.
                    if t == c || t == 1 {
                        continue;
                    }
                    let c_hue = px[t];
                    let Some(c_val) = value_estimate(x, y, t) else {
                        continue;
                    };
                    // Disagreement between the two estimates, normalised by
                    // the local channel magnitude.
                    let mag = c_hue.abs() + c_val.abs() + EPS;
                    let disagree = ((c_val - c_hue).abs() / mag).min(1.0);
                    // Blend weight: product of the green edge term and the
                    // estimate-disagreement term, both in [0,1]. Zero unless
                    // BOTH fire.
                    let alpha = (strength * ghf * disagree).clamp(0.0, 1.0);
                    px[t] = ((1.0 - alpha) * c_hue + alpha * c_val).max(0.0);
                }
                row[x] = px;
            }
        });
}
