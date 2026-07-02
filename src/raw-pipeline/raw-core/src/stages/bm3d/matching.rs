//! BM3D block matching (#1105): grouping of similar patches around each
//! reference position. Joint across channels — the match list is computed
//! ONCE on the luma plane and reused for Y, C1, and C2 (the CBM3D
//! structure from Dabov et al. 2007, where chrominance grouping reuses
//! the luminance match locations).

use super::transforms::PATCH;
use super::{BLOCK, GROUP_MAX, SEARCH_HALF};

/// Extract the 8×8 patch with top-left `(x, y)` from `plane` (width `w`).
/// Caller guarantees the patch is in bounds.
#[inline]
pub fn extract_patch(plane: &[f32], w: usize, x: usize, y: usize) -> [f32; PATCH] {
    let mut p = [0f32; PATCH];
    for r in 0..BLOCK {
        let row = (y + r) * w + x;
        p[r * BLOCK..(r + 1) * BLOCK].copy_from_slice(&plane[row..row + BLOCK]);
    }
    p
}

/// Patch mean via pairwise (tree) summation. The tree shape is what makes
/// the exact-identity guarantee hold: at every level the sum of two EQUAL
/// values is an exact ×2 (exponent bump, no rounding), so for a constant
/// patch the root is exactly `64·v` and `/64` (a power of two) returns
/// `v` bit-exactly. A sequential left fold does NOT have this property —
/// `3v`, `5v`, … round, and the residual leaks a few ulps into the
/// "mean-relative" patch of a uniform field.
#[inline]
pub fn patch_mean(p: &[f32; PATCH]) -> f32 {
    let mut acc = *p;
    let mut n = PATCH;
    while n > 1 {
        n /= 2;
        for i in 0..n {
            acc[i] += acc[i + n];
        }
    }
    acc[0] / PATCH as f32
}

/// Mean-relative SSD between two patches, normalised per pixel. Robust to
/// brightness gradients (clean-room choice: the means are denoised
/// separately along the group axis — see the module docs in `mod.rs`).
#[inline]
fn distance(a: &[f32; PATCH], a_mean: f32, b: &[f32; PATCH], b_mean: f32) -> f32 {
    let mut acc = 0f32;
    for i in 0..PATCH {
        let d = (a[i] - a_mean) - (b[i] - b_mean);
        acc += d * d;
    }
    acc / PATCH as f32
}

/// The reference-grid coordinates along one axis: stride
/// [`super::STRIDE`], clamped so the final patch ends exactly at the
/// edge — every pixel is covered by at least one reference patch.
pub fn ref_coords(extent: usize) -> Vec<usize> {
    debug_assert!(extent >= BLOCK);
    let last = extent - BLOCK;
    let mut v: Vec<usize> = (0..last).step_by(super::STRIDE).collect();
    v.push(last);
    v
}

/// Find the group of most-similar patches to the reference at
/// `(rx, ry)` within the ±[`SEARCH_HALF`] search window. Returns
/// `(positions, means)` — positions sorted by ascending distance
/// (reference first at distance 0), truncated to the largest power of
/// two ≤ [`GROUP_MAX`] (the group-axis WHT needs a power-of-two length).
///
/// `tau_sq` is the per-pixel mean-relative SSD ceiling — candidates above
/// it are dissimilar and excluded (a function of σ; see `mod.rs`).
pub fn find_group(
    plane: &[f32],
    w: usize,
    h: usize,
    rx: usize,
    ry: usize,
    tau_sq: f32,
) -> Vec<(usize, usize)> {
    let ref_patch = extract_patch(plane, w, rx, ry);
    let ref_mean = patch_mean(&ref_patch);

    let x0 = rx.saturating_sub(SEARCH_HALF);
    let y0 = ry.saturating_sub(SEARCH_HALF);
    let x1 = (rx + SEARCH_HALF).min(w - BLOCK);
    let y1 = (ry + SEARCH_HALF).min(h - BLOCK);

    // (distance, x, y) — full step-1 scan of the window.
    let mut cands: Vec<(f32, usize, usize)> = Vec::with_capacity(64);
    for cy in y0..=y1 {
        for cx in x0..=x1 {
            if cx == rx && cy == ry {
                continue;
            }
            let p = extract_patch(plane, w, cx, cy);
            let m = patch_mean(&p);
            let d = distance(&ref_patch, ref_mean, &p, m);
            if d <= tau_sq {
                cands.push((d, cx, cy));
            }
        }
    }
    // Deterministic order: distance, then scan position as a total
    // tie-break (f32 distances can tie exactly on synthetic content).
    cands.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.2.cmp(&b.2)).then(a.1.cmp(&b.1)));
    cands.truncate(GROUP_MAX - 1);

    let mut group: Vec<(usize, usize)> = Vec::with_capacity(GROUP_MAX);
    group.push((rx, ry));
    group.extend(cands.iter().map(|&(_, x, y)| (x, y)));
    // Largest power of two ≤ len, for the group-axis WHT.
    let pow2 = if group.len().is_power_of_two() {
        group.len()
    } else {
        group.len().next_power_of_two() / 2
    };
    group.truncate(pow2);
    group
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_coords_cover_every_pixel() {
        for extent in [BLOCK, 17, 64, 100, 1003] {
            let coords = ref_coords(extent);
            assert_eq!(
                *coords.last().unwrap(),
                extent - BLOCK,
                "last patch flush to edge"
            );
            let mut covered = vec![false; extent];
            for &c in &coords {
                for i in c..c + BLOCK {
                    covered[i] = true;
                }
            }
            assert!(
                covered.iter().all(|&c| c),
                "extent {extent} not fully covered"
            );
        }
    }

    #[test]
    fn group_is_power_of_two_and_self_first() {
        let w = 32;
        let h = 32;
        let plane: Vec<f32> = (0..w * h).map(|i| ((i * 13) % 7) as f32 * 0.01).collect();
        let g = find_group(&plane, w, h, 10, 10, f32::INFINITY);
        assert!(g.len().is_power_of_two());
        assert!(g.len() <= GROUP_MAX);
        assert_eq!(g[0], (10, 10), "reference patch must lead the group");
    }

    #[test]
    fn dissimilar_patches_are_excluded() {
        let w = 40;
        let h = 16;
        // Left half flat 0.2; right half flat 5.0 — wildly dissimilar in
        // mean-relative terms? No: both are FLAT, so mean-relative SSD is
        // 0 — that is by design (means are denoised separately). Make the
        // right half textured instead so its residual differs.
        let mut plane = vec![0.2f32; w * h];
        for y in 0..h {
            for x in 20..w {
                plane[y * w + x] = if (x + y) % 2 == 0 { 5.0 } else { 0.0 };
            }
        }
        let g = find_group(&plane, w, h, 0, 0, 1e-4);
        assert!(
            g.iter().all(|&(x, _)| x < 13),
            "textured right-half patches must be excluded: {:?}",
            g
        );
    }
}
