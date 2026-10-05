//! Actual Auto outcome travels with the already-built chain (#4096).
use super::*;

/// Fit the Auto Profile curve + residual LUT against the embedded JPEG (the SAME
/// entry `apply_auto_profile` shares a cache with — see #924 / #972) and flatten
/// them into the `(profile_curve_flat, residual_lut_size, residual_lut_data)` shape
/// [`build_full_chain_inputs`] consumes. A `None` (Neutral, no preview, degenerate
/// fit) preserves the existing identity-artifact fallback. Reporting the achieved
/// fit does not change that tail or assert its pixel parity with Neutral.
/// The fit is keyed on the RAW BYTES (not the model), so after
/// the first call it is cache-served — re-running it per slider tick is cheap.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn fit_profile_artifacts_with_status(
    raw_img: &raw_core::image::RawImage,
    raw: &[u8],
    ext: &str,
    model: &AdjustmentModel,
) -> (Vec<f32>, usize, Vec<f32>, Option<bool>) {
    let (curve, lut) = match model.profile {
        // Preserve the existing GPU fit quality; this change only reports its outcome.
        Profile::Auto => fit_auto_profile_from_raw(
            raw_img,
            model,
            RenderQuality::Full,
            RawInput::Bytes { bytes: raw, ext },
        )
        .unwrap_or((None, None)),
        _ => (None, None),
    };
    let auto_fit = (model.profile == Profile::Auto).then_some(curve.is_some() || lut.is_some());
    let profile_curve_flat = curve
        .map(|c| c.to_flat())
        .unwrap_or_default();
    let (residual_lut_size, residual_lut_data) = match lut {
        Some(l) => (l.size, l.data),
        None => {
            let id = auto_profile::lut::ColorLut::identity(auto_profile::DEFAULT_LUT_SIZE);
            (id.size, id.data)
        }
    };
    (
        profile_curve_flat,
        residual_lut_size,
        residual_lut_data,
        auto_fit,
    )
}

/// Assemble the [`FullChainInputs`] for `model` from the RAW + the (cache-served)
/// Auto Profile fit. The view-tail-and-WB shape the live chain re-applies every
/// render; cheap (no decode, no GPU compile), so the persistent session rebuilds
/// it per tick from the latest model while reusing the uploaded prefix buffer.
///
/// `film_lut` / `film_lut_key` (epic #2683, Task 9) are the session-resident
/// baked film-look grid + its content-identity key — see
/// [`model::build_full_chain_inputs`]'s doc for why they ride alongside the
/// model instead of inside it. One-shot callers with no loaded look pass
/// `(None, 0)`.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn chain_inputs_with_status(
    raw_img: &raw_core::image::RawImage,
    raw: &[u8],
    ext: &str,
    model: &AdjustmentModel,
    film_lut: Option<&raw_core::film::FilmLut>,
    film_lut_key: u32,
    whites_anchor_ev: f32,
) -> (FullChainInputs<'static>, Option<bool>) {
    let (profile_curve_flat, residual_lut_size, residual_lut_data, auto_fit) =
        fit_profile_artifacts_with_status(raw_img, raw, ext, model);
    let inputs = build_full_chain_inputs(
        model,
        profile_curve_flat,
        residual_lut_size,
        residual_lut_data,
        // The decoded frame's own noise characterisation drives the NR stages'
        // per-pixel modulation on the GPU exactly as it does in `develop`
        // (#1714) — both read `RawImage::{noise_profile, iso}`.
        NoiseProfileInputs {
            profile: raw_img.noise_profile.clone().unwrap_or_default(),
            iso: raw_img.iso,
        },
        film_lut,
        film_lut_key,
        whites_anchor_ev,
    );
    (inputs, auto_fit)
}
