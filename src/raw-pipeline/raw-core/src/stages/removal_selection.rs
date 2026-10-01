//! Continuous, source-space Paint/Subtract rasterization (#3934). The same
//! Rust entry serves native and WASM callers, outside the slider render loop.

use crate::types::removal_mask::{validate_mask_layout, RemovalMask, RemovalStroke};

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectionRequest {
    schema: u32,
    strokes: Vec<RemovalStroke>,
}

/// Shared, versioned host request boundary. The request is ephemeral gesture
/// data; durable intent is the resulting MIMF mask. Empty selection is empty
/// bytes, never a zero-sized asset that could be mistaken for a saved mask.
pub fn rasterize_json(
    source_width: u32,
    source_height: u32,
    request: &str,
) -> Result<Vec<u8>, String> {
    let request: SelectionRequest = serde_json::from_str(request)
        .map_err(|e| format!("removal selection: invalid request: {e}"))?;
    if request.schema != 1 {
        return Err(format!(
            "removal selection: unsupported schema {}",
            request.schema
        ));
    }
    match rasterize(source_width, source_height, &request.strokes)? {
        Some(mask) => crate::pipeline::removal_mask_to_bytes(&mask),
        None => Ok(Vec::new()),
    }
}

/// Replay gestures to a cropped native mask. Removing a gesture from `strokes`
/// implements selection undo; no edit or XMP is committed here. Empty or fully
/// subtracted selection returns None. Pixel centers define all brush coverage.
pub fn rasterize(
    source_width: u32,
    source_height: u32,
    strokes: &[RemovalStroke],
) -> Result<Option<RemovalMask>, String> {
    if source_width == 0 || source_height == 0 {
        return Err("removal selection: source dimensions must be non-zero".into());
    }
    for stroke in strokes {
        stroke.validate()?;
    }
    let mut bounds = [source_width, source_height, 0, 0];
    for stroke in strokes.iter().filter(|s| !s.subtract) {
        let [x0, y0, x1, y1] = stroke_bounds(source_width, source_height, stroke);
        bounds = [
            bounds[0].min(x0),
            bounds[1].min(y0),
            bounds[2].max(x1),
            bounds[3].max(y1),
        ];
    }
    let [x, y, end_x, end_y] = bounds;
    if end_x <= x || end_y <= y {
        return Ok(None);
    }
    let (width, height) = (end_x - x, end_y - y);
    let n = validate_mask_layout(source_width, source_height, x, y, width, height)?;
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(n)
        .map_err(|_| "removal selection: insufficient memory".to_string())?;
    pixels.resize(n, 0);
    let mut mask = RemovalMask {
        source_width,
        source_height,
        x,
        y,
        width,
        height,
        pixels,
    };
    for stroke in strokes {
        apply_stroke(&mut mask, stroke);
    }
    if mask.pixels.iter().all(|v| *v == 0) {
        return Ok(None);
    }
    Ok(Some(mask))
}

/// Combine reviewed person masks or subtract protected intent in source space.
/// Empty bytes mean no selection, matching the gesture replay boundary.
pub fn combine_masks(left: &[u8], right: &[u8], subtract: bool) -> Result<Vec<u8>, String> {
    let decode = |bytes: &[u8]| {
        if bytes.is_empty() {
            Ok(None)
        } else {
            crate::pipeline::removal_mask_from_bytes(bytes).map(Some)
        }
    };
    let (left, right) = (decode(left)?, decode(right)?);
    let Some(right) = right else {
        return match left {
            Some(mask) => crate::pipeline::removal_mask_to_bytes(&mask),
            None => Ok(Vec::new()),
        };
    };
    let Some(left) = left else {
        return if subtract {
            Ok(Vec::new())
        } else {
            crate::pipeline::removal_mask_to_bytes(&right)
        };
    };
    if (left.source_width, left.source_height) != (right.source_width, right.source_height) {
        return Err("removal selection: combined mask source geometry differs".into());
    }
    let x = if subtract {
        left.x
    } else {
        left.x.min(right.x)
    };
    let y = if subtract {
        left.y
    } else {
        left.y.min(right.y)
    };
    let width = if subtract {
        left.width
    } else {
        (left.x + left.width).max(right.x + right.width) - x
    };
    let height = if subtract {
        left.height
    } else {
        (left.y + left.height).max(right.y + right.height) - y
    };
    let count = validate_mask_layout(left.source_width, left.source_height, x, y, width, height)?;
    let sample = |mask: &RemovalMask, sx: u32, sy: u32| {
        sx >= mask.x
            && sy >= mask.y
            && sx < mask.x + mask.width
            && sy < mask.y + mask.height
            && mask.pixels[((sy - mask.y) * mask.width + sx - mask.x) as usize] == 255
    };
    let pixels = (0..count)
        .map(|index| {
            let sx = x + index as u32 % width;
            let sy = y + index as u32 / width;
            let (a, b) = (sample(&left, sx, sy), sample(&right, sx, sy));
            if if subtract { a && !b } else { a || b } {
                255
            } else {
                0
            }
        })
        .collect::<Vec<_>>();
    if pixels.iter().all(|v| *v == 0) {
        return Ok(Vec::new());
    }
    crate::pipeline::removal_mask_to_bytes(&RemovalMask {
        source_width: left.source_width,
        source_height: left.source_height,
        x,
        y,
        width,
        height,
        pixels,
    })
}

