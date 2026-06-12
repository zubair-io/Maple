//! Coarse-to-fine full-resolution correspondence refinement (#1210).
//!
//! The geometry stage matches on long-edge-capped proxies (spec §5.2 —
//! that is the resolution ALIKED/LightGlue carry their accuracy at), which
//! bounds match accuracy at the proxy scale: the matcher's ~0.5 proxy-px
//! floor is ≈ 3× the spec §5.3 full-resolution budget at the default
//! 1600 px cap on a ~5300 px frame. This module closes that floor per
//! standard coarse-to-fine practice: every *verified* correspondence is
//! re-localized on the full-resolution frames with a local
//! zero-normalized cross-correlation (ZNCC) template search plus
//! 3-point parabolic sub-pixel peak fit (the same sub-pixel pattern as
//! `pano_metrics.py wrap_closure`), so bundle adjustment downstream
//! consumes full-res-accuracy matches in full-res coordinates and the
//! §5.3 budgets apply at the resolution the spec wrote them for.
//!
//! # Algorithm (per correspondence)
//!
//! 1. Scale the proxy coordinates to full-res seeds, **per axis**: the
//!    proxy short edge rounds to nearest ([`proxy_to_long_edge`]), so the
//!    x and y scale factors differ by up to ~0.02% — folded into one
//!    scalar that is a systematic error of up to ~0.7 px at the far edge
//!    of a 4000 px frame, half the §5.3 mean budget.
//! 2. Extract a `(2·patch_radius+1)²` luma template around the seed in
//!    frame A (bilinear, Rec.709 luma weights over the scene-linear
//!    planes — a fixed channel mix for matching, not colorimetry).
//! 3. Scan frame B over integer offsets within `search_radius` of B's
//!    seed (default radius `⌈2·scale + 2⌉` — covers the proxy
//!    quantization error plus matcher noise at proxy scale), scoring
//!    each offset with ZNCC, then refine the best offset with a
//!    per-axis 3-point parabolic fit.
//! 4. **Only B moves.** Frame A's coordinate is the reference: refining
//!    both sides would let the same image evidence pull both ends of the
//!    correspondence (double-counting it), and BA's symmetric residual
//!    (two directed blocks per match) already balances the two pixel
//!    planes. Where A's localization is itself noisy, that noise is what
//!    the robust verifier and BA's Huber loss are for.
//!
//! # Fallback — never invent precision
//!
//! A match falls back to its *scaled proxy coordinate* (flagged, never
//! `NaN`, never dropped here — dropping is the verifier's and BA's job)
//! when refinement cannot honestly improve it:
//!
//! - template or search window leaves the frame / touches invalid
//!   pixels (matches hug frame edges in overlap regions; the window
//!   margin is ~16 px on a ~5300 px frame),
//! - the template is (near-)zero-variance — flat sky/water, where ZNCC
//!   is undefined,
//! - the best peak's ZNCC is below `min_ncc` (decorrelated content:
//!   moving water, motion blur),
//! - the peak sits on the search-window border (the true offset may be
//!   outside the modeled error — an interior parabola fit would lie).
//!
//! # Determinism
//!
//! Pure per-match arithmetic in a fixed scan order; `rayon` only maps
//! over matches and the collect preserves input order, so output is
//! bit-identical across runs and thread counts.
//!
//! [`proxy_to_long_edge`]: crate::ingest::proxy_to_long_edge

mod sample;
mod warp;

use rayon::prelude::*;

use crate::ingest::PlanarImage;
use crate::twoview::PixelCorrespondence;

use sample::{mean_ssd, parabolic_delta, sample_luma_grid, IDENTITY_WARP};

pub use warp::RefineGeometry;

/// Tuning for [`refine_correspondences`]. Defaults are the #1210 design
/// values.
#[derive(Debug, Clone)]
pub struct RefineOptions {
    /// Template half-width, full-res px (patch edge = `2r + 1`;
    /// default 6 → 13×13).
    pub patch_radius: u32,
    /// Search half-width around B's scaled seed, full-res px.
    /// `None` (default) derives `⌈2·max(scale_b.x, scale_b.y) + 2⌉`.
    pub search_radius: Option<u32>,
    /// Minimum acceptable peak ZNCC (default 0.5).
    pub min_ncc: f64,
    /// Numerical floor on the mean squared luma deviation of template
    /// and candidate patches — below it the ZNCC denominator is noise.
    /// A degeneracy guard (default 1e-12), not a texture-quality gate;
    /// texture quality is `min_ncc`'s job.
    pub min_variance: f64,
}

