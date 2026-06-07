//! Auto Profile fit entry points — develop a RAW through the view-transform
//! prefix, then fit the #550 curve (and, for #924, the per-image residual LUT)
//! for GPU hosts that bake them into a 3D LUT. Split out of `render/mod.rs` to
//! keep it under the file-size budget; behavior is unchanged (pure code move).

use crate::error::Result;
use crate::image::{ColorSpace, Image, RawImage};
use crate::pipeline::develop::develop_scene_linear_from_raw_with_quality;
use crate::pipeline::{stage, RenderQuality};
use crate::types::adjustment::{AutoExposureMode, Profile};
use crate::view::{agx, auto_profile, encode};
use crate::xmp::AdjustmentModel;

use super::RawInput;

/// Build the [`AdjustmentModel`] the fit develop runs with — a clone of the
/// caller's model that (a) pins `auto_exposure: Off` and (b) zeroes the
/// high-frequency stages that don't move the fit target (#972).
///
/// `auto_exposure: Off` is the existing #871 split: the fitted tail owns the
/// whole scene→JPEG brightness mapping, so AE is disabled for the develop and
/// the AE split governs exposure only (`agx` still runs the caller's ORIGINAL
/// `model.contrast` — see [`develop_display_for_auto_fit`]).
///
/// The four zeroed fields are noise reduction (`nr_color`, `nr_luminance`) and
/// sharpening (`sharpen_amount`, `capture_sharpening_amount`). The fit samples a
/// GLOBAL per-channel tone curve (#550) and a LOW-FREQUENCY color residual LUT
/// (#924) — both averaged over the downscaled ~2048px embedded JPEG and a
/// matching downscale of this develop. NR and sharpening are HIGH-frequency,
/// detail-scale ops; they don't meaningfully move a global curve or a low-freq
/// residual, but the default model runs `nr_color`@25 (~8.5 s) and
/// `sharpen`@40 (~0.8 s) on the full-res buffer purely to be averaged away.
/// Zeroing them removes that redundant cold-open cost. Each stage early-exits at
/// `amount.abs() < 1e-3` (NR / sharpen) or `amount <= 0.0`
/// (`capture_sharpening_params_from_model`), so `0.0` is BIT-EXACT equivalent to
/// the stage being absent — no partial-blend approximation.
///
/// ⚠️ This is a DELIBERATE, near-zero divergence from the CPU/WASM render path.
/// `render_from_raw_with_quality_and_source` develops with the FULL model and
/// fits via [`auto_profile::apply_auto_profile`] against that NR/sharpened
/// buffer; the GPU-host fit entries here now fit against an NR/sharpen-free
/// buffer. Before #972 the two fit inputs were byte-identical (both AE-off, both
/// full NR/sharpen), so the fitted curve/residual matched exactly. After #972 a
/// GPU (Apple Metal) Auto render's baked tail can differ marginally from the
/// CPU/CLI render's tail. Expected magnitude is near zero (high-freq ops vs a
/// global + low-freq fit target), but it is a real new divergence and is NOT
/// covered by `test_color_pipeline.sh`: maple-cli renders via
/// `apply_auto_profile` and never calls this function, so that harness can't see
/// this change even with fixtures. The owner must validate the GPU path via the
/// Apple visual harness (`SliderMatrixUITests`) with real fixtures before merge.
fn fit_develop_model(model: &AdjustmentModel) -> AdjustmentModel {
    AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        // High-frequency stages the fit averages away (#972) — zeroed so they
        // early-exit (bit-exact no-op) instead of running on the full-res buffer.
        nr_color: 0.0,
        nr_luminance: 0.0,
        sharpen_amount: 0.0,
        capture_sharpening_amount: 0.0,
        ..model.clone()
    }
}

