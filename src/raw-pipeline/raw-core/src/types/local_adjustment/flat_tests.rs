//! Unit tests for the flat layer wire — a sibling file so `flat.rs` itself
//! stays inside the 600-line source budget (`CONTRIBUTING.md`), the same
//! split `stages/local_adjustments/tests_hue_range.rs` uses.

use super::*;

fn all_controls() -> PartialAdjustments {
    PartialAdjustments {
        exposure: Some(0.75),
        contrast: Some(-30.0),
        highlights: Some(45.0),
        shadows: Some(-12.5),
        whites: Some(8.0),
        blacks: Some(-60.0),
        saturation: Some(22.0),
        vibrance: Some(-5.0),
        temperature: Some(1500.0),
        tint: Some(-9.0),
        hue: Some(12.0),
        texture: Some(18.0),
        clarity: Some(-24.0),
        dehaze: Some(31.0),
        sharpness: Some(66.0),
        luminance_noise: Some(40.0),
        defringe: Some(75.0),
    }
}

#[test]
fn hue_rides_slot_22_with_presence_bit_10() {
    let layers = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        PartialAdjustments {
            hue: Some(-42.5),
            ..Default::default()
        },
    )];
    let flat = layers_to_flat(&layers);
    assert_eq!(flat[22], -42.5);
    assert_eq!(flat[8] as u32, PRESENT_HUE);
    assert_eq!(layers_from_flat(&flat, &[])[0].adjustments.hue, Some(-42.5));
}

#[test]
fn linear_layer_round_trips() {
    let layers = vec![LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.125, 0.25),
            end: Point2::new(0.875, 0.75),
            feather: 0.375,
        },
        range: None,
        adjustments: all_controls(),
    }];
    let flat = layers_to_flat(&layers);
    assert_eq!(flat.len(), LAYER_FLAT_LEN);
    assert_eq!(layers_from_flat(&flat, &[]), layers);
}

#[test]
fn radial_layer_round_trips_including_invert_and_angle() {
    let layers = vec![LocalAdjustment {
        mask: Mask::Radial {
            center: Point2::new(0.4, 0.6),
            radii: Point2::new(0.3, 0.2),
            angle: 1.25,
            feather: 0.5,
            invert: true,
        },
        range: None,
        adjustments: all_controls(),
    }];
    let flat = layers_to_flat(&layers);
    assert_eq!(layers_from_flat(&flat, &[]), layers);
}

#[test]
fn absent_controls_stay_absent_and_are_distinct_from_zero() {
    let sparse = PartialAdjustments {
        saturation: Some(0.0),
        ..Default::default()
    };
    let layers = vec![LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.0),
            end: Point2::new(1.0, 1.0),
            feather: 0.5,
        },
        range: None,
        adjustments: sparse,
    }];
    let back = layers_from_flat(&layers_to_flat(&layers), &[]);
    assert_eq!(back[0].adjustments.saturation, Some(0.0));
    assert_eq!(back[0].adjustments.vibrance, None);
    assert_eq!(back[0].adjustments.exposure, None);
    assert_eq!(back[0].adjustments.temperature, None);
}

#[test]
fn presence_mask_is_exactly_representable_when_every_field_is_set() {
    let layers = vec![LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.5),
            end: Point2::new(1.0, 0.5),
            feather: 0.0,
        },
        range: None,
        adjustments: all_controls(),
    }];
    let flat = layers_to_flat(&layers);
    // Seventeen controls → bits 0..16 all set. 131071 is far below 2^24,
    // so the f32 slot still carries it exactly.
    assert_eq!(flat[8], 131_071.0);
    assert_eq!(flat[8] as u32, 131_071);
}

#[test]
fn spatial_controls_ride_slots_32_to_37_with_presence_bits_11_to_16() {
    let layers = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        PartialAdjustments {
            texture: Some(18.0),
            clarity: Some(-24.0),
            dehaze: Some(31.0),
            sharpness: Some(66.0),
            luminance_noise: Some(40.0),
            defringe: Some(75.0),
            ..Default::default()
        },
    )];
    let flat = layers_to_flat(&layers);
    assert_eq!(&flat[32..38], &[18.0, -24.0, 31.0, 66.0, 40.0, 75.0]);
    assert_eq!(
        flat[8] as u32,
        PRESENT_TEXTURE
            | PRESENT_CLARITY
            | PRESENT_DEHAZE
            | PRESENT_SHARPNESS
            | PRESENT_LUMINANCE_NOISE
            | PRESENT_DEFRINGE
    );
    assert_eq!(&flat[38..40], &[0.0, 0.0], "tail padding stays zeroed");
    assert_eq!(layers_from_flat(&flat, &[]), layers);
}

