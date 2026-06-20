//! AgX view transform: scene-linear Rec.2020 → display-linear Rec.2020.
//! Spec § 3.6a.
//!
//! Post-#435: **Sobotka AgX with filmic hue restoration + Oklab gamut
//! compression**. The chain is:
//!
//!   inset matrix
//!     → ratio-preserving sigmoid (sigmoid applied to max(R,G,B), RGB
//!       scaled by sigmoid_norm / norm — hue invariant by construction)
//!     → outset matrix
//!     → Oklab hue-preserving gamut compression to [0, 1]^3
//!
//! The per-channel sigmoid + hard `clamp(0, 1)` form (pre-#435) drove
//! channels negative on saturated reds/blues/purples, surfaced as
//! magenta. The `luma_coupled_toe` band-aid that addressed the
//! symmetric problem in deep shadows is now retired — the ratio path
//! handles deep shadows naturally without a separate gate.
//!
//! The matrices, sigmoid coefficients, and LUT are derived by
//! `src/scripts/derive_agx_lut.py` and emitted as:
//!
//!   * `agx_lut.bin`    — 512 × f32 little-endian, embedded via
//!                        `include_bytes!` below.
//!   * `agx_coeffs.rs`  — `AGX_MIN_EV`, `AGX_MAX_EV`, `AGX_MID_GRAY`,
//!                        `AGX_X_PIVOT`, `AGX_Y_PIVOT`, `AGX_BASE_SLOPE`,
//!                        `AGX_TOE_POWER`, `AGX_SHOULDER_POWER`,
//!                        `AGX_INSET_MATRIX`, `AGX_OUTSET_MATRIX`,
//!                        `AGX_LUT_SIZE`, `AGX_VERSION`.
//!
//! The Apple side bundles a byte-identical copy of `agx_lut.bin` for
//! parity tests; the Web side compiles the same constants into a GLSL
//! shader. Cross-platform parity at 1e-4 per channel is a CI gate.

use crate::image::{ColorSpace, Image};
use rayon::prelude::*;

#[path = "agx_coeffs.rs"]
mod coeffs;
#[path = "agx_hue_restoration.rs"]
mod hue_restoration;
pub use coeffs::{
    AGX_BASE_SLOPE, AGX_INSET_MATRIX, AGX_LUT_SIZE, AGX_MAX_EV, AGX_MID_DISPLAY, AGX_MID_GRAY,
    AGX_MIN_EV, AGX_OUTSET_MATRIX, AGX_SHOULDER_POWER, AGX_TOE_POWER, AGX_VERSION, AGX_X_PIVOT,
    AGX_Y_PIVOT,
};
use hue_restoration::{norm_sigmoid_ratio, oklab_gamut_compress};

/// Embedded LUT bytes — 512 × f32 little-endian.
const AGX_LUT_BYTES: &[u8] = include_bytes!("agx_lut.bin");

/// Normalized log-domain position of scene-linear mid-gray. Contrast
/// modulation pivots around this point so the mid-gray anchor is stable.
///
/// `pub(crate)` so `view::agx_inverse` can undo the contrast-slope
/// modulation with the exact same pivot.
pub(crate) const MID_NORM: f32 = -AGX_MIN_EV / (AGX_MAX_EV - AGX_MIN_EV);

/// Parse `AGX_LUT_BYTES` into a `[f32; AGX_LUT_SIZE]` on first access.
///
/// `pub(crate)` so `view::agx_inverse` reverses the exact same monotone
/// sigmoid LUT (single source of truth — no duplicate parse).
pub(crate) fn lut() -> &'static [f32; AGX_LUT_SIZE] {
    static CELL: std::sync::OnceLock<[f32; AGX_LUT_SIZE]> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        assert_eq!(
            AGX_LUT_BYTES.len(),
            AGX_LUT_SIZE * 4,
            "agx_lut.bin size mismatch: expected {} bytes, got {}",
            AGX_LUT_SIZE * 4,
            AGX_LUT_BYTES.len()
        );
        let mut out = [0.0f32; AGX_LUT_SIZE];
        for (i, chunk) in AGX_LUT_BYTES.chunks_exact(4).enumerate() {
            out[i] = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        out
    })
}

