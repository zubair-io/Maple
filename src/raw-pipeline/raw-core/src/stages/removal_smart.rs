//! Shared Smart paint proposal boundary (#3942). Model execution and release
//! qualification remain #3941; editor revision guards remain #1472 integration.
//! This module never commits edits or runs inside the slider chain.

use crate::types::accepted_removal::NativeWindow;
use crate::types::removal_mask::{RemovalMask, RemovalStroke};
use serde::{Deserialize, Serialize};

const SIDE: usize = 1024;
const CANDIDATES: usize = 4;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SmartMaskRequest {
    pub schema: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub window: NativeWindow,
    /// Actual unpadded content extent in the 1024-square encoder plane.
    /// The host prepares an aspect-preserved proxy, padded on bottom/right.
    pub input_width: u32,
    pub input_height: u32,
    #[serde(default)]
    pub prompts: Vec<SmartPrompt>,
    /// Ordered brush footprints remain authoritative after model expansion.
    #[serde(default)]
    pub strokes: Vec<RemovalStroke>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SmartPrompt {
    /// Normalized source coordinates of the continuous pixel centre, before
    /// orientation/presentation. 0/1 labels are keep/remove; 2/3 box corners.
    pub position: [f64; 2],
    pub label: u8,
}

#[derive(Serialize)]
struct ModelPrompts {
    points: Vec<[f32; 2]>,
    labels: Vec<i8>,
}

impl SmartMaskRequest {
    fn model_prompts(&self) -> Result<ModelPrompts, String> {
        self.window
            .validate(self.source_width, self.source_height)?;
        for stroke in &self.strokes {
            stroke.validate()?;
        }
        if self.schema != 1
            || self.input_width == 0
            || self.input_height == 0
            || self.input_width > SIDE as u32
            || self.input_height > SIDE as u32
            || self.prompts.is_empty()
            || self.prompts.len() > 64
        {
            return Err("smart selection: invalid schema, proxy extent or prompt count".into());
        }
        // The pinned encoder uses a 1024-long-edge proxy or an unscaled native
        // window padded to 1024. Exact integer rounding prevents distorted or
        // arbitrarily tiny proxies from passing a loose aspect tolerance.
        let longest = u64::from(self.window.width.max(self.window.height));
        let scaled =
            |extent: u32| ((u64::from(extent) * SIDE as u64 + longest / 2) / longest).max(1) as u32;
        let native =
            self.input_width == self.window.width && self.input_height == self.window.height;
        let resized = self.input_width == scaled(self.window.width)
            && self.input_height == scaled(self.window.height);
        if !native && !resized {
            return Err("smart selection: invalid aspect-preserved proxy extent".into());
        }
        let top_left = self.prompts.iter().filter(|p| p.label == 2).count();
        let bottom_right = self.prompts.iter().filter(|p| p.label == 3).count();
        if top_left > 1 || top_left != bottom_right {
            return Err("smart selection: box requires one ordered corner pair".into());
        }
        let has_box = top_left == 1;
        if !has_box && !self.prompts.iter().any(|p| p.label == 1) {
            return Err("smart selection: a positive prompt is required".into());
        }
        let mut points = Vec::with_capacity(self.prompts.len() + 1);
        let mut labels = Vec::with_capacity(self.prompts.len() + 1);
        for prompt in &self.prompts {
            if prompt.label > 3
                || prompt
                    .position
                    .iter()
                    .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
            {
                return Err("smart selection: invalid source prompt".into());
            }
            let local = [
                prompt.position[0] * f64::from(self.source_width) - f64::from(self.window.x),
                prompt.position[1] * f64::from(self.source_height) - f64::from(self.window.y),
            ];
            let extent = [self.window.width, self.window.height];
            let proxy = [self.input_width, self.input_height];
            let mut point = [0.0; 2];
            for axis in 0..2 {
                if local[axis] < 0.0
                    || local[axis] > f64::from(extent[axis])
                    || (prompt.label < 2 && local[axis] == f64::from(extent[axis]))
                {
                    return Err("smart selection: prompt outside source window".into());
                }
                // SAM adds 0.5 internally. Convert source continuous centres to
                // encoder pixel indices, preserving the half-open native mapping.
                point[axis] = (local[axis] * f64::from(proxy[axis]) / f64::from(extent[axis]) - 0.5)
                    .clamp(0.0, f64::from(proxy[axis] - 1)) as f32;
            }
            points.push(point);
            labels.push(prompt.label as i8);
        }
        if has_box {
            let a = points[labels.iter().position(|v| *v == 2).unwrap()];
            let b = points[labels.iter().position(|v| *v == 3).unwrap()];
            if a[0] >= b[0] || a[1] >= b[1] {
                return Err("smart selection: inverted or empty box".into());
            }
        } else {
            // Upstream ONNX point-only protocol requires a not-a-point token.
            points.push([0.0, 0.0]);
            labels.push(-1);
        }
        Ok(ModelPrompts { points, labels })
    }
}

pub(super) fn parse_request(json: &str) -> Result<SmartMaskRequest, String> {
    serde_json::from_str(json).map_err(|e| format!("smart selection: invalid request: {e}"))
}

/// Shared host preparation, including negative labels and point-only padding.
pub fn model_prompts_json(request: &str) -> Result<String, String> {
    serde_json::to_string(&parse_request(request)?.model_prompts()?)
        .map_err(|e| format!("smart selection: cannot serialize prompts: {e}"))
}

/// Embedding identity shared by native and browser authoring. Prompts/strokes
/// may change during refinement; the fixed source and proxy geometry may not.
pub fn context_identity(
    source: &crate::types::accepted_removal::SourceAnchor,
    request: &str,
) -> Result<crate::types::accepted_removal::ContentDigest, String> {
    source.original.validate()?;
    source.decode.validate()?;
    let request = parse_request(request)?;
    request.model_prompts()?;
    if source.width != request.source_width || source.height != request.source_height {
        return Err("smart selection: source geometry mismatch".into());
    }
    let bytes = serde_json::to_vec(&(
        source,
        request.window,
        request.input_width,
        request.input_height,
    ))
    .map_err(|e| format!("smart selection: context identity: {e}"))?;
    Ok(crate::types::accepted_removal::ContentDigest::for_bytes(
        &bytes,
    ))
}

pub fn context_identity_json(source: &str, request: &str) -> Result<String, String> {
    let source = serde_json::from_str(source)
        .map_err(|e| format!("smart selection: invalid source: {e}"))?;
    Ok(context_identity(&source, request)?.as_str().to_owned())
}

/// Validate model candidates and return a lossless native intent asset. An
/// error retains the editor's previous selection; it must never replace it
/// with an empty or prompt-violating proposal. Scores rank only valid masks.
pub fn mask_from_logits_json(
    request: &str,
    logits: &[f32],
    scores: &[f32],
) -> Result<Vec<u8>, String> {
    let request = parse_request(request)?;
    let choice = candidate_choice(&request, logits, scores)?;
    let plane = SIDE * SIDE;
    let values = &logits[choice * plane..(choice + 1) * plane];
    let mask = native_mask(&request, values)?;
    match super::removal_selection::apply_to_mask(&mask, &request.strokes)? {
        Some(mask) => crate::pipeline::removal_mask_to_bytes(&mask),
        None => Ok(Vec::new()),
    }
}

/// Rank only finite, nonempty candidates honoring every source prompt. Native
/// mask-conditioned passes use the same admission as the original proposal.
pub fn candidate_choice_json(
    request: &str,
    logits: &[f32],
    scores: &[f32],
) -> Result<usize, String> {
    candidate_choice(&parse_request(request)?, logits, scores)
}

fn candidate_choice(
    request: &SmartMaskRequest,
    logits: &[f32],
    scores: &[f32],
) -> Result<usize, String> {
    let prompts = request.model_prompts()?;
    if logits.len() != CANDIDATES * SIDE * SIDE
        || scores.len() != CANDIDATES
        || logits.iter().chain(scores).any(|v| !v.is_finite())
    {
        return Err("smart selection: invalid candidate shape or non-finite output".into());
    }
    let plane = SIDE * SIDE;
    (0..CANDIDATES)
        .filter(|candidate| {
            let content_nonempty = (0..request.input_height as usize).any(|y| {
                logits[candidate * plane + y * SIDE
                    ..candidate * plane + y * SIDE + request.input_width as usize]
                    .iter()
                    .any(|v| *v > 0.0)
            });
            content_nonempty
                && prompts
                    .points
                    .iter()
                    .zip(&prompts.labels)
                    .all(|(point, label)| {
                        *label < 0
                            || *label > 1
                            || (logits[candidate * plane
                                + (point[1] + 0.5).floor() as usize * SIDE
                                + (point[0] + 0.5).floor() as usize]
                                > 0.0)
                                == (*label == 1)
                    })
        })
        .reduce(|a, b| if scores[b] > scores[a] { b } else { a })
        .ok_or_else(|| {
            "smart selection: no candidate honors the positive and negative prompts".into()
        })
}

/// Convert continuous ordered Smart paint gestures into a bounded prompt set.
/// The returned request is reused for both model preparation and validation.
pub fn prepare_strokes_json(request: &str) -> Result<String, String> {
    let prepared = super::removal_smart_strokes::prepare(parse_request(request)?)?;
    prepared.model_prompts()?;
    serde_json::to_string(&prepared)
        .map_err(|e| format!("smart selection: cannot serialize strokes: {e}"))
}

fn native_mask(request: &SmartMaskRequest, logits: &[f32]) -> Result<RemovalMask, String> {
    let (iw, ih) = (request.input_width, request.input_height);
    let mut bounds = [iw, ih, 0, 0];
    for y in 0..ih {
        for x in 0..iw {
            if logits[y as usize * SIDE + x as usize] > 0.0 {
                bounds = [
                    bounds[0].min(x),
                    bounds[1].min(y),
                    bounds[2].max(x + 1),
                    bounds[3].max(y + 1),
                ];
            }
        }
    }
    if bounds[0] >= bounds[2] || bounds[1] >= bounds[3] {
        return Err("smart selection: candidate is empty in source content".into());
    }
    let w = request.window;
    let lower = |v: u32, native: u32, proxy: u32| {
        (u64::from(v) * u64::from(native) / u64::from(proxy)) as u32
    };
    let upper = |v: u32, native: u32, proxy: u32| {
        (u64::from(v) * u64::from(native)).div_ceil(u64::from(proxy)) as u32
    };
    let (x, y) = (
        lower(bounds[0], w.width, iw),
        lower(bounds[1], w.height, ih),
    );
    let (width, height) = (
        upper(bounds[2], w.width, iw) - x,
        upper(bounds[3], w.height, ih) - y,
    );
    let n = crate::types::removal_mask::validate_mask_layout(
        request.source_width,
        request.source_height,
        w.x + x,
        w.y + y,
        width,
        height,
    )?;
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(n)
        .map_err(|_| "smart selection: insufficient memory".to_string())?;
    for sy in y..y + height {
        let py = ((2 * u64::from(sy) + 1) * u64::from(ih) / (2 * u64::from(w.height))) as usize;
        for sx in x..x + width {
            let px = ((2 * u64::from(sx) + 1) * u64::from(iw) / (2 * u64::from(w.width))) as usize;
            pixels.push(if logits[py * SIDE + px] > 0.0 { 255 } else { 0 });
        }
    }
    if pixels.iter().all(|v| *v == 0) {
        return Err("smart selection: candidate vanishes at native resolution".into());
    }
    Ok(RemovalMask {
        source_width: request.source_width,
        source_height: request.source_height,
        x: w.x + x,
        y: w.y + y,
        width,
        height,
        pixels,
    })
}

#[cfg(test)]
#[path = "removal_smart_tests.rs"]
mod tests;
