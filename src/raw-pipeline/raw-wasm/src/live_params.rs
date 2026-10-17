//! The 19-scalar live ABI. Unsupported fields belong to the full XMP path.
use raw_core::xmp::AdjustmentModel;

pub(crate) fn model_from_params(params: &[f32]) -> AdjustmentModel {
    // The Web gate permits only canonical prefix fields on this ABI. Deriving
    // from the uploaded prefix would resurrect an edit the user just reset.
    let defaults = AdjustmentModel::default();
    let mut model =
        raw_core::gpu_host::model::stripped_prefix_model(&defaults, defaults.auto_exposure);

    model.exposure = params[0];
    model.brightness = params[1];
    model.contrast = params[2];
    model.highlights = params[3];
    model.shadows = params[4];
    model.whites = params[5];
    model.blacks = params[6];
    model.vibrance = params[7];
    model.saturation = params[8];
    model.temperature = params[9];
    model.tint = params[10];
    model.temperature_seen = true;
    model.tint_seen = true;
    model.clarity = params[11];
    model.texture = params[12];
    model.dehaze = params[13];
    model.vignette_amount = params[14];
    model.vignette_feather = params[15];
    model.grain_amount = params[16];
    model.grain_size = params[17];
    model.grain_roughness = params[18];

    model
}

#[cfg(test)]
mod tests {
    use super::*;
    use raw_core::gpu_host::model::{prefix_matches, stripped_prefix_model};
    use raw_core::types::adjustment::{HighlightRecoveryMode, Profile};
    use raw_core::types::local_adjustment::Point2;
    use raw_core::types::retouch::{RetouchKind, RetouchSpot};

    fn params() -> [f32; 19] {
        [
            1.5, 0.0, 12.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 5200.0, 11.0, 0.0, 0.0, 0.0, 0.0, 50.0,
            0.0, 25.0, 50.0,
        ]
    }

    #[test]
    fn clearing_a_repair_spot_replaces_the_pixels_with_the_default_prefix() {
        use raw_core::gpu_host::prepare::{develop_prefix_rgba, effective_ae_mode};
        use raw_core::test_support::synth_dng::SyntheticGreyDng;

        let bytes = SyntheticGreyDng {
            width: 64,
            height: 64,
            ..Default::default()
        }
        .write_to_bytes();
        let mut raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
        // A spatially varying sensor makes a clone spot observable in pixels.
        for (i, sample) in raw.raw_data.iter_mut().enumerate() {
            *sample = if i % 64 < 32 { 800 } else { 2400 };
        }
        let baseline = model_from_params(&params());
        let edited = AdjustmentModel {
            retouch_spots: vec![RetouchSpot::new(
                RetouchKind::Clone,
                Point2::new(0.25, 0.5),
                Point2::new(0.75, 0.5),
                0.1,
            )],
            ..baseline.clone()
        };
        let fresh = develop_prefix_rgba(&raw, &bytes, "dng", &baseline, 64).unwrap();
        let mut uploaded = develop_prefix_rgba(&raw, &bytes, "dng", &edited, 64).unwrap();
        assert_ne!(
            uploaded.0, fresh.0,
            "the spot must visibly change the sensor prefix"
        );
        let reset = model_from_params(&params());
        let ae = effective_ae_mode(&reset, &bytes, "dng");
        assert!(!prefix_matches(&reset, &uploaded.3, ae));
        uploaded = develop_prefix_rgba(&raw, &bytes, "dng", &reset, 64).unwrap();
        assert_eq!(
            uploaded, fresh,
            "reset must restore pixels and prefix metadata"
        );
        assert!(prefix_matches(&reset, &uploaded.3, ae));
    }

    #[test]
    fn scalar_drags_keep_the_same_default_prefix() {
        let baseline = AdjustmentModel::default();
        let cached = stripped_prefix_model(&baseline, baseline.auto_exposure);
        let model = model_from_params(&params());
        assert_eq!(model.sharpen_amount, 0.0);
        assert_eq!(model.nr_color, 0.0);
        assert!(prefix_matches(&model, &cached, model.auto_exposure));
    }

    #[test]
    fn reverting_prefix_edits_invalidates_the_uploaded_prefix() {
        let baseline = AdjustmentModel::default();
        let edits = [
            AdjustmentModel {
                profile: Profile::Neutral,
                ..baseline.clone()
            },
            AdjustmentModel {
                highlight_recovery: HighlightRecoveryMode::Off,
                ..baseline.clone()
            },
            AdjustmentModel {
                retouch_spots: vec![RetouchSpot::new(
                    RetouchKind::Clone,
                    Point2::new(0.25, 0.5),
                    Point2::new(0.75, 0.5),
                    0.05,
                )],
                ..baseline.clone()
            },
        ];
        for edited in edits {
            let cached = stripped_prefix_model(&edited, edited.auto_exposure);
            let reverted = model_from_params(&params());
            assert_eq!(reverted.profile, baseline.profile);
            assert_eq!(reverted.highlight_recovery, baseline.highlight_recovery);
            assert!(reverted.retouch_spots.is_empty());
            assert_eq!(reverted.exposure, 1.5);
            assert_eq!(reverted.temperature, 5200.0);
            assert!(reverted.temperature_seen && reverted.tint_seen);
            assert!(!prefix_matches(&reverted, &cached, reverted.auto_exposure));
        }
    }
}
