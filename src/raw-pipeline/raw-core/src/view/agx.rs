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

/// Apply AgX per-channel across the image. Input must be
/// `SceneLinearRec2020`; output space is `DisplayLinearRec2020`.
/// `contrast` in [-100, +100]; 0 is the reference sigmoid.
pub fn apply(img: &mut Image, contrast: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    // Slope = 1 + (contrast/100) * 0.5. At +100 → 1.5×, at −100 → 0.5×.
    let slope = 1.0 + (contrast / 100.0) * 0.5;
    for p in &mut img.pixels {
        p[0] = agx_per_channel(p[0], slope);
        p[1] = agx_per_channel(p[1], slope);
        p[2] = agx_per_channel(p[2], slope);
    }
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
        // Blender's polynomial evaluates to ~-0.00232 at x=0 (clamped to 0)
        // and ~0.986 at x=1. We don't force-clamp the top to exactly 1.0 —
        // the next display stage (gamma encode) handles any headroom.
        let l = lut();
        assert!(l[0].abs() < 1e-5, "LUT[0] = {}", l[0]);
        assert!(l[AGX_LUT_SIZE - 1] >= 0.98 && l[AGX_LUT_SIZE - 1] <= 1.0,
            "LUT[last] = {}, expected in [0.98, 1.0]", l[AGX_LUT_SIZE - 1]);
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
        // Scene mid-gray (AGX_MID_GRAY = 0.18) should render to approximately
        // AGX_MID_DISPLAY at contrast=0 — the AgX pivot anchor on the display
        // side, decoupled from the scene anchor to allow a baseline midtone
        // lift vs scene-referred reference. LUT sampling introduces at most
        // one step of linear-interp error.
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
}
