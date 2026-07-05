use crate::{
    color::oklab::{oklab_to_rec2020, rec2020_to_oklab},
    image::{ColorSpace, Image},
};

/// Oklab-based chroma scale per spec § 02 ("chroma-preserving saturation in a
/// gamut-invariant space, not CIColorControls").
///
/// `saturation` in [-100, +100]; 0 is identity. `-100` fully desaturates to
/// achromatic; `+100` doubles chroma. Unlike vibrance, saturation has no
/// low-chroma boost and no skin-tone protection — it scales all chroma uniformly.
///
/// Gamut handling (#269): after the chroma scale, if any Rec.2020 channel
/// would go negative the chroma is soft-compressed back along the same hue
/// line (Oklab atan2 angle preserved) toward the gamut hull. The
/// compression is a smooth Reinhard-style knee that engages at
/// `GAMUT_KNEE_FRACTION` of the per-pixel hull chroma, so a slider sweep
/// has no derivative jump at the boundary. Saturation < 0 (scale < 1)
/// never increases chroma and skips the gamut check.
pub fn apply(img: &mut Image, saturation: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if saturation.abs() < 1e-3 {
        return;
    }
    let scale = 1.0 + saturation / 100.0;

    for p in &mut img.pixels {
        *p = apply_pixel(*p, scale);
    }
}

/// Fraction of the per-pixel gamut-hull chroma at which the soft-compression
/// knee starts. Below this threshold the scaled chroma passes through
/// unchanged; above it the curve asymptotes smoothly to `C_hull`. 0.8 keeps
/// 80% of the in-gamut range linear and leaves a 20% soft shoulder.
const GAMUT_KNEE_FRACTION: f32 = 0.8;

/// Bisection iteration count for the gamut-hull search. 24 iterations on a
/// `C_target ≤ 1.0`-scale interval produces a relative precision well below
/// 1e-6 — comfortably under the 1e-4 cross-platform parity gate even if the
/// WebGL mirror uses a slightly different float reduction order.
///
/// Was briefly lowered to 12 (Jul 1, #1681–#1687 batch), which halves the
/// bisect resolution to ~2.4e-4 relative — above the cross-platform parity
/// contract this doc-comment states. At 12, a CPU-vs-GPU predicate flip on a
/// hull-boundary pixel leaves an O(2⁻¹²) chroma residual that the dehaze/NR/
/// sharpen suffix amplifies past 1 LSB (the #1769 row-alignment gate red).
/// Restored to 24 (#1769); the GPU twins (`saturation.wgsl` / `vibrance.wgsl`
/// / `hsl.wgsl` + their raw-gpu oracles) carry the SAME count.
const GAMUT_BISECT_ITERS: usize = 24;

/// Tolerance used when deciding whether the bisected chroma is "in gamut".
/// We require every Rec.2020 channel to be ≥ -GAMUT_EPS. Tighter than this
/// and float noise in the Oklab round-trip flips the predicate per-iteration.
const GAMUT_EPS: f32 = 1e-5;

