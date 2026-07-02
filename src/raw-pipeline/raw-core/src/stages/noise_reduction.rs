//! Edge-preserving noise reduction per spec § 3.11.
//!
//! # Algorithm
//!
//! Both luma and chroma NR run **fast non-local-means** via the
//! Darbon 2008 integral-image variant of Buades/Coll/Morel (2005).
//! Patch-based weighted average: every pixel is reconstructed as a
//! similarity-weighted sum of pixels in its local search window,
//! where similarity is the SSD between patches centred on the two
//! pixels. Edges are preserved because pixels across an edge produce
//! large patch-SSDs and contribute near-zero weight.
//!
//! The kernel itself lives in [`crate::stages::nlm`]; this module is
//! the Oklab-space adapter:
//!
//!   * Convert the working image from scene-linear Rec.2020 → Oklab.
//!   * Run NLM on the L plane (luma) or on the a + b planes (chroma).
//!   * Convert back to Rec.2020.
//!
//! Oklab isolates perceptual luminance from chroma so the two NR
//! sliders address orthogonal channels. Chroma uses a wider search
//! window — chroma noise is lower-frequency. A guided-filter fallback
//! is implemented at [`crate::stages::guided`] for cases where the
//! 16 ms slider budget cannot accommodate NLM.
//!
//! # Slider semantics
//!
//! `nr_luminance` / `nr_color` are in [0, 100] (matches the reference renderer's
//! Luminance / Color sliders). The slider amount scales the NLM
//! filtering strength `h` linearly from a noise floor at 0 to the
//! configured maximum at 100. Zero is identity (short-circuited).
//!
//! # Performance
//!
//! NLM at S = 2 (5×5 search = 24 offsets, excluding centre) and
//! P = 2 (5×5 patch) on a 2 MP plane in release mode is ~42 ms on
//! Apple Silicon — over the 16 ms slider tick budget. The slider
//! invariant is honoured by the Apple FFI scene-linear chain
//! (`scene_linear_chain.rs`) which calls `apply_luminance`; the
//! gap is **acknowledged and tracked as a follow-up** for either
//! a SIMD-NLM port or a Metal-side compute kernel. See the PR
//! body of #270 for the measurement and follow-up issue.
//!
//! # Cross-platform parity caveat
//!
//! The Apple Metal `nr_color` shader at
//! `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneNRColor.metal`
//! still implements the original chroma Gaussian blur. Porting it to
//! NLM is tracked separately — the Apple `nr_color` path was already
//! non-bit-equal with the Rust Gaussian before this change (the GPU
//! went through a Core Image Gaussian; Rust went through a custom
//! cascaded-box approximation), so this change doesn't introduce a
//! new parity break — it widens an existing one. Web (WASM-Rust) and
//! headless CLI both ship NLM uniformly.

use crate::{
    cancel::CancelToken,
    color::oklab::{oklab_to_rec2020, rec2020_to_oklab},
    image::{ColorSpace, Image},
    stages::nlm::{denoise_plane_cancellable, NlmParams},
};
use rayon::prelude::*;

/// NLM parameters at amount = 100 for the luma channel. P = 2 (5×5
/// patch) + S = 2 (5×5 search = 24 offsets) lands the slider tick at
/// roughly 40 ms on 2 MP — over budget, but small enough that a
/// future SIMD port can plausibly close the gap. Larger search
/// windows (S = 3, 4) blow past 50 ms.
const LUMA_PATCH_RADIUS: usize = 2;
const LUMA_SEARCH_RADIUS: usize = 2;
/// `h` scales linearly with the slider; at amount = 100 the max
/// strength is 0.04 in Oklab L units. Oklab L is in [0, ~1.0] for
/// typical scenes — 0.04 is ~4% of the L range, comfortably above
/// per-pixel sensor noise stdev at base ISO and aggressive at high
/// ISO without crushing midtone detail.
const LUMA_H_MAX: f32 = 0.04;

/// NLM parameters at amount = 100 for chroma (Oklab a, b). Chroma
/// noise is lower-frequency than luma noise — a wider search window
/// (S = 3, 7×7 = 48 offsets) catches it. Chroma NLM runs only on the
/// refine pass (the slider-tick path omits `nr_color`; see
/// `scene_linear_chain.rs:152`), so the wider window is unconstrained
/// by the 16 ms budget.
const CHROMA_PATCH_RADIUS: usize = 2;
const CHROMA_SEARCH_RADIUS: usize = 3;
/// `h` is larger for chroma because the a/b range is narrower than L
/// (a, b land in roughly [-0.3, 0.3] for normal scenes, but per-pixel
/// noise is concentrated in the low-magnitude region where 0.05
/// covers most of the noise distribution).
const CHROMA_H_MAX: f32 = 0.05;

