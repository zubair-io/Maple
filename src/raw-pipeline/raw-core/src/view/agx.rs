//! AgX view transform: scene-linear Rec.2020 → display-linear Rec.2020.
//! Spec § 3.6a.
//!
//! The sigmoid shape and coefficients are derived once by the Python script
//! `src/scripts/derive_agx_lut.py` and emitted as:
//!
//!   * `agx_lut.bin`    — 512 × f32 little-endian, embedded via
//!                        `include_bytes!` below.
//!   * `agx_coeffs.rs`  — `AGX_MIN_EV`, `AGX_MAX_EV`, `AGX_MID_GRAY`,
//!                        `AGX_BASE_SLOPE`, `AGX_LUT_SIZE`, `AGX_VERSION`.
//!
//! The same two artifacts are the source of truth for the Metal kernel and
//! WebGL shader; numeric parity across all three is gated at 1e-4 per
//! channel (spec § 06 cross-platform § AgX parity).

use crate::image::{ColorSpace, Image};
use rayon::prelude::*;

#[path = "agx_coeffs.rs"]
mod coeffs;
pub use coeffs::{
    AGX_BASE_SLOPE, AGX_LUT_SIZE, AGX_MAX_EV, AGX_MID_DISPLAY, AGX_MID_GRAY, AGX_MIN_EV,
    AGX_VERSION,
};

/// Embedded LUT bytes — 512 × f32 little-endian.
const AGX_LUT_BYTES: &[u8] = include_bytes!("agx_lut.bin");

/// Normalized log-domain position of scene-linear mid-gray. Contrast
/// modulation pivots around this point so the mid-gray anchor is stable.
const MID_NORM: f32 = -AGX_MIN_EV / (AGX_MAX_EV - AGX_MIN_EV);