#[test]
fn absent_spatial_controls_stay_absent_and_are_distinct_from_zero() {
    let layers = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        PartialAdjustments {
            clarity: Some(0.0),
            ..Default::default()
        },
    )];
    let back = layers_from_flat(&layers_to_flat(&layers), &[]);
    assert_eq!(back[0].adjustments.clarity, Some(0.0));
    assert_eq!(back[0].adjustments.texture, None);
    assert_eq!(back[0].adjustments.dehaze, None);
    assert_eq!(back[0].adjustments.sharpness, None);
    assert_eq!(back[0].adjustments.luminance_noise, None);
    assert_eq!(back[0].adjustments.defringe, None);
}

/// The #3407 append kept every pre-existing slot where it was: a record
/// written by a reader that only knew the 32-float layout still decodes
/// to the same point controls when read at the 40-float stride.
#[test]
fn appending_the_spatial_block_left_the_first_32_slots_untouched() {
    let layer = LocalAdjustment {
        mask: Mask::Radial {
            center: Point2::new(0.4, 0.6),
            radii: Point2::new(0.3, 0.2),
            angle: 1.25,
            feather: 0.5,
            invert: true,
        },
        range: Some(RangeRefinement::Color {
            hue_deg: 55.0,
            hue_half_width_deg: 25.0,
            chroma_min: 0.02,
            l_min: 0.15,
            l_max: 0.95,
            feather: 0.3,
        }),
        adjustments: PartialAdjustments {
            exposure: Some(0.75),
            shadows: Some(-12.5),
            hue: Some(12.0),
            ..Default::default()
        },
    };
    let flat = layers_to_flat(&[layer]);
    assert_eq!(&flat[0..8], &[0.4, 0.6, 0.3, 0.2, 0.5, 1.25, 1.0, 1.0]);
    assert_eq!(flat[12], 0.75);
    assert_eq!(flat[15], -12.5);
    assert_eq!(flat[22], 12.0);
    assert_eq!(&flat[24..31], &[1.0, 55.0, 25.0, 0.02, 0.15, 0.95, 0.3]);
}

#[test]
fn multiple_layers_keep_their_order() {
    let layers = vec![
        LocalAdjustment::linear(
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            PartialAdjustments {
                exposure: Some(1.0),
                ..Default::default()
            },
        ),
        LocalAdjustment::radial(
            Point2::new(0.5, 0.5),
            Point2::new(0.2, 0.2),
            PartialAdjustments {
                exposure: Some(-1.0),
                ..Default::default()
            },
        ),
    ];
    let back = layers_from_flat(&layers_to_flat(&layers), &[]);
    assert_eq!(back, layers);
}

#[test]
fn empty_stack_serializes_to_an_empty_wire() {
    assert!(layers_to_flat(&[]).is_empty());
    assert!(layers_from_flat(&[], &[]).is_empty());
}

#[test]
fn truncated_wire_drops_the_partial_tail_layer() {
    let layers = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        },
    )];
    let mut flat = layers_to_flat(&layers);
    flat.extend_from_slice(&[0.0; 5]);
    assert_eq!(layers_from_flat(&flat, &[]).len(), 1);
}

#[test]
fn record_is_40_floats_and_range_rides_slots_24_to_30() {
    let mut layer = LocalAdjustment::linear(
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        PartialAdjustments {
            exposure: Some(0.5),
            ..Default::default()
        },
    );
    layer.range = Some(RangeRefinement::Color {
        hue_deg: 55.0,
        hue_half_width_deg: 25.0,
        chroma_min: 0.02,
        l_min: 0.15,
        l_max: 0.95,
        feather: 0.3,
    });
    let flat = layers_to_flat(&[layer.clone()]);
    assert_eq!(LAYER_FLAT_LEN, 40);
    assert_eq!(flat.len(), 40);
    assert_eq!(&flat[24..31], &[1.0, 55.0, 25.0, 0.02, 0.15, 0.95, 0.3]);
    assert_eq!(layers_from_flat(&flat, &[]), vec![layer]);
}

#[test]
fn absent_range_reads_back_as_none() {
    let layer = LocalAdjustment::linear(
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        PartialAdjustments::default(),
    );
    let flat = layers_to_flat(&[layer]);
    assert_eq!(flat[24], RANGE_KIND_NONE);
    assert_eq!(layers_from_flat(&flat, &[])[0].range, None);
}

/// Pins layer 0 of `test-fixtures/local-adjustments/layer-stack.json`
/// (linear, exposure+shadows) against the same slots
/// `LocalAdjustmentFlatTests.testFixtureLayerStackRoundTripsThroughTheFlatWire`
/// asserts on the Swift side (#3274) — one JSON fixture, two writers.
#[test]
fn the_shared_swift_fixture_serializes_to_the_documented_slots() {
    let layer = LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.1, 0.2),
            end: Point2::new(0.9, 0.8),
            feather: 0.4,
        },
        range: None,
        adjustments: PartialAdjustments {
            exposure: Some(0.5),
            shadows: Some(-20.0),
            ..Default::default()
        },
    };
    let flat = layers_to_flat(&[layer]);
    assert_eq!(&flat[0..5], &[0.1, 0.2, 0.9, 0.8, 0.4]);
    assert_eq!(flat[12], 0.5); // exposure
    assert_eq!(flat[15], -20.0); // shadows
}
