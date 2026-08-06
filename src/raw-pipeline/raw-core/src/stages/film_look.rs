//! `film_look` — display-referred film-emulation stage (epic #2683).
//!
//! Runs on `DisplayLinearRec2020` (post-AgX, pre-gamut-matrix — the same
//! stage position [`crate::stages::grain`] occupies), applying a baked
//! film-print LUT ([`FilmLut`], Task 1) in the "encoded sRGB lattice"
//! domain a `.mlut` is built in, then blending the result back into the
//! display-linear working space by `strength`.
//!
//! ## Per-pixel chain
//!
//! ```text
//! original  = px                                     // display-linear Rec.2020
//! s_lin     = M_REC2020_TO_SRGB · original            // linear sRGB (can exceed [0,1])
//! enc       = clamp(srgb_gamma(s_lin), 0, 1)          // lattice domain — encoded sRGB
//! f_enc     = tetra_sample(lut, enc)                  // the baked film print
//! f_lin     = srgb_degamma(f_enc)                     // back to linear sRGB
//! f_2020    = M_SRGB_TO_REC2020 · f_lin                // back to Rec.2020 primaries
//! t         = clamp(strength / 100, 0, 1)
//! output    = original + (f_2020 − original) · t      // blend toward the film arm
//! ```
//!
//! ## Clamp semantics
//!
//! A `.mlut` lattice is baked over `[0, 1]^3` encoded sRGB — the same
//! domain a real film-print characteristic curve is defined on. A working
//! pixel can legitimately sit outside that cube (AgX highlight roll-off
//! can round-trip a hair over 1.0; a caller could also hand this stage a
//! not-yet-clamped buffer, as the `strength_zero`/`out_of_gamut` tests
//! below do on purpose): the encode step clamps into the lattice domain
//! before sampling, and [`tetra_sample`] clamps again internally, so an
//! out-of-gamut channel blends toward the **clamped** film arm, never an
//! extrapolated one. `original` itself is never clipped — only the LUT
//! lookup's input is.
//!
//! ## Tetrahedral, not trilinear (#1737)
//!
//! [`tetra_sample`] is the same six-tetrahedron decomposition documented
//! on `film::tetra_sample` and its `residual_lut.wgsl` cousin — chosen
//! because trilinear interpolation of a saturated film-print grid produces
//! visible facet banding on smooth gradients near primary/secondary hues.
//! The barycentric split shares this stage's cross-platform parity
//! contract: Task 7 pins a WGSL twin of this stage to 1e-4.
//!
//! ## Identity short-circuit
//!
//! `strength <= 0.0` returns without touching a pixel — bit-identical to
//! the pre-`film_look` baseline, matching every other blend-strength
//! stage in this crate ([`crate::stages::grain::apply`], `dehaze`, …).

use crate::color::matrices::{M_REC2020_TO_SRGB, M_SRGB_TO_REC2020};
use crate::film::{tetra_sample, FilmLut};
use crate::image::{ColorSpace, Image};
use crate::view::encode::{srgb_degamma, srgb_gamma};

/// Apply a baked film-print LUT to a `DisplayLinearRec2020` buffer,
/// blending toward the film result by `strength` (0..100 nominal; values
/// outside are clamped in the per-pixel blend). `strength <= 0.0` is a
/// bit-identical no-op — the buffer is never touched.
pub fn apply(img: &mut Image, lut: &FilmLut, strength: f32) {
    img.assert_space(ColorSpace::DisplayLinearRec2020);
    if strength <= 0.0 {
        return;
    }
    let t = (strength / 100.0).clamp(0.0, 1.0);
    for p in &mut img.pixels {
        *p = apply_pixel(*p, lut, t);
    }
}

