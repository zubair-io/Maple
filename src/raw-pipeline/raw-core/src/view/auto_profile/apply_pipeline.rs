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
use crate::view::acr_fit;

use super::cache::{self, CacheKey};
use super::curve::ProfileCurve;
use super::lut::{self, ColorLut};
use super::pairs::sample_display_pairs;
use super::preview::ExtractedPreview;
use super::{apply_curve, fit_display};

/// #1740 M2 escape hatch: restore the Auto 1.0 fit (curve + free residual
/// LUT, fit against the embedded JPEG) when set. Since the M2 flip, Auto 2.0
/// (the structured tonescale+field solver, `acr_fit::from_pairs`) is the
/// DEFAULT fit — the flip was owner-directed for TestFlight evaluation with
/// the M1 ship-gate at 9/16 (no external users on TestFlight; M3's WB
/// offset is the expected closer for the remaining fidelity breaches).
/// `MAPLE_AUTO1=1` is the same plumbing the M1 dev A/B's `MAPLE_AUTO2` used,
/// inverted — a dev/operator escape hatch, NOT a product setting; the repo's
/// settings system is for operator-facing toggles, and this one has no
/// operator-facing meaning (it swaps an internal fit algorithm, not a
/// behavior an end user chooses).
pub fn auto1_enabled_by_env() -> bool {
    // Match the Swift Auto1Flag semantics exactly: "0" and empty are
    // DISABLED — only a non-empty, non-"0" value engages the escape hatch.
    std::env::var("MAPLE_AUTO1")
        .map(|v| !v.is_empty() && v != "0")
        .unwrap_or(false)
}

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
    // #1740 M2: Auto 2.0's structured solver is the DEFAULT fit;
    // `MAPLE_AUTO1=1` restores the Auto 1.0 curve/LUT logic below. The
    // dispatch runs FIRST (and the default returns early) so the two
    // implementations never interleave — `pixels` is left UN-curved either
    // way (Auto 2.0 has no separate curve stage; its tail is entirely the
    // baked LUT), matching what `fit_via_acr2` samples pairs from. Shares
    // the same cache as Auto 1.0 (`(ProfileCurve, ColorLut)`-shaped either
    // way) — safe because a process runs one mode for its whole lifetime;
    // there is no cross-contamination within a run.
    if !auto1_enabled_by_env() {
        return fit_via_acr2(
            pixels,
            w,
            h,
            orientation,
            preview,
            cache_key,
            cached_curve,
            cached_lut,
        );
    }

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

/// Auto 2.0 — the DEFAULT fit since the #1740 M2 flip (`MAPLE_AUTO1=1`
/// restores Auto 1.0): fit the structured tonescale+field solver against
/// the SAME `pixels`/`preview` pair Auto 1.0's curve+LUT would otherwise
/// fit, then bake it into the same `(ProfileCurve, ColorLut)` shape via
/// [`acr_fit::acr_model_as_profile_artifacts`] so this is a drop-in for
/// [`fit_auto_profile_artifacts`]'s return value — any caller composing/
/// sampling the pair (CPU cube bake, GPU two-pass) gets Auto 2.0's tail
/// without knowing which fit produced it.
///
/// `pixels` is left UN-mutated (no curve applied) — the Auto 2.0 tail is one
/// LUT, no separate curve stage, and its pairs are sampled from `pixels` as
/// the caller developed it, matching `maple-cli fit-auto2`'s own pair
/// sampling (`sample_display_pairs` on the pre-curve buffer).
///
/// Returns `(None, None)` when there's no preview to sample pairs from, or
/// when the solve fails (too few neutral/sweep samples — mirrors
/// `solve_acr_model_from_display_pairs`'s own error contract; there is
/// deliberately no fallback to Auto 1.0 on a failed Auto 2.0 fit, so a
/// solve failure surfaces as "no Auto Profile tail" rather than silently
/// reverting to the other implementation).
fn fit_via_acr2(
    pixels: &mut [f32],
    w: usize,
    h: usize,
    orientation: ExifOrientation,
    preview: Option<&ExtractedPreview>,
    cache_key: Option<&CacheKey>,
    cached_curve: Option<ProfileCurve>,
    cached_lut: Option<ColorLut>,
) -> (Option<ProfileCurve>, Option<ColorLut>) {
    if let (Some(c), Some(l)) = (&cached_curve, &cached_lut) {
        return (Some(c.clone()), Some(l.clone()));
    }
    let Some(p) = preview else {
        return (None, None);
    };
    let pairs = sample_display_pairs(pixels, w, h, p.image.clone(), p.color_space, orientation);
    let model = match acr_fit::solve_acr_model_from_display_pairs(&pairs) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[auto2] structured fit failed, no Auto Profile tail: {e}");
            return (None, None);
        }
    };
    let (curve, residual) = acr_fit::acr_model_as_profile_artifacts(
        &model,
        crate::view::auto_profile::bake::DEFAULT_LUT_SIZE,
    );
    if let (Some(key), Some(c), Some(l)) = (cache_key, curve.as_ref(), residual.as_ref()) {
        cache::insert(key.clone(), c.clone());
        cache::insert_lut(key.clone(), l.clone());
    }
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
