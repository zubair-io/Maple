//! Post-demosaic false-colour suppression (value-vs-hue chroma blend).
//!
//! AMaZE reconstructs the non-sampled channels by constant-hue interpolation
//! of the colour-difference (chroma−green) field. That is the right tool
//! almost everywhere, but it collapses at isolated high-frequency colour
//! edges: a 1-px bright-blue line crossing a near-neutral region has a
//! *flat* (B−G) field, so the reconstruction sets B≈G and the line's colour
//! is lost. A value-domain interpolation of the actual blue samples preserves it.
//! Green-guided weights prevent that interpolation from importing the bright
//! side of a luminance edge into its dark side (#5000). ACR's renderer keeps such edges, so AMaZE's
//! constant-hue result drifts far from the reference precisely there
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

/// A collapsed chroma estimate is only safe when its four contributing
/// samples have nearly the same channel-to-green ratio. The fallback limiter
/// uses the same tolerance to check the centre against its sampled-colour
/// neighbourhood. A wider disagreement can mean a real colour edge.
const MAX_COLLAPSED_RATIO_SPREAD: f32 = 0.15;

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
        out.pixels
            .par_iter_mut()
            .enumerate()
            .for_each(|(i, pixel)| {
                let (x, y) = (i % w, i / w);
                clamp_signed_opposite_chroma(pixel, pattern.color_at(x as u32, y as u32) as usize);
            });
        return;
    }
    const EPS: f32 = 1e-6;
    let color_at = |x: usize, y: usize| pattern.color_at(x as u32, y as u32) as usize;

    // Interpolate sensor values with green as a guide. An unweighted mean
    // imports the bright side of a luminance edge into its dark side, even
    // when AMaZE already reconstructed a plausible chroma there. Inverse-
    // square range weights retain the same nearest CFA stencil and preserve
    // a pure chroma edge (equal green -> equal weights). A shared local scale
    // makes the weighting independent of exposure and of the WB green gain.
    let value_estimate = |x: usize, y: usize, t: usize| -> f32 {
        let centre = green[y * w + x];
        let mut samples = [(0.0_f32, 0.0_f32); 4];
        let mut count = 0;
        for stencil in [
            [(-1_isize, 0_isize), (1, 0), (0, -1), (0, 1)],
            [(-1_isize, -1_isize), (1, -1), (-1, 1), (1, 1)],
        ] {
            for (dx, dy) in stencil {
                let (nx, ny) = (x as isize + dx, y as isize + dy);
                if nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize {
                    continue;
                }
                let (nx, ny) = (nx as usize, ny as usize);
                if color_at(nx, ny) == t {
                    let i = ny * w + nx;
                    samples[count] = (cfa_flat[i], green[i]);
                    count += 1;
                }
            }
            if count > 0 {
                break;
            }
        }
        if count == 0 {
            return 0.0;
        }
        let samples = &samples[..count];
        let unweighted = || samples.iter().map(|(v, _)| v).sum::<f32>() / count as f32;
        // Green is a valid range guide only across a supported color surface.
        // A real chroma edge can change green too; guiding there discards
        // precisely the color samples the value-domain fallback must retain.
        let consistent = |ratios: &[f32]| {
            let mean = ratios.iter().sum::<f32>() / ratios.len() as f32;
            let lo = ratios.iter().copied().fold(f32::INFINITY, f32::min);
            let hi = ratios.iter().copied().fold(f32::NEG_INFINITY, f32::max);
            mean > 0.0 && (hi - lo) / mean <= MAX_COLLAPSED_RATIO_SPREAD
        };
        let mut donor_ratios = [0.0; 4];
        for (i, &(value, guide)) in samples.iter().enumerate() {
            if guide <= 0.0 {
                return unweighted();
            }
            donor_ratios[i] = value / guide;
        }
        if !consistent(&donor_ratios[..count]) {
            return unweighted();
        }
        let sampled = color_at(x, y);
        if sampled != 1 {
            let mut surface_ratios = [0.0; 9];
            let mut n = 0;
            for dy in [-2_isize, 0, 2] {
                for dx in [-2_isize, 0, 2] {
                    let i = (y as isize + dy) as usize * w + (x as isize + dx) as usize;
                    if green[i] <= 0.0 {
                        return unweighted();
                    }
                    surface_ratios[n] = cfa_flat[i] / green[i];
                    n += 1;
                }
            }
            if !consistent(&surface_ratios) {
                return unweighted();
            }
        }
        let scale = samples
            .iter()
            .fold(centre.abs(), |m, (_, g)| m.max(g.abs()))
            .max(EPS);
        let mut sum = 0.0_f32;
        let mut weights = 0.0_f32;
        for &(value, guide) in samples {
            let distance = (guide - centre) / scale;
            let weight = 1.0 / (distance * distance + EPS);
            sum += value * weight;
            weights += weight;
        }
        sum / weights
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

    // A negative opposite chroma at an R/B site means AMaZE's directional
    // kernel extrapolated the colour difference past green at a luminance
    // edge, so the hue path carries no estimate there. The four diagonal
    // samples used by the estimate must agree closely in their channel-to-
    // green ratios. A broader neighborhood average can accept distinct
    // surfaces across a real colour edge and import one side's hue into the
    // other (#4123).
    let collapsed_estimate = |x: usize, y: usize, t: usize| -> Option<f32> {
        let centre_index = y * w + x;
        let centre = green[centre_index];
        if centre <= 0.0 {
            return None;
        }

        // The diagonal target samples must belong to the centre surface, not
        // just agree with one another. An isolated R/B sample can sit inside
        // a flat background whose four opposite-colour diagonals all report
        // the same ratio; transporting that ratio would paint background hue
        // into the centre even though AMaZE's zero-clamped fallback is safer.
        // Check that the centre's sampled colour agrees with its nearest
        // same-colour cardinal neighbours before trusting the opposite plane.
        let sampled_colour = color_at(x, y);
        let centre_ratio = cfa_flat[centre_index] / centre;
        let mut min_surface_ratio = centre_ratio;
        let mut max_surface_ratio = centre_ratio;
        let mut surface_ratio_sum = centre_ratio;
        let mut surface_ratio_count = 1usize;
        // Check the full 3x3 neighborhood on the sampled channel's Bayer
        // lattice. The diagonal sites catch a plus-shaped feature whose
        // cardinal support alone looks uniform, while every comparison stays
        // within this one color channel.
        for dy in [-2_isize, 0, 2] {
            for dx in [-2_isize, 0, 2] {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let nx = (x as isize + dx) as usize;
                let ny = (y as isize + dy) as usize;
                if color_at(nx, ny) != sampled_colour {
                    continue;
                }
                let neighbour_index = ny * w + nx;
                let (sample, guide) = (cfa_flat[neighbour_index], green[neighbour_index]);
                if sample < 0.0 || guide <= 0.0 {
                    return None;
                }
                let ratio = sample / guide;
                min_surface_ratio = min_surface_ratio.min(ratio);
                max_surface_ratio = max_surface_ratio.max(ratio);
                surface_ratio_sum += ratio;
                surface_ratio_count += 1;
            }
        }
        let mean_surface_ratio = surface_ratio_sum / surface_ratio_count as f32;
        if mean_surface_ratio <= 0.0
            || (max_surface_ratio - min_surface_ratio) / mean_surface_ratio
                > MAX_COLLAPSED_RATIO_SPREAD
        {
            return None;
        }

        let mut min_ratio = f32::INFINITY;
        let mut max_ratio = f32::NEG_INFINITY;
        let mut ratio_sum = 0.0_f32;
        let (mut colour, mut guide, mut n) = (0.0_f32, 0.0_f32, 0usize);
        for (dx, dy) in [(-1_isize, -1_isize), (1, -1), (-1, 1), (1, 1)] {
            let (nx, ny) = ((x as isize + dx) as usize, (y as isize + dy) as usize);
            if color_at(nx, ny) != t {
                continue;
            }
            let (sample, g) = (cfa_flat[ny * w + nx], green[ny * w + nx]);
            if sample < 0.0 || g <= 0.0 {
                return None;
            }
            let ratio = sample / g;
            min_ratio = min_ratio.min(ratio);
            max_ratio = max_ratio.max(ratio);
            ratio_sum += ratio;
            colour += sample;
            guide += g;
            n += 1;
        }
        if n == 0 {
            return None;
        }
        let mean_ratio = ratio_sum / n as f32;
        // The center and target are different CFA colors: their absolute
        // channel-to-green ratios encode hue and can differ widely on the
        // same physical surface. Validate each color's local support within
        // its own plane; never compare those unlike ratios directly.
        if mean_ratio <= 0.0 || (max_ratio - min_ratio) / mean_ratio > MAX_COLLAPSED_RATIO_SPREAD {
            return None;
        }
        Some(centre * colour / guide)
    };

    // Reads only touch the immutable `green`/`cfa_flat` planes, so the
    // in-place write to each output pixel is independent of every other.
    out.pixels
        .par_chunks_mut(w)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..w {
                let c = color_at(x, y);
                if x < 3 || y < 3 || x + 3 >= w || y + 3 >= h {
                    clamp_signed_opposite_chroma(&mut row[x], c);
                    continue;
                }
                let ghf = green_hf(x, y);
                let mut px = row[x];
                for t in 0..3usize {
                    // Only reconstructed channels; the sampled channel and
                    // the (reliable) green plane are left as AMaZE produced.
                    if t == c || t == 1 {
                        continue;
                    }
                    if px[t] < 0.0 {
                        if let Some(estimate) = collapsed_estimate(x, y, t) {
                            px[t] = estimate;
                            continue;
                        }
                    }
                    let c_hue = px[t].max(0.0);
                    if ghf <= 0.0 {
                        px[t] = c_hue;
                        continue;
                    }
                    let c_val = value_estimate(x, y, t);
                    // Disagreement between the two estimates, normalised by
                    // the local channel magnitude.
                    let mag = c_hue.abs() + c_val.abs() + EPS;
                    let disagree = ((c_val - c_hue).abs() / mag).min(1.0);
                    // Blend weight: product of the green edge term and the
                    // estimate-disagreement term, both in [0,1]. Zero unless
                    // BOTH fire.
                    let alpha = (strength * ghf * disagree).clamp(0.0, 1.0);
                    let blended = ((1.0 - alpha) * c_hue + alpha * c_val).max(0.0);
                    px[t] = if px[t] < 0.0 {
                        supported_chroma_ceiling(x, y, w, cfa_flat, green)
                            .map_or(blended, |ceiling| blended.min(ceiling))
                    } else {
                        blended
                    };
                }
                row[x] = px;
            }
        });
}