/// Per-pixel saturation with gamut-aware soft-compression on the chroma axis.
/// Pulled out of `apply` so the unit tests can exercise the per-pixel
/// behaviour without building an `Image`.
#[inline]
pub(crate) fn apply_pixel(rgb: [f32; 3], scale: f32) -> [f32; 3] {
    let lab = rec2020_to_oklab(rgb);
    let (l, a, b) = (lab[0], lab[1], lab[2]);

    // Near-neutral pixel: chroma is zero in any direction, scaling is a
    // no-op (and the hue unit vector below would be ill-defined).
    let c_in = (a * a + b * b).sqrt();
    if c_in < 1e-6 {
        return rgb;
    }

    // Target chroma after uniform Oklab scaling. Hue (atan2(b, a)) is the
    // same as the input by construction.
    let c_target = c_in * scale;
    let a_hat = a / c_in;
    let b_hat = b / c_in;

    // For desaturation (scale ≤ 1) or when we're shrinking chroma below
    // the input, gamut never tightens — moving toward neutral can't push
    // any Rec.2020 channel further negative than the original pixel.
    if scale <= 1.0 {
        return oklab_to_rec2020([l, a_hat * c_target, b_hat * c_target]);
    }

    // Fast path: scaled target stays in gamut. Most pixels at +saturation
    // are far enough from the hull that this branch wins.
    let lab_target = [l, a_hat * c_target, b_hat * c_target];
    let rgb_target = oklab_to_rec2020(lab_target);
    if rgb_target[0].min(rgb_target[1]).min(rgb_target[2]) >= -GAMUT_EPS {
        return rgb_target;
    }

    // Bisect for the largest chroma along this (L, hue) ray whose
    // Rec.2020 projection has min channel ≥ -GAMUT_EPS. Lower bracket
    // starts at 0 — neutral is always in gamut (L itself may be > 1 in
    // HDR, but a neutral grey of any luminance is always in [0, ∞)). Upper
    // bracket is `c_target` (we already know that's out).
    let c_hull = bisect_gamut_hull(l, a_hat, b_hat, c_target);

    // If the input chroma is already past the hull (e.g. vibrance pushed
    // the pixel just out of gamut before saturation ran), don't pull it
    // back below where it started — the saturation slider has to be
    // monotone-non-decreasing in chroma for scale ≥ 1. Using `c_in`
    // directly (not `min(c_in, c_hull)`) is what enforces "never reduce
    // chroma below the input": if `c_in > c_hull` the floor stays at
    // `c_in`, and since `soft_compress(..) ≤ c_hull < c_in` the `.max`
    // pins `c_out` to `c_in`.
    let c_floor = c_in;

    let c_out = soft_compress(c_target, c_hull).max(c_floor);
    oklab_to_rec2020([l, a_hat * c_out, b_hat * c_out])
}

/// Reinhard-style smooth compression along a 1D scalar. Below `c_thresh`
/// (= `GAMUT_KNEE_FRACTION * c_hull`) the curve is the identity. Above the
/// knee it asymptotes smoothly to `c_hull` as `c_target → ∞`, with C¹
/// continuity at the knee.
///
/// Form: let `d = c_target - c_thresh` and `d_max = c_hull - c_thresh`; the
/// compressed excess is `d_max * (d / (d + d_max))`, i.e. the standard
/// rational Reinhard knee with f(0) = 0, f'(0) = 1, f → d_max as d → ∞.
#[inline]
fn soft_compress(c_target: f32, c_hull: f32) -> f32 {
    let c_thresh = GAMUT_KNEE_FRACTION * c_hull;
    if c_target <= c_thresh {
        return c_target;
    }
    let d = c_target - c_thresh;
    let d_max = c_hull - c_thresh;
    if d_max <= 0.0 {
        return c_hull;
    }
    c_thresh + d_max * (d / (d + d_max))
}