impl Default for RefineOptions {
    fn default() -> Self {
        Self {
            patch_radius: 6,
            search_radius: None,
            min_ncc: 0.5,
            min_variance: 1e-12,
        }
    }
}

/// Result of [`refine_correspondences`]. All coordinates are FULL-RES
/// pixels; `refined` is index-aligned with the input matches.
#[derive(Debug, Clone)]
pub struct RefineOutcome {
    /// Per input match: `a` = the scaled seed (A is never moved), `b` =
    /// the ZNCC-refined coordinate, or the scaled seed on fallback.
    pub refined: Vec<PixelCorrespondence>,
    /// `refined_mask[i]` ⇔ `refined[i].b` was NCC-refined (false = the
    /// flagged fallback to proxy accuracy).
    pub refined_mask: Vec<bool>,
    /// Number of `true` entries in `refined_mask`.
    pub refined_count: usize,
    /// Number of `false` entries in `refined_mask`.
    pub fallback_count: usize,
}

/// Re-localize proxy-scale matches on the full-resolution frames.
///
/// `matches` are in PROXY pixels of each frame (`.a` in frame A's proxy,
/// `.b` in frame B's proxy); `scale_a` / `scale_b` are the per-axis
/// `(full_width / proxy_width, full_height / proxy_height)` factors.
/// `geometry`, when given, enables per-match perspective compensation of
/// the template from the pair's verified relative rotation
/// ([`warp`] module docs — without it, accuracy in the overlap strip is
/// capped by the A→B perspective compression). See the module docs for
/// the algorithm, the B-side-only contract, and the fallback semantics.
pub fn refine_correspondences(
    full_a: &PlanarImage,
    full_b: &PlanarImage,
    scale_a: (f64, f64),
    scale_b: (f64, f64),
    geometry: Option<&RefineGeometry<'_>>,
    matches: &[PixelCorrespondence],
    opts: &RefineOptions,
) -> RefineOutcome {
    let patch_radius = i64::from(opts.patch_radius.max(1));
    let search_radius = i64::from(
        opts.search_radius
            .unwrap_or_else(|| derived_search_radius(scale_b))
            .max(1),
    );

    let per_match: Vec<(PixelCorrespondence, bool)> = matches
        .par_iter()
        .map(|m| {
            let a_full = (m.a.0 * scale_a.0, m.a.1 * scale_a.1);
            let b_seed = (m.b.0 * scale_b.0, m.b.1 * scale_b.1);
            match refine_one(
                full_a,
                full_b,
                a_full,
                b_seed,
                geometry,
                patch_radius,
                search_radius,
                opts,
            ) {
                Some(b) => (PixelCorrespondence { a: a_full, b }, true),
                None => (
                    PixelCorrespondence {
                        a: a_full,
                        b: b_seed,
                    },
                    false,
                ),
            }
        })
        .collect();

    let mut refined = Vec::with_capacity(per_match.len());
    let mut refined_mask = Vec::with_capacity(per_match.len());
    let mut refined_count = 0usize;
    for (m, ok) in per_match {
        refined.push(m);
        refined_mask.push(ok);
        refined_count += usize::from(ok);
    }
    let fallback_count = refined.len() - refined_count;
    RefineOutcome {
        refined,
        refined_mask,
        refined_count,
        fallback_count,
    }
}

/// Default search half-width for a B-side scale factor: covers the
/// ±0.5 proxy-px quantization of both endpoints (≈ ±1 proxy px ≈
/// `2·scale` full px) plus a 2 px full-res guard band.
fn derived_search_radius(scale_b: (f64, f64)) -> u32 {
    let s = scale_b.0.max(scale_b.1).max(1.0);
    (2.0 * s + 2.0).ceil() as u32
}

