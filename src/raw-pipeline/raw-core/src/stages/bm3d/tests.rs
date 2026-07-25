//! BM3D stage tests (#1105, tone/zoom design spec § 3.2). Proof
//! obligations: bit-identical skip at 0; bit-exact identity on uniform
//! fields (the synthetic-grey gate, any strength); real noise reduction
//! with chroma cleaned harder than luma; thread-count determinism (the
//! #1105 hard gate); cancellation leaves the buffer untouched; edge
//! behavior.

#![cfg(test)]

use super::*;

/// Deterministic LCG (same generator as the chroma-prefilter tests).
struct Lcg(u64);
impl Lcg {
    fn next_f32(&mut self) -> f32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32) / (1u64 << 24) as f32
    }
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

/// A soft two-tone scene (flat regions + an edge) under iid sensor-ish
/// noise on every channel — the content BM3D exists for.
fn noisy_scene(w: u32, h: u32, noise_amp: f32) -> Image {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    let mut rng = Lcg(0x1105_b3d5_eed5_eed5);
    for y in 0..h as usize {
        for x in 0..w as usize {
            let base = if x < (w as usize / 2) { 0.12 } else { 0.30 };
            let p = &mut img.pixels[y * w as usize + x];
            *p = [
                base + rng.noise(noise_amp),
                base + rng.noise(noise_amp),
                base + rng.noise(noise_amp),
            ];
        }
    }
    img
}

fn clone_img(img: &Image) -> Image {
    Image {
        width: img.width,
        height: img.height,
        pixels: img.pixels.clone(),
        space: img.space,
    }
}

fn luma(p: [f32; 3]) -> f32 {
    LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2]
}

/// Mean residual energy vs a flat reference value over a region.
fn region_variance(img: &Image, x0: usize, x1: usize, plane: impl Fn([f32; 3]) -> f32) -> f64 {
    let w = img.width as usize;
    let mut vals = Vec::new();
    for y in 0..img.height as usize {
        for x in x0..x1 {
            vals.push(plane(img.pixels[y * w + x]) as f64);
        }
    }
    let mean = vals.iter().sum::<f64>() / vals.len() as f64;
    vals.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / vals.len() as f64
}

#[test]
fn strength_zero_is_bit_identical_skip() {
    let mut img = noisy_scene(32, 24, 0.02);
    let before = img.pixels.clone();
    apply(&mut img, 0.0, None);
    assert_eq!(
        img.pixels, before,
        "strength 0 must be a bit-identical skip"
    );
}

#[test]
fn uniform_field_is_bit_exact_identity_at_any_strength() {
    // THE synthetic-grey gate (spec § 3.2): on a noiseless uniform field
    // every mean-relative spectrum, means-delta, aggregation delta, and
    // HF term is exactly 0.0 — bit-for-bit identity, not within-tolerance.
    for &s in &[10.0f32, 50.0, 100.0] {
        for &v in &[[0.001f32; 3], [0.18; 3], [1.0; 3], [0.4, 0.1, 0.05]] {
            let mut img = uniform_img(24, 16, v);
            let before = img.pixels.clone();
            apply(&mut img, s, None);
            assert_eq!(
                img.pixels, before,
                "uniform {:?} must be bit-exact at strength {}",
                v, s
            );
        }
    }
}

#[test]
fn noise_energy_drops_on_flat_regions() {
    let img0 = noisy_scene(64, 48, 0.02);
    let var_before = region_variance(&img0, 4, 28, luma);
    let mut img = clone_img(&img0);
    apply(&mut img, 50.0, None);
    let var_after = region_variance(&img, 4, 28, luma);
    assert!(
        var_after < 0.5 * var_before,
        "flat-region luma variance should drop substantially: {} -> {}",
        var_before,
        var_after
    );
}