/// Bisect along the (L, a_hat, b_hat) ray in Oklab for the largest chroma
/// whose Rec.2020 projection has all channels ≥ -GAMUT_EPS. Assumes the
/// caller has verified that `c_high` is out of gamut and that `c_low = 0`
/// is in gamut (true for any L, since L=L, a=b=0 maps to an achromatic
/// grey in Rec.2020).
#[inline]
fn bisect_gamut_hull(l: f32, a_hat: f32, b_hat: f32, c_high: f32) -> f32 {
    let mut lo = 0.0f32;
    let mut hi = c_high;
    for _ in 0..GAMUT_BISECT_ITERS {
        let mid = 0.5 * (lo + hi);
        let rgb = oklab_to_rec2020([l, a_hat * mid, b_hat * mid]);
        let min_c = rgb[0].min(rgb[1]).min(rgb[2]);
        if min_c >= -GAMUT_EPS {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::oklab::rec2020_to_oklab;

    /// Hue angle in Oklab (degrees, wrapped to [-180, 180]).
    fn hue_deg(rgb: [f32; 3]) -> f32 {
        let lab = rec2020_to_oklab(rgb);
        lab[2].atan2(lab[1]) * 180.0 / std::f32::consts::PI
    }

    /// Smallest absolute angular distance in degrees between two hues,
    /// accounting for the [-180, 180] wrap.
    fn hue_delta_deg(a: f32, b: f32) -> f32 {
        let mut d = (a - b).abs();
        if d > 180.0 {
            d = 360.0 - d;
        }
        d
    }

    #[test]
    fn identity_at_zero() {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.4, 0.3, 0.5];
        }
        let before = img.pixels.clone();
        apply(&mut img, 0.0);
        for (a, b) in img.pixels.iter().zip(before.iter()) {
            // The < 1e-3 short-circuit guarantees bit-identical output.
            assert_eq!(a[0], b[0]);
            assert_eq!(a[1], b[1]);
            assert_eq!(a[2], b[2]);
        }
    }

    #[test]
    fn minus_100_makes_achromatic() {
        // Saturation -100 → scale=0 → a=0, b=0 → neutral gray.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.8, 0.1, 0.1];
        apply(&mut img, -100.0);
        // After full desaturation, R == G == B (within float tolerance).
        let p = img.pixels[0];
        assert!((p[0] - p[1]).abs() < 0.05, "R {} vs G {}", p[0], p[1]);
        assert!((p[1] - p[2]).abs() < 0.05, "G {} vs B {}", p[1], p[2]);
    }

    #[test]
    fn plus_100_doubles_chroma_when_in_gamut() {
        // Use a low-chroma red whose doubled chroma is still well inside
        // Rec.2020, so no gamut compression engages and the chroma ratio
        // is exactly the slider scale (2×). After the gamut work the
        // earlier `[0.5, 0.3, 0.3]` no longer satisfies this — its 2×
        // chroma hits the knee.
        let rgb = [0.4, 0.35, 0.35];
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = rgb;

        let before = rec2020_to_oklab(rgb);
        let before_chroma = (before[1] * before[1] + before[2] * before[2]).sqrt();
        apply(&mut img, 100.0);
        let after = rec2020_to_oklab(img.pixels[0]);
        let after_chroma = (after[1] * after[1] + after[2] * after[2]).sqrt();
        assert!(
            (after_chroma / before_chroma - 2.0).abs() < 1e-3,
            "chroma ratio {} should be ~2.0",
            after_chroma / before_chroma
        );
    }

    #[test]
    fn preserves_scene_headroom() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [5.0, 3.0, 1.5];
        apply(&mut img, 50.0);
        for &c in &img.pixels[0] {
            assert!(c.is_finite(), "non-finite after saturation: {}", c);
        }
    }

    // ── #269: gamut-aware soft-clip ─────────────────────────────────────

    /// A near-gamut-boundary Rec.2020 color whose naive 2× Oklab chroma
    /// scale drives at least one channel negative. After `apply` no scene
    /// channel goes below `-GAMUT_EPS`.
    #[test]
    fn plus_100_keeps_all_channels_non_negative() {
        // Highly-saturated primaries-ish colors. Pre-gamut-clip, +100
        // routinely produced channels in the -0.05 .. -0.15 range here.
        let cases: [[f32; 3]; 5] = [
            [0.9, 0.05, 0.05], // near-Rec.2020 red
            [0.05, 0.9, 0.05], // near-Rec.2020 green
            [0.05, 0.05, 0.9], // near-Rec.2020 blue
            [0.7, 0.7, 0.05],  // saturated yellow
            [4.0, 0.5, 0.5],   // HDR-headroom saturated red
        ];
        for rgb in cases {
            let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
            img.pixels[0] = rgb;
            apply(&mut img, 100.0);
            let p = img.pixels[0];
            let min = p[0].min(p[1]).min(p[2]);
            assert!(
                min >= -GAMUT_EPS,
                "input {:?} → output {:?} has min channel {} < -{}",
                rgb,
                p,
                min,
                GAMUT_EPS
            );
            for c in p {
                assert!(c.is_finite(), "non-finite channel in {:?}", p);
            }
        }
    }

    /// Hue (Oklab atan2 angle) must be preserved through gamut compression.
    /// We're scaling the (a, b) vector uniformly so this is true by
    /// construction; the test guards against accidental asymmetric
    /// compression of a vs b in a future refactor.
    #[test]
    fn plus_100_preserves_hue_within_two_degrees() {
        let cases: [[f32; 3]; 5] = [
            [0.9, 0.05, 0.05],
            [0.05, 0.9, 0.05],
            [0.05, 0.05, 0.9],
            [0.7, 0.7, 0.05],
            [4.0, 0.5, 0.5],
        ];
        for rgb in cases {
            let h_in = hue_deg(rgb);
            let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
            img.pixels[0] = rgb;
            apply(&mut img, 100.0);
            let h_out = hue_deg(img.pixels[0]);
            let d = hue_delta_deg(h_in, h_out);
            assert!(
                d < 2.0,
                "input {:?} hue {} → output {:?} hue {} drifted by {}°",
                rgb,
                h_in,
                img.pixels[0],
                h_out,
                d
            );
        }
    }

    /// Gamut soft-clip must not *decrease* chroma when saturation is
    /// positive — the slider is monotone non-decreasing in chroma for
    /// scale ≥ 1. (Decreasing would mean +saturation desaturates the
    /// pixel; visibly wrong.)
    #[test]
    fn plus_100_never_decreases_chroma_on_in_gamut_inputs() {
        let cases: [[f32; 3]; 4] = [
            [0.9, 0.05, 0.05],
            [0.05, 0.9, 0.05],
            [0.05, 0.05, 0.9],
            [0.7, 0.7, 0.05],
        ];
        for rgb in cases {
            let before = rec2020_to_oklab(rgb);
            let c_before = (before[1] * before[1] + before[2] * before[2]).sqrt();
            let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
            img.pixels[0] = rgb;
            apply(&mut img, 100.0);
            let after = rec2020_to_oklab(img.pixels[0]);
            let c_after = (after[1] * after[1] + after[2] * after[2]).sqrt();
            assert!(
                c_after >= c_before - 1e-4,
                "+saturation reduced chroma: {:?} c={} → {:?} c={}",
                rgb,
                c_before,
                img.pixels[0],
                c_after
            );
        }
    }

    /// Sanity: the bisection's gamut predicate is consistent — the
    /// returned chroma `c_hull` projects to a Rec.2020 triple whose
    /// minimum channel is in [-GAMUT_EPS, +GAMUT_EPS] (i.e. right at
    /// the hull, not far inside it).
    #[test]
    fn bisect_lands_on_hull() {
        // L from mid-gray, hue toward red.
        let l = 0.5;
        let a_hat = 1.0;
        let b_hat = 0.0;
        // Pick a c_high we know is out of gamut for this hue / L.
        let c = bisect_gamut_hull(l, a_hat, b_hat, 0.5);
        let rgb = oklab_to_rec2020([l, a_hat * c, b_hat * c]);
        let min_c = rgb[0].min(rgb[1]).min(rgb[2]);
        // After 24 iterations the bisection bracket is ~3e-8; the min
        // channel at the recovered `c` should be flush against zero (within
        // GAMUT_EPS slack one side, and tighter on the other since `lo`
        // was the in-gamut tracker).
        assert!(min_c >= -GAMUT_EPS, "bisect overshot: min = {}", min_c);
        assert!(
            min_c.abs() < 1e-3,
            "bisect didn't reach the hull: min = {} (expected near 0)",
            min_c
        );
    }

    /// Soft-compress is identity below the knee and continuous through it.
    #[test]
    fn soft_compress_identity_below_knee() {
        let c_hull = 1.0;
        let c_thresh = GAMUT_KNEE_FRACTION * c_hull;
        // Identity for c_target ≤ c_thresh.
        assert_eq!(soft_compress(0.0, c_hull), 0.0);
        assert!((soft_compress(0.5 * c_thresh, c_hull) - 0.5 * c_thresh).abs() < 1e-7);
        // C¹ continuity at the knee: f(c_thresh) == c_thresh and f'(c_thresh⁺)
        // approaches 1 from below.
        assert!((soft_compress(c_thresh, c_hull) - c_thresh).abs() < 1e-7);
        let eps = 1e-4;
        let slope = (soft_compress(c_thresh + eps, c_hull) - c_thresh) / eps;
        assert!(
            slope > 0.99 && slope <= 1.0001,
            "soft_compress slope at knee = {}, expected ~1",
            slope
        );
    }

    /// Diagnostic-only: prints the pre/post-gamut-clip (min, max) channels at
    /// +saturation=100 across a handful of highly-saturated inputs. Not a
    /// CI gate — only there to capture the PR body's before/after table.
    /// Marked `#[ignore]` so it stays out of the default `cargo test` run
    /// (no runtime cost, no stderr noise in CI). Run on demand with
    /// `cargo test … print_gamut_clip_before_after -- --ignored --nocapture`.
    #[test]
    #[ignore = "diagnostic-only; prints a table for the PR body, not a CI gate"]
    fn print_gamut_clip_before_after() {
        let cases: [[f32; 3]; 5] = [
            [0.9, 0.05, 0.05],
            [0.05, 0.9, 0.05],
            [0.05, 0.05, 0.9],
            [0.7, 0.7, 0.05],
            [4.0, 0.5, 0.5],
        ];
        eprintln!(
            "{:<24} | {:^21} | {:^21}",
            "input rgb", "before (uniform 2×)", "after (gamut-clip)",
        );
        eprintln!(
            "{:<24} | {:<10} {:<10} | {:<10} {:<10}",
            "", "min", "max", "min", "max",
        );
        for rgb in cases {
            // "Before" = the old behaviour (uniform Oklab chroma scale, no
            // gamut check). Mirror the pre-#269 math exactly.
            let lab = rec2020_to_oklab(rgb);
            let scale = 2.0;
            let old =
                crate::color::oklab::oklab_to_rec2020([lab[0], lab[1] * scale, lab[2] * scale]);
            let old_min = old[0].min(old[1]).min(old[2]);
            let old_max = old[0].max(old[1]).max(old[2]);

            let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
            img.pixels[0] = rgb;
            apply(&mut img, 100.0);
            let new_min = img.pixels[0][0].min(img.pixels[0][1]).min(img.pixels[0][2]);
            let new_max = img.pixels[0][0].max(img.pixels[0][1]).max(img.pixels[0][2]);

            eprintln!(
                "[{:>4.2},{:>4.2},{:>4.2}]       | {:>+10.4} {:>+10.4} | {:>+10.4} {:>+10.4}",
                rgb[0], rgb[1], rgb[2], old_min, old_max, new_min, new_max,
            );
        }
    }

    /// Soft-compress asymptotes to c_hull and never exceeds it.
    #[test]
    fn soft_compress_asymptotes_to_hull() {
        let c_hull = 1.0;
        for &c_target in &[1.0, 1.5, 2.0, 10.0, 100.0] {
            let out = soft_compress(c_target, c_hull);
            assert!(
                out <= c_hull + 1e-6,
                "soft_compress({}, {}) = {} > c_hull",
                c_target,
                c_hull,
                out
            );
            assert!(
                out > GAMUT_KNEE_FRACTION * c_hull,
                "soft_compress({}, {}) = {} below knee",
                c_target,
                c_hull,
                out
            );
        }
        // Very large c_target → essentially c_hull.
        assert!((soft_compress(1e6, c_hull) - c_hull).abs() < 1e-3);
    }
}
