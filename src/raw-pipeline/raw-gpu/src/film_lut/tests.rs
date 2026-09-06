//! Parity tests for the film-look WGSL kernel (epic #2683, Task 7).
//!
//! Split out of `film_lut.rs` for the 600-LOC budget. Included via
//! `#[path = "film_lut/tests.rs"] mod tests;` so it reaches the parent's
//! private helpers through `super::*`.
//!
//! The headless GPU kernel is gated DIRECTLY against the real
//! `raw_core::stages::film_look::apply` (the ticket's parity oracle), via the
//! test-only `raw-core` dev-dep, at `< 1e-4`. The load-bearing case is a
//! NON-identity, pseudo-random lattice on a pixel spread that includes
//! out-of-`[0, 1]` values (AgX highlight roll-off can round-trip a hair over
//! 1.0; the film_look module docs call this out explicitly) — an identity
//! lattice alone would be a false green (a passthrough grid returns its input
//! regardless of whether the tetrahedral corner blend is correct).

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;
use raw_core::film::FilmLut;
use raw_core::image::{ColorSpace, Image};

/// Deterministic pseudo-random f32 stream (xorshift32) — no `rand` dep, and
/// determinism is desirable for a reproducible test anyway.
fn xorshift_stream(seed: u32) -> impl FnMut() -> f32 {
    let mut state = seed | 1;
    move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (state as f32) * (1.0 / 4_294_967_295.0)
    }
}

/// A deterministic 64×64 DisplayLinearRec2020 RGBA test buffer. Range widened
/// past `[0, 1]` on purpose (`⊂ [-0.3, 1.3]`) — the module docs' clamp-
/// semantics contract (AgX highlight roll-off, an unclamped caller buffer)
/// specifically exercises the encode step's clamp-into-lattice-domain path.
fn pcg_display_linear_64x64() -> (Vec<f32>, u32, u32) {
    let (w, h) = (64u32, 64u32);
    let mut next = xorshift_stream(0xC0FF_EE01);
    let mut v = Vec::with_capacity((w * h * 4) as usize);
    for _ in 0..(w * h) {
        let r = next() * 1.6 - 0.3;
        let g = next() * 1.6 - 0.3;
        let b = next() * 1.6 - 0.3;
        v.extend_from_slice(&[r, g, b, 1.0]);
    }
    (v, w, h)
}

/// A deterministic pseudo-random 33³ film LUT — a real `.mlut`-shaped grid
/// (33 nodes/axis matches a realistic baked-LUT size), NOT an identity
/// passthrough, so the tetrahedral interpolation runs off the identity
/// diagonal genuinely (the non-vacuous-gate requirement).
fn random_film_lut(size: usize, seed: u32) -> FilmLut {
    let mut next = xorshift_stream(seed);
    let data: Vec<f32> = (0..(size * size * size * 3)).map(|_| next()).collect();
    FilmLut { size, data }
}

/// Run the REAL `raw_core::stages::film_look::apply` on an interleaved RGBA
/// buffer, returning a full RGBA buffer (alpha carried through). THE
/// reference — the actual raw-core film-look stage, not a reimplementation.
fn raw_core_film_look(input: &[f32], w: u32, h: u32, lut: &FilmLut, strength: f32) -> Vec<f32> {
    let mut img = Image::new(w, h, ColorSpace::DisplayLinearRec2020);
    for (i, chunk) in input.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::film_look::apply(&mut img, lut, strength);
    let mut out = Vec::with_capacity(input.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], input[i * 4 + 3]]);
    }
    out
}

fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0_f32, f32::max)
}

