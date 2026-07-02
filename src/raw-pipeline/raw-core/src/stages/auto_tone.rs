//! Auto Tone — one-shot per-image slider recommendation.
//!
//! Phase 1a: exposure only. Phases 1b (whites/blacks) and 1c (contrast/
//! highlights/shadows) are tracked as separate tickets on the
//! `#505` epic.
//!
//! # Algorithm (exposure-only, this phase)
//!
//! 1. Build a normalised luma histogram on the post-WB scene-linear buffer,
//!    using Rec.2020 luma weights to match the working color space.
//! 2. Find the p50 (median) percentile, expressed as a normalised
//!    scene-linear luminance value in `(0, 1]`.
//! 3. Compute `gain = target_midgray / p50` with `target_midgray = 0.18`.
//! 4. Convert to stops: `exposure = log2(gain)`, clamped to `[-5, +5]` so
//!    the recommended value always fits the slider range.
//!
//! The `clip` parameter is reserved for Phase 1b (whites/blacks); it is
//! unused in this revision but kept in the signature to avoid an API churn
//! between phases.
//!
//! # On reuse of `auto_exposure`
//!
//! The Task A1 plan assumed a public `build_luma_histogram` lived in
//! [`crate::stages::auto_exposure`]. That helper (and its raw-CFA
//! companion) was removed in `#494` when the scene-anchor heuristic
//! switched to a quickselect-based percentile band — see the history note
//! in `auto_exposure/mod.rs`. We rebuild a minimal scene-linear luma
//! histogram inline here rather than resurrect a generic helper that has
//! no other consumer. The histogram width matches AgX's working precision
//! tier (4096 bins ≈ 12 bits) which is well below the noise floor of any
//! real RAW and well above the precision the downstream gain inversion
//! consumes.
//!
//! Refs spec `docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md`.

use crate::image::{ColorSpace, Image};

/// Rec.2020 luma weights — match the working color space of the post-WB
/// scene-linear buffer this stage analyses. Identical to
/// `crate::stages::auto_exposure::LUMA_REC2020`; duplicated as a private
/// constant to avoid widening the visibility of the original.
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Scene-linear target for mid-gray. Matches `AGX_MID_GRAY` and the same
/// constant in `auto_exposure` — the load-bearing anchor of the whole
/// scene-referred pipeline.
const TARGET_MIDGRAY: f32 = 0.18;

/// Number of histogram bins. 4096 = 12 bits; below the noise floor of a
/// real RAW and well above the precision of the downstream `log2` step.
const HIST_BINS: usize = 4096;

/// Slider range clamp. Mirrors the UI range exposed on the `Exposure`
/// slider so the recommended value can be assigned verbatim without
/// downstream clipping surprises.
const EXPOSURE_CLAMP_EV: f32 = 5.0;

/// One-shot per-image slider recommendation.
///
/// Phase 1a populates `exposure`; the remaining sliders are zeroed (i.e.
/// "no change") and will be filled in by Phases 1b/1c. Defaulting unfilled
/// fields to zero rather than `Option<f32>` keeps the FFI surface (#A2) a
/// flat C struct and matches the slider rest position.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AutoTone {
    pub exposure: f32,
    pub contrast: f32,
    pub whites: f32,
    pub blacks: f32,
    pub highlights: f32,
    pub shadows: f32,
}

impl Default for AutoTone {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            contrast: 0.0,
            whites: 0.0,
            blacks: 0.0,
            highlights: 0.0,
            shadows: 0.0,
        }
    }
}

/// Compute a slider recommendation for `scene_post_wb`.
///
/// `scene_post_wb` must be in [`ColorSpace::SceneLinearRec2020`] —
/// upstream stages (decode, demosaic, DCP, white balance) have already run.
/// `clip` is reserved for Phase 1b (whites/blacks tail-percentile) and is
/// ignored in this revision; it is kept in the signature so the FFI/WASM
/// surface added in #A2 does not need to change between phases.
///
/// Returns an `AutoTone` whose `exposure` field is the recommended slider
/// value in stops, clamped to `[-5, +5]`. All other fields are zero in
/// Phase 1a.
pub fn compute_auto_tone(scene_post_wb: &Image, clip: f32) -> AutoTone {
    let _ = clip;
    scene_post_wb.assert_space(ColorSpace::SceneLinearRec2020);

    let hist = build_luma_histogram(scene_post_wb);
    auto_tone_from_histogram(&hist)
}

