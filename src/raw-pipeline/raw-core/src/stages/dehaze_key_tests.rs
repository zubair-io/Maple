//! `haze_key` (#3287): which dehaze amounts a retained haze map depends on.
use super::*;
use crate::types::Point2;

#[test]
fn the_haze_key_ignores_amounts_no_retained_map_depends_on() {
    let layer = |dehaze: Option<f32>| {
        LocalAdjustment::radial(
            Point2::new(0.5, 0.5),
            Point2::new(0.3, 0.3),
            PartialAdjustments {
                dehaze,
                ..Default::default()
            },
        )
    };
    let model = |global: f32, first: Option<f32>, second: Option<f32>| AdjustmentModel {
        dehaze: global,
        local_adjustments: vec![layer(first), layer(second)],
        ..Default::default()
    };
    let key = |m: AdjustmentModel| haze_key(&m);
    // The last dehaze layer's amount feeds no map.
    assert_eq!(
        key(model(0.0, Some(20.0), Some(30.0))),
        key(model(0.0, Some(20.0), Some(-70.0)))
    );
    assert_eq!(
        key(model(0.0, None, Some(30.0))),
        key(model(0.0, None, Some(90.0)))
    );
    // An upstream layer's amount feeds the later layer's map.
    assert_ne!(
        key(model(0.0, Some(20.0), Some(30.0))),
        key(model(0.0, Some(60.0), Some(30.0)))
    );
    // The global amount feeds every layer's map, and no map without layers.
    assert_ne!(
        key(model(10.0, None, Some(30.0))),
        key(model(40.0, None, Some(30.0)))
    );
    assert_eq!(key(model(10.0, None, None)), key(model(-40.0, None, None)));
    // Engagement decides which maps exist, so it always changes the key.
    assert_ne!(
        key(model(0.0, None, Some(30.0))),
        key(model(0.0, None, None))
    );
    assert_ne!(key(model(10.0, None, None)), key(model(0.0, None, None)));
}

#[test]
fn the_haze_key_ignores_every_stage_downstream_of_the_last_map() {
    let base = AdjustmentModel {
        dehaze: 30.0,
        ..Default::default()
    };
    let key = |m: AdjustmentModel| haze_key(&m);
    for downstream in [
        AdjustmentModel {
            sharpen_amount: 80.0,
            ..base.clone()
        },
        AdjustmentModel {
            nr_luminance: 40.0,
            nr_color: 60.0,
            ..base.clone()
        },
        AdjustmentModel {
            vignette_amount: -50.0,
            ..base.clone()
        },
        AdjustmentModel {
            grain_amount: 25.0,
            ..base.clone()
        },
        AdjustmentModel {
            contrast: 30.0,
            whites: 20.0,
            ..base.clone()
        },
        AdjustmentModel {
            color_grade_midtone_hue: 120.0,
            split_tone_balance: 20.0,
            ..base.clone()
        },
        AdjustmentModel {
            defringe_purple_amount: 30.0,
            ..base.clone()
        },
        AdjustmentModel {
            local_adjustments: vec![LocalAdjustment::radial(
                Point2::new(0.5, 0.5),
                Point2::new(0.3, 0.3),
                PartialAdjustments {
                    exposure: Some(1.0),
                    ..Default::default()
                },
            )],
            ..base.clone()
        },
    ] {
        assert_eq!(key(downstream), key(base.clone()));
    }
    for upstream in [
        AdjustmentModel {
            exposure: 0.5,
            ..base.clone()
        },
        AdjustmentModel {
            clarity: 20.0,
            ..base.clone()
        },
        AdjustmentModel {
            saturation: 15.0,
            ..base.clone()
        },
        AdjustmentModel {
            temperature: 4200.0,
            ..base.clone()
        },
    ] {
        assert_ne!(key(upstream), key(base.clone()));
    }
    // With a dehaze layer, defringe and earlier layers run before its map.
    let layered = AdjustmentModel {
        local_adjustments: vec![LocalAdjustment::radial(
            Point2::new(0.5, 0.5),
            Point2::new(0.3, 0.3),
            PartialAdjustments {
                dehaze: Some(20.0),
                ..Default::default()
            },
        )],
        ..base.clone()
    };
    assert_ne!(
        key(AdjustmentModel {
            defringe_purple_amount: 30.0,
            ..layered.clone()
        }),
        key(layered.clone())
    );
    assert_eq!(
        key(AdjustmentModel {
            sharpen_amount: 80.0,
            ..layered.clone()
        }),
        key(layered)
    );
}

/// `hash_haze_layers` keeps exactly the layer part of `haze_key`, so a host
/// that hashes the flat wire agrees with every `haze_key` holder.
#[test]
fn hashing_the_flat_layers_agrees_with_the_haze_key() {
    let layer = |exposure: f32, adjustments: PartialAdjustments| {
        LocalAdjustment::radial(
            Point2::new(0.4, 0.5),
            Point2::new(0.3, 0.2),
            PartialAdjustments {
                exposure: Some(exposure),
                ..adjustments
            },
        )
    };
    let dehaze = |amount: f32| PartialAdjustments {
        dehaze: Some(amount),
        ..Default::default()
    };
    let stacks = [
        vec![layer(0.2, PartialAdjustments::default())],
        vec![layer(0.2, dehaze(30.0))],
        vec![layer(0.2, dehaze(-60.0))],
        vec![layer(0.5, dehaze(30.0))],
        vec![layer(
            0.2,
            PartialAdjustments {
                sharpness: Some(40.0),
                luminance_noise: Some(20.0),
                defringe: Some(10.0),
                ..dehaze(30.0)
            },
        )],
        vec![layer(
            0.2,
            PartialAdjustments {
                clarity: Some(25.0),
                ..dehaze(30.0)
            },
        )],
        vec![
            layer(0.2, dehaze(30.0)),
            layer(0.9, PartialAdjustments::default()),
        ],
        vec![layer(0.2, dehaze(10.0)), layer(0.9, dehaze(30.0))],
        vec![layer(0.2, dehaze(50.0)), layer(0.9, dehaze(30.0))],
        vec![layer(0.2, dehaze(50.0)), layer(0.9, dehaze(-5.0))],
    ];
    let hashed = |layers: &[LocalAdjustment]| {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        let any = hash_haze_layers(&crate::types::layers_to_flat(layers), &mut h);
        (any, std::hash::Hasher::finish(&h))
    };
    let keyed = |layers: &[LocalAdjustment]| {
        haze_key(&AdjustmentModel {
            local_adjustments: layers.to_vec(),
            ..Default::default()
        })
        .local_adjustments
    };
    for a in &stacks {
        for b in &stacks {
            assert_eq!(
                hashed(a) == hashed(b),
                keyed(a) == keyed(b),
                "{a:?} vs {b:?}"
            );
        }
        assert_eq!(hashed(a).0, !keyed(a).is_empty());
    }
}