/// A rejected constant-hue fit does not justify importing the bright side's
/// absolute sensor value into a dark centre. Bound only that fallback's
/// overshoot by the largest measured target/green ratio, without selecting
/// one hue or raising a collapsed channel away from zero.
///
/// The centre's sampled ratio must agree with the same-colour diagonal
/// neighbourhood and lie strictly inside its range. A centre at an endpoint
/// may be a distinct colour plateau rather than an interpolated surface.
/// This rejects colour edges, isolated pixels and plus-shaped features, while allowing local variation
/// that prevents a constant-hue fit across the entire neighbourhood.
fn supported_chroma_ceiling(
    x: usize,
    y: usize,
    w: usize,
    cfa: &[f32],
    green: &[f32],
) -> Option<f32> {
    let i = y * w + x;
    if green[i] <= 0.0 || cfa[i] < 0.0 {
        return None;
    }
    let centre_ratio = cfa[i] / green[i];
    let mut min_surface = f32::INFINITY;
    let mut max_surface = f32::NEG_INFINITY;
    let mut surface_sum = 0.0_f32;
    let mut max_target = 0.0_f32;
    for (dx, dy) in [(-1_isize, -1_isize), (1, -1), (-1, 1), (1, 1)] {
        let offset = dy * w as isize + dx;
        let surface = (i as isize + 2 * offset) as usize;
        let target = (i as isize + offset) as usize;
        if green[surface] <= 0.0 || green[target] <= 0.0 || cfa[surface] < 0.0 || cfa[target] < 0.0
        {
            return None;
        }
        let ratio = cfa[surface] / green[surface];
        min_surface = min_surface.min(ratio);
        max_surface = max_surface.max(ratio);
        surface_sum += ratio;
        max_target = max_target.max(cfa[target] / green[target]);
    }
    let mean_surface = surface_sum * 0.25;
    let ratio_roundoff = f32::EPSILON * max_surface;
    (min_surface + ratio_roundoff < centre_ratio
        && centre_ratio < max_surface - ratio_roundoff
        && mean_surface > 0.0
        && (centre_ratio - mean_surface).abs() / mean_surface <= MAX_COLLAPSED_RATIO_SPREAD)
        .then_some(green[i] * max_target)
}

fn clamp_signed_opposite_chroma(pixel: &mut [f32; 3], sampled_color: usize) {
    let opposite_color = match sampled_color {
        0 => 2,
        2 => 0,
        _ => return,
    };
    pixel[opposite_color] = pixel[opposite_color].max(0.0);
}
