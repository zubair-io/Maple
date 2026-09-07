//! Which Bayer kernel a full-resolution render should actually run (#3413).
//!
//! Before this module the answer was a constant per quality level: the
//! on-screen path ran RCD and export ran AMaZE, whatever the frame was. A
//! 12800-ISO handheld frame therefore got exactly the same treatment as a
//! tripod-mounted base-ISO landscape, even though the two want opposite
//! things from a demosaic — the landscape wants every last cycle of detail
//! resolved, and the ISO-12800 frame wants the reconstruction to stop
//! believing its own noise.
//!
//! ## The rule
//!
//! A user who has picked a kernel by hand always gets that kernel
//! ([`crate::types::DemosaicChoice`], `papp:Demosaic`, default `Auto`).
//! Otherwise:
//!
//! 1. **Noisy frame → LMMSE.** The only kernel here with an explicit noise
//!    model. "Noisy" is decided from the DNG `NoiseProfile` when the file
//!    carries one — the sensor's own measured variance, which is the honest
//!    signal — and falls back to a plain ISO threshold when it does not.
//! 2. **Large frame → dual AMaZE + VNG4.** Detail where there is detail,
//!    quiet where there is not.
//! 3. **Small frame → AMaZE alone.** The dual mode's second kernel is a real
//!    cost, and on a frame small enough that the whole demosaic is already
//!    cheap, paying it buys a difference measured over too few pixels to
//!    matter.
//!
//! Note what is *not* here: nothing looks at whether the frame "seems"
//! detailed. That decision is per-pixel and belongs to [`super::dual`]'s
//! contrast mask, which measures it directly. This module only picks which
//! pair of kernels the mask gets to choose between.

use super::DemosaicAlgorithm;
use crate::image::RawImage;
use crate::types::DemosaicChoice;

/// Scene-linear signal level at which the noise profile is evaluated. Mid
/// grey is where a viewer's eye lands and where the profile's linear
/// variance model (`variance = scale · signal + offset`) is best
/// conditioned: at black the offset term dominates and tells you about read
/// noise rather than the frame, and at clipping there is no noise to speak
/// of because the samples are pinned.
const MID_GREY: f32 = 0.18;

/// Noise standard deviation at mid grey, in normalised `[0, 1]` scene
/// units, at or above which the automatic selection switches to LMMSE.
///
/// 0.008 is 0.8 % of full scale. On a current full-frame body that is
/// roughly ISO 3200: base ISO measures around 0.0015, and the profile's
/// scale term grows linearly with the analogue gain, so eight ISO doublings
/// from 100 land in this neighbourhood. Below it the detail-first kernels'
/// noiseless-sample premise still broadly holds and they resolve more; above
/// it they are amplifying read noise into maze patterning, which is exactly
/// what LMMSE's shrinkage suppresses.
pub const LMMSE_SIGMA_MID_GREY: f32 = 0.008;

/// ISO at or above which the automatic selection switches to LMMSE **when
/// the file carries no usable noise profile**.
///
/// Most vendor RAW formats ship no `NoiseProfile` tag at all, so this is the
/// common path rather than the exotic one. It is deliberately not derived
/// from [`LMMSE_SIGMA_MID_GREY`] through a synthetic noise model: that model
/// (`crate::stages::nlm`'s fallback) is calibrated for a denoiser's strength
/// knob, not for absolute variance, and reading an absolute threshold off it
/// would be a guess dressed as a measurement. A stated ISO is at least a
/// number the camera actually reported.
pub const LMMSE_ISO_FALLBACK: u32 = 3200;

/// Sensor pixel count at or above which the automatic selection uses the
/// dual mode rather than AMaZE alone.
///
/// 20 MP. The dual mode's cost is one extra VNG4 pass over the whole frame
/// plus the mask; on the 100 MP reference that is worth paying because the
/// flat regions it fixes are hundreds of megapixels of sky per shoot, and on
/// a 12 MP frame the same flat regions are small enough that AMaZE's
/// artefacts in them are already at the edge of visibility while the extra
/// pass is pure cost.
pub const DUAL_MIN_PIXELS: u64 = 20_000_000;

/// Mean per-plane noise standard deviation at mid grey, from a DNG
/// `NoiseProfile`.
///
/// The tag stores `(scale, offset)` pairs — one per colour plane, so six
/// floats for an R/G/B profile and eight when the two greens are profiled
/// separately — defining `variance = scale · signal + offset`. Returns
/// `None` for a profile too short to carry even one pair, which is how a
/// truncated or unparsed tag falls through to the ISO rule rather than
/// asserting a noise level it does not know.
///
/// The planes are averaged rather than maximised: the red and blue planes
/// are always the noisiest (they collect a quarter of the sites and take
/// the largest white-balance gain), so maximising would classify a frame by
/// its worst channel and pull the threshold effectively a stop lower than
/// it reads.
pub fn mid_grey_sigma(profile: &[f32]) -> Option<f32> {
    let planes = profile.len() / 2;
    if planes == 0 {
        return None;
    }
    let total: f32 = (0..planes)
        .map(|k| {
            (profile[2 * k] * MID_GREY + profile[2 * k + 1])
                .max(0.0)
                .sqrt()
        })
        .sum();
    Some(total / planes as f32)
}

/// Whether this frame's noise level puts it in LMMSE's territory.
pub fn is_high_noise(iso: u32, noise_profile: Option<&[f32]>) -> bool {
    match noise_profile.and_then(mid_grey_sigma) {
        Some(sigma) => sigma >= LMMSE_SIGMA_MID_GREY,
        None => iso >= LMMSE_ISO_FALLBACK,
    }
}