/// Develop a RAW through the EXACT Auto Profile fit prefix and return the
/// `DisplayEncodedSrgb` buffer the curve / residual LUT fits sample against.
///
/// Shared by [`fit_profile_curve_from_raw`] (curve-only, the shipped #812 FFI)
/// and [`fit_auto_profile_from_raw`] (curve + residual, #924) so the two GPU
/// fit entries can never drift FROM EACH OTHER. Prefix:
///   * the fit develop model from [`fit_develop_model`] — `auto_exposure: Off`
///     (#871) plus the four high-frequency stages zeroed (#972); see that fn for
///     the rationale and the deliberate CPU↔GPU fit divergence it introduces;
///   * the shared scene-linear develop chain;
///   * `agx` (with the caller's ORIGINAL `model.contrast`, NOT the fit clone —
///     the AE split governs exposure only), then `rec2020→srgb` primaries, then
///     `srgb` gamma encode. The fit lives in `DisplayEncodedSrgb` — the buffer
///     state on return.
fn develop_display_for_auto_fit(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<Image> {
    let auto_model = fit_develop_model(model);
    let mut scene = develop_scene_linear_from_raw_with_quality(raw, &auto_model, quality)?;
    stage("agx", || agx::apply(&mut scene, model.contrast));
    stage("rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
    stage("srgb_gamma_encode", || encode::srgb_gamma_encode(&mut scene));
    scene.assert_space(ColorSpace::DisplayEncodedSrgb);
    Ok(scene)
}

/// Fit the per-image Auto Profile [`auto_profile::curve::ProfileCurve`]
/// for a RAW + model WITHOUT rendering an output buffer (#812).
///
/// This reproduces EXACTLY the prefix of `render_from_raw_with_quality_and_source`
/// up to and including the `auto_profile` fit point — same `AutoExposureMode::Off`
/// guard, same develop chain, same `agx` → `rec2020_to_srgb` → `srgb_gamma_encode`
/// view-transform stages — then fits the curve from the resulting f32
/// sRGB-encoded display buffer against the embedded JPEG and returns it
/// instead of applying it and continuing to quantise.
///
/// It exists so a GPU host (Apple Metal #812, Web WebGL2 #394) can obtain
/// the fitted curve, bake it into a 3D LUT via [`auto_profile::bake_profile_lut`],
/// and apply it on the GPU in the SAME f32 sRGB-encoded display space the
/// CPU path fits in — keeping the GPU and CPU Auto Profile renders from
/// drifting. The host runs AgX + the rec2020→sRGB encode itself (on Apple
/// CoreImage's encode boundary); this entry's only job is the fit, which
/// requires the developed display buffer as the fit's source.
///
/// `quality` MUST match the quality the host's render uses, or the fitted
/// curve — and thus the per-band bias against the reference — will differ.
///
/// Returns `None` when `model.profile != Profile::Auto`, the embedded JPEG
/// can't be extracted, or the fit is degenerate (see
/// [`auto_profile::fit_curve_from_raw_display`]). The host falls back to
/// plain AgX (= `Profile::Neutral`) on `None`. The fit result is inserted
/// into the shared `auto_profile::cache` LRU so a subsequent CPU render of
/// the same RAW reuses it (and vice-versa).
pub fn fit_profile_curve_from_raw(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: RawInput<'_>,
) -> Option<auto_profile::curve::ProfileCurve> {
    if model.profile != Profile::Auto {
        return None;
    }
    // Mirror the cache lookup in `render_from_raw_with_quality_and_source`
    // so a hit on either path serves the other without re-fitting.
    let auto_cache_key = match &raw_source {
        RawInput::Path(p) => auto_profile::cache::CacheKey::from_path(p),
        RawInput::Bytes { bytes, .. } => Some(auto_profile::cache::CacheKey::from_bytes(bytes)),
    };
    if let Some(c) = auto_cache_key.as_ref().and_then(auto_profile::cache::get) {
        return Some(c);
    }
    let scene = develop_display_for_auto_fit(raw, model, quality).ok()?;
    let (w, h) = (scene.width as usize, scene.height as usize);
    let pixels: &[f32] = bytemuck::cast_slice(&scene.pixels);
    let fitted = match raw_source {
        RawInput::Path(path) => {
            auto_profile::fit_curve_from_raw_display(path, pixels, w, h, raw.orientation)
        }
        RawInput::Bytes { bytes, ext } => {
            auto_profile::fit_curve_from_bytes_display(bytes, ext, pixels, w, h, raw.orientation)
        }
    };
    if let (Some(key), Some(c)) = (auto_cache_key, fitted.as_ref()) {
        auto_profile::cache::insert(key, c.clone());
    }
    fitted
}

/// Fit BOTH the #550 per-channel curve and the per-image residual 3D LUT for a
/// GPU host that bakes them into ONE composed CIColorCube / texture (#924).
///
/// Develops the RAW through the same prefix as [`fit_profile_curve_from_raw`]
/// (via [`develop_display_for_auto_fit`]), fits the curve, applies it in place,
/// then fits the residual on the now-curved buffer — so the residual's pairs are
/// `(curve(maple), jpeg)`, EXACTLY as [`auto_profile::apply_auto_profile`] does
/// on the CPU render path. Both stages share the same `auto_profile::cache`
/// LRUs as the CPU/curve paths, so a hit on any path serves the others (and the
/// fast path below skips the multi-second develop when both are already cached).
///
/// Returns:
/// - `None` when NEITHER stage applies — not `Profile::Auto`, or no embedded
///   JPEG so both fits fail. The host renders plain AgX (= `Profile::Neutral`).
/// - `Some((curve, residual))` otherwise, where EITHER element may be `None`:
///   * `(Some, Some)` — the full tail; the host bakes `curve ∘ residual`.
///   * `(Some, None)` — curve only (too few residual pairs); curve-only bake,
///     byte-identical to the #812 cube.
///   * `(None, Some)` — residual only (degenerate curve but a usable JPEG). The
///     residual was fit on the UN-curved AE-off buffer, so it still
///     brightness-anchors maple→jpeg. This case MUST NOT collapse to plain AgX:
///     an AE-off buffer with no tail renders DARKER than Neutral (#871), so
///     dropping the residual here would make selecting "Auto" *darken* the
///     image. This mirrors `apply_auto_profile`'s "fit the residual regardless
///     of whether the curve succeeded" invariant — see its inline comment.
pub fn fit_auto_profile_from_raw(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: RawInput<'_>,
) -> Option<(
    Option<auto_profile::curve::ProfileCurve>,
    Option<auto_profile::lut::ColorLut>,
)> {
    if model.profile != Profile::Auto {
        return None;
    }
    let auto_cache_key = match &raw_source {
        RawInput::Path(p) => auto_profile::cache::CacheKey::from_path(p),
        RawInput::Bytes { bytes, .. } => Some(auto_profile::cache::CacheKey::from_bytes(bytes)),
    };

    // Fast path: both stages already cached (e.g. a CPU render of the same RAW
    // ran first) — return without the multi-second develop. Only short-circuit
    // when BOTH are present; a cached curve with no cached LUT still needs the
    // develop to fit the residual (a legitimately-`None` residual can't be
    // distinguished from "never fit" via the cache, but the host caches the
    // baked cube, so this re-fits at most once per image).
    if let Some(key) = auto_cache_key.as_ref() {
        if let (Some(curve), Some(lut)) =
            (auto_profile::cache::get(key), auto_profile::cache::get_lut(key))
        {
            return Some((Some(curve), Some(lut)));
        }
    }

    let mut scene = develop_display_for_auto_fit(raw, model, quality).ok()?;
    let (w, h) = (scene.width as usize, scene.height as usize);

    // 1. #550 curve — reuse cache or fit on the pre-curve buffer.
    let curve = match auto_cache_key.as_ref().and_then(auto_profile::cache::get) {
        Some(c) => Some(c),
        None => {
            let pixels: &[f32] = bytemuck::cast_slice(&scene.pixels);
            let fitted = match &raw_source {
                RawInput::Path(path) => {
                    auto_profile::fit_curve_from_raw_display(path, pixels, w, h, raw.orientation)
                }
                RawInput::Bytes { bytes, ext } => auto_profile::fit_curve_from_bytes_display(
                    bytes,
                    ext,
                    pixels,
                    w,
                    h,
                    raw.orientation,
                ),
            };
            if let (Some(key), Some(c)) = (auto_cache_key.as_ref(), fitted.as_ref()) {
                auto_profile::cache::insert(key.clone(), c.clone());
            }
            fitted
        }
    };

    // 2. Apply the curve in place so the residual is fit on `(curve(maple), jpeg)`
    //    — the same buffer state `apply_auto_profile` fits the residual against.
    //    When the curve failed, the buffer stays the un-curved AE-off AgX maple
    //    and the residual degrades to a full value-keyed maple→jpeg map (still
    //    smooth + brightness-anchoring), matching the CPU path.
    if let Some(c) = &curve {
        let pixels: &mut [f32] = bytemuck::cast_slice_mut(&mut scene.pixels);
        auto_profile::apply_curve(pixels, c);
    }

    // 3. Residual LUT — reuse cache or fit on the buffer as step 2 left it.
    let residual = match auto_cache_key.as_ref().and_then(auto_profile::cache::get_lut) {
        Some(l) => Some(l),
        None => {
            let pixels: &[f32] = bytemuck::cast_slice(&scene.pixels);
            let fitted = match &raw_source {
                RawInput::Path(path) => {
                    auto_profile::lut::fit_lut_from_raw_display(path, pixels, w, h, raw.orientation)
                }
                RawInput::Bytes { bytes, ext } => auto_profile::lut::fit_lut_from_bytes_display(
                    bytes,
                    ext,
                    pixels,
                    w,
                    h,
                    raw.orientation,
                ),
            };
            if let (Some(key), Some(l)) = (auto_cache_key.as_ref(), fitted.as_ref()) {
                auto_profile::cache::insert_lut(key.clone(), l.clone());
            }
            fitted
        }
    };

    if curve.is_none() && residual.is_none() {
        return None;
    }
    Some((curve, residual))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `fit_develop_model` (#972) MUST zero exactly the four high-frequency
    /// stages the fit averages away, pin `auto_exposure: Off` (#871), and leave
    /// every other field — including the OTHER sharpen params — untouched. This
    /// is the only automated coverage for the change: maple-cli renders via
    /// `apply_auto_profile` (full NR/sharpen) and never calls the fit develop,
    /// so `test_color_pipeline.sh` cannot see it. We assert on the pure helper
    /// rather than fitting a RAW two ways — the GPU and CPU fits share
    /// `auto_profile::cache`, so a both-ways curve-equality test would have the
    /// second caller reuse the first's cached fit and silently pass.
    #[test]
    fn fit_develop_model_zeroes_high_freq_and_preserves_rest() {
        // Start from a model whose every relevant field is deliberately
        // NON-default and non-zero, so a missing copy can't masquerade as a
        // correct zero/passthrough.
        let model = AdjustmentModel {
            auto_exposure: AutoExposureMode::On,
            // The four fields that must be forced to 0.0.
            nr_color: 25.0,
            nr_luminance: 17.0,
            sharpen_amount: 40.0,
            capture_sharpening_amount: 65.0,
            // Fields that must survive verbatim, incl. the OTHER sharpen knobs
            // (only `sharpen_amount` / `capture_sharpening_amount` are zeroed).
            sharpen_radius: 1.3,
            sharpen_detail: 30.0,
            sharpen_masking: 12.0,
            capture_sharpening_sigma: 1.2,
            contrast: 22.0,
            exposure: 1.5,
            temperature: 5200.0,
            tint: -8.0,
            profile: Profile::Auto,
            ..AdjustmentModel::default()
        };

        let fit = fit_develop_model(&model);

        // (a) The four high-frequency stages are zeroed → each early-exits as a
        //     bit-exact no-op (see `fit_develop_model` doc + stage guards).
        assert_eq!(fit.nr_color, 0.0, "nr_color must be zeroed for the fit");
        assert_eq!(fit.nr_luminance, 0.0, "nr_luminance must be zeroed for the fit");
        assert_eq!(fit.sharpen_amount, 0.0, "sharpen_amount must be zeroed for the fit");
        assert_eq!(
            fit.capture_sharpening_amount, 0.0,
            "capture_sharpening_amount must be zeroed for the fit"
        );

        // (b) Auto-exposure is pinned Off (the #871 split, unchanged by #972).
        assert_eq!(fit.auto_exposure, AutoExposureMode::Off);

        // (c) Everything else is passed through verbatim — especially the OTHER
        //     sharpen params, which #972 must NOT touch.
        assert_eq!(fit.sharpen_radius, 1.3);
        assert_eq!(fit.sharpen_detail, 30.0);
        assert_eq!(fit.sharpen_masking, 12.0);
        assert_eq!(fit.capture_sharpening_sigma, 1.2);
        assert_eq!(fit.contrast, 22.0);
        assert_eq!(fit.exposure, 1.5);
        assert_eq!(fit.temperature, 5200.0);
        assert_eq!(fit.tint, -8.0);
        assert_eq!(fit.profile, Profile::Auto);
    }
}