/// One correspondence: `Some(refined_b)` or `None` for fallback (see the
/// module docs for the gate list).
#[allow(clippy::too_many_arguments)] // private kernel of one public entry point
fn refine_one(
    full_a: &PlanarImage,
    full_b: &PlanarImage,
    a_full: (f64, f64),
    b_seed: (f64, f64),
    geometry: Option<&RefineGeometry<'_>>,
    patch_radius: i64,
    search_radius: i64,
    opts: &RefineOptions,
) -> Option<(f64, f64)> {
    if !(a_full.0.is_finite()
        && a_full.1.is_finite()
        && b_seed.0.is_finite()
        && b_seed.1.is_finite())
    {
        return None;
    }
    let n_patch = {
        let side = 2 * patch_radius + 1;
        (side * side) as f64
    };

    // Template in A, centered on the exact (sub-pixel) seed, sampled in
    // frame B's local geometry when the pair geometry permits (identity
    // when absent or locally degenerate — uncompensated, still gated).
    let jinv = geometry
        .and_then(|g| warp::local_warp_inverse(g, a_full))
        .unwrap_or(IDENTITY_WARP);
    let template = sample_luma_grid(full_a, a_full, patch_radius, &jinv)?;
    let (t_mean, t_ssd) = mean_ssd(&template);
    let t_var = t_ssd / n_patch;
    if t_var.is_nan() || t_var < opts.min_variance {
        return None; // flat (or NaN) template — ZNCC undefined.
    }

    // One luma window in B covers every candidate patch: offsets are
    // integers, so the fractional phase of `b_seed` is shared and each
    // candidate is an integer-indexed sub-grid. The window is always
    // axis-aligned — the warp lives entirely on the template side.
    let window_half = patch_radius + search_radius;
    let window = sample_luma_grid(full_b, b_seed, window_half, &IDENTITY_WARP)?;
    let window_side = (2 * window_half + 1) as usize;

    // ZNCC over all integer offsets; first-wins argmax in scan order.
    let scan_side = (2 * search_radius + 1) as usize;
    let mut ncc = vec![f64::NEG_INFINITY; scan_side * scan_side];
    let (mut best_idx, mut best_ncc) = (0usize, f64::NEG_INFINITY);
    for sy in 0..scan_side {
        for sx in 0..scan_side {
            // Patch top-left inside the window for offset (dx, dy) =
            // (sx - search_radius, sy - search_radius).
            let (mut sum, mut sum_sq, mut cross) = (0.0f64, 0.0f64, 0.0f64);
            for py in 0..(2 * patch_radius + 1) as usize {
                let row = (sy + py) * window_side + sx;
                let t_row = py * (2 * patch_radius + 1) as usize;
                for px in 0..(2 * patch_radius + 1) as usize {
                    let v = window[row + px];
                    sum += v;
                    sum_sq += v * v;
                    cross += v * (template[t_row + px] - t_mean);
                }
            }
            let p_ssd = sum_sq - sum * sum / n_patch;
            let p_var = p_ssd / n_patch;
            if p_var.is_nan() || p_var < opts.min_variance {
                continue; // flat (or NaN) candidate — leave at -inf.
            }
            // `cross` already subtracts the template mean, and
            // Σ(T−T̄)(P−P̄) = Σ(T−T̄)·P because Σ(T−T̄) = 0.
            let score = cross / (t_ssd * p_ssd).sqrt();
            let i = sy * scan_side + sx;
            ncc[i] = score;
            if score > best_ncc {
                best_ncc = score;
                best_idx = i;
            }
        }
    }

    // NaN scores never win the strict `>` above, so `best_ncc` is either
    // −∞ (every candidate flat) or a real ZNCC value.
    if best_ncc < opts.min_ncc {
        return None; // weak peak — decorrelated content.
    }
    let (bx, by) = (best_idx % scan_side, best_idx / scan_side);
    if bx == 0 || by == 0 || bx == scan_side - 1 || by == scan_side - 1 {
        return None; // border peak — true offset may exceed the window.
    }

    let dx = bx as f64 - search_radius as f64
        + parabolic_delta(ncc[best_idx - 1], best_ncc, ncc[best_idx + 1]);
    let dy = by as f64 - search_radius as f64
        + parabolic_delta(
            ncc[best_idx - scan_side],
            best_ncc,
            ncc[best_idx + scan_side],
        );
    Some((b_seed.0 + dx, b_seed.1 + dy))
}

#[cfg(test)]
mod tests {
    use super::sample::luma_bilinear;
    use super::*;
    use crate::ingest::ValidityMask;
    use crate::prng::SplitMix64;