fn luma_params(amount: f32) -> NlmParams {
    let t = (amount / 100.0).clamp(0.0, 1.0);
    NlmParams {
        patch_radius: LUMA_PATCH_RADIUS,
        search_radius: LUMA_SEARCH_RADIUS,
        h: t * LUMA_H_MAX,
    }
}

fn chroma_params(amount: f32) -> NlmParams {
    let t = (amount / 100.0).clamp(0.0, 1.0);
    NlmParams {
        patch_radius: CHROMA_PATCH_RADIUS,
        search_radius: CHROMA_SEARCH_RADIUS,
        h: t * CHROMA_H_MAX,
    }
}

/// Apply luminance NR: NLM-denoise the L channel of Oklab, leave a/b
/// untouched.
///
/// The Rec.2020 ↔ Oklab pixel-local maps run through rayon's
/// `par_iter`; the NLM kernel itself is internally parallel across
/// its row-update / sqdiff sweeps (see [`crate::stages::nlm`]).
#[inline]
pub fn apply_luminance(img: &mut Image, amount: f32, noise_profile: Option<&[f32]>, iso: u32) {
    apply_luminance_cancellable(img, amount, CancelToken::never(), noise_profile, iso);
}

/// Cancellable variant of [`apply_luminance`]. Forwards `cancel` into the
/// NLM kernel so the between-shifts check can unwind a long luma pass. With
/// a never-cancel token the result is bit-identical to [`apply_luminance`].
pub fn apply_luminance_cancellable(
    img: &mut Image,
    amount: f32,
    cancel: CancelToken<'_>,
    noise_profile: Option<&[f32]>,
    iso: u32,
) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 {
        return;
    }
    let params = luma_params(amount);

    let w = img.width as usize;
    let h = img.height as usize;

    // Convert to Oklab.
    let mut oklab: Vec<[f32; 3]> = vec![[0.0; 3]; img.pixels.len()];
    oklab
        .par_iter_mut()
        .zip(img.pixels.par_iter())
        .for_each(|(dst, src)| *dst = rec2020_to_oklab(*src));

    // Extract L plane.
    let l_plane: Vec<f32> = oklab.par_iter().map(|p| p[0]).collect();

    // Denoise.
    let denoised_l = denoise_plane_cancellable(
        &l_plane,
        w,
        h,
        params,
        cancel,
        &l_plane,
        noise_profile,
        iso,
        false,
    );

    // Writeback L, convert back to Rec.2020.
    img.pixels
        .par_iter_mut()
        .zip(oklab.par_iter())
        .zip(denoised_l.par_iter())
        .for_each(|((dst, lab), &new_l)| {
            *dst = oklab_to_rec2020([new_l, lab[1], lab[2]]);
        });
}

/// Apply color NR: NLM-denoise the a and b channels of Oklab, leave
/// L untouched. Uses a wider search window than luma (chroma noise
/// is lower-frequency).
#[inline]
pub fn apply_color(img: &mut Image, amount: f32, noise_profile: Option<&[f32]>, iso: u32) {
    apply_color_cancellable(img, amount, CancelToken::never(), noise_profile, iso);
}

