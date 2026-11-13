//! Upright semantic detection with durable un-oriented RAW coordinates (#3941).
//! Cold model input only; no color math, saved edits or slider work occurs here.
use crate::image::{apply_orientation, ExifOrientation};

const SIDE: usize =
    crate::types::removal_models::EXPERIMENTAL_REMOVAL_MODELS[3].native_side as usize;

fn orientation(code: u16) -> Result<ExifOrientation, String> {
    if !(1..=8).contains(&code) {
        return Err("person detection: invalid EXIF orientation".into());
    }
    Ok(ExifOrientation::from_u16(code))
}

pub fn upright_size(source: [u32; 2], code: u16) -> Result<[u32; 2], String> {
    let orientation = orientation(code)?;
    if source.contains(&0) {
        return Err("person detection: empty source".into());
    }
    Ok(if orientation.swaps_wh() {
        [source[1], source[0]]
    } else {
        source
    })
}

/// Exact pixel permutation of a planar detector input. Explicitly interleave
/// for the shared RGB permutation, then restore CHW without changing samples.
pub fn upright_rgb(rgb: &[f32], code: u16) -> Result<Vec<f32>, String> {
    let orientation = orientation(code)?;
    if rgb.len() != 3 * SIDE * SIDE
        || rgb
            .iter()
            .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
    {
        return Err("person detection: invalid RGB input".into());
    }
    let plane = SIDE * SIDE;
    let interleaved: Vec<_> = (0..plane)
        .flat_map(|index| [rgb[index], rgb[plane + index], rgb[2 * plane + index]])
        .collect();
    let (_, _, pixels) = apply_orientation(&interleaved, SIDE as u32, SIDE as u32, orientation);
    let mut output = vec![0.0; rgb.len()];
    for (index, pixel) in pixels.chunks_exact(3).enumerate() {
        output[index] = pixel[0];
        output[plane + index] = pixel[1];
        output[2 * plane + index] = pixel[2];
    }
    Ok(output)
}

/// The model returns upright pixel-edge XYXY boxes. Map all corners with the
/// shared display-to-sensor transform, retaining float precision and outlying
/// edges for the existing clipping/review boundary. No box rounding or dilation.
pub fn source_box(bounds: [f32; 4], source: [u32; 2], code: u16) -> Result<[f32; 4], String> {
    let orientation = orientation(code)?;
    let display = upright_size(source, code)?;
    if bounds.iter().any(|value| !value.is_finite())
        || bounds[0] > bounds[2]
        || bounds[1] > bounds[3]
    {
        return Err("person detection: invalid box".into());
    }
    // Normal-orientation proposals retain their original bits, including the
    // existing photographic regression's exact downstream SAM mask identity.
    if code == 1 {
        return Ok(bounds);
    }
    let corners = [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[1]],
        [bounds[0], bounds[3]],
        [bounds[2], bounds[3]],
    ]
    .map(|point| {
        let uv = orientation
            .display_uv_to_sensor([point[0] / display[0] as f32, point[1] / display[1] as f32]);
        [uv[0] * source[0] as f32, uv[1] * source[1] as f32]
    });
    Ok([
        corners.iter().map(|p| p[0]).fold(f32::INFINITY, f32::min),
        corners.iter().map(|p| p[1]).fold(f32::INFINITY, f32::min),
        corners
            .iter()
            .map(|p| p[0])
            .fold(f32::NEG_INFINITY, f32::max),
        corners
            .iter()
            .map(|p| p[1])
            .fold(f32::NEG_INFINITY, f32::max),
    ])
}

#[cfg(test)]
#[path = "removal_detection_geometry_tests.rs"]
mod tests;
