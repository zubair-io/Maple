use super::*;

fn stroke(points: &[[f32; 2]], radius: f32, subtract: bool) -> RemovalStroke {
    RemovalStroke {
        points: points.to_vec(),
        radius,
        subtract,
    }
}

fn selected(mask: &RemovalMask, x: u32, y: u32) -> bool {
    x >= mask.x
        && y >= mask.y
        && x < mask.x + mask.width
        && y < mask.y + mask.height
        && mask.pixels[(y - mask.y) as usize * mask.width as usize + (x - mask.x) as usize] == 255
}

#[test]
fn circles_use_source_width_on_a_non_square_image() {
    let mask = rasterize(100, 50, &[stroke(&[[0.5, 0.5]], 0.1, false)])
        .unwrap()
        .unwrap();
    assert_eq!((mask.x, mask.y, mask.width, mask.height), (39, 14, 22, 22));
    // 0.1f32 is slightly above 0.1 in f64. Window rounding may include an
    // empty border, but actual coverage is exactly the same circle in pixels.
    assert!(selected(&mask, 59, 25));
    assert!(selected(&mask, 50, 34));
    assert!(!selected(&mask, 60, 25));
    assert!(!selected(&mask, 50, 35));
    mask.validate().unwrap();
}

#[test]
fn sparse_events_form_a_continuous_capsule() {
    let mask = rasterize(100, 50, &[stroke(&[[0.1, 0.5], [0.9, 0.5]], 0.02, false)])
        .unwrap()
        .unwrap();
    for x in 10..90 {
        assert!(selected(&mask, x, 25), "gap at x={x}");
    }
    assert!(!selected(&mask, 50, 29));
}

#[test]
fn ordered_subtract_and_gesture_undo_replay() {
    let add = stroke(&[[0.1, 0.5], [0.9, 0.5]], 0.03, false);
    let subtract = stroke(&[[0.5, 0.0], [0.5, 1.0]], 0.04, true);
    let mask = rasterize(100, 50, &[add.clone(), subtract])
        .unwrap()
        .unwrap();
    assert!(!selected(&mask, 50, 25));
    assert!(selected(&mask, 20, 25));
    let undo = rasterize(100, 50, &[add]).unwrap().unwrap();
    assert!(selected(&undo, 50, 25));
    assert!(selected(&undo, 20, 25));
    assert!(!selected(&undo, 50, 35));
}

#[test]
fn empty_and_fully_subtracted_selection_have_no_asset() {
    assert_eq!(rasterize(100, 50, &[]).unwrap(), None);
    let add = stroke(&[[0.5, 0.5]], 0.1, false);
    let sub = stroke(&[[0.5, 0.5]], 0.2, true);
    assert_eq!(rasterize(100, 50, &[add, sub.clone()]).unwrap(), None);
    assert_eq!(rasterize(100, 50, &[sub]).unwrap(), None);
}

#[test]
fn border_stroke_clips_without_touching_the_opposite_border() {
    let mask = rasterize(100, 50, &[stroke(&[[0.0, 0.0]], 0.02, false)])
        .unwrap()
        .unwrap();
    assert_eq!((mask.x, mask.y), (0, 0));
    assert!(selected(&mask, 0, 0));
    assert!(!selected(&mask, 99, 49));
    assert!(mask.width <= 3 && mask.height <= 3);
}

#[test]
fn small_selection_on_100mp_source_stays_a_small_window() {
    let mask = rasterize(12288, 8192, &[stroke(&[[0.5, 0.5]], 0.001, false)])
        .unwrap()
        .unwrap();
    assert!(mask.pixels.len() < 1000);
    assert_eq!((mask.source_width, mask.source_height), (12288, 8192));
}

#[test]
fn bad_stroke_and_empty_source_fail_instead_of_painting() {
    assert!(rasterize(0, 100, &[]).is_err());
    for s in [
        stroke(&[], 0.1, false),
        stroke(&[[f32::NAN, 0.5]], 0.1, false),
        stroke(&[[1.1, 0.5]], 0.1, false),
        stroke(&[[0.5, 0.5]], f32::INFINITY, false),
        stroke(&[[0.5, 0.5]], 0.0, false),
    ] {
        assert!(rasterize(100, 50, &[s]).is_err());
    }
}

#[test]
fn host_request_rejects_unknown_version_and_fields() {
    for request in [
        r#"{"strokes":[]}"#,
        r#"{"schema":2,"strokes":[]}"#,
        r#"{"schema":1,"strokes":[],"typo":true}"#,
        r#"{"schema":1,"strokes":[{"points":[[0.5,0.5]],"radius":0.1,"subtract":false,"typo":true}]}"#,
    ] {
        assert!(rasterize_json(100, 50, request).is_err());
    }
    assert!(rasterize_json(100, 50, r#"{"schema":1,"strokes":[]}"#)
        .unwrap()
        .is_empty());
}

#[test]
fn reviewed_people_union_and_protection_are_source_bound_and_leave_no_empty_asset() {
    let encode = |x, y, width, height, pixels| {
        crate::pipeline::removal_mask_to_bytes(&RemovalMask {
            source_width: 10,
            source_height: 8,
            x,
            y,
            width,
            height,
            pixels,
        })
        .unwrap()
    };
    let a = encode(1, 1, 2, 1, vec![255, 255]);
    let b = encode(2, 1, 1, 2, vec![255, 255]);
    let union = combine_masks(&a, &b, false).unwrap();
    let mask = crate::pipeline::removal_mask_from_bytes(&union).unwrap();
    assert_eq!((mask.x, mask.y, mask.width, mask.height), (1, 1, 2, 2));
    assert_eq!(mask.pixels, vec![255, 255, 0, 255]);
    let protected = combine_masks(&union, &b, true).unwrap();
    assert_eq!(
        crate::pipeline::removal_mask_from_bytes(&protected)
            .unwrap()
            .pixels,
        vec![255, 0, 0, 0]
    );
    assert!(combine_masks(&union, &union, true).unwrap().is_empty());
    assert_eq!(combine_masks(&[], &a, false).unwrap(), a);
    assert!(combine_masks(&[], &a, true).unwrap().is_empty());
    let mut other = crate::pipeline::removal_mask_from_bytes(&a).unwrap();
    other.source_width = 11;
    assert!(combine_masks(
        &a,
        &crate::pipeline::removal_mask_to_bytes(&other).unwrap(),
        false
    )
    .is_err());
}