/// The kernel the automatic policy picks for a frame with these facts.
pub fn auto_algorithm(iso: u32, noise_profile: Option<&[f32]>, pixels: u64) -> DemosaicAlgorithm {
    if is_high_noise(iso, noise_profile) {
        return DemosaicAlgorithm::Lmmse;
    }
    if pixels >= DUAL_MIN_PIXELS {
        return DemosaicAlgorithm::DualAmazeVng4;
    }
    DemosaicAlgorithm::Amaze
}

/// Resolve the user's [`DemosaicChoice`] against a decoded frame.
///
/// `fallback` is the kernel this render path would have run before #3413 —
/// RCD for the on-screen full-resolution path, AMaZE for export — and is
/// what a `choice` of `Auto` returns on any path that has not opted into the
/// noise-adaptive selection; `crate::pipeline::bayer_kernel` is what
/// decides whether a given path's fallback is a fixed kernel or
/// [`auto_algorithm`]'s verdict.
pub fn resolve_algorithm(choice: DemosaicChoice, fallback: DemosaicAlgorithm) -> DemosaicAlgorithm {
    match choice {
        DemosaicChoice::Auto => fallback,
        DemosaicChoice::Amaze => DemosaicAlgorithm::Amaze,
        DemosaicChoice::Rcd => DemosaicAlgorithm::Rcd,
        DemosaicChoice::DualAmaze => DemosaicAlgorithm::DualAmazeVng4,
        DemosaicChoice::DualRcd => DemosaicAlgorithm::DualRcdVng4,
        DemosaicChoice::Lmmse => DemosaicAlgorithm::Lmmse,
    }
}

/// The frame's own pixel count, as [`auto_algorithm`] wants it.
pub fn sensor_pixels(raw: &RawImage) -> u64 {
    raw.width as u64 * raw.height as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Representative full-frame `NoiseProfile` pairs, scaled by the
    /// analogue gain: the scale term is linear in ISO, the offset
    /// quadratic (it is a variance, and read noise referred to the signal
    /// scales with the gain).
    fn profile_at(iso: u32) -> Vec<f32> {
        let g = iso as f32 / 100.0;
        let (scale, offset) = (1.2e-5 * g, 4.0e-8 * g * g);
        vec![scale, offset, scale, offset, scale, offset]
    }

    #[test]
    fn mid_grey_sigma_is_none_for_a_truncated_profile() {
        assert!(mid_grey_sigma(&[]).is_none());
        assert!(mid_grey_sigma(&[1.0]).is_none());
    }

    #[test]
    fn mid_grey_sigma_reads_the_variance_model() {
        // variance = scale·0.18 + offset, so a scale of 1/0.18 with no
        // offset is exactly unit variance.
        let sigma = mid_grey_sigma(&[1.0 / MID_GREY, 0.0]).unwrap();
        assert!((sigma - 1.0).abs() < 1e-6, "{sigma}");
    }

    #[test]
    fn base_iso_is_not_high_noise_and_deep_iso_is() {
        assert!(!is_high_noise(100, Some(&profile_at(100))));
        assert!(!is_high_noise(800, Some(&profile_at(800))));
        assert!(is_high_noise(6400, Some(&profile_at(6400))));
        assert!(is_high_noise(12800, Some(&profile_at(12800))));
    }

    #[test]
    fn without_a_profile_the_iso_threshold_decides() {
        assert!(!is_high_noise(LMMSE_ISO_FALLBACK - 1, None));
        assert!(is_high_noise(LMMSE_ISO_FALLBACK, None));
    }

    #[test]
    fn a_present_profile_outranks_the_iso_number() {
        // A clean sensor that reports a high ISO stays on the detail-first
        // kernels, because the measured variance says it can.
        assert!(!is_high_noise(12800, Some(&profile_at(100))));
    }

    #[test]
    fn auto_picks_lmmse_dual_or_amaze_by_noise_then_size() {
        let big = DUAL_MIN_PIXELS;
        let small = DUAL_MIN_PIXELS - 1;
        assert_eq!(
            auto_algorithm(12800, None, big),
            DemosaicAlgorithm::Lmmse,
            "noise outranks size"
        );
        assert_eq!(
            auto_algorithm(12800, None, small),
            DemosaicAlgorithm::Lmmse,
            "noise outranks size on a small frame too"
        );
        assert_eq!(
            auto_algorithm(100, Some(&profile_at(100)), big),
            DemosaicAlgorithm::DualAmazeVng4
        );
        assert_eq!(
            auto_algorithm(100, Some(&profile_at(100)), small),
            DemosaicAlgorithm::Amaze
        );
    }

    #[test]
    fn every_manual_choice_maps_to_its_own_kernel() {
        let cases = [
            (DemosaicChoice::Amaze, DemosaicAlgorithm::Amaze),
            (DemosaicChoice::Rcd, DemosaicAlgorithm::Rcd),
            (DemosaicChoice::DualAmaze, DemosaicAlgorithm::DualAmazeVng4),
            (DemosaicChoice::DualRcd, DemosaicAlgorithm::DualRcdVng4),
            (DemosaicChoice::Lmmse, DemosaicAlgorithm::Lmmse),
        ];
        for (choice, expected) in cases {
            assert_eq!(
                resolve_algorithm(choice, DemosaicAlgorithm::Rcd),
                expected,
                "{choice:?}"
            );
        }
    }

    #[test]
    fn auto_defers_to_the_paths_own_fallback() {
        for fallback in [DemosaicAlgorithm::Rcd, DemosaicAlgorithm::Amaze] {
            assert_eq!(resolve_algorithm(DemosaicChoice::Auto, fallback), fallback);
        }
    }
}
