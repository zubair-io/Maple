//! Tests for `raster_pipeline_buf` / `raster_analyze_buf`'s `Task`s (#3509
//! Task 5). Calls each `Task::compute()` directly, mirroring real cases from
//! `raw-ffi/src/raster_pipeline.rs`'s own test module (the RGBA-to-PNG recipe)
//! and `builder-state.ts`'s `stateToRecipe` (the resize-only recipe a plain
//! `.resize(w, h).toBuffer()` call on an encoded input actually produces),
//! plus `raw-ffi/src/raster_analyze_tests.rs`'s substring-assertion style for
//! the analyze reply, since this crate adds no `serde_json` dependency (see
//! `pipeline.rs`'s module doc) to parse it structurally.
//!
//! Lives under `src/` (not `tests/`) for the same reason `filename_tests.rs`
//! does: this crate's `crate-type` is `["cdylib"]` only, so an integration
//! test under `tests/` cannot link `raw_napi` as an external crate.

use napi::Task;

use crate::pipeline::{RasterAnalyzeBufTask, RasterPipelineBufTask};

fn png(w: u32, h: u32, rgb: [u8; 3]) -> Vec<u8> {
    let mut px = Vec::with_capacity((w * h * 3) as usize);
    for _ in 0..(w * h) {
        px.extend_from_slice(&rgb);
    }
    raw_core::png::encode(w, h, &px).unwrap()
}

/// Ports `raw-ffi/src/raster_pipeline.rs`'s own `RGBA_TO_PNG` constant: raw
/// RGBA pixel input, no ops, PNG output.
const RGBA_TO_PNG: &str = r#"{"v":1,"input":{"kind":"raw","width":2,"height":1,"channels":4},"ops":[],"output":{"format":"png"}}"#;

#[test]
fn raw_rgba_input_with_no_ops_encodes_straight_to_png() {
    let px = [255u8, 0, 0, 255, 0, 255, 0, 128];
    let mut task = RasterPipelineBufTask {
        input: px.to_vec(),
        recipe_json: RGBA_TO_PNG.to_string(),
        aux: vec![],
    };
    let result = task.compute().unwrap();
    assert!(result.ok, "pipeline failed: {:?}", result.error);
    assert_eq!(
        (result.width, result.height, result.channels),
        (Some(2), Some(1), Some(4))
    );
    let buffer = result.buffer.expect("ok result carries a buffer");
    assert_eq!(&buffer[..8], b"\x89PNG\r\n\x1a\n");
}

/// Mirrors what `stateToRecipe` (`src/maple/src/builder-state.ts`) actually
/// assembles for a plain `.resize(width, height).toFormat('png').toBuffer()`
/// call on an already-encoded input: `input.kind` is `"encoded"` (bytes come
/// straight from the caller's buffer, not a raw pixel spec), one `resize` op
/// carrying every `Resize` field the builder's default fills in (`fit`
/// defaults to `"cover"` on the wire — see `raster_recipe.rs`'s `Op::Resize`
/// — this recipe pins `"fill"` explicitly so the case has one unambiguous
/// output size to assert on), and an `output.format`.
#[test]
fn resize_only_recipe_on_an_encoded_input_produces_the_target_box() {
    let input_png = png(40, 20, [1, 2, 3]);
    let recipe = r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"resize","width":10,"height":10,"fit":"fill"}],"output":{"format":"png"}}"#;
    let mut task = RasterPipelineBufTask {
        input: input_png,
        recipe_json: recipe.to_string(),
        aux: vec![],
    };
    let result = task.compute().unwrap();
    assert!(result.ok, "pipeline failed: {:?}", result.error);
    assert_eq!((result.width, result.height), (Some(10), Some(10)));
    let buffer = result.buffer.expect("ok result carries a buffer");
    let meta = raw_core::raster::probe_raster_metadata(&buffer).unwrap();
    assert_eq!((meta.width, meta.height), (10, 10));
}

#[test]
fn a_malformed_recipe_is_reported_as_an_error_not_a_panic() {
    let mut task = RasterPipelineBufTask {
        input: vec![0, 0, 0, 255],
        recipe_json: "{not json".to_string(),
        aux: vec![],
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    assert!(result.buffer.is_none());
    assert!(result.error.is_some());
}

#[test]
fn an_unrecognized_op_is_reported_as_an_error() {
    let input_png = png(4, 4, [0, 0, 0]);
    let recipe = r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"notARealOp"}],"output":{"format":"png"}}"#;
    let mut task = RasterPipelineBufTask {
        input: input_png,
        recipe_json: recipe.to_string(),
        aux: vec![],
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    assert!(result.error.is_some());
}

#[test]
fn analyze_metadata_request_reports_the_containers_own_dimensions() {
    let file = png(4, 2, [90, 90, 90]);
    let mut task = RasterAnalyzeBufTask {
        input: file,
        request_json: r#"{"v":1,"what":["metadata"]}"#.to_string(),
    };
    let result = task.compute().unwrap();
    assert!(result.ok, "analyze failed: {:?}", result.error);
    let json = result.json.expect("ok result carries a json reply");
    assert!(json.contains("\"width\":4"), "{json}");
    assert!(json.contains("\"height\":2"), "{json}");
}

#[test]
fn analyze_stats_can_be_requested_without_the_metadata_key() {
    let file = png(4, 2, [10, 20, 30]);
    let mut task = RasterAnalyzeBufTask {
        input: file,
        request_json: r#"{"v":1,"what":["stats"]}"#.to_string(),
    };
    let result = task.compute().unwrap();
    assert!(result.ok, "analyze failed: {:?}", result.error);
    let json = result.json.expect("ok result carries a json reply");
    assert!(json.contains("\"stats\""), "{json}");
    assert!(!json.contains("\"metadata\""), "{json}");
}

#[test]
fn analyze_reports_an_error_for_a_malformed_request() {
    let file = png(2, 2, [0, 0, 0]);
    let mut task = RasterAnalyzeBufTask {
        input: file,
        request_json: "{not json".to_string(),
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    assert!(result.json.is_none());
    assert!(result.error.is_some());
}
