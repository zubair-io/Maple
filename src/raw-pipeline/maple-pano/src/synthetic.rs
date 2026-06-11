//! Procedural equirectangular test scene.
//!
//! Generates a deterministic linear-light RGB equirect image with three
//! ingredient layers, chosen so that both feature matchers and RMSE-style
//! metrics have structure to bite on:
//!
//! 1. **Smooth gradients** — seeded sinusoid mixes over longitude/latitude
//!    and over random great-circle directions. Gives every region a
//!    distinct low-frequency signature (anchors gain solving and RMSE).
//! 2. **Checkers** — a moderate-contrast angular checkerboard
//!    (15° cells; 24 cells around the equator, an even count, so the
//!    pattern is continuous across the ±180° seam). Gives gradients and
//!    edges everywhere without saturating.
//! 3. **Point features** — a few hundred small anisotropy-free Gaussian
//!    blobs at seeded directions with seeded per-channel amplitudes and
//!    radii. Gives corner detectors unambiguous, well-localized keypoints.
//!
//! All randomness is drawn **up front** from a [`SplitMix64`] stream seeded
//! by the caller; per-pixel evaluation is a pure function of the pixel
//! center direction and that table, so the image is byte-deterministic and
//! row-parallel rendering cannot reorder anything.
//!
//! Values are clamped to `[0, 1]` linear; typical content sits in
//! `[0.05, 0.95]` so 16-bit quantization never clips structure away.

use rayon::prelude::*;

use crate::math::Vec3;
use crate::prng::SplitMix64;

/// Number of Gaussian point features splatted onto the sphere.
const FEATURE_COUNT: usize = 192;
/// Angular checker cell size (radians). π/12 = 15°; 2π / (π/12) = 24 cells
/// around the equator — even, so checker parity is seamless at ±180°.
const CHECKER_CELL: f64 = std::f64::consts::PI / 12.0;
/// Checker modulation amplitude (linear units, on top of the gradients).
const CHECKER_AMP: f64 = 0.07;

struct Feature {
    dir: Vec3,
    /// Per-channel signed amplitude.
    amp: [f64; 3],
    /// `1 / (2σ²)` for the angular Gaussian.
    inv_two_sigma_sq: f64,
    /// Skip threshold: `cos(4σ)` — beyond ~4σ the blob is negligible.
    cos_cutoff: f64,
}

struct Layers {
    /// Per-channel longitude frequency (integer-valued, so the gradient
    /// layer is continuous across the ±180° seam), phase, and latitude
    /// frequency/phase for the lon/lat sinusoid.
    lon_freq: [f64; 3],
    lon_phase: [f64; 3],
    lat_freq: [f64; 3],
    lat_phase: [f64; 3],
    /// Per-channel random great-circle axis + frequency for the second,
    /// non-axis-aligned gradient term.
    grad_axis: [Vec3; 3],
    grad_freq: [f64; 3],
    grad_phase: [f64; 3],
    features: Vec<Feature>,
}

fn build_layers(seed: u64) -> Layers {
    let mut rng = SplitMix64::new(seed);
    let mut lon_freq = [0.0; 3];
    let mut lon_phase = [0.0; 3];
    let mut lat_freq = [0.0; 3];
    let mut lat_phase = [0.0; 3];
    let mut grad_axis = [Vec3::new(0.0, 0.0, 1.0); 3];
    let mut grad_freq = [0.0; 3];
    let mut grad_phase = [0.0; 3];
    for c in 0..3 {
        // Integer lon frequencies keep the layer seam-free; 1..=4 cycles.
        lon_freq[c] = (1 + (rng.next_u64() % 4)) as f64;
        lon_phase[c] = rng.next_range(0.0, std::f64::consts::TAU);
        lat_freq[c] = rng.next_range(1.0, 3.0);
        lat_phase[c] = rng.next_range(0.0, std::f64::consts::TAU);
        grad_axis[c] = rng.next_unit_vector();
        grad_freq[c] = rng.next_range(1.5, 4.0);
        grad_phase[c] = rng.next_range(0.0, std::f64::consts::TAU);
    }
    let features = (0..FEATURE_COUNT)
        .map(|_| {
            let dir = rng.next_unit_vector();
            let amp = [
                rng.next_range(-0.28, 0.28),
                rng.next_range(-0.28, 0.28),
                rng.next_range(-0.28, 0.28),
            ];
            let sigma = rng.next_range(0.5, 2.0).to_radians();
            Feature {
                dir,
                amp,
                inv_two_sigma_sq: 1.0 / (2.0 * sigma * sigma),
                cos_cutoff: (4.0 * sigma).cos(),
            }
        })
        .collect();
    Layers {
        lon_freq,
        lon_phase,
        lat_freq,
        lat_phase,
        grad_axis,
        grad_freq,
        grad_phase,
        features,
    }
}

