use crate::{
    film::FilmLut, image::RawImage, types::adjustment::AutoExposureMode,
    view::auto_profile::preview::ExtractedPreview, view::auto_profile::preview_vignetting,
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

/// The fit model for one RAW: [`fit_develop_model`] with the lens vignetting
/// scale set to what the embedded preview carries (#5791).
///
/// The fit pairs this develop against the preview pixel for pixel, so the
/// develop must carry the preview's illumination field. A bundled Lensfun
/// gain the preview lacks otherwise reads as scene tone, and the fitted tail
/// darkens the whole frame to cancel the bright corners. The scale is
/// measured from the RAW and its own preview
/// ([`preview_vignetting::scale`]), so the fit stays a function of the RAW
/// alone. Without a preview there is nothing to fit and the scale stays the
/// default.
pub fn fit_develop_model_for(
    model: &AdjustmentModel,
    raw: &RawImage,
    preview: Option<&ExtractedPreview>,
) -> AdjustmentModel {
    let pinned = fit_develop_model(model);
    match preview {
        Some(preview) => AdjustmentModel {
            lens_correction_vignetting: preview_vignetting::scale(raw, preview),
            ..pinned
        },
        None => pinned,
    }
}

pub(in crate::pipeline::render) fn uses_pinned_fit_pixels(
    active: &AdjustmentModel,
    pinned: AdjustmentModel,
    film: Option<&FilmLut>,
) -> bool {
    // Inactive film metadata cannot change the developed pixels or Auto route.
    (film.is_none() || active.film_strength <= 0.0)
        && *active
            == AdjustmentModel {
                film_look: active.film_look.clone(),
                film_strength: active.film_strength,
                ..pinned
            }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inactive_film_metadata_preserves_the_pinned_fit_route() {
        let film = FilmLut {
            size: 3,
            data: crate::view::auto_profile::lut::ColorLut::identity(3).data,
        };
        for look in ["", "selected-look"] {
            for strength in [-1., 0., 0.001, 100.] {
                let model = AdjustmentModel {
                    film_look: look.into(),
                    film_strength: strength,
                    auto_exposure: AutoExposureMode::Off,
                    ..Default::default()
                };
                let pinned = fit_develop_model(&model);
                assert!(uses_pinned_fit_pixels(&model, pinned.clone(), None));
                assert_eq!(
                    uses_pinned_fit_pixels(&model, pinned, Some(&film)),
                    strength <= 0.0
                );
                let edited = AdjustmentModel {
                    exposure: 1.0,
                    ..model
                };
                for supplied in [None, Some(&film)] {
                    assert!(!uses_pinned_fit_pixels(
                        &edited,
                        fit_develop_model(&edited),
                        supplied
                    ));
                }
            }
        }
    }

    /// #5791: the fit develops at the lens vignetting scale the embedded
    /// preview carries. When that is not the scale the render uses, the
    /// render buffer is not the fit buffer; the render at the preview's own
    /// scale is.
    #[test]
    fn the_fit_model_carries_the_previews_lens_vignetting() {
        use crate::image::CfaPattern;
        use crate::view::auto_profile::preview_vignetting::tests::{frame, preview};

        let raw = frame(CfaPattern::Rggb);
        let model = AdjustmentModel {
            auto_exposure: AutoExposureMode::Off,
            exposure: 1.0,
            ..Default::default()
        };
        assert_eq!(
            fit_develop_model_for(&model, &raw, None),
            fit_develop_model(&model),
            "no preview: nothing to fit, nothing to measure"
        );
        let carried = fit_develop_model_for(&model, &raw, Some(&preview(&raw, 1.0)));
        assert_eq!(carried, fit_develop_model(&model));

        let lacking = fit_develop_model_for(&model, &raw, Some(&preview(&raw, 0.0)));
        assert_eq!(
            lacking,
            AdjustmentModel {
                lens_correction_vignetting: 0.0,
                ..fit_develop_model(&model)
            },
            "only the lens vignetting scale follows the preview"
        );
        let default_render = fit_develop_model(&model);
        assert!(!uses_pinned_fit_pixels(
            &default_render,
            lacking.clone(),
            None
        ));
        assert!(uses_pinned_fit_pixels(&lacking.clone(), lacking, None));
    }
}