fn stroke_bounds(w: u32, h: u32, stroke: &RemovalStroke) -> [u32; 4] {
    let radius = f64::from(stroke.radius) * f64::from(w);
    let mut bounds = [w, h, 0, 0];
    for [u, v] in &stroke.points {
        let (x, y) = (f64::from(*u) * f64::from(w), f64::from(*v) * f64::from(h));
        bounds = [
            bounds[0].min((x - radius).floor().max(0.0) as u32),
            bounds[1].min((y - radius).floor().max(0.0) as u32),
            bounds[2].max((x + radius).ceil().min(f64::from(w)) as u32),
            bounds[3].max((y + radius).ceil().min(f64::from(h)) as u32),
        ];
    }
    bounds
}

/// Preserve all model expansion except where the ordered painted footprint
/// adds/removes intent. Used by Smart paint; inference cannot erase user paint.
pub fn apply_to_mask(
    base: &RemovalMask,
    strokes: &[RemovalStroke],
) -> Result<Option<RemovalMask>, String> {
    base.validate()?;
    if strokes.is_empty() {
        return Ok(Some(base.clone()));
    }
    let mut bounds = [base.x, base.y, base.x + base.width, base.y + base.height];
    for stroke in strokes {
        stroke.validate()?;
        if !stroke.subtract {
            let b = stroke_bounds(base.source_width, base.source_height, stroke);
            bounds = [
                bounds[0].min(b[0]),
                bounds[1].min(b[1]),
                bounds[2].max(b[2]),
                bounds[3].max(b[3]),
            ];
        }
    }
    let [x, y, end_x, end_y] = bounds;
    let (width, height) = (end_x - x, end_y - y);
    let n = validate_mask_layout(base.source_width, base.source_height, x, y, width, height)?;
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(n)
        .map_err(|_| "removal selection: insufficient memory".to_string())?;
    pixels.resize(n, 0);
    for row in 0..base.height as usize {
        let offset =
            (base.y - y) as usize * width as usize + (base.x - x) as usize + row * width as usize;
        pixels[offset..offset + base.width as usize].copy_from_slice(
            &base.pixels[row * base.width as usize..(row + 1) * base.width as usize],
        );
    }
    let mut mask = RemovalMask {
        source_width: base.source_width,
        source_height: base.source_height,
        x,
        y,
        width,
        height,
        pixels,
    };
    for stroke in strokes {
        apply_stroke(&mut mask, stroke);
    }
    Ok(mask.pixels.iter().any(|v| *v == 255).then_some(mask))
}

pub(super) fn covers_point(w: u32, h: u32, stroke: &RemovalStroke, point: [f64; 2]) -> bool {
    let native = |p: [f32; 2]| {
        [
            f64::from(p[0]) * f64::from(w),
            f64::from(p[1]) * f64::from(h),
        ]
    };
    let point = [point[0] * f64::from(w), point[1] * f64::from(h)];
    let radius = f64::from(stroke.radius) * f64::from(w);
    let start = native(stroke.points[0]);
    segment_distance_squared(point, start, start) <= radius * radius
        || stroke
            .points
            .windows(2)
            .any(|p| segment_distance_squared(point, native(p[0]), native(p[1])) <= radius * radius)
}

fn apply_stroke(mask: &mut RemovalMask, stroke: &RemovalStroke) {
    let point = |p: [f32; 2]| {
        [
            f64::from(p[0]) * f64::from(mask.source_width),
            f64::from(p[1]) * f64::from(mask.source_height),
        ]
    };
    let radius = f64::from(stroke.radius) * f64::from(mask.source_width);
    let mut start = point(stroke.points[0]);
    for p in &stroke.points {
        let end = point(*p);
        let x0 = ((start[0].min(end[0]) - radius)
            .floor()
            .max(f64::from(mask.x)) as u32)
            .min(mask.x + mask.width);
        let y0 = ((start[1].min(end[1]) - radius)
            .floor()
            .max(f64::from(mask.y)) as u32)
            .min(mask.y + mask.height);
        let x1 = ((start[0].max(end[0]) + radius).ceil().max(0.0) as u32).min(mask.x + mask.width);
        let y1 = ((start[1].max(end[1]) + radius).ceil().max(0.0) as u32).min(mask.y + mask.height);
        for y in y0..y1 {
            for x in x0..x1 {
                if segment_distance_squared([f64::from(x) + 0.5, f64::from(y) + 0.5], start, end)
                    <= radius * radius
                {
                    let index = (y - mask.y) as usize * mask.width as usize + (x - mask.x) as usize;
                    mask.pixels[index] = if stroke.subtract { 0 } else { 255 };
                }
            }
        }
        start = end;
    }
}

fn segment_distance_squared(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let d = [b[0] - a[0], b[1] - a[1]];
    let length_squared = d[0] * d[0] + d[1] * d[1];
    let t = if length_squared == 0.0 {
        0.0
    } else {
        (((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / length_squared).clamp(0.0, 1.0)
    };
    let dx = p[0] - (a[0] + t * d[0]);
    let dy = p[1] - (a[1] + t * d[1]);
    dx * dx + dy * dy
}

#[cfg(test)]
#[path = "removal_selection_tests.rs"]
mod tests;
