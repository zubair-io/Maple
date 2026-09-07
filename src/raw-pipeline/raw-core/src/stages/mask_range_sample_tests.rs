//! Tests for [`super`] — the colour-range eyedropper (#362). The seed's one
//! contract is that the colour the photographer clicked is INSIDE the range
//! it seeds, so every case checks the seeded range's weight on the sampled
//! pixel through the stage's own evaluator rather than asserting numbers.

use super::*;
use crate::color::oklab::oklab_to_rec2020;
use crate::stages::local_adjustments::range;
use crate::test_support::synth_dng::SyntheticGreyDng;
use crate::types::SKIN_TONE_RANGE;

fn probe_of(rgb: [f32; 3]) -> Image {
    let mut probe = Image::new(16, 16, ColorSpace::SceneLinearRec2020);
    probe.pixels.iter_mut().for_each(|px| *px = rgb);
    probe
}

/// Scene-linear Rec.2020 for an Oklab (L, C, hue°) triple.
fn rgb_of(l: f32, c: f32, hue_deg: f32) -> [f32; 3] {
    let h = hue_deg.to_radians();
    oklab_to_rec2020([l, c * h.cos(), c * h.sin()])
}

/// A sampled colour lands at weight 1 in the range it seeds, whatever the
/// layer's band width and feather — the reason the seed exists.
#[test]
fn seed_lands_at_full_weight() {
    for (l, c, hue) in [
        (0.5, 0.15, 55.0),
        (0.3, 0.05, -120.0),
        (0.9, 0.2, 100.0),
        (0.06, 0.021, 179.0),
        (0.95, 0.03, -179.9),
        (0.5, 0.0201, 0.0),
    ] {
        let rgb = rgb_of(l, c, hue);
        let sample = sample_from_probe(&probe_of(rgb), 0.5, 0.5).unwrap();
        let seed = RangeSeed::from_sample(&sample);
        for base in [
            SKIN_TONE_RANGE,
            RangeRefinement::Color {
                hue_deg: 0.0,
                hue_half_width_deg: 5.0,
                chroma_min: 0.3,
                l_min: 0.9,
                l_max: 0.91,
                feather: 1.0,
            },
        ] {
            let seeded = base.with_seed(&seed);
            assert_eq!(
                range::weight(&seeded, rgb),
                1.0,
                "({l}, {c}, {hue}) seeded {seed:?} into {seeded:?}"
            );
        }
    }
}

/// Only the four seeded coordinates move; width and feather are the user's.
#[test]
fn seed_keeps_band_width_and_feather() {
    let seed = RangeSeed {
        hue_deg: 210.0,
        chroma_min: 0.05,
        l_min: 0.1,
        l_max: 0.6,
    };
    assert_eq!(
        SKIN_TONE_RANGE.with_seed(&seed),
        RangeRefinement::Color {
            hue_deg: 210.0,
            hue_half_width_deg: 25.0,
            chroma_min: 0.05,
            l_min: 0.1,
            l_max: 0.6,
            feather: 0.3,
        }
    );
}

/// The seed is already on the two-decimal wire grid every writer emits.
#[test]
fn seed_is_quantised_to_the_wire() {
    let seed = RangeSeed::from_sample(&RangeSample {
        hue_deg: 54.5678,
        chroma: 0.0777,
        l: 0.4321,
    });
    assert_eq!(seed.hue_deg, 54.57);
    assert_eq!(seed.chroma_min, 0.03); // floor(0.03885)
    assert_eq!(seed.l_min, 0.18); // floor(0.1821)
    assert_eq!(seed.l_max, 0.69); // ceil(0.6821)
}

#[test]
fn seed_clamps_the_lightness_window_to_the_slider_domain() {
    let dark = RangeSeed::from_sample(&RangeSample {
        hue_deg: 0.0,
        chroma: 0.1,
        l: 0.1,
    });
    assert_eq!((dark.l_min, dark.l_max), (0.0, 0.35));
    let bright = RangeSeed::from_sample(&RangeSample {
        hue_deg: 0.0,
        chroma: 0.1,
        l: 0.9,
    });
    assert_eq!((bright.l_min, bright.l_max), (0.65, 1.0));
}

#[test]
fn sample_reads_oklab_hue_chroma_and_lightness() {
    let s = sample_from_probe(&probe_of(rgb_of(0.6, 0.12, 30.0)), 0.5, 0.5).unwrap();
    assert!((s.hue_deg - 30.0).abs() < 0.05, "{s:?}");
    assert!((s.chroma - 0.12).abs() < 1e-3, "{s:?}");
    assert!((s.l - 0.6).abs() < 1e-3, "{s:?}");
}

#[test]
fn a_neutral_surface_is_rejected() {
    assert_eq!(
        sample_from_probe(&probe_of([0.18, 0.18, 0.18]), 0.5, 0.5),
        Err(RangeSampleError::Neutral)
    );
}

#[test]
fn a_black_surface_is_rejected() {
    assert_eq!(
        sample_from_probe(&probe_of(rgb_of(0.02, 0.05, 40.0)), 0.5, 0.5),
        Err(RangeSampleError::TooDark)
    );
}

#[test]
fn a_point_outside_the_image_is_rejected() {
    let raw = SyntheticGreyDng::default().with_hasselblad_dcp();
    let raw = crate::decode::decode_bytes(&raw.write_to_bytes(), "dng").unwrap();
    for (nx, ny) in [(-0.01, 0.5), (1.01, 0.5), (0.5, -0.2), (0.5, 1.5)] {
        assert_eq!(
            sample_mask_range(&raw, &AdjustmentModel::default(), nx, ny),
            Err(RangeSampleError::OutsideImage),
            "({nx}, {ny})"
        );
    }
}

/// End to end through the real develop: a grey field under the camera's
/// own light is neutral wherever it is clicked.
#[test]
fn grey_field_develops_and_reads_neutral() {
    let raw = SyntheticGreyDng {
        linear_value: 0.18,
        ..SyntheticGreyDng::default()
    }
    .with_hasselblad_dcp();
    let raw = crate::decode::decode_bytes(&raw.write_to_bytes(), "dng").unwrap();
    assert_eq!(
        sample_mask_range(&raw, &AdjustmentModel::default(), 0.5, 0.5),
        Err(RangeSampleError::Neutral)
    );
}

/// The stage-input model strips the stack and everything downstream of it
/// and nothing else — the sample must track the upstream edits.
#[test]
fn stage_input_model_strips_only_the_stack_and_its_downstream() {
    let mut model = AdjustmentModel::default();
    model.exposure = 1.5;
    model.temperature = 4000.0;
    model.dehaze = 30.0;
    model.vignette_amount = -50.0;
    model.sharpen_amount = 80.0;
    model.nr_luminance = 20.0;
    model.nr_color = 40.0;
    model.local_adjustments = vec![crate::types::LocalAdjustment {
        mask: crate::types::Mask::Everywhere,
        range: Some(SKIN_TONE_RANGE),
        adjustments: crate::types::PartialAdjustments::default(),
    }];
    let probe = stage_input_model(&model);
    assert_eq!(probe.exposure, 1.5);
    assert_eq!(probe.temperature, 4000.0);
    assert_eq!(probe.dehaze, 30.0);
    assert!(probe.local_adjustments.is_empty());
    assert_eq!(probe.vignette_amount, 0.0);
    assert_eq!(probe.sharpen_amount, 0.0);
    assert_eq!(probe.nr_luminance, 0.0);
    assert_eq!(probe.nr_color, 0.0);
}
