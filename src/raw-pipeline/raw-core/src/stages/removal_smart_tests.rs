use super::*;
use serde_json::json;

fn request() -> serde_json::Value {
    json!({"schema":1,"source_width":4096,"source_height":2048,
        "window":{"x":100,"y":200,"width":2048,"height":1024},
        "input_width":1024,"input_height":512,
        "prompts":[{"position":[1125.0/4096.0,713.0/2048.0],"label":1},
            {"position":[1325.0/4096.0,713.0/2048.0],"label":0}]})
}

fn logits() -> Vec<f32> {
    vec![-1.0; CANDIDATES * SIDE * SIDE]
}

fn rectangle(
    values: &mut [f32],
    candidate: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) {
    for py in y..y + height {
        values[candidate * SIDE * SIDE + py * SIDE + x
            ..candidate * SIDE * SIDE + py * SIDE + x + width]
            .fill(1.0);
    }
}

#[test]
fn prompts_keep_both_labels_and_pad_without_distorting_aspect() {
    let model: serde_json::Value =
        serde_json::from_str(&model_prompts_json(&request().to_string()).unwrap()).unwrap();
    assert_eq!(model["labels"], json!([1, 0, -1]));
    assert_eq!(
        model["points"],
        json!([[512.0, 256.0], [612.0, 256.0], [0.0, 0.0]])
    );
}

#[test]
fn negative_point_overrides_higher_model_score_and_native_mask_has_exact_mapping() {
    let mut values = logits();
    rectangle(&mut values, 0, 500, 250, 120, 20); // violates keep prompt
    rectangle(&mut values, 1, 500, 250, 20, 20);
    let bytes =
        mask_from_logits_json(&request().to_string(), &values, &[0.99, 0.7, 0.0, 0.0]).unwrap();
    assert_eq!(
        candidate_choice_json(&request().to_string(), &values, &[0.99, 0.7, 0.0, 0.0]).unwrap(),
        1
    );
    let mask = crate::pipeline::removal_mask_from_bytes(&bytes).unwrap();
    assert_eq!(
        [mask.x, mask.y, mask.width, mask.height],
        [1100, 700, 40, 40]
    );
    assert_eq!(mask.pixels, vec![255; 1600]);
}

#[test]
fn no_prompt_satisfying_proposal_is_an_error_not_an_empty_replacement() {
    let mut values = logits();
    for i in 0..4 {
        rectangle(&mut values, i, 500, 250, 120, 20);
    }
    assert!(
        mask_from_logits_json(&request().to_string(), &values, &[0.9; 4])
            .unwrap_err()
            .contains("no candidate")
    );
    assert!(candidate_choice_json(&request().to_string(), &values, &[0.9; 4]).is_err());
}

#[test]
fn padding_cannot_create_native_intent_and_invalid_shapes_fail() {
    let mut values = logits();
    rectangle(&mut values, 1, 500, 250, 20, 20);
    rectangle(&mut values, 1, 0, 600, 1024, 10);
    let req = request().to_string();
    let mask = crate::pipeline::removal_mask_from_bytes(
        &mask_from_logits_json(&req, &values, &[0.0, 0.9, 0.0, 0.0]).unwrap(),
    )
    .unwrap();
    assert_eq!(
        [mask.x, mask.y, mask.width, mask.height],
        [1100, 700, 40, 40]
    );
    assert!(mask_from_logits_json(&req, &values[..values.len() - 1], &[0.9; 4]).is_err());
    assert!(mask_from_logits_json(&req, &values, &[0.9; 3]).is_err());
    values[0] = f32::NAN;
    assert!(mask_from_logits_json(&req, &values, &[0.9; 4]).is_err());
    assert!(candidate_choice_json(&req, &values, &[0.9; 4]).is_err());
}

#[test]
fn fractional_proxy_prompt_checks_the_same_nearest_pixel_as_native_intent() {
    let mut req = request();
    req["prompts"][0]["position"] = json!([1126.5 / 4096.0, 714.5 / 2048.0]);
    let mut values = logits();
    rectangle(&mut values, 0, 513, 257, 1, 1);
    let mask = crate::pipeline::removal_mask_from_bytes(
        &mask_from_logits_json(&req.to_string(), &values, &[0.9; 4]).unwrap(),
    )
    .unwrap();
    assert_eq!([mask.x, mask.y, mask.width, mask.height], [1126, 714, 2, 2]);
    assert_eq!(mask.pixels, vec![255; 4]);
}

