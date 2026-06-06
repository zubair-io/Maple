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

/// Develop a RAW through the EXACT Auto Profile fit prefix and return the
/// `DisplayEncodedSrgb` buffer the curve / residual LUT fits sample against.
///
/// Shared by [`fit_profile_curve_from_raw`] (curve-only, the shipped #812 FFI)
/// and [`fit_auto_profile_from_raw`] (curve + residual, #924) so the two GPU
/// fit entries can never drift. Reproduces the render path's prefix verbatim:
///   * `auto_exposure: Off` for the develop, so the fitted tail owns the whole
///     scene→JPEG brightness mapping (see the render entry's long comment and
///     #871);
///   * the shared scene-linear develop chain;
///   * `agx` (with the caller's ORIGINAL `model.contrast`, NOT the AE-off clone
///     — the AE split governs exposure only), then `rec2020→srgb` primaries,
///     then `srgb` gamma encode. The fit lives in `DisplayEncodedSrgb` — the
///     buffer state on return.
fn develop_display_for_auto_fit(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<Image> {
    let auto_model = AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        ..model.clone()
    };
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