    fn planar_from_fn(w: u32, h: u32, f: impl Fn(u32, u32) -> f32) -> PlanarImage {
        let n = (w as usize) * (h as usize);
        let mut v = Vec::with_capacity(n);
        for y in 0..h {
            for x in 0..w {
                v.push(f(x, y));
            }
        }
        PlanarImage::from_planes(
            w,
            h,
            v.clone(),
            v.clone(),
            v,
            ValidityMask::new_filled(w, h, true),
        )
    }

    /// Smooth, aperiodic value noise (the ml_smoke rationale: periodic
    /// texture defeats correlation; real photographs are aperiodic).
    fn noise_image(w: u32, h: u32, seed: u64) -> PlanarImage {
        fn hash(x: u64, y: u64, seed: u64) -> f64 {
            let mut s = SplitMix64::new(
                seed ^ x.wrapping_mul(0x9E37_79B9_7F4A_7C15)
                    ^ y.wrapping_mul(0xC2B2_AE3D_27D4_EB4F),
            );
            s.next_f64()
        }
        planar_from_fn(w, h, |x, y| {
            let mut v = 0.0f64;
            let mut amp = 0.5f64;
            for (octave, cell) in [(1u64, 16u32), (2, 4)] {
                let (gx, gy) = (u64::from(x / cell), u64::from(y / cell));
                let fx = f64::from(x % cell) / f64::from(cell);
                let fy = f64::from(y % cell) / f64::from(cell);
                let s = seed.wrapping_add(octave);
                let top = hash(gx, gy, s) * (1.0 - fx) + hash(gx + 1, gy, s) * fx;
                let bot = hash(gx, gy + 1, s) * (1.0 - fx) + hash(gx + 1, gy + 1, s) * fx;
                v += amp * (top * (1.0 - fy) + bot * fy);
                amp *= 0.5;
            }
            v as f32
        })
    }

    /// `B(q) = A(q − t)` by bilinear resampling (out-of-support → 0; the
    /// tests keep seeds far enough inside that the border is never read).
    fn shifted(a: &PlanarImage, t: (f64, f64)) -> PlanarImage {
        planar_from_fn(a.width(), a.height(), |x, y| {
            let (px, py) = (f64::from(x) + 0.5 - t.0, f64::from(y) + 0.5 - t.1);
            luma_bilinear(a, px, py).unwrap_or(0.0) as f32
        })
    }

    fn one_match(a: (f64, f64), b: (f64, f64)) -> Vec<PixelCorrespondence> {
        vec![PixelCorrespondence { a, b }]
    }

    #[test]
    fn recovers_a_sub_pixel_shift_from_a_perturbed_seed() {
        let a = noise_image(96, 80, 11);
        let t = (3.4, -2.6);
        let b = shifted(&a, t);
        let p = (40.25, 37.75); // sub-pixel reference point in A
        let seed_err = (1.3, -0.8);
        let matches = one_match(p, (p.0 + t.0 + seed_err.0, p.1 + t.1 + seed_err.1));
        let opts = RefineOptions {
            search_radius: Some(4),
            ..RefineOptions::default()
        };
        let out = refine_correspondences(&a, &b, (1.0, 1.0), (1.0, 1.0), None, &matches, &opts);
        assert_eq!(out.refined_count, 1, "textured shift must refine");
        assert_eq!(out.refined[0].a, p, "A side is the untouched reference");
        let (ex, ey) = (
            out.refined[0].b.0 - (p.0 + t.0),
            out.refined[0].b.1 - (p.1 + t.1),
        );
        let err = (ex * ex + ey * ey).sqrt();
        assert!(
            err < 0.25,
            "refined B {:?} vs true {:?} — err {err:.3} px",
            out.refined[0].b,
            (p.0 + t.0, p.1 + t.1)
        );
        assert!(err < seed_err.0.hypot(seed_err.1), "must beat the seed");
    }

    #[test]
    fn scales_proxy_coordinates_per_axis() {
        // Flat frames: everything falls back, exposing the seed scaling
        // exactly (anisotropic on the B side, as proxy rounding produces).
        let a = planar_from_fn(64, 64, |_, _| 0.25);
        let b = planar_from_fn(64, 64, |_, _| 0.25);
        let matches = one_match((10.0, 8.0), (4.0, 6.0));
        let out = refine_correspondences(
            &a,
            &b,
            (2.0, 2.5),
            (3.0, 2.0),
            None,
            &matches,
            &RefineOptions::default(),
        );
        assert_eq!(out.refined_count, 0);
        assert_eq!(out.fallback_count, 1);
        assert_eq!(out.refined_mask, vec![false]);
        assert_eq!(out.refined[0].a, (20.0, 20.0));
        assert_eq!(out.refined[0].b, (12.0, 12.0));
        assert!(out.refined[0].b.0.is_finite() && out.refined[0].b.1.is_finite());
    }