/// THE PARITY GATE: the WGSL film-look kernel matches
/// `raw_core::stages::film_look::apply` within 1e-4, at strength 100 AND a
/// partial strength (37) — proving the blend-toward-the-film-arm lerp, not
/// just the full-strength substitution.
#[test]
fn wgsl_film_lut_matches_raw_core_stage_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = pcg_display_linear_64x64();
    let lut = random_film_lut(33, 0x5EED_1337);

    for &strength in &[100.0_f32, 37.0] {
        let reference = raw_core_film_look(&input, w, h, &lut, strength);

        let img = GpuImage::upload(&ctx, &input, w, h);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&FilmLutPass {
            size: lut.size as u32,
            strength,
            data: lut.data.clone().into(),
        }]);

        let max_diff = max_abs_diff(&reference, &gpu);
        eprintln!("PARITY vs raw-core film_look strength={strength}: max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "film_look(strength={strength}): GPU vs raw-core stage max abs diff {max_diff} \
             exceeds 1e-4"
        );
    }
}

/// Pin the local CPU oracle (`apply_film_lut`) to the real
/// `film_look::apply` too, so the transcribed matrix/gamma constants can't
/// silently drift from the canonical source.
#[test]
fn local_oracle_matches_raw_core_stage_within_1e_4() {
    let (input, w, h) = pcg_display_linear_64x64();
    let lut = random_film_lut(17, 0xABCD_EF01);

    for &strength in &[100.0_f32, 37.0] {
        let reference = raw_core_film_look(&input, w, h, &lut, strength);
        let mut local = input.clone();
        apply_film_lut(&mut local, &lut.data, lut.size, strength);
        let max_diff = max_abs_diff(&reference, &local);
        assert!(
            max_diff < 1e-4,
            "film_look(strength={strength}): local oracle vs raw-core diff {max_diff} \
             exceeds 1e-4"
        );
    }
}

/// Self-contained fallback gate: the WGSL kernel matches the local CPU
/// oracle within 1e-4 (no raw-core dep needed to run). Fast, dependency-free
/// signal alongside the raw-core gate; mirrors the residual_lut / vibrance
/// precedent.
#[test]
fn wgsl_film_lut_matches_cpu_oracle_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = pcg_display_linear_64x64();
    let lut = random_film_lut(9, 0x1234_5678);

    for &strength in &[100.0_f32, 37.0] {
        let mut cpu = input.clone();
        apply_film_lut(&mut cpu, &lut.data, lut.size, strength);

        let img = GpuImage::upload(&ctx, &input, w, h);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&FilmLutPass {
            size: lut.size as u32,
            strength,
            data: lut.data.clone().into(),
        }]);

        let max_diff = max_abs_diff(&cpu, &gpu);
        eprintln!("PARITY [strength={strength}]: GPU vs CPU oracle max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "[strength={strength}]: GPU vs CPU max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// `strength <= 0.0` is a bit-identical no-op on the GPU too, matching
/// `film_look::apply`'s own short-circuit contract (the module doc's
/// "Identity short-circuit" section).
#[test]
fn strength_zero_is_bit_exact_noop_on_gpu() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = pcg_display_linear_64x64();
    let lut = random_film_lut(9, 0x0BAD_F00D);

    let img = GpuImage::upload(&ctx, &input, w, h);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&FilmLutPass {
        size: lut.size as u32,
        strength: 0.0,
        data: lut.data.clone().into(),
    }]);

    assert_eq!(
        gpu, input,
        "strength 0.0 must be a bit-exact no-op on the GPU"
    );
}

/// Alpha is carried through untouched by the GPU kernel (the film LUT
/// touches only RGB), mirroring the per-stage alpha-passthrough contract.
#[test]
fn gpu_alpha_passthrough() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = pcg_display_linear_64x64();
    let lut = random_film_lut(9, 0xFACE_FEED);

    let img = GpuImage::upload(&ctx, &input, w, h);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&FilmLutPass {
        size: lut.size as u32,
        strength: 80.0,
        data: lut.data.clone().into(),
    }]);

    for (i, chunk) in input.chunks_exact(4).enumerate() {
        assert_eq!(
            gpu[i * 4 + 3],
            chunk[3],
            "alpha changed at pixel {i}: {} -> {}",
            chunk[3],
            gpu[i * 4 + 3]
        );
    }
}
