use super::*;

#[test]
fn negative_hdr_and_shadow_identity_preserve_scene_information() {
    let scene = [
        [-0.125, 0.0, 8.0],
        [65000.0, -1.0, 32000.0],
        [0.00001, 0.00002, 0.00003],
        [0.18; 3],
        [0.0; 3],
    ];
    let recipe = PhotographicContrast::fit(&scene).unwrap();
    let model = recipe.encode(&scene).unwrap();
    assert!(model.iter().flatten().all(|v| *v > 0.0 && *v < 1.0));
    let restored = recipe.decode(&model).unwrap();
    for (actual, expected) in restored.iter().zip(scene) {
        let limit = expected.into_iter().map(f32::abs).fold(1.0, f32::max) * 3e-6;
        for channel in 0..3 {
            assert!(
                (actual[channel] - expected[channel]).abs() <= limit,
                "{actual:?} != {expected:?}, limit {limit}"
            );
        }
    }
    assert!(restored[0][0] < 0.0 && restored[1][1] < 0.0);
    assert_eq!(model[4], [BLACK; 3]);
}

#[test]
fn neutral_ramp_is_monotonic_across_negative_black_and_hdr() {
    let scene: Vec<_> = (-1000..=1000)
        .map(|i| {
            let magnitude = (f32::from(i as i16).abs() / 100.0).exp_m1();
            // A neutral in the target linear-sRGB primaries. The shared
            // four-decimal Rec2020-to-sRGB matrix's row sums are not exact1.
            M_SRGB_TO_REC2020.mul_vec([magnitude.copysign(i as f32); 3])
        })
        .collect();
    let recipe = PhotographicContrast::fit(&scene).unwrap();
    let model = recipe.encode(&scene).unwrap();
    assert!(model.windows(2).all(|pair| pair[0][0] < pair[1][0]));
    for pixel in model {
        assert!((pixel[0] - pixel[1]).abs() < 1e-6);
        assert!((pixel[1] - pixel[2]).abs() < 1e-6);
    }
}

#[test]
fn recipe_serialization_replays_both_directions_exactly() {
    let scene = [[-0.1, 12.0, 0.0004], [0.03, 0.15, 0.9]];
    let recipe = PhotographicContrast::fit(&scene).unwrap();
    let loaded: PhotographicContrast =
        serde_json::from_str(&serde_json::to_string(&recipe).unwrap()).unwrap();
    let encoded = recipe.encode(&scene).unwrap();
    assert_eq!(encoded, loaded.encode(&scene).unwrap());
    assert_eq!(
        recipe.decode(&encoded).unwrap(),
        loaded.decode(&encoded).unwrap()
    );
}

#[test]
fn corrupt_recipes_and_out_of_domain_inputs_fail_closed() {
    let recipe = PhotographicContrast::fit(&[[0.0; 3]]).unwrap();
    for (key, value) in [
        ("method", serde_json::json!("unsupported")),
        ("high", serde_json::json!(0)),
    ] {
        let mut json = serde_json::to_value(&recipe).unwrap();
        json[key] = value;
        let corrupt: PhotographicContrast = serde_json::from_value(json).unwrap();
        assert!(corrupt.encode(&[[0.0; 3]]).is_err());
        assert!(corrupt.decode(&[[0.5; 3]]).is_err());
    }
    assert!(PhotographicContrast::fit(&[]).is_err());
    assert!(PhotographicContrast::fit(&[[f32::INFINITY; 3]]).is_err());
    assert!(recipe.encode(&[[32.0; 3]]).is_err());
    assert!(recipe.encode(&[[f32::NAN; 3]]).is_err());
    for value in [f32::NAN, f32::INFINITY, -0.01, 1.01] {
        assert!(recipe.decode(&[[value; 3]]).is_err());
    }
}

#[test]
fn flat_black_and_generated_endpoints_remain_finite_and_unclipped() {
    let recipe = PhotographicContrast::fit(&[[0.0; 3]; 8]).unwrap();
    assert_eq!(recipe.encode(&[[0.0; 3]]).unwrap(), vec![[BLACK; 3]]);
    let generated = recipe.decode(&[[0.0; 3], [1.0; 3]]).unwrap();
    assert!(generated[0].iter().all(|v| *v < 0.0));
    assert!(generated[1].iter().all(|v| *v > 1.0 && v.is_finite()));
}