/// Shim variant of [`compute_auto_tone`] that operates on a flat RGBA f32
/// slice instead of an [`Image`]. The FFI (#A2) and WASM (#A2) surfaces use
/// this so they can feed the function from a caller-owned post-WB
/// scene-linear buffer without round-tripping through an `Image` copy.
///
/// `scene_post_wb_rgba` must be `4 * width * height` f32 lanes (RGBA, the
/// alpha lane is ignored). `width * height` must equal the pixel count;
/// when it doesn't, the function returns the identity recommendation
/// (all zeros) — the FFI shim is expected to validate dimensions before
/// calling, but the defensive fallback keeps this safe to use from
/// scripted contexts.
///
/// `clip` is reserved for Phase 1b and is currently ignored, matching the
/// `Image`-flavoured [`compute_auto_tone`].
pub fn compute_auto_tone_from_rgba(
    scene_post_wb_rgba: &[f32],
    width: usize,
    height: usize,
    clip: f32,
) -> AutoTone {
    let _ = clip;
    let pixels = match width.checked_mul(height) {
        Some(p) => p,
        None => return AutoTone::default(),
    };
    let expected = match pixels.checked_mul(4) {
        Some(l) => l,
        None => return AutoTone::default(),
    };
    if scene_post_wb_rgba.len() < expected {
        return AutoTone::default();
    }
    let hist = build_luma_histogram_rgba(&scene_post_wb_rgba[..expected]);
    auto_tone_from_histogram(&hist)
}

/// Convert a normalised luma histogram into an [`AutoTone`] recommendation.
/// Shared by the [`Image`]- and RGBA-flavoured entries so the inversion
/// math lives in one place.
fn auto_tone_from_histogram(hist: &[u32; HIST_BINS]) -> AutoTone {
    let mut t = AutoTone::default();

    let p50 = match percentile(hist, 0.50) {
        Some(p) => p,
        None => return t, // empty / degenerate image → identity recommendation
    };

    // Floor `p50` so a near-black scene cannot produce a hyper-gain that
    // overflows the slider clamp via Infinity / NaN. The clamp below is
    // the user-visible guardrail; this floor just keeps the arithmetic
    // well-defined.
    const P50_FLOOR: f32 = 1e-6;
    let p50_safe = p50.max(P50_FLOOR);
    let gain = TARGET_MIDGRAY / p50_safe;

    let stops = gain.log2();
    t.exposure = if stops.is_finite() {
        stops.clamp(-EXPOSURE_CLAMP_EV, EXPOSURE_CLAMP_EV)
    } else {
        0.0
    };
    t
}

/// Build a normalised luma histogram on a scene-linear buffer.
///
/// Bin assignment treats `[0, 1]` as the working luminance range — values
/// outside that interval (specular highlights above 1.0, negative
/// out-of-gamut excursions) collapse into the top / bottom bins, which is
/// the desired behaviour for a percentile lookup.
///
/// Single-pass, `O(pixels)`, no allocation beyond the fixed-size bin
/// array. Returns the raw count per bin; callers normalise by walking the
/// cumulative sum (see [`percentile`]).
fn build_luma_histogram(image: &Image) -> [u32; HIST_BINS] {
    let mut bins = [0u32; HIST_BINS];
    for p in &image.pixels {
        let y = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
        if !y.is_finite() {
            continue;
        }
        // Map `y ∈ [0, 1]` to `bin ∈ [0, HIST_BINS)`. Out-of-range values
        // saturate to the appropriate end so percentile lookups stay
        // monotone.
        let scaled = (y * HIST_BINS as f32).floor();
        let idx = if scaled <= 0.0 {
            0
        } else if scaled >= (HIST_BINS - 1) as f32 {
            HIST_BINS - 1
        } else {
            scaled as usize
        };
        bins[idx] = bins[idx].saturating_add(1);
    }
    bins
}

/// Build a normalised luma histogram on a flat RGBA f32 slice. Mirrors
/// [`build_luma_histogram`] but consumes the FFI-friendly memory layout
/// (`R0 G0 B0 A0 R1 G1 B1 A1 …`) directly — the alpha lane is ignored.
///
/// Used by [`compute_auto_tone_from_rgba`] to avoid the `Vec<[f32; 3]>`
/// copy a full [`Image`] construction would require at the FFI boundary.
fn build_luma_histogram_rgba(rgba: &[f32]) -> [u32; HIST_BINS] {
    let mut bins = [0u32; HIST_BINS];
    for chunk in rgba.chunks_exact(4) {
        let y =
            LUMA_REC2020[0] * chunk[0] + LUMA_REC2020[1] * chunk[1] + LUMA_REC2020[2] * chunk[2];
        if !y.is_finite() {
            continue;
        }
        let scaled = (y * HIST_BINS as f32).floor();
        let idx = if scaled <= 0.0 {
            0
        } else if scaled >= (HIST_BINS - 1) as f32 {
            HIST_BINS - 1
        } else {
            scaled as usize
        };
        bins[idx] = bins[idx].saturating_add(1);
    }
    bins
}

