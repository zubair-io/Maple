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
use serde::Serialize;

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
///
/// `serde::Serialize` is derived so `maple-cli auto-tone` can print the
/// struct directly as JSON. The flat-struct field ordering matches the
/// `MapleAutoTone` C struct in `raw-ffi/src/auto_tone.rs` and the
/// `AutoTone` `#[wasm_bindgen]` struct in `raw-wasm/src/auto_tone.rs` so
/// the three surfaces present an identical schema to Swift/TypeScript.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
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
    compute_auto_tone_inner(scene_post_wb)
}

/// Compute Auto Tone from a flat scene-linear RGBA f32 slice.
///
/// Adapter for the FFI (`maple_compute_auto_tone`) and WASM
/// (`compute_auto_tone`) entry points, which receive RGBA buffers from the
/// per-platform render paths rather than a `raw_core::image::Image`. The
/// alpha channel is discarded; the RGB triple is interpreted as
/// `ColorSpace::SceneLinearRec2020` and routed through the same percentile
/// math as the in-process [`compute_auto_tone`] entry. Keeping the strip
/// here means both surfaces share one implementation and stay in lockstep
/// across phases. Returns [`AutoTone::default`] if `rgba.len() < 4 * w * h`
/// — the FFI / WASM bindings already validate shape, so this is a
/// defensive guardrail rather than a normal control-flow path.
pub fn compute_auto_tone_from_rgba(
    rgba: &[f32],
    width: usize,
    height: usize,
    clip: f32,
) -> AutoTone {
    let _ = clip;
    let pixels = width.checked_mul(height).unwrap_or(0);
    if pixels == 0 || rgba.len() < pixels * 4 {
        return AutoTone::default();
    }
    let mut img = Image::new(width as u32, height as u32, ColorSpace::SceneLinearRec2020);
    for (i, px) in img.pixels.iter_mut().enumerate() {
        let base = i * 4;
        *px = [rgba[base], rgba[base + 1], rgba[base + 2]];
    }
    compute_auto_tone_inner(&img)
}

/// Shared histogram → exposure heuristic, parameterised on the post-WB
/// scene-linear `Image`. Split out from [`compute_auto_tone`] so the
/// RGBA-slice adapter ([`compute_auto_tone_from_rgba`]) does not pay the
/// public-entry `assert_space` cost on every FFI/WASM call — the slice
/// adapter constructs its own `Image` with the right tag, so the assert
/// would be a no-op at runtime but a hard `panic!` if a future refactor
/// breaks the invariant. Mirrors the inverse of `auto_exposure::apply`.
fn compute_auto_tone_inner(scene_post_wb: &Image) -> AutoTone {
    let mut t = AutoTone::default();

    let hist = build_luma_histogram(scene_post_wb);
    let p50 = match percentile(&hist, 0.50) {
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

    #[test]
    fn from_rgba_matches_image_entry() {
        // The RGBA adapter must produce bit-identical exposure to the
        // `Image` entry on the same neutral patch — the FFI/WASM surface
        // is just a shape adapter, not a different algorithm.
        let w = 64usize;
        let h = 64usize;
        let mut rgba = vec![0f32; w * h * 4];
        for i in 0..(w * h) {
            rgba[i * 4]     = 0.045;
            rgba[i * 4 + 1] = 0.045;
            rgba[i * 4 + 2] = 0.045;
            rgba[i * 4 + 3] = 1.0;
        }
        let rgba_result = compute_auto_tone_from_rgba(&rgba, w, h, 0.005);
        let img_result = compute_auto_tone(&flat_image(0.045), 0.005);
        assert_eq!(rgba_result.exposure, img_result.exposure);
        assert_eq!(rgba_result.contrast, 0.0);
    }

    #[test]
    fn from_rgba_short_buffer_returns_identity() {
        // Defensive: callers (FFI/WASM) validate shape before calling us,
        // but if a short slice does reach the adapter we return the
        // identity recommendation rather than panicking on an OOB read.
        let short = vec![0.18f32; 3];
        let t = compute_auto_tone_from_rgba(&short, 64, 64, 0.005);
        assert_eq!(t, AutoTone::default());
    }

    #[test]
    fn from_rgba_zero_dims_returns_identity() {
        let rgba = vec![0.18f32; 16];
        let t = compute_auto_tone_from_rgba(&rgba, 0, 0, 0.005);
        assert_eq!(t, AutoTone::default());
    }
}
