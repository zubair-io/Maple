//! Chroma pre-filter stage tests (#1104, tone/zoom design spec § 3.1).
//!
//! Proof obligations, in spec order: bit-identical skip at strength 0;
//! bit-exact identity on ANY uniform field (the grey-card gate) at any
//! strength; Y passthrough; desaturate-only (magnitude clamp); chroma
//! noise actually reduced, monotonically in strength; luma edges stop
//! chroma diffusion; border + degenerate sizes safe; thread-count
//! determinism.

#![cfg(test)]

use super::*;

/// Deterministic LCG so noise fixtures are reproducible without an RNG dep.
struct Lcg(u64);
impl Lcg {
    fn next_f32(&mut self) -> f32 {
        // Numerical Recipes LCG; top 24 bits → [0, 1).
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32) / (1u64 << 24) as f32
    }
    /// Zero-mean uniform noise in [-a, a].
    fn noise(&mut self, a: f32) -> f32 {
        (self.next_f32() * 2.0 - 1.0) * a
    }
}

fn uniform_img(w: u32, h: u32, value: [f32; 3]) -> Image {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = value;
    }
    img
}

/// Mid-grey base + per-pixel chroma noise (R/B perturbed, G compensated so
/// that part is purely chromatic) + a small independent luma noise — the
/// realistic sensor-noise shape the filter exists for. The luma component
/// matters for the strength tests: with perfectly flat luma the Cauchy
/// range weight saturates at 1 for every σ and the response becomes
/// strength-independent.
fn chroma_noisy_img(w: u32, h: u32) -> Image {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    let mut rng = Lcg(0x9e3779b97f4a7c15);
    for p in &mut img.pixels {
        let nr = rng.noise(0.04);
        let nb = rng.noise(0.04);
        // Compensate G so this part keeps Y ~constant:
        // dY = wR·nr + wB·nb + wG·ng = 0.
        let ng = -(LUMA_REC2020[0] * nr + LUMA_REC2020[2] * nb) / LUMA_REC2020[1];
        // Independent luma noise (~±5% of the base level), uniform on RGB.
        let nl = rng.noise(0.009);
        *p = [0.18 + nr + nl, 0.18 + ng + nl, 0.18 + nb + nl];
    }
    img
}

fn luma(p: [f32; 3]) -> f32 {
    LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2]
}

/// Sum of per-pixel opponent-chroma magnitude² — the energy the filter is
/// supposed to shrink.
fn chroma_energy(img: &Image) -> f64 {
    img.pixels
        .iter()
        .map(|p| {
            let y = luma(*p);
            let c1 = (p[0] - y) as f64;
            let c2 = (p[2] - y) as f64;
            c1 * c1 + c2 * c2
        })
        .sum()
}

#[test]
fn strength_zero_is_bit_identical_skip() {
    let mut img = chroma_noisy_img(16, 16);
    let before = img.pixels.clone();
    apply(&mut img, 0.0);
    assert_eq!(
        img.pixels, before,
        "strength 0 must be a bit-identical skip"
    );
}

#[test]
fn uniform_grey_is_bit_exact_identity_at_any_strength() {
    // THE grey-card gate (spec § 3.1): on a uniform field every tap sees
    // equal luma AND equal chroma, so the delta-form filter is exactly
    // identity — bit-for-bit, not within-tolerance.
    for &s in &[1.0f32, 25.0, 50.0, 100.0] {
        for &v in &[0.001f32, 0.05, 0.18, 1.0, 4.0] {
            let mut img = uniform_img(12, 10, [v, v, v]);
            let before = img.pixels.clone();
            apply(&mut img, s);
            assert_eq!(
                img.pixels, before,
                "uniform grey {} must be bit-exact at strength {}",
                v, s
            );
        }
    }
}

#[test]
fn uniform_saturated_field_is_bit_exact_identity() {
    // The exact-identity property holds for ANY uniform field, not just
    // neutral ones — the deltas are zero whenever all taps are equal.
    for &color in &[[0.4f32, 0.1, 0.05], [0.02, 0.3, 0.5], [1.5, 0.2, 0.9]] {
        let mut img = uniform_img(12, 10, color);
        let before = img.pixels.clone();
        apply(&mut img, 100.0);
        assert_eq!(
            img.pixels, before,
            "uniform color {:?} must be bit-exact at strength 100",
            color
        );
    }
}

#[test]
fn luma_passes_through_untouched() {
    // Y is algebraically invariant by construction; float rounding of the
    // G-compensation term leaves at most ~1e-6 relative drift.
    let mut img = chroma_noisy_img(24, 24);
    let y_before: Vec<f32> = img.pixels.iter().map(|p| luma(*p)).collect();
    apply(&mut img, 75.0);
    for (i, p) in img.pixels.iter().enumerate() {
        let dy = (luma(*p) - y_before[i]).abs();
        let tol = 1e-5 * y_before[i].abs().max(1.0);
        assert!(
            dy <= tol,
            "pixel {}: |ΔY| = {} exceeds {} (Y before {})",
            i,
            dy,
            tol,
            y_before[i]
        );
    }
}