    #[test]
    fn decorrelated_content_falls_back_on_the_ncc_gate() {
        // Independent noise fields: peak ZNCC over a ±4 scan stays far
        // below 0.5 (deterministic with these seeds).
        let a = noise_image(96, 80, 7);
        let b = noise_image(96, 80, 1234);
        let matches = one_match((48.0, 40.0), (48.0, 40.0));
        let opts = RefineOptions {
            search_radius: Some(4),
            ..RefineOptions::default()
        };
        let out = refine_correspondences(&a, &b, (1.0, 1.0), (1.0, 1.0), None, &matches, &opts);
        assert_eq!(out.refined_count, 0, "unrelated noise must not refine");
        assert_eq!(out.refined[0].b, (48.0, 40.0), "fallback keeps the seed");
    }

    #[test]
    fn window_leaving_the_frame_or_validity_falls_back() {
        let a = noise_image(96, 80, 21);
        let b = shifted(&a, (2.0, 0.0));
        let opts = RefineOptions {
            search_radius: Some(4),
            ..RefineOptions::default()
        };
        // B window (half 6+4=10) would cross the left edge.
        let out = refine_correspondences(
            &a,
            &b,
            (1.0, 1.0),
            (1.0, 1.0),
            None,
            &one_match((12.0, 40.0), (9.0, 40.0)),
            &opts,
        );
        assert_eq!(out.refined_count, 0, "near-edge window must fall back");
        // A template (half 6) over an invalidated pixel.
        let mut a_masked = noise_image(96, 80, 21);
        a_masked.validity.set(50, 40, false);
        let out = refine_correspondences(
            &a_masked,
            &b,
            (1.0, 1.0),
            (1.0, 1.0),
            None,
            &one_match((48.0, 40.0), (50.0, 40.0)),
            &opts,
        );
        assert_eq!(
            out.refined_count, 0,
            "invalid template pixel must fall back"
        );
    }

    #[test]
    fn outcome_is_index_aligned_counted_and_deterministic() {
        let a = noise_image(128, 96, 3);
        let b = shifted(&a, (1.7, 2.2));
        let mut rng = SplitMix64::new(99);
        let matches: Vec<PixelCorrespondence> = (0..64)
            .map(|_| {
                let p = (rng.next_range(30.0, 100.0), rng.next_range(30.0, 70.0));
                PixelCorrespondence {
                    a: p,
                    b: (
                        p.0 + 1.7 + rng.next_range(-1.5, 1.5),
                        p.1 + 2.2 + rng.next_range(-1.5, 1.5),
                    ),
                }
            })
            .collect();
        let opts = RefineOptions {
            search_radius: Some(4),
            ..RefineOptions::default()
        };
        let out = refine_correspondences(&a, &b, (1.0, 1.0), (1.0, 1.0), None, &matches, &opts);
        assert_eq!(out.refined.len(), matches.len());
        assert_eq!(out.refined_mask.len(), matches.len());
        assert_eq!(out.refined_count + out.fallback_count, matches.len());
        assert!(
            out.refined_count >= 60,
            "textured pure-shift pair should refine nearly all ({}/64)",
            out.refined_count
        );
        for (m, r) in matches.iter().zip(&out.refined) {
            assert_eq!(r.a, m.a, "A side untouched at scale 1");
        }
        let again = refine_correspondences(&a, &b, (1.0, 1.0), (1.0, 1.0), None, &matches, &opts);
        for (x, y) in out.refined.iter().zip(&again.refined) {
            assert_eq!(x, y, "bit-identical across runs");
        }
        assert_eq!(out.refined_mask, again.refined_mask);
    }

    #[test]
    fn derived_search_radius_covers_the_proxy_error_model() {
        assert_eq!(derived_search_radius((3.295, 3.2955)), 9); // pano_01 scale
        assert_eq!(derived_search_radius((1.0, 1.0)), 4);
        assert_eq!(derived_search_radius((0.5, 0.5)), 4); // never below scale-1
    }
}
