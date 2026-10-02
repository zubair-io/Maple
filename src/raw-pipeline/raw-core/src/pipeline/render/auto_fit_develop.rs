//! Shared pinned Auto fit prefix; preparation and existing producers use the
//! same default-model arithmetic. Cooperative cancellation is opt-in (#1472).
use crate::{
    cancel::CancelToken,
    error::{Error, Result},
    image::{ColorSpace, Image, RawImage},
    pipeline::{
        develop::develop_scene_linear_from_raw_with_quality_cancellable,
        develop_sized::develop_scene_linear_sized_from_raw_with_quality_cancellable, stage,
        RenderQuality,
    },
    stages::{color_grade, grain},
    types::adjustment::AutoExposureMode,
    view::{agx, encode},
    xmp::AdjustmentModel,
};

/// Build the [`AdjustmentModel`] the fit develop runs with: the DEFAULT model
/// with `auto_exposure: Off` pinned and the caller's `profile` carried —
/// nothing else from the caller survives (#1085).
///
/// `auto_exposure: Off` is the existing #871/#550 split: the fitted tail owns
/// the whole scene→JPEG brightness mapping, so AE is disabled for the fit
/// develop. `profile` is the one field the fit genuinely needs from the
/// caller — it is what makes this a `Profile::Auto` fit at all (the entry
/// guards check it; the develop chain itself never reads it). Every other
/// field is pinned to [`AdjustmentModel::default()`] so the fit input — and
/// therefore the fitted curve/LUT under the RAW-identity cache key — cannot
/// depend on the caller's live edits.
///
/// This REPLACES the #972 variant, which cloned the caller's model and zeroed
/// the four high-frequency fields (`nr_color`, `nr_luminance`,
/// `sharpen_amount`, `capture_sharpening_amount`). Two reasons:
/// * Pinning to the default model is what makes the fit model-independent;
///   a caller clone (even a partially-zeroed one) keeps every other slider
///   leaking into the fit (#1085's bug).
/// * The CPU render path fits from a default-model develop — which runs the
///   DEFAULT `nr_color`@25 / `sharpen`@40 — and that path is what the
///   bit-exact color-pipeline harness gates. Keeping the GPU fit zeroed would
///   preserve #972's admitted (and harness-invisible) CPU↔GPU fit divergence;
///   pinning both to the same default model removes it. The cost is that the
///   GPU hosts' cold fit develop pays the default NR/sharpen again
///   (~9 s on the 100 MP reference frame — the #972 saving), traded for one
///   unified, deterministic fit definition across every path.
pub(in crate::pipeline::render) fn fit_develop_model(model: &AdjustmentModel) -> AdjustmentModel {
    AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        profile: model.profile,
        ..AdjustmentModel::default()
    }
}

/// Develop a RAW through the EXACT (pinned) Auto Profile fit prefix and return
/// the `DisplayEncodedSrgb` buffer the curve / residual LUT fits sample
/// against:
///   * the pinned fit model from [`fit_develop_model`] — default model,
///     `auto_exposure: Off`, caller's `profile` carried (#1085; see that fn);
///   * the shared scene-linear develop chain (early-downsampled when
///     `max_long_edge` is `Some`, mirroring the sized render entry — the GPU
///     fit entries pass `None` for the full-size develop);
///   * the render's display tail up to the Auto Profile stage, every stage
///     fed the PINNED model's fields: `agx` with the pinned `contrast` (= the
///     default `0.0`, NOT the caller's — pre-#1085 the caller's contrast
///     leaked into the fit here), `split_tone` (#1111) and `grain` (#1110) at
///     their defaults (both identity short-circuits — present so the prefix
///     stays stage-for-stage the render chain even if defaults ever change),
///     then `rec2020→srgb` primaries, then `srgb` gamma encode. The fit lives
///     in `DisplayEncodedSrgb` — the buffer state on return.
///
/// Shared by every fit entry in this module so the fit inputs can never drift
/// from each other — one pinned prefix, CPU and GPU alike. It is the chain
/// `render_display_from_raw` runs for a default-model caller, stage for stage
/// — which is what lets `run_auto_profile_stage` treat that caller's render
/// buffer AS the fit buffer without a second develop.
pub(in crate::pipeline::render) fn develop_display_for_auto_fit(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: Option<u32>,
) -> Result<Image> {
    develop_display_for_auto_fit_cancellable(
        raw,
        model,
        quality,
        max_long_edge,
        CancelToken::never(),
    )
}

/// #1472: identical pinned fit prefix, with the existing cooperative stage
/// token. This is preparation work; never run it on the GPU submission actor.
pub(in crate::pipeline::render) fn develop_display_for_auto_fit_cancellable(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: Option<u32>,
    cancel: CancelToken<'_>,
) -> Result<Image> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let auto_model = fit_develop_model(model);
    let mut scene = match max_long_edge {
        Some(mle) => develop_scene_linear_sized_from_raw_with_quality_cancellable(
            raw,
            &auto_model,
            quality,
            mle,
            cancel,
        )?,
        None => develop_scene_linear_from_raw_with_quality_cancellable(
            raw,
            &auto_model,
            quality,
            cancel,
        )?,
    };
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    stage("agx", || {
        agx::apply(&mut scene, auto_model.contrast, auto_model.whites)
    });
    stage("color_grade", || {
        color_grade::apply_model(&mut scene, &auto_model)
    });
    stage("grain", || {
        grain::apply(
            &mut scene,
            auto_model.grain_amount,
            auto_model.grain_size,
            auto_model.grain_roughness,
        )
    });
    stage("rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
    stage("srgb_gamma_encode", || {
        encode::srgb_gamma_encode(&mut scene)
    });
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    scene.assert_space(ColorSpace::DisplayEncodedSrgb);
    Ok(scene)
}