#[test]
fn chroma_magnitude_never_increases() {
    // The clamp guarantees smoothing only desaturates — per pixel the
    // filtered opponent-chroma magnitude is ≤ the original (one float
    // rounding of the rescale allowed).
    let mut img = chroma_noisy_img(32, 32);
    let before = img.pixels.clone();
    apply(&mut img, 100.0);
    for (i, (a, b)) in before.iter().zip(img.pixels.iter()).enumerate() {
        let ya = luma(*a);
        let yb = luma(*b);
        let m0 = ((a[0] - ya).powi(2) + (a[2] - ya).powi(2)).sqrt();
        let mf = ((b[0] - yb).powi(2) + (b[2] - yb).powi(2)).sqrt();
        assert!(
            mf <= m0 * (1.0 + 1e-5) + 1e-9,
            "pixel {}: filtered chroma magnitude {} exceeds original {}",
            i,
            mf,
            m0
        );
    }
}

#[test]
fn chroma_noise_energy_shrinks_and_is_monotone_in_strength() {
    let base = chroma_noisy_img(48, 48);
    let e0 = chroma_energy(&base);
    let mut prev = e0;
    for &s in &[25.0f32, 50.0, 100.0] {
        let mut img = Image {
            width: base.width,
            height: base.height,
            pixels: base.pixels.clone(),
            space: base.space,
        };
        apply(&mut img, s);
        let e = chroma_energy(&img);
        assert!(
            e < prev,
            "chroma energy must shrink monotonically: strength {} gave {} (prev {})",
            s,
            e,
            prev
        );
        prev = e;
    }
    // And the reduction at full strength is substantial, not cosmetic.
    assert!(
        prev < 0.5 * e0,
        "strength 100 should remove >50% of pure chroma-noise energy: {} vs {}",
        prev,
        e0
    );
}

#[test]
fn luma_edge_stops_chroma_diffusion() {
    // Two flat regions with very different luma and different chroma.
    // The right region's chroma must not bleed into the left region's
    // edge pixels: with the luma edge present, the cross-edge taps carry
    // ~zero range weight, so edge pixels stay near their own region's
    // chroma. Compare against an equal-luma control where mixing DOES
    // happen — that contrast is the cross-bilateral property.
    let w = 32u32;
    let h = 16u32;
    // Edge image: left dark warm, right bright cool (10× luma step).
    let mut edge = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    // Control: same chroma split, same luma everywhere.
    let mut flat = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for y in 0..h as usize {
        for x in 0..w as usize {
            let i = y * w as usize + x;
            if x < w as usize / 2 {
                edge.pixels[i] = [0.06, 0.05, 0.04]; // dark, warm
                flat.pixels[i] = [0.60, 0.44, 0.40]; // warm, Rec.2020 luma matched to the right half
            } else {
                edge.pixels[i] = [0.40, 0.50, 0.60]; // bright, cool
                flat.pixels[i] = [0.40, 0.50, 0.60];
            }
        }
    }
    let probe = (h as usize / 2) * w as usize + (w as usize / 2 - 1); // left side of the seam
    let edge_before = edge.pixels[probe];
    let flat_before = flat.pixels[probe];
    apply(&mut edge, 100.0);
    apply(&mut flat, 100.0);
    let shift = |before: [f32; 3], after: [f32; 3]| {
        let yb = luma(before);
        let ya = luma(after);
        let d1 = (after[0] - ya) - (before[0] - yb);
        let d2 = (after[2] - ya) - (before[2] - yb);
        (d1 * d1 + d2 * d2).sqrt()
    };
    let edge_shift = shift(edge_before, edge.pixels[probe]);
    let flat_shift = shift(flat_before, flat.pixels[probe]);
    assert!(
        edge_shift < 0.25 * flat_shift,
        "luma edge must suppress chroma mixing: edge shift {} vs equal-luma shift {}",
        edge_shift,
        flat_shift
    );
}

#[test]
fn degenerate_sizes_do_not_panic() {
    for &(w, h) in &[(1u32, 1u32), (2, 2), (4, 1), (1, 4), (5, 5)] {
        let mut img = uniform_img(w, h, [0.2, 0.18, 0.16]);
        let before = img.pixels.clone();
        apply(&mut img, 100.0);
        // All taps OOB or uniform → identity either way.
        assert_eq!(img.pixels, before, "{}x{} should be identity", w, h);
    }
}

#[test]
fn deterministic_across_thread_counts() {
    let base = chroma_noisy_img(40, 28);
    let run = |threads: usize| -> Vec<[f32; 3]> {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .expect("build pool");
        let mut img = Image {
            width: base.width,
            height: base.height,
            pixels: base.pixels.clone(),
            space: base.space,
        };
        pool.install(|| apply(&mut img, 60.0));
        img.pixels
    };
    let one = run(1);
    let many = run(8);
    assert_eq!(
        one, many,
        "output must be byte-identical across thread counts"
    );
}
