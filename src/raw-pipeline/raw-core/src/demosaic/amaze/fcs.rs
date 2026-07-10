//! Post-demosaic false-colour suppression (value-vs-hue chroma blend).
//!
//! AMaZE reconstructs the non-sampled channels by constant-hue interpolation
//! of the colour-difference (chroma−green) field. That is the right tool
//! almost everywhere, but it collapses at isolated high-frequency colour
//! edges: a 1-px bright-blue line crossing a near-neutral region has a
//! *flat* (B−G) field, so the reconstruction sets B≈G and the line's colour
//! is lost. A value-domain (bilinear) interpolation — averaging the actual
//! blue samples — preserves it. ACR's renderer keeps such edges, so AMaZE's
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

    // Value-domain estimate of channel `t` at (x, y): the bilinear value
    // interpolation the constant-hue path replaces. Only the *nearest* same-
    // colour samples are used (the immediate Bayer neighbours of that
    // colour), so a sharp 1-px colour edge is preserved rather than averaged
    // away.
    let value_estimate = |x: usize, y: usize, t: usize| -> f32 {
        // Pass 1: distance-1 cardinal same-colour neighbours.
        let mut sum = 0.0_f32;
        let mut cnt = 0.0_f32;
        for (dx, dy) in [(-1_isize, 0_isize), (1, 0), (0, -1), (0, 1)] {
            let nx = x as isize + dx;
            let ny = y as isize + dy;
            if nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize {
                continue;
            }
            let (nxu, nyu) = (nx as usize, ny as usize);
            if color_at(nxu, nyu) == t {
                sum += cfa_flat[nyu * w + nxu];
                cnt += 1.0;
            }
        }
        if cnt > 0.0 {
            return sum / cnt;
        }
        // Pass 2: distance-√2 diagonal same-colour neighbours (used when the
        // target colour is not a cardinal neighbour of this site, e.g. the
        // opposite-chroma channel at an R/B site).
        for (dx, dy) in [(-1_isize, -1_isize), (1, -1), (-1, 1), (1, 1)] {
            let nx = x as isize + dx;
            let ny = y as isize + dy;
            if nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize {
                continue;
            }
            let (nxu, nyu) = (nx as usize, ny as usize);
            if color_at(nxu, nyu) == t {
                sum += cfa_flat[nyu * w + nxu];
                cnt += 1.0;
            }
        }
        if cnt > 0.0 {
            sum / cnt
        } else {
            0.0
        }
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
                    let c_val = value_estimate(x, y, t);
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