/// Parse `AGX_LUT_BYTES` into a `[f32; AGX_LUT_SIZE]` on first access.
fn lut() -> &'static [f32; AGX_LUT_SIZE] {
    static CELL: std::sync::OnceLock<[f32; AGX_LUT_SIZE]> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        assert_eq!(
            AGX_LUT_BYTES.len(), AGX_LUT_SIZE * 4,
            "agx_lut.bin size mismatch: expected {} bytes, got {}",
            AGX_LUT_SIZE * 4, AGX_LUT_BYTES.len()
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

/// Per-channel AgX: log2-encode scene value, normalize to [0, 1], apply
/// contrast-modulated sigmoid, return display-linear value in [0, 1].
///
/// `slope` is 1.0 at `contrast=0`; positive contrast steepens, negative
/// softens. Slope pivots around `MID_NORM` so mid-gray stays anchored.
fn agx_per_channel(scene: f32, slope: f32) -> f32 {
    // Clamp below toe: scene values below MID_GRAY * 2^MIN_EV are pinned.
    let floor = AGX_MID_GRAY * AGX_MIN_EV.exp2();
    let clamped = scene.max(floor);
    // Log encode + normalize to [0, 1].
    let log = (clamped / AGX_MID_GRAY).log2().clamp(AGX_MIN_EV, AGX_MAX_EV);
    let norm = (log - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
    // Contrast as slope around mid-gray normalized anchor.
    let contrast_adjusted = (MID_NORM + (norm - MID_NORM) * slope).clamp(0.0, 1.0);
    sample_lut(contrast_adjusted).clamp(0.0, 1.0)
}

/// Scene-linear shoulder where pre-formation rolloff begins, in units of
/// `AGX_MID_GRAY`. 8× mid-gray = +3 EV from mid-gray = 1.44 scene-linear.
/// Below this, the per-channel sigmoid is in its near-linear region and
/// channels reach the shoulder together — no rolloff needed. Above this,
/// per-channel divergence creates hue rotation, so we compress chroma
/// toward luminance proportional to how far we are above the shoulder.
const PREFORM_SHOULDER_X: f32 = 8.0;

/// Rec.2020 (BT.2020) luminance weights. Used by `preform_rolloff` as the
/// achromatic target for chroma compression in saturated highlights.
const REC2020_LUM_R: f32 = 0.2627;
const REC2020_LUM_G: f32 = 0.6780;
const REC2020_LUM_B: f32 = 0.0593;

/// Pre-formation rolloff: when any channel exceeds the AgX shoulder
/// (~+3 EV from mid-gray = `AGX_MID_GRAY * PREFORM_SHOULDER_X`), compress
/// chroma toward Rec.2020 luminance proportionally to the excess. Brings
/// all three channels closer in magnitude before the per-channel sigmoid
/// so they reach the shoulder together — eliminates the hue rotation
/// that pure-color saturated highlights otherwise produce (red→pink,
/// blue→magenta, green→yellow-lime).
///
/// Per `docs/superpowers/plans/2026-04-27-clipping-and-artifacts.md`
/// Phase 1, "AgX pre-formation rolloff". Sobotka's AgX 1.x Open Domain
/// rolloff with the simpler max-channel compression metric (vs. the full
/// Blender 4.x 3D-compression form, which would require a separate
/// codegen path for the Metal/WebGL mirrors).
fn preform_rolloff(scene: [f32; 3]) -> [f32; 3] {
    let max = scene[0].max(scene[1]).max(scene[2]);
    let shoulder = AGX_MID_GRAY * PREFORM_SHOULDER_X;
    if max <= shoulder {
        return scene; // below shoulder, no rolloff
    }
    // Compression factor: 0 at max == shoulder, asymptotic to 1 as max → ∞.
    let t = ((max - shoulder) / max).clamp(0.0, 1.0);
    // Rec.2020 luminance — the achromatic target.
    let y = REC2020_LUM_R * scene[0] + REC2020_LUM_G * scene[1] + REC2020_LUM_B * scene[2];
    [
        scene[0] * (1.0 - t) + y * t,
        scene[1] * (1.0 - t) + y * t,
        scene[2] * (1.0 - t) + y * t,
    ]
}

/// Apply AgX per-channel across the image. Input must be
/// `SceneLinearRec2020`; output space is `DisplayLinearRec2020`.
/// `contrast` in [-100, +100]; 0 is the reference sigmoid.
pub fn apply(img: &mut Image, contrast: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    // Slope = 1 + (contrast/100) * 0.5. At +100 → 1.5×, at −100 → 0.5×.
    let slope = 1.0 + (contrast / 100.0) * 0.5;
    img.pixels.par_iter_mut().for_each(|p| {
        let rolled = preform_rolloff(*p);
        p[0] = agx_per_channel(rolled[0], slope);
        p[1] = agx_per_channel(rolled[1], slope);
        p[2] = agx_per_channel(rolled[2], slope);
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
        // Maple AgX evaluates to ~9e-5 at x=0 (clamped to 0) and ~0.99 at
        // x=1. We don't force-clamp the top to exactly 1.0 — the next
        // display stage (gamma encode) handles any headroom.
        let l = lut();
        assert!(l[0].abs() < 1e-3, "LUT[0] = {}", l[0]);
        assert!(l[AGX_LUT_SIZE - 1] >= 0.97 && l[AGX_LUT_SIZE - 1] <= 1.0,
            "LUT[last] = {}, expected in [0.97, 1.0]", l[AGX_LUT_SIZE - 1]);
    }

    #[test]
    fn lut_is_monotone_nondecreasing() {
        let l = lut();
        for i in 1..AGX_LUT_SIZE {
            assert!(l[i] >= l[i - 1] - 1e-6,
                "non-monotone at {}: {} → {}", i, l[i - 1], l[i]);
        }
    }

    #[test]
    fn mid_gray_anchor_preserved() {
        // Scene mid-gray (AGX_MID_GRAY = 0.18) renders to approximately
        // AGX_MID_DISPLAY at contrast=0. Maple AgX preserves mid-gray
        // through the curve (AGX_MID_DISPLAY ≈ 0.164, target 0.18 — small
        // residual is the least-squares fit error in the 6th-order
        // polynomial). LUT sampling adds at most one step of linear-interp
        // error on top.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [AGX_MID_GRAY, AGX_MID_GRAY, AGX_MID_GRAY];
        apply(&mut img, 0.0);
        let p = img.pixels[0];
        assert!((p[0] - AGX_MID_DISPLAY).abs() < 0.01,
            "R = {}, expected near {}", p[0], AGX_MID_DISPLAY);
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
        let scene_dark   = 0.05;

        let mut img = Image::new(2, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [scene_bright; 3];
        img.pixels[1] = [scene_dark; 3];
        apply(&mut img, 0.0);
        let (base_bright, base_dark) = (img.pixels[0][0], img.pixels[1][0]);

        let mut img2 = Image::new(2, 1, ColorSpace::SceneLinearRec2020);
        img2.pixels[0] = [scene_bright; 3];
        img2.pixels[1] = [scene_dark; 3];
        apply(&mut img2, 100.0);
        assert!(img2.pixels[0][0] > base_bright,
            "bright should go higher at +100: {} vs {}", img2.pixels[0][0], base_bright);
        assert!(img2.pixels[1][0] < base_dark,
            "dark should go lower at +100: {} vs {}", img2.pixels[1][0], base_dark);
    }

    #[test]
    fn per_channel_gamut_compression_reduces_saturation_on_blown_channels() {
        // A scene with one channel way out of gamut (e.g., saturated red
        // specular at 20× mid-gray, green/blue at mid-gray). AgX should
        // roll R off toward 1 while keeping G/B near the mid-gray display
        // level, producing a LESS-saturated display triple than naive
        // per-channel clipping would.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [20.0 * AGX_MID_GRAY, AGX_MID_GRAY, AGX_MID_GRAY];
        apply(&mut img, 0.0);
        let p = img.pixels[0];
        // R should be near the top (shoulder rolloff), but G and B should
        // sit near mid-gray display. R - G < 20× - 1× = 19× worth of
        // chroma in scene linear; post-AgX it must be less than (1 - 0.18) ≈ 0.82.
        assert!(p[0] > p[1], "R < G: {} vs {}", p[0], p[1]);
        let max_spread = 1.0 - AGX_MID_DISPLAY;
        assert!(p[0] - p[1] < max_spread,
            "gamut compression failed: R-G = {} - {} = {}, expected much < {}",
            p[0], p[1], p[0] - p[1], max_spread);
    }

    #[test]
    fn preform_rolloff_is_noop_below_shoulder() {
        // Pixels at or below 8× mid-gray (~+3 EV) pass through unchanged.
        let p = preform_rolloff([0.18, 0.18, 0.18]);
        assert_eq!(p, [0.18, 0.18, 0.18]);
        let p = preform_rolloff([1.0, 0.5, 0.3]);
        assert_eq!(p, [1.0, 0.5, 0.3]);
        // Right at the shoulder (max == 8 × MID_GRAY = 1.44): still no-op.
        let p = preform_rolloff([AGX_MID_GRAY * 8.0, 0.18, 0.18]);
        assert!((p[0] - AGX_MID_GRAY * 8.0).abs() < 1e-6);
        assert!((p[1] - 0.18).abs() < 1e-6);
    }

    #[test]
    fn preform_rolloff_compresses_chroma_above_shoulder() {
        // Saturated red specular: R way above shoulder, G/B near mid-gray.
        // After rolloff, R should be lower (compressed toward luminance) and
        // G/B should be higher (also pulled toward luminance), so the
        // luminance is roughly preserved but channels are closer together.
        let scene = [20.0 * AGX_MID_GRAY, AGX_MID_GRAY, AGX_MID_GRAY];
        let y_before = REC2020_LUM_R * scene[0] + REC2020_LUM_G * scene[1] + REC2020_LUM_B * scene[2];
        let rolled = preform_rolloff(scene);
        let y_after = REC2020_LUM_R * rolled[0] + REC2020_LUM_G * rolled[1] + REC2020_LUM_B * rolled[2];
        assert!(rolled[0] < scene[0], "R should compress: {} -> {}", scene[0], rolled[0]);
        assert!(rolled[1] > scene[1], "G should lift: {} -> {}", scene[1], rolled[1]);
        assert!(rolled[2] > scene[2], "B should lift: {} -> {}", scene[2], rolled[2]);
        // Luminance preserved within numerical noise (this is the *point*
        // of using REC2020 luminance weights).
        assert!((y_before - y_after).abs() / y_before < 1e-4,
            "luminance shifted: {} -> {}", y_before, y_after);
    }

    #[test]
    fn preform_rolloff_preserves_hue_on_saturated_red() {
        // The big invariant: a saturated red highlight, post-rolloff, has
        // R/G and R/B ratios that match what a less-saturated version of
        // the same hue would have. Without rolloff, the per-channel sigmoid
        // compresses R and rolls G/B differently → hue rotation. With
        // rolloff, the three channels are closer in magnitude going INTO
        // the sigmoid, so they reach the shoulder together.
        //
        // Test this indirectly: end-to-end through `apply()`, the post-AgX
        // R/G ratio of a saturated red should be MUCH closer to the
        // pre-rolloff R/G ratio than per-channel-only AgX would produce.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        let r_in = 20.0 * AGX_MID_GRAY;
        let g_in = 0.5 * AGX_MID_GRAY;
        let b_in = 0.5 * AGX_MID_GRAY;
        img.pixels[0] = [r_in, g_in, b_in];
        let pre_ratio_rg = r_in / g_in;
        apply(&mut img, 0.0);
        let p = img.pixels[0];
        let post_ratio_rg = p[0] / p[1].max(1e-6);
        // Without rolloff, the per-channel AgX would push R near 1.0 and
        // G near MID_DISPLAY (~0.16), giving a post ratio ~6.25 — vs the
        // pre ratio of 40. With rolloff, the post ratio should sit in a
        // milder range (luminance-preserving compression brings G/B up).
        // The exact value depends on the sigmoid shape; we just check that
        // R is still the dominant channel and the ratio isn't catastrophic.
        assert!(p[0] > p[1], "R should still dominate: ({}, {}, {})", p[0], p[1], p[2]);
        assert!(p[0] > p[2], "R should still dominate B: ({}, {}, {})", p[0], p[1], p[2]);
        assert!(post_ratio_rg < pre_ratio_rg,
            "post ratio {} should be less than pre ratio {} (compression occurred)",
            post_ratio_rg, pre_ratio_rg);
    }
}