#[test]
fn conflicting_points_cannot_be_silently_dropped() {
    let mut req = request();
    req["prompts"][1]["position"] = req["prompts"][0]["position"].clone();
    let mut values = logits();
    rectangle(&mut values, 0, 500, 250, 20, 20);
    assert!(mask_from_logits_json(&req.to_string(), &values, &[0.9; 4]).is_err());
}

#[test]
fn source_box_corners_and_last_native_pixel_are_preserved() {
    let mut req = request();
    req["prompts"] = json!([{"position":[100.0/4096.0,200.0/2048.0],"label":2},
        {"position":[2148.0/4096.0,1224.0/2048.0],"label":3}]);
    let model: serde_json::Value =
        serde_json::from_str(&model_prompts_json(&req.to_string()).unwrap()).unwrap();
    assert_eq!(model["labels"], json!([2, 3]));
    assert_eq!(model["points"], json!([[0.0, 0.0], [1023.0, 511.0]]));
    let mut values = logits();
    rectangle(&mut values, 2, 1023, 511, 1, 1);
    let mask = crate::pipeline::removal_mask_from_bytes(
        &mask_from_logits_json(&req.to_string(), &values, &[1.0, 0.0, 0.2, 0.0]).unwrap(),
    )
    .unwrap();
    assert_eq!(
        [mask.x, mask.y, mask.width, mask.height],
        [2146, 1222, 2, 2]
    );
}

#[test]
fn invalid_or_future_requests_are_rejected() {
    let original = request();
    let mut invalid = vec![];
    for (key, value) in [
        ("schema", json!(2)),
        ("input_width", json!(1025)),
        ("input_height", json!(1024)),
        ("prompts", json!([])),
    ] {
        let mut req = original.clone();
        req[key] = value;
        invalid.push(req);
    }
    let mut tiny = original.clone();
    tiny["input_width"] = json!(1);
    tiny["input_height"] = json!(1);
    invalid.push(tiny);
    let mut req = original.clone();
    req["prompts"][0]["label"] = json!(4);
    invalid.push(req);
    let mut req = original.clone();
    req["prompts"][0]["position"] = json!([0.99, 0.99]);
    invalid.push(req);
    let mut req = original.clone();
    req["prompts"][0]["label"] = json!(0);
    invalid.push(req);
    let mut req = original.clone();
    req["prompts"][0]["label"] = json!(2);
    invalid.push(req);
    let mut req = original;
    req["unknown"] = json!(true);
    invalid.push(req);
    for req in invalid {
        assert!(model_prompts_json(&req.to_string()).is_err(), "{req}");
    }
}

#[test]
fn embedding_identity_is_canonical_and_ignores_refinement_intent() {
    use crate::types::accepted_removal::{ContentDigest, SourceAnchor};
    let source = SourceAnchor {
        original: ContentDigest::for_bytes(b"raw"),
        decode: ContentDigest::for_bytes(b"calibration"),
        width: 4096,
        height: 2048,
    };
    let mut request = request();
    let before = context_identity(&source, &request.to_string()).unwrap();
    request["prompts"][0]["position"][0] = json!(1130.0 / 4096.0);
    assert_eq!(
        before,
        context_identity(&source, &request.to_string()).unwrap()
    );
    let unordered = format!(
        r#"{{"height":2048,"decode":"{}","width":4096,"original":"{}"}}"#,
        source.decode.as_str(),
        source.original.as_str()
    );
    assert_eq!(
        before.as_str(),
        context_identity_json(&unordered, &request.to_string()).unwrap()
    );
    request["window"]["x"] = json!(101);
    assert_ne!(
        before,
        context_identity(&source, &request.to_string()).unwrap()
    );
    let changed = SourceAnchor {
        original: ContentDigest::for_bytes(b"other"),
        ..source
    };
    assert_ne!(
        context_identity(&changed, &request.to_string()).unwrap(),
        ContentDigest::parse(&context_identity_json(&unordered, &request.to_string()).unwrap())
            .unwrap()
    );
    request["source_width"] = json!(4095);
    assert!(context_identity(&changed, &request.to_string()).is_err());
}
