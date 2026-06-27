//! Shared Oklab gamut compression — bisect chroma at constant lightness
//! until a triple fits inside the `[0, 1]^3` display box, while keeping
//! hue invariant by construction.
//!
//! This is the algorithm shape used by:
//!
//! * **AgX post-outset compression** (#435 / `view/agx_hue_restoration.rs`):
//!   working space is **Rec.2020**, so callers pass
//!   `rec2020_to_oklab` / `oklab_to_rec2020`. (#435 currently inlines its
//!   own copy of the bisection; it can rebase onto
//!   [`compress_to_unit_cube_oklab`] for free with no algorithm drift.)
//! * **Rec.2020 → sRGB encode** (#438 / `view/encode.rs`): the matrix
//!   leaves the working triple in **linear sRGB**, so the encode path
//!   passes `srgb_linear_to_oklab` / `oklab_to_srgb_linear`. The bisection
//!   loop and unit-box test are identical; only the two transform
//!   functions differ.
//!
//! Keeping the loop in one place is the contract: future tunings (bisection
//! count, epsilon, in-gamut fast-path) apply to every site at once.

/// Start of the compression zone as a fraction of the hull chroma. Chroma
/// below `COMPRESS_THRESHOLD * hull` passes through untouched; chroma from
/// there outward is smoothly rolled off so it asymptotes to — but never
/// exceeds — the hull. This turns the pre-#1621 hard clip-to-hull (which
/// projected *every* out-of-gamut chroma onto the single hull value and
/// posterised saturated gradients) into an order-preserving soft compression.
pub const COMPRESS_THRESHOLD: f32 = 0.8;

/// Chroma at or below this is treated as neutral — nothing to compress.
const CHROMA_FLOOR: f32 = 1e-5;

/// Hue-preserving **soft** gamut compression toward the `[0, 1]^3` unit cube
/// via Oklab `(a, b)` scaling at constant `L` (#1621).
///
/// * `rgb` is the input triple in **whatever working space `to_oklab` /
///   `from_oklab` operate in** (Rec.2020 for the AgX caller, sRGB-linear
///   for the encode caller). The unit-box test is performed in the same
///   working space — out-of-gamut means out-of-`[0, 1]^3` in that space.
/// * `to_oklab` and `from_oklab` are the working-space ↔ Oklab transform
///   pair. They MUST be true round-trip inverses on the neutral axis
///   (`R = G = B in → R = G = B out` within ~1e-5).
///
/// Behaviour:
/// * **Neutral / below the knee** (chroma `≤ COMPRESS_THRESHOLD * hull`): the
///   input is returned **unmodified** — byte-identical to the pre-compression
///   path for the in-gamut core, and a perf fast-path (a single Oklab probe,
///   no bisection).
/// * **Near-boundary or out-of-gamut** (chroma `> COMPRESS_THRESHOLD * hull`):
///   the chroma is rolled off with a Reinhard soft-knee into `[knee, hull)`.
///   The mapping is **strictly increasing** in input chroma (distinct inputs
///   stay distinct — no plateau) and **bounded by the hull** (stays in gamut).
///   Hue is preserved by construction (uniform `a, b` scaling at constant `L`).
#[inline]
pub fn compress_to_unit_cube_oklab<F, G>(
    rgb: [f32; 3],
    to_oklab: F,
    from_oklab: G,
) -> [f32; 3]
where
    F: Fn([f32; 3]) -> [f32; 3],
    G: Fn([f32; 3]) -> [f32; 3],
{
    let lab = to_oklab(rgb);
    let l = lab[0];
    let a = lab[1];
    let b = lab[2];
    let c_in = (a * a + b * b).sqrt();

    // Neutral / near-neutral: no chroma to compress. Preserve the pre-#1621
    // byte-identity for in-gamut neutrals — the trailing clamp is a no-op on a
    // value already in [0, 1]; it only tidies fp wobble and scrubs non-finite
    // (#1088: a NaN here fails `c_in <= CHROMA_FLOOR` and is scrubbed below).
    if c_in <= CHROMA_FLOOR {
        return [
            clamp_unit_scrub_non_finite(rgb[0]),
            clamp_unit_scrub_non_finite(rgb[1]),
            clamp_unit_scrub_non_finite(rgb[2]),
        ];
    }

    // Scale the chroma (a, b) by `s` at constant L and hue.
    let scale_chroma = |s: f32| from_oklab([l, a * s, b * s]);

    // Cheap knee probe: if scaling chroma by 1/THRESHOLD still lands in gamut
    // then `c_in ≤ THRESHOLD * hull` — we are below the knee. Pass through
    // untouched (byte-identical inner core, and skips the bisection).
    if in_unit_box(scale_chroma(1.0 / COMPRESS_THRESHOLD)) {
        return rgb;
    }

    // Find the hull: the largest chroma scale whose triple is still in gamut.
    // s == 1 is the input; an in-gamut-near-boundary pixel's hull is at s > 1,
    // an out-of-gamut pixel's at s < 1.
    let s_hull = hull_scale(&scale_chroma);
    let hull = c_in * s_hull;
    if !hull.is_finite() || hull <= CHROMA_FLOOR {
        // Degenerate (e.g. extreme L where even the neutral axis is outside
        // the box) — fall back to a hard projection so we always emit a legal
        // pixel rather than divide by ~0 in the soft-knee.
        let out = scale_chroma(s_hull.max(0.0));
        return [
            clamp_unit_scrub_non_finite(out[0]),
            clamp_unit_scrub_non_finite(out[1]),
            clamp_unit_scrub_non_finite(out[2]),
        ];
    }

    // Reinhard soft-knee: compress chroma in [knee, ∞) into [knee, hull).
    // `x/(1+x)` is strictly increasing on [0, ∞) and asymptotes to 1, so the
    // output is order-preserving and strictly below the hull.
    let knee = COMPRESS_THRESHOLD * hull;
    let c_out = if c_in <= knee {
        c_in
    } else {
        let x = (c_in - knee) / (hull - knee);
        knee + (hull - knee) * (x / (1.0 + x))
    };
    let out = scale_chroma(c_out / c_in);
    [
        clamp_unit_scrub_non_finite(out[0]),
        clamp_unit_scrub_non_finite(out[1]),
        clamp_unit_scrub_non_finite(out[2]),
    ]
}

