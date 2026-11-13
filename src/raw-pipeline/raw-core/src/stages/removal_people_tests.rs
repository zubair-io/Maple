use super::*;
use serde_json::{json, Value};
fn person(bounds: [f32; 4], score: f32) -> Value {
    json!({"class":0,"bounds":bounds,"score":score})
}
fn suggest(detections: Vec<Value>) -> Value {
    serde_json::from_str(
        &suggest_json(
            &json!({"schema":1,"source_width":1000,
        "source_height":1000,"detections":detections})
            .to_string(),
        )
        .unwrap(),
    )
    .unwrap()
}
#[test]
fn empty_and_non_person_are_distinct_from_failure() {
    assert_eq!(suggest(vec![]), json!([]));
    assert_eq!(
        suggest(vec![json!({"class":2,"bounds":[0,0,50,90],"score":0.99})]),
        json!([])
    );
    assert!(suggest_json("{}").is_err());
}
#[test]
fn solo_portrait_is_kept_even_off_centre() {
    let p = suggest(vec![person([650., 100., 980., 950.], 0.99)]);
    assert_eq!(p[0]["role"], "subject");
    assert_eq!(p[0]["keep"], true);
}
#[test]
fn confident_small_separated_people_are_selected_with_large_subject_kept() {
    let p = suggest(vec![
        person([20., 100., 350., 950.], 0.98),
        person([650., 400., 700., 600.], 0.92),
        person([800., 450., 850., 650.], 0.9),
    ]);
    assert_eq!(p[0]["keep"], true);
    for i in [1, 2] {
        assert_eq!(p[i]["role"], "background");
        assert_eq!(p[i]["keep"], false);
    }
}
#[test]
fn group_portraits_are_all_kept() {
    let p = suggest(vec![
        person([20., 100., 350., 950.], 0.98),
        person([550., 100., 850., 900.], 0.92),
    ]);
    assert!(p.as_array().unwrap().iter().all(|p| p["keep"] == true));
}
#[test]
fn weak_or_similarly_sized_instances_remain_uncertain_and_kept() {
    let p = suggest(vec![
        person([0., 0., 300., 900.], 0.98),
        person([500., 0., 600., 400.], 0.6),
        person([750., 0., 950., 550.], 0.9),
    ]);
    assert_eq!(p[1]["role"], "uncertain");
    assert_eq!(p[2]["role"], "uncertain");
    assert!(p.as_array().unwrap().iter().all(|p| p["keep"] == true));
    assert_eq!(
        suggest(vec![person([500., 0., 600., 400.], 0.6)])[0]["role"],
        "uncertain"
    );
}
#[test]
fn overlapping_small_instance_cannot_be_auto_selected() {
    let p = suggest(vec![
        person([0., 0., 300., 900.], 0.98),
        person([250., 400., 350., 600.], 0.92),
    ]);
    assert_eq!(p[1]["role"], "uncertain");
    assert_eq!(p[1]["keep"], true);
}
#[test]
fn repeated_detector_queries_collapse_to_one_reviewable_person() {
    let p = suggest(vec![
        person([0., 0., 300., 900.], 0.98),
        person([1., 1., 301., 901.], 0.97),
    ]);
    assert_eq!(p.as_array().unwrap().len(), 1);
}
#[test]
fn clips_edge_boxes_and_discards_empty_off_image_proposals() {
    let p = suggest(vec![
        person([-50., -20., 1100., 1200.], 0.98),
        person([1100., 0., 1200., 30.], 0.9),
    ]);
    assert_eq!(p.as_array().unwrap().len(), 1);
    assert_eq!(p[0]["detection"]["bounds"], json!([0., 0., 1000., 1000.]));
}
#[test]
fn confidence_ties_have_source_coordinate_order_independent_of_input_order() {
    let a = person([0., 0., 300., 900.], 0.95);
    let b = person([600., 0., 800., 800.], 0.95);
    assert_eq!(suggest(vec![a.clone(), b.clone()]), suggest(vec![b, a]));
}
#[test]
fn rejects_unbounded_or_malformed_external_boundaries() {
    for value in [
        json!({"schema":2,"source_width":1000,"source_height":1000,"detections":[]}),
        json!({"schema":1,"source_width":0,"source_height":1000,"detections":[]}),
        json!({"schema":1,"source_width":1000,"source_height":1000,"detections":vec![person([0.,0.,20.,20.],0.9);301]}),
        json!({"schema":1,"source_width":1000,"source_height":1000,"detections":[person([0.,0.,20.,20.],1.1)]}),
        json!({"schema":1,"source_width":1000,"source_height":1000,"detections":[{"class":80,"bounds":[0,0,20,20],"score":0.9}]}),
    ] {
        assert!(suggest_json(&value.to_string()).is_err());
    }
    assert!(suggest_json(r#"{"schema":1,"source_width":1000,"source_height":1000,"detections":[{"class":0,"bounds":[0,0,20],"score":0.9}]}"#).is_err());
}

#[test]
fn uncertainty_propagates_through_an_overlapping_group() {
    let p = suggest(vec![
        person([0., 0., 300., 900.], 0.98),
        person([250., 400., 350., 600.], 0.92),
        person([340., 400., 440., 600.], 0.9),
    ]);
    assert!(p.as_array().unwrap().iter().all(|p| p["keep"] == true));
}
