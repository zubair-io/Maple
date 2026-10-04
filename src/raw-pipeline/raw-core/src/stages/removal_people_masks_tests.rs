use super::*;
use crate::{pipeline::removal_mask_to_bytes, types::removal_mask::RemovalMask};
use serde_json::{json, Value};

fn mask(points: &[(u32, u32)]) -> Vec<u8> {
    if points.is_empty() {
        return Vec::new();
    }
    let mut pixels = vec![0; 1000 * 1000];
    for (x, y) in points {
        pixels[(y * 1000 + x) as usize] = 255;
    }
    removal_mask_to_bytes(&RemovalMask {
        source_width: 1000,
        source_height: 1000,
        x: 0,
        y: 0,
        width: 1000,
        height: 1000,
        pixels,
    })
    .unwrap()
}
fn request(masks: &[Vec<u8>]) -> Value {
    json!({"schema":1,"source_width":1000,"source_height":1000,
      "detections":[{"class":0,"score":0.98,"bounds":[0,0,300,900]},
                    {"class":0,"score":0.92,"bounds":[250,400,300,550]}],
      "mask_lengths": masks.iter().map(Vec::len).collect::<Vec<_>>()})
}
fn suggest(masks: &[Vec<u8>]) -> Value {
    serde_json::from_str(&suggest_json(&request(masks).to_string(), &masks.concat()).unwrap())
        .unwrap()
}

#[test]
fn disjoint_masks_allow_background_despite_intersecting_boxes() {
    let p = suggest(&[mask(&[(20, 20)]), mask(&[(270, 450)])]);
    assert_eq!(p[0]["role"], "subject");
    assert_eq!(p[0]["keep"], true);
    assert_eq!(p[1]["role"], "background");
    assert_eq!(p[1]["keep"], false);
}

#[test]
fn actual_overlap_keeps_background_uncertain() {
    let p = suggest(&[mask(&[(270, 450)]), mask(&[(270, 450)])]);
    assert_eq!(p[1]["role"], "uncertain");
    assert_eq!(p[1]["keep"], true);
}

#[test]
fn missing_subject_or_background_mask_cannot_authorize_auto_selection() {
    for masks in [
        [mask(&[]), mask(&[(270, 450)])],
        [mask(&[(20, 20)]), mask(&[])],
    ] {
        let p = suggest(&masks);
        assert_eq!(p[1]["role"], "uncertain");
        assert_eq!(p[1]["keep"], true);
    }
}

#[test]
fn uncertainty_propagates_through_actual_masks() {
    let masks = [
        mask(&[(20, 20)]),
        mask(&[(20, 20), (270, 450)]),
        mask(&[(270, 450)]),
    ];
    let mut r = request(&masks);
    r["detections"]
        .as_array_mut()
        .unwrap()
        .push(json!({"class":0,"score":0.9,"bounds":[270,450,320,600]}));
    let p: Value =
        serde_json::from_str(&suggest_json(&r.to_string(), &masks.concat()).unwrap()).unwrap();
    assert_eq!(p[1]["role"], "uncertain");
    assert_eq!(p[2]["role"], "uncertain");
}

#[test]
fn missing_uncertain_mask_falls_back_to_conservative_box_overlap() {
    let masks = [mask(&[(20, 20)]), mask(&[(270, 450)]), mask(&[])];
    let mut r = request(&masks);
    r["detections"]
        .as_array_mut()
        .unwrap()
        .push(json!({"class":0,"score":0.7,"bounds":[240,400,320,550]}));
    let p: Value =
        serde_json::from_str(&suggest_json(&r.to_string(), &masks.concat()).unwrap()).unwrap();
    assert_eq!(p[1]["role"], "uncertain");
    assert_eq!(p[2]["role"], "uncertain");
}

#[test]
fn invalid_count_length_source_and_detector_requests_are_rejected() {
    let masks = [mask(&[(20, 20)]), mask(&[(270, 450)])];
    let r = request(&masks);
    for changed in [
        {
            let mut v = r.clone();
            v["mask_lengths"] = json!([masks[0].len()]);
            v
        },
        {
            let mut v = r.clone();
            v["mask_lengths"][0] = json!(1);
            v
        },
        {
            let mut v = r.clone();
            v["source_width"] = json!(1001);
            v
        },
        {
            let mut v = r.clone();
            v["detections"][1]["class"] = json!(2);
            v
        },
        {
            let mut v = r.clone();
            v["detections"][1]["bounds"][0] = json!(-1);
            v
        },
        {
            let mut v = r.clone();
            v["detections"][1]["score"] = json!(0.1);
            v
        },
    ] {
        assert!(suggest_json(&changed.to_string(), &masks.concat()).is_err());
    }
    let mut bytes = masks.concat();
    bytes[4] = 2;
    assert!(suggest_json(&r.to_string(), &bytes).is_err());
    assert_eq!(
        suggest_json(
            r#"{"schema":1,"source_width":1,"source_height":1,"detections":[],"mask_lengths":[]}"#,
            &[]
        )
        .unwrap(),
        "[]"
    );
}
