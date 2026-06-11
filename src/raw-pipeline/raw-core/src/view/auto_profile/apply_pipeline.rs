//! Fit + apply the per-image Auto Profile tail (#550 curve + residual 3D LUT)
//! against a developed display buffer. Shared by the CPU render path and the
//! GPU fit entries (`pipeline::render::auto_fit`) so the fit/cache/ordering
//! logic lives in exactly one place.
//!
//! ## #1085 contract — the fit input is the PINNED default-model develop
//!
//! `pixels` must be the buffer developed under the pinned fit model
//! (`auto_fit::fit_develop_model`: `AdjustmentModel::default()` with
//! `auto_exposure: Off` and the caller's `profile` carried), NOT the caller's
//! live edit model. That makes every fit a pure function of the RAW (at a
//! given develop quality/size), so the RAW-identity [`cache`] key is correct
//! by construction — no adjustment digest needed, no cache-order dependence,
//! and a cold fit can never learn (and so partially cancel) the user's edits.
//! Callers whose render buffer IS that pinned develop (the default-model
//! cold-open case) pass it directly; everyone else develops a separate pinned
//! buffer (see `auto_fit::run_auto_profile_stage`).

use crate::image::ExifOrientation;

use super::cache::{self, CacheKey};
use super::curve::ProfileCurve;
use super::lut::{self, ColorLut};
use super::preview::ExtractedPreview;
use super::{apply_curve, fit_display};

/// Fit (or reuse from cache) the Auto Profile artifacts from the pinned fit
/// buffer `pixels` (interleaved RGB f32, `DisplayEncodedSrgb`, `w × h`,
/// sensor-oriented), applying the CURVE in place along the way:
///   1. the #550 per-channel tone curve — `cached_curve`, else fit on the
///      pre-curve buffer; then applied in place so `pixels` becomes
///      `curve(maple)` (the state the residual fit needs, and the state a
///      caller rendering FROM this buffer continues with);
///   2. the per-image residual 3D LUT — `cached_lut`, else fit on the
///      now-curved buffer so its pairs are `(curve(maple), jpeg)` and it
///      carries only the cross-channel residual the separable curve can't.
///      NOT applied — the caller owns the residual apply (and its strength,
///      [`lut::lut_strength_from_env`]).
///
/// `preview` is the pre-extracted embedded JPEG (+ color space) — extracted
/// ONCE by the caller and shared by both fits (#1085). `None` (no embedded
/// preview) makes each un-cached fit a no-op for that stage.
///
/// `MAPLE_DISABLE_AUTO_LUT` skips the residual stage ENTIRELY — no fit, no
/// cache read/insert, `None` returned — not just the apply (#1085). The LUT
/// generalizes the curve, so disabling it leaves exactly the #550 curve.
/// A failed curve fit leaves the buffer un-curved and the residual degrades
/// to a full value-keyed `maple → jpeg` map — still smooth + brightness-
/// anchoring, which is what avoids an AE-off dark frame; hence the residual
/// is fit regardless of whether the curve succeeded.
///
/// Successful fits insert into the shared [`cache`] LRUs under `cache_key`
/// (always at FULL residual strength — see [`lut::fit_lut_from_preview`]).
pub fn fit_auto_profile_artifacts(
    pixels: &mut [f32],
    w: usize,
    h: usize,
    orientation: ExifOrientation,
    preview: Option<&ExtractedPreview>,
    cache_key: Option<&CacheKey>,
    cached_curve: Option<ProfileCurve>,
    cached_lut: Option<ColorLut>,
) -> (Option<ProfileCurve>, Option<ColorLut>) {
    // 1. #550 per-channel curve — cached, or fit on the pre-curve buffer.
    let curve = cached_curve.or_else(|| {
        let fitted = preview.and_then(|p| {
            fit_display::fit_curve_from_preview_display(
                p.image.clone(),
                p.color_space,
                pixels,
                w,
                h,
                orientation,
            )
        });
        if let (Some(key), Some(c)) = (cache_key, fitted.as_ref()) {
            cache::insert(key.clone(), c.clone());
        }
        fitted
    });
    if let Some(c) = &curve {
        apply_curve(pixels, c);
    }

    // 2. residual 3D LUT — fit on the buffer as step 1 left it.
    if lut::lut_disabled_by_env() {
        return (curve, None);
    }
    let residual = cached_lut.or_else(|| {
        let fitted = preview.and_then(|p| {
            lut::fit_lut_from_preview(pixels, w, h, p.image.clone(), p.color_space, orientation)
        });
        if let (Some(key), Some(l)) = (cache_key, fitted.as_ref()) {
            cache::insert_lut(key.clone(), l.clone());
        }
        fitted
    });
    (curve, residual)
}

/// Apply the FULL Auto Profile tail in place to `pixels` — the CPU render
/// path's entry for the case where the render buffer IS the pinned fit buffer
/// (see module doc): [`fit_auto_profile_artifacts`] (curve fit + in-place
/// curve apply + residual fit), then the residual apply at the env strength.
pub fn apply_auto_profile(
    pixels: &mut [f32],
    w: usize,
    h: usize,
    orientation: ExifOrientation,
    preview: Option<&ExtractedPreview>,
    cache_key: Option<&CacheKey>,
    cached_curve: Option<ProfileCurve>,
    cached_lut: Option<ColorLut>,
) {
    let (_curve, residual) = fit_auto_profile_artifacts(
        pixels,
        w,
        h,
        orientation,
        preview,
        cache_key,
        cached_curve,
        cached_lut,
    );
    if let Some(l) = residual {
        l.apply_with_strength(pixels, lut::lut_strength_from_env());
    }
}