/// The per-pixel chain documented in the module doc above. Pulled out of
/// [`apply`] so it stays a single, explicit block of arithmetic — the
/// same shape Task 7's WGSL port has to mirror.
#[inline]
fn apply_pixel(original: [f32; 3], lut: &FilmLut, t: f32) -> [f32; 3] {
    let s_lin = M_REC2020_TO_SRGB.mul_vec(original);
    let enc = [
        srgb_gamma(s_lin[0]).clamp(0.0, 1.0),
        srgb_gamma(s_lin[1]).clamp(0.0, 1.0),
        srgb_gamma(s_lin[2]).clamp(0.0, 1.0),
    ];
    let f_enc = tetra_sample(lut.size, &lut.data, enc);
    let f_lin = [
        srgb_degamma(f_enc[0]),
        srgb_degamma(f_enc[1]),
        srgb_degamma(f_enc[2]),
    ];
    let f_2020 = M_SRGB_TO_REC2020.mul_vec(f_lin);
    [
        original[0] + (f_2020[0] - original[0]) * t,
        original[1] + (f_2020[1] - original[1]) * t,
        original[2] + (f_2020[2] - original[2]) * t,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Identity lattice: node (r,g,b) stores (r,g,b)/(n-1) — sampling it
    /// reproduces the input. Duplicated from `film.rs`'s own (private)
    /// test helper — that one isn't visible outside its module.
    fn identity_lattice(n: usize) -> FilmLut {
        let denom = (n - 1) as f32;
        let mut data = vec![0.0f32; n * n * n * 3];
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let i = ((b * n + g) * n + r) * 3;
                    data[i] = r as f32 / denom;
                    data[i + 1] = g as f32 / denom;
                    data[i + 2] = b as f32 / denom;
                }
            }
        }
        FilmLut { size: n, data }
    }

    /// A deliberately non-identity, non-monochrome lattice: node (r,g,b)
    /// stores a fixed channel-rotating, rescaled function of its own
    /// indices — enough to make `f_2020` diverge meaningfully from
    /// `original` without needing any particular photographic meaning.
    fn synthetic_lattice(n: usize) -> FilmLut {
        let denom = (n - 1) as f32;
        let mut data = vec![0.0f32; n * n * n * 3];
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let (rf, gf, bf) = (r as f32 / denom, g as f32 / denom, b as f32 / denom);
                    let i = ((b * n + g) * n + r) * 3;
                    data[i] = (gf * 0.6 + 0.2).clamp(0.0, 1.0);
                    data[i + 1] = (bf * 0.5 + 0.3).clamp(0.0, 1.0);
                    data[i + 2] = (rf * 0.4 + 0.1).clamp(0.0, 1.0);
                }
            }
        }
        FilmLut { size: n, data }
    }

    /// Every node stores `(l, l, l)` — a monochrome ("black & white film")
    /// lattice. `l` tracks the node's own average index, so the lattice
    /// still varies across the cube (exercising every `tetra_sample`
    /// barycentric branch) rather than being a single flat plateau.
    fn bw_lattice(n: usize) -> FilmLut {
        let denom = (3 * (n - 1)) as f32;
        let mut data = vec![0.0f32; n * n * n * 3];
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let l = (r + g + b) as f32 / denom;
                    let i = ((b * n + g) * n + r) * 3;
                    data[i] = l;
                    data[i + 1] = l;
                    data[i + 2] = l;
                }
            }
        }
        FilmLut { size: n, data }
    }

    /// Deterministic pseudo-random f32 stream (xorshift32) — this crate
    /// carries no `rand` dependency, and determinism is desirable for a
    /// reproducible test anyway. Range widened past `[0, 1]` on purpose to
    /// cover overshoot/undershoot pixels.
    fn xorshift_pixels(seed: u32, count: usize) -> Vec<[f32; 3]> {
        let mut state = seed | 1;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state as f32 / u32::MAX as f32) * 1.6 - 0.3 // ⊂ [-0.3, 1.3]
        };
        (0..count).map(|_| [next(), next(), next()]).collect()
    }

    fn image_from_pixels(w: u32, h: u32, pixels: Vec<[f32; 3]>) -> Image {
        Image {
            width: w,
            height: h,
            pixels,
            space: ColorSpace::DisplayLinearRec2020,
        }
    }

    #[test]
    fn strength_zero_is_bit_exact_noop() {
        let pixels = xorshift_pixels(0xC0FF_EE01, 64);
        let mut img = image_from_pixels(8, 8, pixels.clone());
        let lut = identity_lattice(5);
        apply(&mut img, &lut, 0.0);
        for (got, orig) in img.pixels.iter().zip(pixels.iter()) {
            for c in 0..3 {
                assert_eq!(
                    got[c].to_bits(),
                    orig[c].to_bits(),
                    "strength 0.0 must be a bit-exact no-op"
                );
            }
        }
    }

    #[test]
    fn identity_lattice_at_full_strength_is_noop_within_1e6_for_in_gamut() {
        // Pixels chosen so the post-matrix sRGB triple lands in [0, 1]^3
        // ("in-gamut" per the module doc's clamp semantics), so the
        // encode/decode round-trip through the identity lattice loses no
        // signal to clamping. 33 nodes/axis (k/32 spacing) matches a
        // realistic baked `.mlut` grid size — every node value is exact in
        // f16, so this also stands in for a real decode_mlut round-trip.
        let inputs: [[f32; 3]; 5] = [
            [0.5, 0.5, 0.5],
            [0.3, 0.4, 0.5],
            [0.6, 0.55, 0.5],
            [0.2, 0.25, 0.22],
            [0.7, 0.6, 0.65],
        ];
        let lut = identity_lattice(33);
        for input in inputs {
            let s_lin = M_REC2020_TO_SRGB.mul_vec(input);
            for c in 0..3 {
                assert!(
                    (0.0..=1.0).contains(&s_lin[c]),
                    "test setup: {input:?} maps post-matrix to {s_lin:?}, not in-gamut"
                );
            }
            let mut img = image_from_pixels(1, 1, vec![input]);
            apply(&mut img, &lut, 100.0);
            for c in 0..3 {
                assert!(
                    (img.pixels[0][c] - input[c]).abs() < 1e-6,
                    "identity lattice at full strength must be a no-op: {input:?} -> {:?}",
                    img.pixels[0]
                );
            }
        }
    }

    #[test]
    fn strength_is_linear_in_display_linear_domain() {
        let lut = synthetic_lattice(5);
        let input = [0.6f32, 0.35, 0.5];

        let mut img0 = image_from_pixels(1, 1, vec![input]);
        apply(&mut img0, &lut, 0.0);
        let mut img100 = image_from_pixels(1, 1, vec![input]);
        apply(&mut img100, &lut, 100.0);
        let mut img50 = image_from_pixels(1, 1, vec![input]);
        apply(&mut img50, &lut, 50.0);

        for c in 0..3 {
            let expected = 0.5 * (img0.pixels[0][c] + img100.pixels[0][c]);
            assert!(
                (img50.pixels[0][c] - expected).abs() < 1e-6,
                "channel {c}: out50 {} != midpoint(out0, out100) {expected}",
                img50.pixels[0][c]
            );
        }
    }

    #[test]
    fn bw_lattice_yields_r_eq_g_eq_b() {
        // Colored (non-neutral) input, deliberately dark: the sRGB<->
        // Rec.2020 matrix pair is only accurate to ~1e-4 relative (see
        // `matrices::tests::rec2020_to_srgb_preserves_white`'s own 1e-3
        // budget) — its rows don't sum to EXACTLY 1, so a mid-brightness
        // achromatic `f_lin` would pick up a few 1e-5 of channel imbalance
        // after the final Rec.2020 matrix. Staying dark keeps that
        // residual well clear of this test's 1e-6 bar while still
        // exercising a genuinely colored (non-equal-channel) input
        // through every stage of the chain.
        let input = [0.003f32, 0.0012, 0.002];
        let lut = bw_lattice(5);
        let mut img = image_from_pixels(1, 1, vec![input]);
        apply(&mut img, &lut, 100.0);
        let out = img.pixels[0];
        assert!((out[0] - out[1]).abs() < 1e-6, "R != G: {out:?}");
        assert!((out[1] - out[2]).abs() < 1e-6, "G != B: {out:?}");
    }

    #[test]
    fn out_of_gamut_input_blends_toward_clamped_film_arm_only() {
        let input = [1.4f32, 0.5, 0.3];
        let lut = identity_lattice(5);

        // strength 0: bitwise unchanged.
        let mut img0 = image_from_pixels(1, 1, vec![input]);
        apply(&mut img0, &lut, 0.0);
        for c in 0..3 {
            assert_eq!(img0.pixels[0][c].to_bits(), input[c].to_bits());
        }

        // Independently assemble the "clamped film arm" from the same
        // primitives `apply` uses, so this isn't tautological against the
        // stage's own private helper.
        let s_lin = M_REC2020_TO_SRGB.mul_vec(input);
        assert!(
            s_lin[0] > 1.0,
            "test setup: s_lin[0] = {} must exceed 1.0 for this to exercise the clamp",
            s_lin[0]
        );
        let enc = [
            srgb_gamma(s_lin[0]).clamp(0.0, 1.0),
            srgb_gamma(s_lin[1]).clamp(0.0, 1.0),
            srgb_gamma(s_lin[2]).clamp(0.0, 1.0),
        ];
        assert!(
            (enc[0] - 1.0).abs() < 1e-6,
            "an over-range channel must saturate to enc ~= 1.0, got {}",
            enc[0]
        );
        let f_enc = tetra_sample(lut.size, &lut.data, enc);
        let f_lin = [
            srgb_degamma(f_enc[0]),
            srgb_degamma(f_enc[1]),
            srgb_degamma(f_enc[2]),
        ];
        let film_arm = M_SRGB_TO_REC2020.mul_vec(f_lin);

        // strength 100: output equals the film arm exactly.
        let mut img100 = image_from_pixels(1, 1, vec![input]);
        apply(&mut img100, &lut, 100.0);
        for c in 0..3 {
            assert!(
                (img100.pixels[0][c] - film_arm[c]).abs() < 1e-6,
                "channel {c}: {} != film arm {}",
                img100.pixels[0][c],
                film_arm[c]
            );
        }

        // strength 50: exact midpoint between original and the film arm.
        let mut img50 = image_from_pixels(1, 1, vec![input]);
        apply(&mut img50, &lut, 50.0);
        for c in 0..3 {
            let expected = 0.5 * (input[c] + film_arm[c]);
            assert!(
                (img50.pixels[0][c] - expected).abs() < 1e-6,
                "channel {c}: {} != midpoint {expected}",
                img50.pixels[0][c]
            );
        }
    }
}
