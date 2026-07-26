//! Parity gates for the PER-PIXEL noise-profile modulation (#1714) — the case
//! the original NLM gates were structurally blind to.
//!
//! `tests.rs` calls raw-core with `noise_profile: None` everywhere, so every one
//! of its assertions holds whether or not the GPU modulates `h` per pixel: the
//! reference itself is un-modulated. On a DNG that carries a NoiseProfile —
//! nearly every modern camera — raw-core instead derives a per-pixel `scale` from
//! the Oklab L plane and filters each pixel with `local_h = h · scale` and a
//! shrunk `local_s`. This file drives the SAME reference with a real profile, so
//! a GPU that pushes one scalar per dispatch fails these and passes those.
//!
//! ## Fixture design: the profile and the plane must BOTH be non-uniform
//!
//! `scale = clamp(sqrt(s·L + o) / 0.002366, 0.1, 10)` is a function of the pixel's
//! own L. A flat plane gives a constant `scale`, which a single-scalar shader can
//! still match by accident (it collapses to a rescaled `h`); so does a profile
//! whose coefficients put every pixel on the same clamp. `profile_plane` sweeps L
//! across the full dynamic range and `TEST_NOISE_PROFILE` is a real DJI Mavic 3
//! Pro-scale row, which together put the frame's pixels across the interior of
//! the `scale` range AND across at least two distinct `local_s` values —
//! `spread_is_wide_enough` asserts exactly that, so the gate can never quietly
//! degenerate into the uniform case it exists to catch.

use super::tests::{color_pass, denoise_plane_gpu, luma_pass, max_diff_at, modest_image};
use super::*;
use crate::chain::ChainRunner;
use crate::context::GpuContext;
use crate::image::GpuImage;

// ── Fixtures ──────────────────────────────────────────────────────────────────

/// A DNG NoiseProfile in the 6-float `(slope, offset)`-per-RGB-channel layout,
/// scaled to the same order as the reference 100 MP Hasselblad frame's: shot-noise
/// slopes ~1e-5 and read-noise offsets ~1e-7, with the green channel quieter than
/// red/blue. These land the derived `sigma` a decade or two around raw-core's
/// `0.002366` reference, i.e. inside the `[0.1, 10]` clamp rather than pinned to
/// an end of it.
const TEST_NOISE_PROFILE: [f32; 6] = [
    2.4e-5, 1.1e-7, // red   (slope, offset)
    1.3e-5, 6.0e-8, // green
    3.1e-5, 1.4e-7, // blue
];

/// ISO for the profile cases. Non-zero, since raw-core reads `iso == 0` as
/// "unknown" and zeroes both coefficients.
const TEST_ISO: u32 = 3200;

/// A plane whose values sweep the L range a real frame spans — deep shadow to
/// near-clipping — so the per-pixel `scale` genuinely varies across the frame.
/// The sweep runs on the diagonal (both axes contribute) with the same
/// low-amplitude deterministic texture `modest_plane` uses, so the patch SSDs stay
/// small enough that raw-core's box-sum and our direct sum agree to the f32 floor
/// and the divergence measured here is the modulation, nothing else.
fn profile_plane(w: usize, h: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let gx = x as f32 / (w - 1) as f32;
            let gy = y as f32 / (h - 1) as f32;
            // 0.02 (deep shadow) → 0.98 (near clip) along the diagonal.
            let base = 0.02 + 0.96 * (gx + gy) * 0.5;
            let texture = 0.02 * ((x * 7 + y * 13) % 5) as f32 / 5.0;
            v[y * w + x] = base + texture;
        }
    }
    v
}

/// An RGBA image whose luminance sweeps the same range as [`profile_plane`], with
/// the per-channel skew `modest_image` uses so the Oklab a/b planes carry real
/// chroma for the color gate.
fn profile_image(w: usize, h: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let gx = x as f32 / (w - 1) as f32;
            let gy = y as f32 / (h - 1) as f32;
            let luma = 0.02 + 0.90 * (gx + gy) * 0.5 + 0.02 * ((x * 7 + y * 13) % 5) as f32 / 5.0;
            let skew = 0.03 * ((x + y) % 3) as f32;
            let i = (y * w + x) * 4;
            v[i] = (luma * 1.06 + skew).clamp(0.0, 1.0);
            v[i + 1] = (luma * 0.98).clamp(0.0, 1.0);
            v[i + 2] = (luma * 0.88 + skew * 0.5).clamp(0.0, 1.0);
            v[i + 3] = 1.0;
        }
    }
    v
}

