use super::*;
use serde_json::json;

fn request(strokes: serde_json::Value) -> String {
    json!({"schema":1,"source_width":1024,"source_height":512,
        "window":{"x":0,"y":0,"width":1024,"height":512},
        "input_width":1024,"input_height":512,"strokes":strokes})
    .to_string()
}

#[test]
fn bounded_arc_sampling_keeps_every_positive_negative_gesture_and_endpoints() {
    let json = request(json!([
        {"points":[[0.1,0.2],[0.4,0.2],[0.9,0.2]],"radius":0.0001,"subtract":false},
        {"points":[[0.1,0.8],[0.9,0.8]],"radius":0.0001,"subtract":true}
    ]));
    let prepared = prepare(super::super::removal_smart::parse_request(&json).unwrap()).unwrap();
    assert_eq!(prepared.prompts.len(), 64);
    for label in [0, 1] {
        let group: Vec<_> = prepared
            .prompts
            .iter()
            .filter(|p| p.label == label)
            .collect();
        assert_eq!(group.len(), 32);
        assert!((group[0].position[0] - 0.1).abs() < 1e-7);
        assert!((group[31].position[0] - 0.9).abs() < 1e-7);
        assert!(group
            .windows(2)
            .all(|pair| ((pair[1].position[0] - pair[0].position[0]) - 0.8 / 31.0).abs() < 1e-7));
    }
}

#[test]
fn later_erase_replaces_older_overlapping_positive_prompts() {
    let json = request(json!([
        {"points":[[0.3,0.5],[0.7,0.5]],"radius":0.05,"subtract":false},
        {"points":[[0.3,0.5]],"radius":0.1,"subtract":true}
    ]));
    let prepared = prepare(super::super::removal_smart::parse_request(&json).unwrap()).unwrap();
    assert!(prepared
        .prompts
        .iter()
        .any(|p| p.label == 0 && (p.position[0] - 0.3).abs() < 1e-7));
    assert!(prepared.prompts.iter().any(|p| p.label == 1));
    assert!(prepared
        .prompts
        .iter()
        .filter(|p| p.label == 1)
        .all(|p| p.position[0] > 0.4));
}

#[test]
fn gesture_edges_map_to_real_native_centres_and_no_silent_endpoint_truncation() {
    let json = request(json!([{ "points":[[0.0,0.5],[1.0,0.5]],"radius":0.5,"subtract":false }]));
    let prepared = prepare(super::super::removal_smart::parse_request(&json).unwrap()).unwrap();
    assert_eq!(prepared.prompts[0].position[0], 0.5 / 1024.0);
    assert_eq!(
        prepared.prompts.last().unwrap().position[0],
        1023.5 / 1024.0
    );
    let gestures =
        vec![json!({"points":[[0.1,0.1],[0.9,0.9]],"radius":0.001,"subtract":false}); 33];
    let invalid = request(json!(gestures));
    assert!(
        prepare(super::super::removal_smart::parse_request(&invalid).unwrap())
            .err()
            .unwrap()
            .contains("endpoints")
    );
}

#[test]
fn full_erase_or_gesture_outside_context_does_not_create_a_proposal() {
    let json = request(json!([
        {"points":[[0.5,0.5]],"radius":0.05,"subtract":false},
        {"points":[[0.5,0.5]],"radius":0.1,"subtract":true}
    ]));
    assert!(super::super::removal_smart::prepare_strokes_json(&json)
        .unwrap_err()
        .contains("no remaining positive"));
    let mut json: serde_json::Value = serde_json::from_str(&request(
        json!([{"points":[[0.9,0.9]],"radius":0.1,"subtract":false}]),
    ))
    .unwrap();
    json["window"] = json!({"x":0,"y":0,"width":512,"height":512});
    assert!(super::super::removal_smart::prepare_strokes_json(&json.to_string()).is_err());
}

#[test]
fn ordered_footprints_keep_expansion_and_erase_whole_capsule() {
    let base = crate::types::removal_mask::RemovalMask {
        source_width: 100,
        source_height: 100,
        x: 30,
        y: 30,
        width: 40,
        height: 40,
        pixels: vec![255; 1600],
    };
    let strokes: Vec<RemovalStroke> = serde_json::from_value(json!([
        {"points":[[0.1,0.5]],"radius":0.03,"subtract":false},
        {"points":[[0.4,0.5],[0.6,0.5]],"radius":0.05,"subtract":true}
    ]))
    .unwrap();
    let mask = super::super::removal_selection::apply_to_mask(&base, &strokes)
        .unwrap()
        .unwrap();
    let pixel = |x: u32, y: u32| {
        mask.pixels[(y - mask.y) as usize * mask.width as usize + (x - mask.x) as usize]
    };
    assert_eq!(pixel(10, 50), 255); // add extends model bounds
    assert_eq!(pixel(35, 35), 255); // expansion remains
    for x in 40..60 {
        assert_eq!(pixel(x, 50), 0);
    } // exact erase footprint
    let erase = RemovalStroke {
        points: vec![[0.5, 0.5]],
        radius: 1.0,
        subtract: true,
    };
    assert!(
        super::super::removal_selection::apply_to_mask(&base, &[erase])
            .unwrap()
            .is_none()
    );
}