/// Walk the cumulative sum of `hist` and return the normalised
/// scene-linear luminance at which it crosses `q`. Bin midpoints are
/// returned so the lookup is a continuous function of `q`. Returns `None`
/// when the histogram is empty.
fn percentile(hist: &[u32; HIST_BINS], q: f32) -> Option<f32> {
    let total: u64 = hist.iter().map(|&c| c as u64).sum();
    if total == 0 {
        return None;
    }
    let target = ((total as f64) * (q as f64)).ceil() as u64;
    let mut acc: u64 = 0;
    for (i, &c) in hist.iter().enumerate() {
        acc += c as u64;
        if acc >= target {
            return Some((i as f32 + 0.5) / HIST_BINS as f32);
        }
    }
    Some(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a flat image with every pixel set to `(luma, luma, luma)`.
    /// A neutral patch's luma equals its channel value (Rec.2020 weights
    /// sum to 1.0), so the histogram peaks at the bin containing `luma`.
    fn flat_image(luma: f32) -> Image {
        let mut img = Image::new(64, 64, ColorSpace::SceneLinearRec2020);
        for px in &mut img.pixels {
            *px = [luma, luma, luma];
        }
        img
    }

    #[test]
    fn midgray_image_recommends_zero_exposure() {
        let img = flat_image(0.18);
        let t = compute_auto_tone(&img, 0.005);
        assert!(t.exposure.abs() < 0.05, "got {}", t.exposure);
    }

    #[test]
    fn dark_image_recommends_positive_exposure() {
        // 0.045 = 0.18 / 4 → 2 stops under midgray.
        let img = flat_image(0.045);
        let t = compute_auto_tone(&img, 0.005);
        assert!((t.exposure - 2.0).abs() < 0.15, "got {}", t.exposure);
    }

    #[test]
    fn bright_image_recommends_negative_exposure() {
        // 0.72 = 0.18 * 4 → 2 stops over midgray.
        let img = flat_image(0.72);
        let t = compute_auto_tone(&img, 0.005);
        assert!((t.exposure + 2.0).abs() < 0.15, "got {}", t.exposure);
    }

    #[test]
    fn clamps_to_slider_range() {
        let img = flat_image(0.0005);
        let t = compute_auto_tone(&img, 0.005);
        assert!(t.exposure <= 5.0, "got {}", t.exposure);
        assert!(t.exposure >= -5.0, "got {}", t.exposure);
    }

    /// The RGBA shim used by the FFI/WASM surface must agree with the
    /// `Image`-flavoured entry on every fixture — they share the histogram
    /// → percentile → gain inversion math, so any drift is a structural
    /// bug, not a tolerance one.
    fn flat_rgba(luma: f32, w: usize, h: usize) -> Vec<f32> {
        let mut v = vec![0.0f32; w * h * 4];
        for px in v.chunks_exact_mut(4) {
            px[0] = luma;
            px[1] = luma;
            px[2] = luma;
            px[3] = 1.0;
        }
        v
    }

    #[test]
    fn rgba_shim_matches_image_entry_for_midgray() {
        let img = flat_image(0.18);
        let rgba = flat_rgba(0.18, 64, 64);
        let t_img = compute_auto_tone(&img, 0.005);
        let t_rgba = compute_auto_tone_from_rgba(&rgba, 64, 64, 0.005);
        assert!((t_img.exposure - t_rgba.exposure).abs() < 1e-6);
    }

    #[test]
    fn rgba_shim_matches_image_entry_for_dark_scene() {
        let img = flat_image(0.045);
        let rgba = flat_rgba(0.045, 64, 64);
        let t_img = compute_auto_tone(&img, 0.005);
        let t_rgba = compute_auto_tone_from_rgba(&rgba, 64, 64, 0.005);
        assert!((t_img.exposure - t_rgba.exposure).abs() < 1e-6);
    }

    #[test]
    fn rgba_shim_ignores_alpha_lane() {
        // Alpha varies wildly; luma is what drives the histogram.
        let mut rgba = flat_rgba(0.18, 32, 32);
        for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
            px[3] = (i as f32) * 0.01;
        }
        let t = compute_auto_tone_from_rgba(&rgba, 32, 32, 0.005);
        assert!(t.exposure.abs() < 0.05, "got {}", t.exposure);
    }

    #[test]
    fn rgba_shim_returns_default_on_shape_mismatch() {
        let rgba = vec![0.18f32; 8]; // says 32x32, only has 2 pixels
        let t = compute_auto_tone_from_rgba(&rgba, 32, 32, 0.005);
        assert_eq!(t, AutoTone::default());
    }
}