/// The CPU-side `scale` for one plane value — raw-core's per-pixel derivation,
/// reproduced here ONLY to characterise the fixture (the spread assertions
/// below). The parity gates themselves never use it; they compare against the
/// real `denoise_plane_cancellable`.
fn reference_scale(l: f32, s_coeff: f32, o_coeff: f32) -> f32 {
    let local_l = l.clamp(0.0, 10.0);
    let sigma = (s_coeff * local_l + o_coeff).max(0.0).sqrt();
    (sigma / 0.002366).clamp(0.1, 10.0)
}

/// Luma `(slope, offset)` for [`TEST_NOISE_PROFILE`] — the BT.2020 combination
/// raw-core uses for the L plane.
fn luma_coeffs() -> (f32, f32) {
    let p = &TEST_NOISE_PROFILE;
    let s = 0.2627 * p[0] + 0.6780 * p[2] + 0.0593 * p[4];
    let o = 0.2627 * 0.2627 * p[1] + 0.6780 * 0.6780 * p[3] + 0.0593 * 0.0593 * p[5];
    (s, o)
}

// ── References ────────────────────────────────────────────────────────────────

/// `raw_core::stages::nlm::denoise_plane_cancellable` WITH the profile — the
/// plane-level reference for the modulated filter. `denoise_plane` (the wrapper
/// the flat gates use) hard-codes `noise_profile: None`, which is precisely why
/// those gates could not see this bug.
fn raw_core_denoise_modulated(
    plane: &[f32],
    guide: &[f32],
    w: usize,
    h: usize,
    params: NlmParams,
    is_chroma: bool,
) -> Vec<f32> {
    let rc = raw_core::stages::nlm::NlmParams {
        patch_radius: params.patch_radius,
        search_radius: params.search_radius,
        h: params.h,
    };
    raw_core::stages::nlm::denoise_plane_cancellable(
        plane,
        w,
        h,
        rc,
        raw_core::cancel::CancelToken::never(),
        guide,
        Some(&TEST_NOISE_PROFILE),
        TEST_ISO,
        is_chroma,
    )
}

/// `apply_luminance` with the profile — the stage-level reference.
fn raw_core_nr_luma_modulated(buf: &[f32], w: u32, h: u32, amount: f32) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::noise_reduction::apply_luminance(
        &mut img,
        amount,
        Some(&TEST_NOISE_PROFILE),
        TEST_ISO,
    );
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// `apply_color` with the profile — the stage-level reference for chroma.
fn raw_core_nr_color_modulated(buf: &[f32], w: u32, h: u32, amount: f32) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::noise_reduction::apply_color(
        &mut img,
        amount,
        Some(&TEST_NOISE_PROFILE),
        TEST_ISO,
    );
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// A luma pass carrying the test profile.
fn luma_pass_profiled(amount: f32) -> NlmLumaPass {
    NlmLumaPass {
        nr_luminance: amount,
        noise_profile: TEST_NOISE_PROFILE.to_vec(),
        iso: TEST_ISO,
    }
}

/// A color pass carrying the test profile.
fn color_pass_profiled(amount: f32) -> NlmColorPass {
    NlmColorPass {
        nr_color: amount,
        noise_profile: TEST_NOISE_PROFILE.to_vec(),
        iso: TEST_ISO,
    }
}

// ── The fixture is genuinely NON-UNIFORM (the guard on the guard) ─────────────

/// The fixture actually spreads `scale` — and therefore `local_s` — across the
/// frame. Without this the modulated gates could pass on a constant-`scale`
/// plane, which a single-scalar shader reproduces exactly; the gate would run,
/// pass, and prove nothing, which is the failure mode #1714 documents.
#[test]
fn spread_is_wide_enough() {
    let (w, h) = (48usize, 48usize);
    let plane = profile_plane(w, h);
    let (s_coeff, o_coeff) = luma_coeffs();
    let s = LUMA_SEARCH_RADIUS as f32;

    let scales: Vec<f32> = plane
        .iter()
        .map(|&l| reference_scale(l, s_coeff, o_coeff))
        .collect();
    let lo = scales.iter().copied().fold(f32::INFINITY, f32::min);
    let hi = scales.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let mut radii: Vec<i32> = scales
        .iter()
        .map(|&sc| ((s * sc).round() as i32).clamp(1, LUMA_SEARCH_RADIUS as i32))
        .collect();
    radii.sort_unstable();
    radii.dedup();

    eprintln!(
        "FIXTURE SPREAD: scale ∈ [{lo:.3}, {hi:.3}] (ratio {:.2}×), distinct local_s = {radii:?}",
        hi / lo
    );
    assert!(
        hi / lo > 2.0,
        "per-pixel scale spans only {:.2}× ([{lo}, {hi}]) — the fixture is near-uniform, so a \
         single-scalar shader would match it and the gate proves nothing",
        hi / lo
    );
    assert!(
        radii.len() >= 2,
        "every pixel resolves to the same local_s ({radii:?}) — the search-radius half of the \
         modulation is untested"
    );
}