/// Sample the AgX sigmoid LUT with linear interpolation at normalized-log
/// position `x`. Clamps outside [0, 1].
fn sample_lut(x: f32) -> f32 {
    let lut = lut();
    let x = x.clamp(0.0, 1.0);
    let idx = x * ((AGX_LUT_SIZE - 1) as f32);
    let i0 = idx.floor() as usize;
    let i1 = (i0 + 1).min(AGX_LUT_SIZE - 1);
    let f = idx - (i0 as f32);
    lut[i0] * (1.0 - f) + lut[i1] * f
}

/// Apply a 3×3 matrix to an RGB triple.
#[inline]
fn matrix_mul(m: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// Per-channel log2 encode + normalize to [0, 1]. Mirror of Sobotka
/// `open_domain_to_normalized_log2`. Pinned at the toe (`MIN_EV`) for
/// non-positive inputs.
#[inline]
fn log_encode(channel: f32) -> f32 {
    let floor = AGX_MID_GRAY * AGX_MIN_EV.exp2();
    let clamped = channel.max(floor);
    let log_v = (clamped / AGX_MID_GRAY).log2().clamp(AGX_MIN_EV, AGX_MAX_EV);
    (log_v - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV)
}

/// Apply AgX to a single pixel:
///
/// `slope` is 1.0 at `contrast=0`; positive contrast steepens, negative
/// softens. Slope pivots around `MID_NORM`. Per the #435 audit the
/// inner `.clamp(0.0, 1.0)` was removed from the contrast modulation —
/// `sample_lut` already clamps its input to `[0, 1]`, and the inner
/// clamp was posterising the toe/shoulder when `|contrast| > 0`.
///
/// The sigmoid is **applied in a ratio-preserving way** (norm = max of
/// inset RGB; sigmoid the norm once, scale RGB by sigmoid_norm / norm),
/// so hue survives the curve. The post-outset clamp is replaced with
/// Oklab hue-preserving gamut compression to keep saturated-primary
/// pixels in `[0, 1]^3` without producing magenta.
fn agx_pixel(scene: [f32; 3], slope: f32) -> [f32; 3] {
    // 1) Inset matrix: Rec.2020 → AgX-Base-Rec.2020 (per-channel desat).
    //    No pre-clamp: the ratio-preserving sigmoid below handles
    //    deep shadow uniformly without a luma gate (the old
    //    `luma_coupled_toe` is retired in #435).
    let inset = matrix_mul(&AGX_INSET_MATRIX, scene);

    // 2) Ratio-preserving sigmoid: sigmoid applied to max(R,G,B), the
    //    other channels ride the same scale. Hue invariant; replaces
    //    the per-channel form that produced magenta on saturated
    //    primaries.
    let sigmoid_curve = |x: f32| -> f32 {
        let norm = log_encode(x);
        let modulated = MID_NORM + (norm - MID_NORM) * slope;
        sample_lut(modulated)
    };
    let sig = norm_sigmoid_ratio(inset, sigmoid_curve);

    // 3) Outset matrix: AgX-Base-Rec.2020 → Rec.2020 (restores chroma).
    let out = matrix_mul(&AGX_OUTSET_MATRIX, sig);

    // 4) Hue-preserving gamut compression to [0, 1]^3. Most in-gamut
    //    pixels short-circuit; only saturated primaries pay the Oklab
    //    bisection cost.
    oklab_gamut_compress(out)
}

/// Apply AgX across the image. Input must be `SceneLinearRec2020`; output
/// space is `DisplayLinearRec2020`. `contrast` in [-100, +100]; 0 is the
/// reference Sobotka sigmoid.
pub fn apply(img: &mut Image, contrast: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    // Slope = 1 + (contrast/100) * 0.5. At +100 → 1.5×, at −100 → 0.5×.
    let slope = 1.0 + (contrast / 100.0) * 0.5;
    img.pixels.par_iter_mut().for_each(|p| {
        *p = agx_pixel(*p, slope);
    });
    img.space = ColorSpace::DisplayLinearRec2020;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lut_size_matches_declared_constant() {
        assert_eq!(lut().len(), AGX_LUT_SIZE);
    }

    #[test]
    fn lut_anchors_are_zero_and_near_one() {
        // Sobotka sigmoid evaluates to ~0 at x=0 and slightly below 1.0 at
        // x=1. The pipeline clamps post-outset; both endpoint anchors
        // should be in the expected range.
        let l = lut();
        assert!(l[0].abs() < 1e-3, "LUT[0] = {}", l[0]);
        assert!(
            l[AGX_LUT_SIZE - 1] >= 0.97 && l[AGX_LUT_SIZE - 1] <= 1.0,
            "LUT[last] = {}, expected in [0.97, 1.0]",
            l[AGX_LUT_SIZE - 1]
        );
    }

    #[test]
    fn lut_is_monotone_nondecreasing() {
        let l = lut();
        for i in 1..AGX_LUT_SIZE {
            assert!(
                l[i] >= l[i - 1] - 1e-6,
                "non-monotone at {}: {} → {}",
                i,
                l[i - 1],
                l[i]
            );
        }
    }

    #[test]
    fn lut_pivot_value_equals_y_pivot() {
        // Canonical Sobotka sigmoid: sigmoid(X_PIVOT) = Y_PIVOT = 0.18.
        // The LUT entry closest to AGX_X_PIVOT must land within
        // interpolation tolerance of AGX_Y_PIVOT.
        let l = lut();
        let pivot_norm = AGX_X_PIVOT;
        let idx = pivot_norm * ((AGX_LUT_SIZE - 1) as f32);
        let i0 = idx.floor() as usize;
        let i1 = (i0 + 1).min(AGX_LUT_SIZE - 1);
        let f = idx - (i0 as f32);
        let sampled = l[i0] * (1.0 - f) + l[i1] * f;
        assert!(
            (sampled - AGX_Y_PIVOT).abs() < 1e-4,
            "LUT @ X_PIVOT = {}, expected Y_PIVOT = {} (diff {})",
            sampled,
            AGX_Y_PIVOT,
            (sampled - AGX_Y_PIVOT).abs()
        );
    }

    #[test]
    fn inset_outset_row_sums_are_one() {
        // The structural guarantee that makes neutral grey-axis preservation
        // work. If either matrix's row sums drift away from 1, neutral
        // mid-gray no longer maps to neutral mid-gray.
        for row in &AGX_INSET_MATRIX {
            let s: f32 = row.iter().sum();
            assert!(
                (s - 1.0).abs() < 1e-6,
                "INSET row sum {} ≠ 1.0",
                s
            );
        }
        for row in &AGX_OUTSET_MATRIX {
            let s: f32 = row.iter().sum();
            assert!(
                (s - 1.0).abs() < 1e-6,
                "OUTSET row sum {} ≠ 1.0",
                s
            );
        }
    }

    #[test]
    fn inset_outset_are_numerical_inverses() {
        // Pure mathematical sanity: INSET @ OUTSET = I within fp tolerance.
        let mut product = [[0.0f32; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                let mut s = 0.0f32;
                for k in 0..3 {
                    s += AGX_INSET_MATRIX[i][k] * AGX_OUTSET_MATRIX[k][j];
                }
                product[i][j] = s;
            }
        }
        for i in 0..3 {
            for j in 0..3 {
                let expected = if i == j { 1.0 } else { 0.0 };
                assert!(
                    (product[i][j] - expected).abs() < 1e-5,
                    "INSET @ OUTSET[{},{}] = {}, expected {}",
                    i,
                    j,
                    product[i][j],
                    expected
                );
            }
        }
    }

    #[test]
    fn mid_gray_identity_preserved() {
        // The load-bearing #263 acceptance criterion: scene-linear neutral
        // 0.18 must land at display-linear 0.18 within 1e-3.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [AGX_MID_GRAY, AGX_MID_GRAY, AGX_MID_GRAY];
        apply(&mut img, 0.0);
        let p = img.pixels[0];
        for &c in &p {
            assert!(
                (c - AGX_MID_GRAY).abs() < 1e-3,
                "mid-gray identity broken: {} ≠ 0.18 (|Δ|={:.2e})",
                c,
                (c - AGX_MID_GRAY).abs()
            );
        }
    }

    #[test]
    fn mid_gray_anchor_preserved() {
        // Companion to `mid_gray_identity_preserved` — assert against the
        // declared anchor constant. With Y_PIVOT=0.18, AGX_MID_DISPLAY=0.18
        // by construction; both should agree under the full pipeline.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [AGX_MID_GRAY, AGX_MID_GRAY, AGX_MID_GRAY];
        apply(&mut img, 0.0);
        let p = img.pixels[0];
        assert!(
            (p[0] - AGX_MID_DISPLAY).abs() < 1e-3,
            "R = {}, expected near {} (AGX_MID_DISPLAY)",
            p[0],
            AGX_MID_DISPLAY
        );
    }

    #[test]
    fn huge_scene_values_map_below_or_equal_one() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [100.0, 50.0, 20.0];
        apply(&mut img, 0.0);
        for &c in &img.pixels[0] {
            assert!(c <= 1.0 + 1e-5 && c >= 0.0, "{} should be in [0, 1]", c);
        }
    }

    #[test]
    fn negative_inputs_clamp_to_toe() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [-0.3, 0.0, 0.1];
        apply(&mut img, 0.0);
        for &c in &img.pixels[0] {
            assert!(c.is_finite() && c >= 0.0 && c <= 1.0, "{} out of bounds", c);
        }
    }

    #[test]
    fn output_space_becomes_display_linear() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.18, 0.18, 0.18];
        apply(&mut img, 0.0);
        assert_eq!(img.space, ColorSpace::DisplayLinearRec2020);
    }

    #[test]
    fn positive_contrast_steepens_around_mid_gray() {
        let scene_bright = 0.5;
        let scene_dark = 0.05;

        let mut img = Image::new(2, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [scene_bright; 3];
        img.pixels[1] = [scene_dark; 3];
        apply(&mut img, 0.0);
        let (base_bright, base_dark) = (img.pixels[0][0], img.pixels[1][0]);

        let mut img2 = Image::new(2, 1, ColorSpace::SceneLinearRec2020);
        img2.pixels[0] = [scene_bright; 3];
        img2.pixels[1] = [scene_dark; 3];
        apply(&mut img2, 100.0);
        assert!(
            img2.pixels[0][0] > base_bright,
            "bright should go higher at +100: {} vs {}",
            img2.pixels[0][0],
            base_bright
        );
        assert!(
            img2.pixels[1][0] < base_dark,
            "dark should go lower at +100: {} vs {}",
            img2.pixels[1][0],
            base_dark
        );
    }

    #[test]
    fn saturated_highlight_reduces_in_spread() {
        // A scene with one channel way out of gamut (e.g., saturated red
        // specular at 20× mid-gray, green/blue at mid-gray). The inset
        // matrix bakes per-channel desat into the sigmoid input, so R rolls
        // off toward 1 while G/B sit below; the ratio-preserving sigmoid
        // (#435) and Oklab gamut compression keep the result hue-correct
        // and inside [0, 1]^3.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [20.0 * AGX_MID_GRAY, AGX_MID_GRAY, AGX_MID_GRAY];
        apply(&mut img, 0.0);
        let p = img.pixels[0];
        assert!(p[0] > p[1], "R < G: {} vs {}", p[0], p[1]);
        // After ratio-preserving sigmoid the spread can approach but cannot
        // exceed 1.0 (output is bounded in `[0, 1]`). The earlier 1−mid_gray
        // bound was a per-channel-sigmoid artefact and doesn't hold under
        // ratio-preservation; the load-bearing invariant is "stays in gamut",
        // which `lands_in_unit_box` and `gamut_compress_lands_in_unit_box`
        // already cover. Here we just confirm a real spread exists (the
        // pixel isn't flattened to neutral) and the output channels are
        // legal.
        for &c in &p {
            assert!(c >= 0.0 && c <= 1.0, "out of [0,1]: {}", c);
        }
        assert!(p[0] - p[1] > 0.05, "R-G spread collapsed: {} vs {}", p[0], p[1]);
    }

    #[test]
    fn neutral_axis_preserved_across_log_domain() {
        // The matrices have row-sums-of-1, so every neutral RGB input
        // (R=G=B) must produce a neutral RGB output. This is the load-
        // bearing structural property that makes mid-gray preserve.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        for scene in &[0.001f32, 0.01, 0.05, 0.18, 0.5, 1.0, 5.0] {
            img.pixels[0] = [*scene, *scene, *scene];
            apply(&mut img, 0.0);
            let p = img.pixels[0];
            // R, G, B should all match within fp tolerance.
            assert!(
                (p[0] - p[1]).abs() < 1e-4 && (p[1] - p[2]).abs() < 1e-4,
                "neutral input {} → non-neutral output {:?}",
                scene,
                p
            );
            // And output should stay in [0, 1].
            for &c in &p {
                assert!(c >= 0.0 && c <= 1.0, "out of [0,1]: {}", c);
            }
            // Reset color-space marker for the next iteration.
            img.space = ColorSpace::SceneLinearRec2020;
        }
    }

    #[test]
    fn deep_shadow_chroma_preserved_via_ratio_sigmoid() {
        // A pixel in deep shadow with a non-trivial R:G:B ratio. Pre-#435
        // the per-channel sigmoid + per-channel toe clamp could clip one
        // channel asymmetrically and produce magenta. The ratio-preserving
        // sigmoid scales R, G, B by the same factor (sigmoid(max)/max),
        // so the input chroma direction is preserved exactly.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        let floor = AGX_MID_GRAY * AGX_MIN_EV.exp2();
        let r = 0.005f32;
        let g = 0.001f32;
        let b = floor * 0.5; // intentionally below the per-channel toe floor
        img.pixels[0] = [r, g, b];
        apply(&mut img, 0.0);
        let p = img.pixels[0];
        // R should remain larger than G in display space — chroma preserved
        // through the INSET → ratio sigmoid → OUTSET round-trip.
        assert!(
            p[0] > p[1],
            "deep shadow chroma collapsed: R={} not > G={}",
            p[0],
            p[1]
        );
    }

    #[test]
    fn below_toe_luminance_collapses_to_neutral() {
        // Companion to `deep_shadow_chroma_preserved_*`: when luma itself
        // is below the toe (truly black pixel), all channels collapse to
        // the floor uniformly. No magenta in deep-deep shadow.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.0, 0.0, 0.0];
        apply(&mut img, 0.0);
        let p = img.pixels[0];
        // Pure black input must produce a neutral output (all three
        // channels equal). Mid-gray of zero through the pipeline can be
        // very slightly above zero from inset/outset rounding, but R, G,
        // and B must agree.
        assert!(
            (p[0] - p[1]).abs() < 1e-4 && (p[1] - p[2]).abs() < 1e-4,
            "zero input → non-neutral output {:?}",
            p
        );
    }

    /// LUT byte-equality between raw-core's embedded copy and the
    /// Apple SwiftPM-bundled mirror. Both are written by the same
    /// `derive_agx_lut.py --bin … --apple-bin …` invocation, so any
    /// divergence means the script wasn't re-run after a coefficient
    /// edit.
    #[test]
    fn lut_hash_matches_apple_bundle() {
        // Resolve the Apple-bundled LUT relative to CARGO_MANIFEST_DIR.
        // The file is COMMITTED (not a gitignored fixture), so absence is a
        // broken checkout — fail loudly rather than skip-pass (#1082).
        let apple_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apple/Packages/MapleCore/Sources/MapleCore/Metal/agx_lut.bin");
        assert!(
            apple_path.exists(),
            "Apple-bundled agx_lut.bin not found at {} — it is committed to the \
             repo, so this is a broken/partial checkout, not a missing fixture",
            apple_path.display()
        );
        let apple_bytes = std::fs::read(&apple_path)
            .unwrap_or_else(|e| panic!("read {} failed: {}", apple_path.display(), e));
        assert_eq!(
            apple_bytes.len(),
            AGX_LUT_BYTES.len(),
            "Apple-bundled LUT size {} differs from Rust LUT size {}",
            apple_bytes.len(),
            AGX_LUT_BYTES.len()
        );
        // Byte-equality is the parity gate; the LUT is a single source of
        // truth (derive_agx_lut.py emits both with --apple-bin).
        assert_eq!(
            apple_bytes.as_slice(),
            AGX_LUT_BYTES,
            "Apple-bundled agx_lut.bin diverges from Rust LUT. Re-run \
             `python3 src/scripts/derive_agx_lut.py --bin … --rs … --apple-bin …`."
        );
    }
}
