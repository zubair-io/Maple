use crate::{film::FilmLut, types::adjustment::AutoExposureMode, xmp::AdjustmentModel};

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
}