/// Evaluate the scene at one direction. `lambda`/`phi` follow the crate's
/// longitude/latitude convention; `dir` is the matching unit vector.
fn eval(layers: &Layers, lambda: f64, phi: f64, dir: Vec3) -> [f32; 3] {
    let mut px = [0.0_f64; 3];
    // Layer 1: smooth gradients.
    for (c, v) in px.iter_mut().enumerate() {
        let lonlat = (layers.lon_freq[c] * lambda + layers.lon_phase[c]).sin()
            * (layers.lat_freq[c] * phi + layers.lat_phase[c]).cos();
        let oblique =
            (layers.grad_freq[c] * dir.dot(layers.grad_axis[c]) + layers.grad_phase[c]).sin();
        *v = 0.45 + 0.17 * lonlat + 0.13 * oblique;
    }
    // Layer 2: checker parity over (λ, φ) cells.
    let cell = ((lambda / CHECKER_CELL).floor() + (phi / CHECKER_CELL).floor()) as i64;
    let checker = if cell.rem_euclid(2) == 0 {
        CHECKER_AMP
    } else {
        -CHECKER_AMP
    };
    for v in px.iter_mut() {
        *v += checker;
    }
    // Layer 3: Gaussian point features (angular distance via dot product).
    for f in &layers.features {
        let t = dir.dot(f.dir);
        if t <= f.cos_cutoff {
            continue;
        }
        let ang = t.clamp(-1.0, 1.0).acos();
        let w = (-ang * ang * f.inv_two_sigma_sq).exp();
        for (v, amp) in px.iter_mut().zip(f.amp) {
            *v += amp * w;
        }
    }
    [
        px[0].clamp(0.0, 1.0) as f32,
        px[1].clamp(0.0, 1.0) as f32,
        px[2].clamp(0.0, 1.0) as f32,
    ]
}

/// Generate a `width × height` equirect image (linear RGB, row-major,
/// `[r, g, b]` per pixel). `width` must equal `2 × height` (full-sphere
/// equirect); the caller validates that.
///
/// Pixel `(ix, iy)` stores the scene at its center direction:
/// `λ = ((ix + 0.5)/W − 0.5)·2π`, `φ = (0.5 − (iy + 0.5)/H)·π`.
pub fn generate(width: u32, height: u32, seed: u64) -> Vec<[f32; 3]> {
    let layers = build_layers(seed);
    let w = width as usize;
    let h = height as usize;
    let mut pixels = vec![[0.0_f32; 3]; w * h];
    pixels.par_chunks_mut(w).enumerate().for_each(|(iy, row)| {
        let phi = (0.5 - (iy as f64 + 0.5) / h as f64) * std::f64::consts::PI;
        let (sp, cp) = phi.sin_cos();
        for (ix, out) in row.iter_mut().enumerate() {
            let lambda = ((ix as f64 + 0.5) / w as f64 - 0.5) * std::f64::consts::TAU;
            let (sl, cl) = lambda.sin_cos();
            let dir = Vec3::new(cp * sl, -sp, cp * cl);
            *out = eval(&layers, lambda, phi, dir);
        }
    });
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_for_same_seed() {
        let a = generate(64, 32, 17);
        let b = generate(64, 32, 17);
        assert_eq!(a, b);
    }

    #[test]
    fn different_seed_changes_content() {
        let a = generate(64, 32, 17);
        let b = generate(64, 32, 18);
        assert_ne!(a, b);
    }

    #[test]
    fn values_in_unit_interval_with_real_spread() {
        let img = generate(128, 64, 3);
        let mut lo = f32::MAX;
        let mut hi = f32::MIN;
        for p in &img {
            for &v in p {
                assert!((0.0..=1.0).contains(&v));
                lo = lo.min(v);
                hi = hi.max(v);
            }
        }
        // Structure check: the scene must actually vary.
        assert!(hi - lo > 0.2, "synthetic scene too flat: [{lo}, {hi}]");
    }

    /// The smooth layers must be continuous across the ±180° longitude
    /// seam — a non-integer longitude frequency would put a fake edge
    /// there (up to ~0.34 in linear units). The checker layer legitimately
    /// flips at the seam (λ = π is a cell boundary; 24 cells/equator keeps
    /// the pattern itself seamless), so the allowed jump is the checker
    /// flip (2 × CHECKER_AMP) plus modest slack for one pixel of smooth
    /// gradient and any feature blob straddling the seam.
    #[test]
    fn longitude_seam_jump_is_only_the_checker_flip() {
        let (w, h) = (512_u32, 256_u32);
        let img = generate(w, h, 11);
        let allowed = 2.0 * CHECKER_AMP as f32 + 0.06;
        for iy in (h / 8..h - h / 8).step_by(3) {
            let left = img[(iy * w) as usize]; // ix = 0 (λ just past −π)
            let right = img[(iy * w + (w - 1)) as usize]; // ix = W−1 (λ just under π)
            for c in 0..3 {
                let d = (left[c] - right[c]).abs();
                assert!(
                    d <= allowed,
                    "seam discontinuity at row {iy} channel {c}: |Δ| = {d} > {allowed}"
                );
            }
        }
    }
}