/// Cancellable variant of [`apply_color`]. Both chroma NLM passes observe
/// `cancel` between shifts. This is the dominant cold-open cost (the ~8.5 s
/// `nr_color`), so the in-kernel check here is what actually interrupts the
/// freeze. With a never-cancel token the result is bit-identical to
/// [`apply_color`].
pub fn apply_color_cancellable(
    img: &mut Image,
    amount: f32,
    cancel: CancelToken<'_>,
    noise_profile: Option<&[f32]>,
    iso: u32,
) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 {
        return;
    }
    let params = chroma_params(amount);

    let w = img.width as usize;
    let h = img.height as usize;

    let mut oklab: Vec<[f32; 3]> = vec![[0.0; 3]; img.pixels.len()];
    oklab
        .par_iter_mut()
        .zip(img.pixels.par_iter())
        .for_each(|(dst, src)| *dst = rec2020_to_oklab(*src));

    let l_plane: Vec<f32> = oklab.par_iter().map(|p| p[0]).collect();
    let a_plane: Vec<f32> = oklab.par_iter().map(|p| p[1]).collect();
    let b_plane: Vec<f32> = oklab.par_iter().map(|p| p[2]).collect();

    // Run both NLM passes in parallel — each is already internally
    // parallel via the row-update sweeps, but at viewport sizes the
    // outer split still helps on 8+-core machines. Both share the same
    // cancel token (a `Copy` borrow), so a host cancel unwinds both.
    let (denoised_a, denoised_b) = rayon::join(
        || {
            denoise_plane_cancellable(
                &a_plane,
                w,
                h,
                params,
                cancel,
                &l_plane,
                noise_profile,
                iso,
                true,
            )
        },
        || {
            denoise_plane_cancellable(
                &b_plane,
                w,
                h,
                params,
                cancel,
                &l_plane,
                noise_profile,
                iso,
                true,
            )
        },
    );

    img.pixels
        .par_iter_mut()
        .zip(oklab.par_iter())
        .zip(denoised_a.par_iter())
        .zip(denoised_b.par_iter())
        .for_each(|(((dst, lab), &new_a), &new_b)| {
            *dst = oklab_to_rec2020([lab[0], new_a, new_b]);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_luminance_is_identity() {
        let mut img = Image::new(5, 5, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.3, 0.5, 0.7];
        }
        let before = img.pixels.clone();
        apply_luminance(&mut img, 0.0, None, 100);
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn zero_color_is_identity() {
        let mut img = Image::new(5, 5, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.3, 0.5, 0.7];
        }
        let before = img.pixels.clone();
        apply_color(&mut img, 0.0, None, 100);
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn luminance_smooths_without_killing_color() {
        // Alternating bright/dark pixels on same hue.
        let mut img = Image::new(16, 16, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = if i % 2 == 0 {
                [0.6, 0.3, 0.3]
            } else {
                [0.3, 0.1, 0.1]
            };
        }
        apply_luminance(&mut img, 100.0, None, 100);
        // After NR the alternation should be smoothed; the red tint
        // should persist on average.
        for p in &img.pixels {
            let luma = 0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2];
            let saturation = (p[0] - p[1]).max(p[0] - p[2]);
            assert!(
                luma > 0.15 && luma < 0.6,
                "luma out of expected range: {}",
                luma
            );
            assert!(saturation > 0.05, "saturation lost: {}", saturation);
        }
    }

    #[test]
    fn preserves_scene_headroom() {
        let mut img = Image::new(8, 8, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [5.0, 3.0, 1.5];
        }
        apply_luminance(&mut img, 100.0, None, 100);
        for p in &img.pixels {
            for &c in p {
                assert!(c.is_finite());
            }
        }
    }

    /// Acceptance criterion from issue #270.
    ///
    /// At nr_luminance = 50 on a synthetic noisy fixture:
    ///   * luma noise stdev (flat-region) drops ≥ 60%
    ///   * edge sharpness (Sobel-x peak at the edge column) drops
    ///     < 10%
    ///
    /// Fixture: a vertical step function (left half 0.30, right half
    /// 0.70 in luminance) plus per-pixel additive Gaussian-ish noise
    /// of σ ≈ 0.04. The flat region for the stdev measurement is the
    /// left half excluding columns within 4 px of the edge — that's
    /// enough padding to clear the NLM patch+search reach
    /// (P + S = 4 px) so the stdev sample is pure flat. The Sobel-x
    /// peak is sampled AT the edge column only — a ±2 window
    /// conflates the edge response with the noise gradient in
    /// adjacent columns, which falls fastest with NR.
    #[test]
    fn nr_luminance_50_meets_acceptance_thresholds() {
        let w = 96usize;
        let h = 96usize;
        let edge_col = w / 2;
        let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
        let mut rng_state: u32 = 0x9E3779B9;
        for y in 0..h {
            for x in 0..w {
                let base = if x < edge_col { 0.30 } else { 0.70 };
                // xorshift32 -> two uniforms -> Box-Muller-ish normal.
                rng_state ^= rng_state << 13;
                rng_state ^= rng_state >> 17;
                rng_state ^= rng_state << 5;
                let u1 = (rng_state as f32 / u32::MAX as f32).max(1e-6);
                rng_state ^= rng_state << 13;
                rng_state ^= rng_state >> 17;
                rng_state ^= rng_state << 5;
                let u2 = rng_state as f32 / u32::MAX as f32;
                let z = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos();
                let noisy = (base + 0.04 * z).clamp(0.0, 1.0);
                img.pixels[y * w + x] = [noisy, noisy, noisy];
            }
        }

        let input_pixels = img.pixels.clone();
        apply_luminance(&mut img, 50.0, None, 100);
        let output_pixels = img.pixels.clone();

        // --- Flat-region noise stdev (left half, away from the edge). ---
        let left_band = (4, edge_col - 4);
        let stdev_band = |pixels: &[[f32; 3]]| -> f32 {
            let mut samples = Vec::new();
            for y in 4..(h - 4) {
                for x in left_band.0..left_band.1 {
                    samples.push(pixels[y * w + x][1]); // G ~ luma here
                }
            }
            let mean: f32 = samples.iter().sum::<f32>() / samples.len() as f32;
            let var: f32 =
                samples.iter().map(|&v| (v - mean).powi(2)).sum::<f32>() / samples.len() as f32;
            var.sqrt()
        };
        let in_stdev = stdev_band(&input_pixels);
        let out_stdev = stdev_band(&output_pixels);
        let stdev_drop = 1.0 - out_stdev / in_stdev;
        eprintln!(
            "nr_luminance=50 stdev: in={:.4} out={:.4} drop={:.1}%",
            in_stdev,
            out_stdev,
            stdev_drop * 100.0,
        );
        assert!(
            stdev_drop >= 0.60,
            "noise stdev drop {:.3} < 0.60 target (in={:.4} out={:.4})",
            stdev_drop,
            in_stdev,
            out_stdev,
        );

        // --- Edge sharpness via Sobel-x at the edge column only. ---
        let sobel_x_mean = |pixels: &[[f32; 3]]| -> f32 {
            let g = |x: usize, y: usize| pixels[y * w + x][1];
            let mut acc = 0.0f32;
            let mut count = 0usize;
            let x = edge_col;
            for y in 1..(h - 1) {
                let gx = -1.0 * g(x - 1, y - 1) + 1.0 * g(x + 1, y - 1) - 2.0 * g(x - 1, y)
                    + 2.0 * g(x + 1, y)
                    - 1.0 * g(x - 1, y + 1)
                    + 1.0 * g(x + 1, y + 1);
                acc += gx.abs();
                count += 1;
            }
            acc / count as f32
        };
        let in_sobel = sobel_x_mean(&input_pixels);
        let out_sobel = sobel_x_mean(&output_pixels);
        let sobel_drop = 1.0 - out_sobel / in_sobel;
        eprintln!(
            "nr_luminance=50 sobel: in={:.4} out={:.4} drop={:.1}%",
            in_sobel,
            out_sobel,
            sobel_drop * 100.0,
        );
        assert!(
            sobel_drop < 0.10,
            "edge sharpness drop {:.3} ≥ 0.10 (in={:.4} out={:.4})",
            sobel_drop,
            in_sobel,
            out_sobel,
        );
    }

    /// Perf measurement: at nr_luminance = 50 on a 2 MP image,
    /// `apply_luminance` runs in ~40 ms on Apple Silicon in release
    /// mode. The 16 ms slider tick budget is **not** met by NLM on
    /// CPU; this test asserts only the 50 ms hard limit and prints
    /// the actual elapsed time. See the PR body of #270 for the
    /// follow-up that closes the gap (either a SIMD NLM port or a
    /// Metal/WebGL compute kernel).
    ///
    /// Skips the assertion in debug builds (3-5× slower).
    #[test]
    fn perf_luminance_2mp_under_hard_limit_release() {
        let w = 1920u32;
        let h = 1080u32;
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            let v = ((i as f32 * 0.001).sin() * 0.5 + 0.5).clamp(0.05, 0.95);
            *p = [v, v, v];
        }
        // Warm-up: first run includes thread-pool spin-up.
        apply_luminance(&mut img.clone(), 50.0, None, 100);
        let start = std::time::Instant::now();
        apply_luminance(&mut img, 50.0, None, 100);
        let elapsed = start.elapsed();
        eprintln!(
            "perf_luminance_2mp: 1920x1080 nr_luminance=50 in {:?}",
            elapsed
        );
        if cfg!(not(debug_assertions)) {
            assert!(
                elapsed.as_millis() < 50,
                "luminance NR on 2MP took {:?} — over the 50 ms hard limit",
                elapsed,
            );
        }
    }
}