// ── Plane-level parity, WITH the profile ──────────────────────────────────────

/// THE #1714 GATE: the GPU NLM core matches raw-core's PER-PIXEL-MODULATED
/// `denoise_plane_cancellable` `< 1e-4` at the luma params. This is the assertion
/// the pre-fix shader fails — it filtered every pixel with one `inv_norm`.
#[test]
fn nlm_core_matches_modulated_denoise_plane_luma() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 48usize);
    let plane = profile_plane(w, h);
    let params = luma_params(100.0);
    let reference = raw_core_denoise_modulated(&plane, &plane, w, h, params, false);
    let flat = raw_core::stages::nlm::denoise_plane(
        &plane,
        w,
        h,
        raw_core::stages::nlm::NlmParams {
            patch_radius: params.patch_radius,
            search_radius: params.search_radius,
            h: params.h,
        },
    );
    let gpu = denoise_plane_gpu(
        &ctx,
        &plane,
        &plane,
        w as u32,
        h as u32,
        params,
        NoiseModulation::from_profile(Some(&TEST_NOISE_PROFILE), TEST_ISO, false),
    );

    // How far the modulation moves the result. If this were ~0 the gate would be
    // satisfied by the un-modulated shader and would prove nothing.
    let (modulation_effect, _) = max_diff_at(&reference, &flat);
    let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
    eprintln!(
        "MODULATED PLANE PARITY (luma): max abs diff = {max_diff:e} at ({},{}); \
         modulation moves the reference by {modulation_effect:e} vs the flat filter",
        worst_i % w,
        worst_i / w
    );
    assert!(
        modulation_effect > 1e-3,
        "per-pixel modulation barely changes raw-core's own output ({modulation_effect:e}) — \
         the fixture cannot distinguish a modulated shader from a scalar one"
    );
    assert!(
        max_diff < 1e-4,
        "GPU NLM core vs the MODULATED denoise_plane (luma) max abs diff {max_diff} exceeds 1e-4"
    );
}

/// The same gate at the CHROMA params, where the guide plane is a DIFFERENT plane
/// from the one being denoised (raw-core derives chroma's `scale` from L, not from
/// a/b) and the wider `S = 3` gives `local_s` more room to vary.
#[test]
fn nlm_core_matches_modulated_denoise_plane_chroma() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 48usize);
    let guide = profile_plane(w, h);
    // The denoised plane is a chroma-scale plane (Oklab a/b magnitudes), with
    // structure of its own that is UNRELATED to the guide's brightness sweep — so
    // a shader that modulated off the denoised plane instead of the guide would
    // derive different scales and fail here.
    let plane: Vec<f32> = (0..w * h)
        .map(|i| {
            let (x, y) = (i % w, i / w);
            0.08 * ((x as f32 * 0.3).sin() + (y as f32 * 0.21).cos()) * 0.5
        })
        .collect();
    let params = chroma_params(100.0);
    let reference = raw_core_denoise_modulated(&plane, &guide, w, h, params, true);
    let flat = raw_core::stages::nlm::denoise_plane(
        &plane,
        w,
        h,
        raw_core::stages::nlm::NlmParams {
            patch_radius: params.patch_radius,
            search_radius: params.search_radius,
            h: params.h,
        },
    );
    let gpu = denoise_plane_gpu(
        &ctx,
        &plane,
        &guide,
        w as u32,
        h as u32,
        params,
        NoiseModulation::from_profile(Some(&TEST_NOISE_PROFILE), TEST_ISO, true),
    );
    let (modulation_effect, _) = max_diff_at(&reference, &flat);
    let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
    eprintln!(
        "MODULATED PLANE PARITY (chroma, L guide): max abs diff = {max_diff:e} at ({},{}); \
         modulation moves the reference by {modulation_effect:e} vs the flat filter",
        worst_i % w,
        worst_i / w
    );
    assert!(
        modulation_effect > 1e-3,
        "per-pixel modulation barely changes raw-core's chroma output ({modulation_effect:e}) — \
         the fixture cannot distinguish a modulated shader from a scalar one"
    );
    assert!(
        max_diff < 1e-4,
        "GPU NLM core vs the MODULATED denoise_plane (chroma) max abs diff {max_diff} exceeds 1e-4"
    );
}

// ── Stage-level parity, WITH the profile ──────────────────────────────────────

