//! One-shot worker binding for guided geometry; the worker already owns WASM.
use raw_core::stages::perspective::{solve_guides, GuideFamily, GuideLine, Perspective};
use wasm_bindgen::prelude::*;

/// Input UVs are post-perspective, pre-crop. Undo the existing geometry before
/// solving, so rerunning Guided replaces rather than compounds a correction.
#[wasm_bindgen]
pub fn solve_guided_geometry(
    points: &[f32],
    family: &str,
    aspect: f32,
    xmp: &str,
) -> Result<Vec<f32>, JsValue> {
    let family = match family {
        "vertical" => GuideFamily::Vertical,
        "horizontal" => GuideFamily::Horizontal,
        "both" => GuideFamily::Both,
        _ => return Err(JsValue::from_str("Unknown guide direction.")),
    };
    if points.len() != if family == GuideFamily::Both { 16 } else { 8 } {
        return Err(JsValue::from_str("Draw two guides per direction."));
    }
    let model = raw_core::xmp::parse(xmp).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let lines = points
        .chunks_exact(4)
        .map(|p| {
            GuideLine([
                p[0] * 2.0 - 1.0,
                p[1] * 2.0 - 1.0,
                p[2] * 2.0 - 1.0,
                p[3] * 2.0 - 1.0,
            ])
        })
        .collect::<Vec<_>>();
    let result = solve_guides(
        &lines,
        family,
        aspect,
        Perspective::from_model(&model),
        model.crop.angle,
    )
    .map_err(JsValue::from_str)?;
    Ok(vec![
        result.vertical,
        result.horizontal,
        result.rotate,
        if result.limited { 1.0 } else { 0.0 },
    ])
}
