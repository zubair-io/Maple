use super::*;

#[test]
fn preserves_negative_hdr_and_shadow_channels() {
    let scene = [
        [-0.125, 0.0, 8.0],
        [65000.0, -1.0, 32000.0],
        [0.00001, 0.00002, 0.00003],
        [0.18; 3],
        [0.0; 3],
    ];
    let recipe = RemovalModelEncoding::fit(&scene).unwrap();
    let model = recipe.encode(&scene).unwrap();
    assert!(model
        .iter()
        .flatten()
        .all(|value| *value > 0.0 && *value < 1.0));
    let restored = recipe.decode(&model).unwrap();
    for (actual, expected) in restored.iter().zip(scene) {
        // Matrix cancellation makes per-channel relative error undefined
        // around zero. Bound absolute error relative to this RGB vector,
        // retaining a 2e-6 scene-unit floor for dark channels.
        let limit = expected.into_iter().map(f32::abs).fold(1.0, f32::max) * 2e-6;
        for channel in 0..3 {
            assert!(
                (actual[channel] - expected[channel]).abs() <= limit,
                "{actual:?} != {expected:?}, limit {limit}"
            );
        }
    }
    assert!(restored[0][0] < 0.0);
    assert!(restored[1][1] < 0.0);
}

#[test]
fn serialized_recipe_reproduces_exact_samples() {
    let scene = [[0.03, 0.15, 0.9], [-0.1, 12.0, 0.0004]];
    let recipe = RemovalModelEncoding::fit(&scene).unwrap();
    let encoded = recipe.encode(&scene).unwrap();
    let loaded: RemovalModelEncoding =
        serde_json::from_str(&serde_json::to_string(&recipe).unwrap()).unwrap();
    assert_eq!(encoded, loaded.encode(&scene).unwrap());
    assert_eq!(
        recipe.decode(&encoded).unwrap(),
        loaded.decode(&encoded).unwrap()
    );
}

#[test]
fn flat_black_context_and_generated_endpoints_are_finite() {
    let recipe = RemovalModelEncoding::fit(&[[0.0; 3]; 8]).unwrap();
    assert_eq!(recipe.encode(&[[0.0; 3]]).unwrap(), vec![[0.015; 3]]);
    let generated = recipe.decode(&[[0.0; 3], [1.0; 3]]).unwrap();
    assert!(generated[0].iter().all(|value| *value < 0.0));
    assert!(generated[1].iter().all(|value| *value > 1.0));
}

#[test]
fn corrupt_recipe_and_invalid_pixels_fail_closed() {
    for json in [
        r#"{"version":2,"low":0,"span":4}"#,
        r#"{"version":1,"low":0,"span":0}"#,
        r#"{"version":1,"low":2,"span":4}"#,
        r#"{"version":1,"low":-200,"span":204}"#,
    ] {
        let recipe: RemovalModelEncoding = serde_json::from_str(json).unwrap();
        assert!(recipe.encode(&[[0.0; 3]]).is_err());
        assert!(recipe.decode(&[[0.5; 3]]).is_err());
    }
    assert!(RemovalModelEncoding::fit(&[]).is_err());
    assert!(RemovalModelEncoding::fit(&[[f32::INFINITY; 3]]).is_err());
    let recipe = RemovalModelEncoding::fit(&[[0.0; 3]]).unwrap();
    for pixel in [[f32::NAN; 3], [-0.01; 3], [1.01; 3]] {
        assert!(recipe.decode(&[pixel]).is_err());
    }
    assert!(recipe.encode(&[[f32::NAN; 3]]).is_err());
    assert!(recipe.encode(&[[32.0; 3]]).is_err());
}