/// Largest chroma scale `s ≥ 0` for which `scaled(s)` is inside the unit cube,
/// found by bracketing then 24-iteration bisection (~6e-8 precision on the
/// scale, well below 8-bit quantisation). `scaled(s)` maps a chroma scale to a
/// candidate triple at constant L and hue.
#[inline]
fn hull_scale<S: Fn(f32) -> [f32; 3]>(scaled: &S) -> f32 {
    let in_at = |s: f32| in_unit_box(scaled(s));
    let (mut lo, mut hi) = if in_at(1.0) {
        // In gamut at the input chroma — grow the scale until we exit the box.
        let mut s = 1.0f32;
        let mut steps = 0;
        while in_at(s) && steps < 16 {
            s *= 2.0;
            steps += 1;
        }
        if in_at(s) {
            // Never exited within the cap — effectively unbounded; no
            // meaningful compression to apply.
            return s;
        }
        (s * 0.5, s) // lo: last in-gamut, hi: first out-of-gamut
    } else {
        // Out of gamut at the input chroma — the hull is in [0, 1].
        (0.0, 1.0)
    };
    for _ in 0..24 {
        let mid = 0.5 * (lo + hi);
        if in_at(mid) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

/// `clamp(0, 1)` that maps non-finite values to 0.0 — Rust's `f32::clamp`
/// returns NaN for NaN input (#1088). Inf could only arise here from
/// broken upstream math (not "very bright"), so it scrubs to 0.0 too,
/// matching the FFI pack-endcap convention in `pipeline::finite_or_zero`.
#[inline]
pub(crate) fn clamp_unit_scrub_non_finite(v: f32) -> f32 {
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// In-gamut predicate with a small fp-edge epsilon so values like
/// `1.0 + 1e-7` (fp error on the matrix multiply) don't trigger the
/// expensive compression path.
#[inline]
fn in_unit_box(rgb: [f32; 3]) -> bool {
    const EPS_HI: f32 = 1.0 + 1e-5;
    const EPS_LO: f32 = -1e-5;
    rgb[0] >= EPS_LO
        && rgb[0] <= EPS_HI
        && rgb[1] >= EPS_LO
        && rgb[1] <= EPS_HI
        && rgb[2] >= EPS_LO
        && rgb[2] <= EPS_HI
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::oklab::{
        oklab_to_rec2020, oklab_to_srgb_linear, rec2020_to_oklab, srgb_linear_to_oklab,
    };

    fn chroma(lab: [f32; 3]) -> f32 {
        (lab[1] * lab[1] + lab[2] * lab[2]).sqrt()
    }

    /// #1621 stability sweep — the load-bearing correctness gate. Across a grid
    /// of hues (every 15°) and lightnesses, a constant-hue chroma ramp through
    /// the soft compressor must satisfy ALL of:
    ///   (a) output stays in `[0, 1]^3` (in gamut),
    ///   (b) chroma is never INCREASED (compression only reduces),
    ///   (c) hue is preserved (< 2°),
    ///   (d) output chroma is monotonic non-decreasing (no inversion),
    ///   (e) the mapping never amplifies — output chroma step ≤ input step,
    ///   (f) where the ramp leaves gamut, the output does NOT plateau.
    /// This is the broad guard the original clip-to-hull would have failed at:
    /// the clip satisfies (b)/(d)/(e) but FAILS (f) — the whole out-of-gamut
    /// span collapses onto one hull color.
    ///
    /// `STEP_TOL` (1.5e-3) absorbs a sub-8-bit-LSB floor: the *test* re-measures
    /// chroma via `srgb_linear_to_oklab(out)`, whose `cbrt` amplifies fp error
    /// on dark, deeply-out-of-gamut colors (where the ramp has already
    /// converged toward the boundary — correct behavior). Verified the actual
    /// output there is u8-stable (e.g. L=0.25/30° deep tail is all u8 [70,2,0]).
    /// The real anti-banding signal is (f), the OOG *span*, which is ~100× this
    /// floor, so the loose per-step tolerance cannot hide a plateau.
    #[test]
    fn soft_compress_invariants_across_hue_and_lightness() {
        use std::f32::consts::{PI, TAU};
        const N: usize = 200;
        const C_MAX: f32 = 0.45; // past the sRGB hull for essentially every hue
        const STEP_TOL: f32 = 1.5e-3; // sub-8-bit-LSB chroma-remeasurement floor
        let in_step = C_MAX / ((N - 1) as f32);

        for li in 0..4 {
            let l = 0.25 + 0.20 * li as f32; // 0.25, 0.45, 0.65, 0.85
            let mut hue_deg = 0.0f32;
            while hue_deg < 360.0 {
                let h = hue_deg.to_radians();
                let (sin_h, cos_h) = h.sin_cos();

                let mut prev_out_c = -1.0f32;
                let mut oog = 0usize;
                let mut first_oog_c = -1.0f32;
                let mut last_oog_c = -1.0f32;

                for i in 0..N {
                    let c_in = C_MAX * (i as f32) / ((N - 1) as f32);
                    let lin = oklab_to_srgb_linear([l, c_in * cos_h, c_in * sin_h]);
                    let was_oog = !in_unit_box(lin);
                    let out = compress_to_unit_cube_oklab(
                        lin,
                        srgb_linear_to_oklab,
                        oklab_to_srgb_linear,
                    );

                    // (a) in gamut
                    assert!(
                        out.iter().all(|&v| (-1e-4..=1.0 + 1e-4).contains(&v)),
                        "(a) out of gamut L={l} hue={hue_deg} c_in={c_in}: {out:?}"
                    );

                    let lab_out = srgb_linear_to_oklab(out);
                    let c_out = chroma(lab_out);

                    // (b) chroma never increases
                    assert!(
                        c_out <= c_in + STEP_TOL,
                        "(b) chroma increased L={l} hue={hue_deg}: {c_in} -> {c_out}"
                    );

                    // (c) hue preserved (skip near-neutral where angle is noisy)
                    if c_in > 2e-3 && c_out > 2e-3 {
                        let h_out = lab_out[2].atan2(lab_out[1]);
                        let mut d = (h_out - h).abs();
                        if d > PI {
                            d = TAU - d;
                        }
                        assert!(
                            d.to_degrees() < 2.0,
                            "(c) hue drift {}° L={l} hue={hue_deg} c_in={c_in}",
                            d.to_degrees()
                        );
                    }

                    // (d) monotonic + (e) non-amplifying
                    if prev_out_c >= 0.0 {
                        assert!(
                            c_out >= prev_out_c - STEP_TOL,
                            "(d) non-monotonic L={l} hue={hue_deg}: {prev_out_c} -> {c_out}"
                        );
                        assert!(
                            c_out - prev_out_c <= in_step + STEP_TOL,
                            "(e) amplified step L={l} hue={hue_deg}: d_out={} > d_in={in_step}",
                            c_out - prev_out_c
                        );
                    }
                    prev_out_c = c_out;

                    if was_oog {
                        if first_oog_c < 0.0 {
                            first_oog_c = c_out;
                        }
                        last_oog_c = c_out;
                        oog += 1;
                    }
                }

                // (f) no plateau across the out-of-gamut span — the real
                // anti-banding gate. Threshold is RELATIVE to the hull
                // (`last_oog_c` ≈ hull): the soft-knee maps the whole OOG region
                // into roughly the top 10% below the hull, so the span scales
                // with the hull (small for dark, small-gamut hues; larger for
                // bright). A real collapse (the old clip) drives the span to ~0
                // regardless of hull, so a 5%-of-hull floor catches it with
                // margin while passing legitimately narrow dark-color ranges.
                if oog > 20 {
                    let floor = 0.05 * last_oog_c.max(1e-4);
                    assert!(
                        last_oog_c - first_oog_c > floor,
                        "(f) plateau on OOG span L={l} hue={hue_deg}: \
                         {first_oog_c}..{last_oog_c} (need span > {floor})"
                    );
                }

                hue_deg += 15.0;
            }
        }
    }

    #[test]
    fn srgb_in_gamut_core_passes_through_byte_identical() {
        // The in-gamut *core* — neutral and low/moderate chroma, comfortably
        // below the soft-knee (`COMPRESS_THRESHOLD * hull`) — must be returned
        // bit-for-bit. Post-#1621 only colors *near* the boundary are touched;
        // the bulk of every image is byte-identical (and skips the bisection).
        let cases = [
            [0.0f32, 0.0, 0.0],
            [0.18, 0.18, 0.18],
            [0.5, 0.5, 0.5],
            [1.0, 1.0, 1.0],
            [0.4, 0.3, 0.2],
            [0.5, 0.45, 0.4],
        ];
        for p in cases {
            let out =
                compress_to_unit_cube_oklab(p, srgb_linear_to_oklab, oklab_to_srgb_linear);
            assert_eq!(out[0].to_bits(), p[0].to_bits(), "R drift on {:?}", p);
            assert_eq!(out[1].to_bits(), p[1].to_bits(), "G drift on {:?}", p);
            assert_eq!(out[2].to_bits(), p[2].to_bits(), "B drift on {:?}", p);
        }
    }

    #[test]
    fn srgb_near_boundary_in_gamut_is_softly_compressed() {
        // #1621: the whole point of soft compression is that *in-gamut* colors
        // near the boundary are gently rolled off (rather than left untouched
        // until a hard knee at the hull). Each saturated-but-legal input must
        // come out with REDUCED chroma, still in gamut, and the same hue.
        let cases = [
            [0.9f32, 0.05, 0.05], // saturated red
            [0.05, 0.9, 0.05],    // saturated green
            [0.05, 0.05, 0.9],    // saturated blue
        ];
        for p in cases {
            // Precondition: input is genuinely in-gamut.
            assert!(p.iter().all(|&v| (0.0..=1.0).contains(&v)), "setup {:?}", p);
            let out =
                compress_to_unit_cube_oklab(p, srgb_linear_to_oklab, oklab_to_srgb_linear);
            let lab_in = srgb_linear_to_oklab(p);
            let lab_out = srgb_linear_to_oklab(out);
            // Chroma reduced (the soft-knee pulled it toward the hull from
            // below) but not collapsed to neutral.
            assert!(
                chroma(lab_out) < chroma(lab_in) && chroma(lab_out) > 0.5 * chroma(lab_in),
                "near-boundary chroma not softly compressed on {:?}: {} -> {}",
                p,
                chroma(lab_in),
                chroma(lab_out)
            );
            // Still in gamut.
            assert!(out.iter().all(|&v| (0.0..=1.0).contains(&v)), "out of gamut {:?}", out);
            // Hue preserved (<2°) — uniform (a, b) scaling.
            let h_in = lab_in[2].atan2(lab_in[1]).to_degrees();
            let h_out = lab_out[2].atan2(lab_out[1]).to_degrees();
            let mut d = (h_out - h_in).abs();
            if d > 180.0 {
                d = 360.0 - d;
            }
            assert!(d < 2.0, "hue drift {}° on {:?}", d, p);
        }
    }

    /// #1621 — banding regression guard. A constant-lightness, constant-hue
    /// chroma ramp that crosses the gamut boundary must come out
    /// **monotonically increasing** in chroma: distinct input chroma must map
    /// to distinct output chroma. The pre-#1621 hard clip-to-hull collapses the
    /// entire out-of-gamut span onto a single hull chroma (a flat plateau),
    /// which posterizes saturated gradients (foliage/sky/skin). Soft gamut
    /// compression must keep the ramp ordered. (Promoted from the
    /// `gamut-clip-demo` example repro.)
    #[test]
    fn out_of_gamut_chroma_ramp_stays_monotonic_no_plateau() {
        // Seed a saturated foliage yellow-green; sweep chroma at fixed L + hue.
        let seed = [0.30f32, 0.85, 0.04];
        let seed_lab = srgb_linear_to_oklab(seed);
        let l = seed_lab[0];
        let hue = seed_lab[2].atan2(seed_lab[1]);
        let (sin_h, cos_h) = hue.sin_cos();
        let c_max = chroma(seed_lab) * 2.4;

        const N: usize = 256;
        let mut out_chroma = Vec::with_capacity(N);
        let mut oog_idx = Vec::with_capacity(N);
        for i in 0..N {
            let c_in = c_max * (i as f32) / ((N - 1) as f32);
            let lin = oklab_to_srgb_linear([l, c_in * cos_h, c_in * sin_h]);
            let oog = !lin.iter().all(|&v| (-1e-5..=1.0 + 1e-5).contains(&v));
            let out =
                compress_to_unit_cube_oklab(lin, srgb_linear_to_oklab, oklab_to_srgb_linear);
            out_chroma.push(chroma(srgb_linear_to_oklab(out)));
            if oog {
                oog_idx.push(i);
            }
        }
        assert!(
            oog_idx.len() > 20,
            "test setup: ramp should cross the gamut boundary; only {} OOG steps",
            oog_idx.len()
        );

        // No inversions anywhere along the ramp.
        for (i, w) in out_chroma.windows(2).enumerate() {
            assert!(
                w[1] >= w[0] - 1e-5,
                "output chroma inverted at step {}: {} -> {}",
                i,
                w[0],
                w[1]
            );
        }

        // The load-bearing anti-plateau gate: the out-of-gamut span must NOT
        // collapse to a single chroma. The hard clip maps every OOG step onto
        // the same hull chroma (span == 0) -> this fails. Soft compression
        // keeps distinct saturated inputs distinct.
        let first = *oog_idx.first().unwrap();
        let last = *oog_idx.last().unwrap();
        let span = out_chroma[last] - out_chroma[first];
        assert!(
            span > 0.01,
            "out-of-gamut chroma collapsed to a plateau (span {:.4}); distinct \
             saturated inputs map to the same color -> banding",
            span
        );
    }

    #[test]
    fn srgb_out_of_gamut_lands_in_unit_box() {
        // Saturated wide-gamut "red" projected post-matrix sits outside
        // [0, 1]^3 (negative G/B). The compressor must land it inside.
        let p = [1.4f32, -0.2, -0.1];
        let out = compress_to_unit_cube_oklab(p, srgb_linear_to_oklab, oklab_to_srgb_linear);
        for (i, c) in out.iter().enumerate() {
            assert!(
                *c >= 0.0 && *c <= 1.0,
                "channel {} out of [0, 1]: {} on input {:?}",
                i,
                c,
                p
            );
        }
    }

    #[test]
    fn srgb_out_of_gamut_preserves_hue_direction() {
        // Saturated red goes in, red dominance must remain (R > G, R > B).
        // Per-channel clipping would force the result toward magenta
        // (G stays at 0, B stays at 0, R clips to 1, hue rotates).
        let p = [1.4f32, -0.05, -0.1];
        let out = compress_to_unit_cube_oklab(p, srgb_linear_to_oklab, oklab_to_srgb_linear);
        assert!(
            out[0] > out[1] && out[0] > out[2],
            "red dominance lost: {:?}",
            out
        );
    }

    #[test]
    fn srgb_hue_angle_drift_under_2_degrees() {
        // The strict hue-preservation gate: convert input + output to
        // Oklab and confirm the (a, b) hue angle drifts < 2°. The
        // bisection scales `(a, b)` uniformly, so the angle should be
        // exact to fp precision — the 2° budget absorbs any sign-flip
        // edge cases from the matrix round-trip.
        let cases = [
            [1.4f32, -0.2, -0.1],   // red-dominant
            [-0.1, 1.3, -0.05],     // green-dominant
            [-0.05, -0.1, 1.5],     // blue-dominant
            [1.2, -0.05, 1.1],      // magenta (R+B)
        ];
        for p in cases {
            let lab_in = srgb_linear_to_oklab(p);
            let out =
                compress_to_unit_cube_oklab(p, srgb_linear_to_oklab, oklab_to_srgb_linear);
            let lab_out = srgb_linear_to_oklab(out);
            let h_in = lab_in[2].atan2(lab_in[1]).to_degrees();
            let h_out = lab_out[2].atan2(lab_out[1]).to_degrees();
            let mut diff = (h_out - h_in).abs();
            if diff > 180.0 {
                diff = 360.0 - diff;
            }
            assert!(
                diff < 2.0,
                "hue drift {}° on input {:?} (in={}°, out={}°)",
                diff,
                p,
                h_in,
                h_out
            );
        }
    }

    #[test]
    fn rec2020_caller_signature_compiles_and_runs() {
        // Smoke-test the other call site shape (Rec.2020 working space).
        // Confirms the API contract supports both AgX (#435 rebase) and
        // encode (#438) without per-call-site adapters.
        let p = [0.18f32, 0.18, 0.18];
        let out = compress_to_unit_cube_oklab(p, rec2020_to_oklab, oklab_to_rec2020);
        // In-gamut passes through.
        assert_eq!(out[0].to_bits(), p[0].to_bits());
    }

    /// #1088 — non-finite input must come out finite in [0, 1]. A NaN
    /// fails every `in_unit_box` comparison, so it always reaches the
    /// compression fallthrough — where the pre-fix `clamp(0.0, 1.0)`
    /// passed it straight through (Rust's `f32::clamp` returns NaN for
    /// NaN input) and into the display encode.
    #[test]
    fn non_finite_input_scrubs_to_finite_unit_range() {
        let cases: [[f32; 3]; 5] = [
            [f32::NAN, 0.5, 0.5],
            [0.5, f32::NAN, 0.5],
            [f32::NAN, f32::NAN, f32::NAN],
            [f32::INFINITY, 0.2, 0.2],
            [0.2, 0.2, f32::NEG_INFINITY],
        ];
        for p in cases {
            let out =
                compress_to_unit_cube_oklab(p, srgb_linear_to_oklab, oklab_to_srgb_linear);
            for (i, c) in out.iter().enumerate() {
                assert!(
                    c.is_finite() && (0.0..=1.0).contains(c),
                    "channel {} not finite-in-[0,1] for input {:?}: {}",
                    i,
                    p,
                    c
                );
            }
        }
    }
}
