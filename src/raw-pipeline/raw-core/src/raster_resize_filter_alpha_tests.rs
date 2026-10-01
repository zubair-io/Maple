use crate::raster_recipe::parse_recipe;
use crate::raster_recipe_exec::run_recipe;

fn run(width: u32, height: u32, channels: u8, pixels: &[u8], ops: serde_json::Value) -> Vec<u8> {
    let recipe = parse_recipe(
        &serde_json::json!({
            "v": 1,
            "input": {"kind": "raw", "width": width, "height": height, "channels": channels},
            "ops": ops,
            "output": {"format": "raw"}
        })
        .to_string(),
    )
    .unwrap();
    run_recipe(&recipe, pixels, &[]).unwrap().bytes
}

#[test]
fn resize_threshold_tests_premultiplied_colour_and_alpha() {
    let source: Vec<u8> = (0..16).flat_map(|_| [200, 180, 80, 64]).collect();
    let pixels = run(
        4,
        4,
        4,
        &source,
        serde_json::json!([
            {"op": "resize", "width": 2, "kernel": "nearest"},
            {"op": "threshold", "value": 128, "greyscale": false}
        ]),
    );
    assert_eq!(pixels, vec![0; 16]);
}

#[test]
fn resizing_alone_uses_sharps_float_premultiply_and_truncating_cast() {
    let source: Vec<u8> = (0..16).flat_map(|_| [200, 180, 80, 64]).collect();
    let pixels = run(
        4,
        4,
        4,
        &source,
        serde_json::json!([
            {"op": "resize", "width": 2, "kernel": "nearest"}
        ]),
    );
    assert_eq!(
        pixels,
        (0..4).flat_map(|_| [199, 179, 79, 64]).collect::<Vec<_>>()
    );
}

#[test]
fn a_noop_resize_does_not_roundtrip_low_alpha_colour() {
    let source: Vec<u8> = (0..16).flat_map(|_| [200, 180, 80, 64]).collect();
    for resize in [
        serde_json::json!({"op": "resize", "width": 4, "fit": "inside"}),
        serde_json::json!({"op": "resize", "width": 8, "fit": "inside", "withoutEnlargement": true}),
        serde_json::json!({"op": "resize", "width": 2, "fit": "inside", "withoutReduction": true}),
    ] {
        assert_eq!(
            run(
                4,
                4,
                4,
                &source,
                serde_json::json!([resize, {"op": "median", "size": 3}])
            ),
            source
        );
    }
}

#[test]
fn contain_background_is_premultiplied_once_with_the_image() {
    let source: Vec<u8> = (0..8).flat_map(|_| [200, 180, 80, 64]).collect();
    let pixels = run(
        4,
        2,
        4,
        &source,
        serde_json::json!([
            {"op": "resize", "width": 2, "height": 2, "fit": "contain", "kernel": "nearest",
             "background": [200, 180, 80, 64]}
        ]),
    );
    assert_eq!(
        pixels,
        (0..4).flat_map(|_| [199, 179, 79, 64]).collect::<Vec<_>>()
    );
}

#[test]
fn transparent_colour_cannot_bleed_through_resize_and_box_blur() {
    let source: Vec<u8> = (0..8)
        .flat_map(|_| [[200, 0, 0, 255], [0, 250, 0, 0]].concat())
        .collect();
    let pixels = run(
        2,
        8,
        4,
        &source,
        serde_json::json!([
            {"op": "resize", "width": 1, "height": 4, "fit": "fill", "kernel": "linear"},
            {"op": "blur"}
        ]),
    );
    assert!(pixels
        .chunks_exact(4)
        .all(|px| px[0] > 190 && px[1] == 0 && px[2] == 0 && px[3] > 0));
}

#[test]
fn rgb_resize_filter_chain_preserves_opaque_colour() {
    let source: Vec<u8> = (0..16).flat_map(|_| [200, 180, 80]).collect();
    let pixels = run(
        4,
        4,
        3,
        &source,
        serde_json::json!([
            {"op": "resize", "width": 2, "kernel": "nearest"},
            {"op": "blur"}
        ]),
    );
    assert_eq!(
        pixels,
        (0..4).flat_map(|_| [200, 180, 80]).collect::<Vec<_>>()
    );
}