#[test]
fn chroma_is_cleaned_harder_than_luma() {
    // σ_C = 1.8 σ_Y: the chroma planes get a higher threshold, so the
    // RESIDUAL chroma fraction must come out at-or-below the residual
    // luma fraction (noise biased toward luminance — the § 3 tier story).
    let img0 = noisy_scene(64, 48, 0.02);
    let c1 = |p: [f32; 3]| p[0] - luma(p);
    let var_y0 = region_variance(&img0, 4, 28, luma);
    let var_c0 = region_variance(&img0, 4, 28, c1);
    let mut img = clone_img(&img0);
    apply(&mut img, 50.0, None);
    let var_y1 = region_variance(&img, 4, 28, luma);
    let var_c1 = region_variance(&img, 4, 28, c1);
    let luma_residual = var_y1 / var_y0;
    let chroma_residual = var_c1 / var_c0;
    assert!(
        chroma_residual <= luma_residual * 1.05,
        "chroma residual {} should be <= luma residual {}",
        chroma_residual,
        luma_residual
    );
}

#[test]
fn edge_is_preserved_while_flats_clean() {
    // The two-tone step must survive denoising: compare the cross-edge
    // contrast before/after — collaborative filtering groups same-side
    // patches, so the step stays.
    let img0 = noisy_scene(64, 48, 0.02);
    let mut img = clone_img(&img0);
    apply(&mut img, 50.0, None);
    let w = img.width as usize;
    let mid_y = (img.height as usize / 2) * w;
    let left = luma(img.pixels[mid_y + w / 2 - 6]);
    let right = luma(img.pixels[mid_y + w / 2 + 6]);
    assert!(
        right - left > 0.12,
        "the 0.12->0.30 step must survive: left {} right {}",
        left,
        right
    );
}

#[test]
fn deterministic_across_thread_counts() {
    // THE #1105 determinism gate: byte equality at 1 thread vs N threads.
    let base = noisy_scene(48, 40, 0.02);
    let run = |threads: usize| -> Vec<[f32; 3]> {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .expect("build pool");
        let mut img = clone_img(&base);
        pool.install(|| apply(&mut img, 60.0, None));
        img.pixels
    };
    let one = run(1);
    let many = run(8);
    assert_eq!(
        one, many,
        "BM3D output must be byte-identical across thread counts"
    );
}

#[test]
fn cancellation_leaves_buffer_untouched() {
    use std::sync::atomic::AtomicBool;
    let mut img = noisy_scene(48, 40, 0.02);
    let before = img.pixels.clone();
    let flag = AtomicBool::new(true); // pre-cancelled
    apply_cancellable(&mut img, 60.0, CancelToken::new(&flag), None);
    assert_eq!(
        img.pixels, before,
        "a cancelled run must never write a partially-denoised buffer"
    );
}

#[test]
fn tiny_images_are_identity() {
    for &(w, h) in &[(1u32, 1u32), (7, 7), (7, 32), (32, 7)] {
        let mut img = uniform_img(w, h, [0.3, 0.2, 0.1]);
        let before = img.pixels.clone();
        apply(&mut img, 80.0, None);
        assert_eq!(
            img.pixels, before,
            "{}x{}: no 8x8 patch fits -> identity",
            w, h
        );
    }
}

#[test]
fn progress_is_reported_monotonically_for_both_passes() {
    use std::sync::Mutex;
    let log: Mutex<Vec<(&'static str, f32)>> = Mutex::new(Vec::new());
    let sink = |pass: &'static str, frac: f32| {
        log.lock().unwrap().push((pass, frac));
    };
    let mut img = noisy_scene(32, 24, 0.02);
    apply(&mut img, 50.0, Some(&sink));
    let log = log.into_inner().unwrap();
    let p1: Vec<f32> = log
        .iter()
        .filter(|(n, _)| *n == super::PASS_1)
        .map(|&(_, f)| f)
        .collect();
    let p2: Vec<f32> = log
        .iter()
        .filter(|(n, _)| *n == super::PASS_2)
        .map(|&(_, f)| f)
        .collect();
    assert!(
        !p1.is_empty() && !p2.is_empty(),
        "both passes must report progress"
    );
    assert!(
        p1.windows(2).all(|w| w[1] >= w[0]),
        "pass 1 progress must be monotone"
    );
    assert!(
        p2.windows(2).all(|w| w[1] >= w[0]),
        "pass 2 progress must be monotone"
    );
    assert!(
        (p1.last().unwrap() - 1.0).abs() < 1e-6,
        "pass 1 must reach 100%"
    );
    assert!(
        (p2.last().unwrap() - 1.0).abs() < 1e-6,
        "pass 2 must reach 100%"
    );
}