/// `NlmLumaPass` carrying a profile matches `apply_luminance` carrying the same
/// profile, across slider values — the whole stage (extract → prepare → shift
/// loop → finalize → writeback) under modulation.
#[test]
fn nlm_luma_pass_matches_modulated_raw_core() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 48usize);
    let input = profile_image(w, h);
    for &amount in &[40.0_f32, 100.0] {
        let reference = raw_core_nr_luma_modulated(&input, w as u32, h as u32, amount);
        let (moved, _) = max_diff_at(&input, &reference);
        let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&luma_pass_profiled(amount)]);
        let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
        let px = worst_i / 4;
        eprintln!(
            "MODULATED LUMA STAGE PARITY amount={amount}: max abs diff = {max_diff:e} at pixel \
             ({},{}); raw-core moved input by {moved:e}",
            px % w,
            px / w
        );
        assert!(
            moved > 1e-3,
            "modulated luma-NR amount={amount} barely moved the image ({moved:e}) — gate is vacuous"
        );
        assert!(
            max_diff < 1e-4,
            "NlmLumaPass vs the MODULATED apply_luminance amount={amount} max abs diff \
             {max_diff} exceeds 1e-4"
        );
    }
}

/// `NlmColorPass` carrying a profile matches `apply_color` carrying the same
/// profile — covers the chroma coefficient combination and the shared L guide
/// both a and b are modulated by.
#[test]
fn nlm_color_pass_matches_modulated_raw_core() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 48usize);
    let input = profile_image(w, h);
    for &amount in &[40.0_f32, 100.0] {
        let reference = raw_core_nr_color_modulated(&input, w as u32, h as u32, amount);
        let (moved, _) = max_diff_at(&input, &reference);
        let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&color_pass_profiled(amount)]);
        let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
        let px = worst_i / 4;
        eprintln!(
            "MODULATED COLOR STAGE PARITY amount={amount}: max abs diff = {max_diff:e} at pixel \
             ({},{}); raw-core moved input by {moved:e}",
            px % w,
            px / w
        );
        assert!(
            moved > 1e-4,
            "modulated color-NR amount={amount} barely moved the image ({moved:e}) — gate is \
             vacuous"
        );
        assert!(
            max_diff < 1e-4,
            "NlmColorPass vs the MODULATED apply_color amount={amount} max abs diff {max_diff} \
             exceeds 1e-4"
        );
    }
}

// ── The two paths stay distinct ───────────────────────────────────────────────

/// An EMPTY profile is raw-core's `None`: the GPU must reproduce the flat filter
/// exactly, not "modulation with `scale = 1`-ish". Pins the no-profile path
/// against the pre-#1714 behaviour so the new plane can't perturb files that
/// carry no NoiseProfile.
#[test]
fn empty_profile_matches_the_flat_filter() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (32usize, 32usize);
    let input = modest_image(w, h);
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let flat = runner.run_blocking(&[&luma_pass(80.0)]);
    let empty_profiled = runner.run_blocking(&[&NlmLumaPass {
        nr_luminance: 80.0,
        noise_profile: Vec::new(),
        iso: TEST_ISO,
    }]);
    assert_eq!(
        flat, empty_profiled,
        "an empty noise profile must be bit-identical to the flat filter"
    );
}

/// A profiled pass must NOT produce the flat pass's output — the fix has to be
/// observable at the stage level, not only against a reference that also changed.
#[test]
fn profiled_stage_differs_from_flat_stage() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 48usize);
    let input = profile_image(w, h);
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let flat = runner.run_blocking(&[&luma_pass(100.0)]);
    let profiled = runner.run_blocking(&[&luma_pass_profiled(100.0)]);
    let (diff, _) = max_diff_at(&flat, &profiled);
    eprintln!("PROFILED vs FLAT (GPU, luma amount=100): max abs diff = {diff:e}");
    assert!(
        diff > 1e-3,
        "the profiled GPU pass matches the flat one to {diff:e} — the per-pixel modulation is \
         not reaching the kernel"
    );
    // The color stage carries the profile too (its own coefficient combination).
    let flat_c = runner.run_blocking(&[&color_pass(100.0)]);
    let profiled_c = runner.run_blocking(&[&color_pass_profiled(100.0)]);
    let (diff_c, _) = max_diff_at(&flat_c, &profiled_c);
    eprintln!("PROFILED vs FLAT (GPU, color amount=100): max abs diff = {diff_c:e}");
    assert!(
        diff_c > 1e-5,
        "the profiled GPU color pass matches the flat one to {diff_c:e} — the chroma planes are \
         not modulated"
    );
}