/// The host bridges (#1153) fold a `(pass, fraction)` tick into one
/// `[0, 1]` bar value; pass 1 owns the first half, pass 2 the second, and
/// the sequence is monotone across the pass boundary.
#[test]
fn overall_fraction_spans_both_passes_monotonically() {
    use super::{overall_fraction, PASS_1, PASS_2};
    assert!((overall_fraction(PASS_1, 0.0) - 0.0).abs() < 1e-6);
    assert!((overall_fraction(PASS_1, 1.0) - 0.5).abs() < 1e-6);
    assert!((overall_fraction(PASS_2, 0.0) - 0.5).abs() < 1e-6);
    assert!((overall_fraction(PASS_2, 1.0) - 1.0).abs() < 1e-6);
    // Out-of-range input is clamped, never escapes [0, 1].
    assert!((overall_fraction(PASS_2, 7.0) - 1.0).abs() < 1e-6);
    assert!((overall_fraction(PASS_1, -3.0) - 0.0).abs() < 1e-6);
    // An unknown label is treated as pass 1 (never over-reports).
    assert!(overall_fraction("???", 1.0) <= 0.5);
}

/// A registered host sink receives the same ticks the borrowed `Progress`
/// sink does, and clearing it stops delivery. Serialized against the other
/// sink test by running both through one `#[test]` (the registry is
/// process-global).
#[test]
fn registered_progress_sink_receives_ticks_until_cleared() {
    use super::{set_progress_sink, PASS_1, PASS_2};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TICKS: AtomicUsize = AtomicUsize::new(0);
    static SAW_PASS_2: AtomicUsize = AtomicUsize::new(0);

    fn sink(pass: &'static str, _fraction: f32) {
        TICKS.fetch_add(1, Ordering::Relaxed);
        if pass == PASS_2 {
            SAW_PASS_2.fetch_add(1, Ordering::Relaxed);
        }
        assert!(pass == PASS_1 || pass == PASS_2, "unexpected pass label");
    }

    set_progress_sink(Some(sink));
    let mut img = noisy_scene(32, 24, 0.02);
    apply(&mut img, 50.0, super::active_progress());
    set_progress_sink(None);
    let engaged = TICKS.load(Ordering::Relaxed);
    assert!(engaged > 0, "registered sink must receive ticks");
    assert!(SAW_PASS_2.load(Ordering::Relaxed) > 0, "pass 2 must report");

    // Cleared: a second run adds nothing.
    let mut img2 = noisy_scene(32, 24, 0.02);
    apply(&mut img2, 50.0, super::active_progress());
    assert_eq!(
        TICKS.load(Ordering::Relaxed),
        engaged,
        "a cleared sink must receive no further ticks"
    );
}

#[test]
fn every_strength_cleans_flat_noise_substantially() {
    // NOTE: flat-region residual variance is deliberately NOT monotone in
    // strength — the spec-mandated high-frequency re-injection scales
    // with strength (§ 3.2 "against plastic skin"), so at high strengths
    // a controlled fraction of the original HF texture returns. The
    // contract is that EVERY engaged strength removes the bulk of the
    // flat-field noise.
    let base = noisy_scene(64, 48, 0.02);
    let v0 = region_variance(&base, 36, 60, luma);
    for &s in &[25.0f32, 50.0, 100.0] {
        let mut img = clone_img(&base);
        apply(&mut img, s, None);
        let v = region_variance(&img, 36, 60, luma);
        assert!(
            v < 0.10 * v0,
            "strength {} should remove >90% of flat noise variance: {} vs {}",
            s,
            v,
            v0
        );
    }
}
