//! Role review after segmentation: exact mask overlap, same prominence policy.
//! This does not infer duplicate-instance ownership or change manual choices.
use super::removal_people::{
    intersection, protect_overlaps, role_defaults, serialize_suggestions, Detection, PersonRole,
};
use crate::{
    pipeline::{packed_removal_mask, PackedRemovalMask},
    types::removal_models::REMOVAL_PERSON_MIN_SCORE,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema: u32,
    source_width: u32,
    source_height: u32,
    /// Already filtered, clipped and ordered by the box-proposal boundary.
    detections: Vec<Detection>,
    /// Lengths of concatenated MIMF assets, in exactly the detection order.
    mask_lengths: Vec<usize>,
}

/// Segmentation refines only the overlap decision. Empty masks cannot be
/// selected automatically, and a missing main-subject mask keeps all possible
/// backgrounds uncertain. No MIMF pixel planes are expanded or resized.
pub fn suggest_json(request: &str, bytes: &[u8]) -> Result<String, String> {
    let request: Request = serde_json::from_str(request)
        .map_err(|e| format!("person mask suggestions: invalid request: {e}"))?;
    if request.schema != 1
        || request.source_width == 0
        || request.source_height == 0
        || request.detections.len() > 300
        || request.mask_lengths.len() != request.detections.len()
    {
        return Err("person mask suggestions: invalid source, schema or mask count".into());
    }
    let w = request.source_width as f32;
    let h = request.source_height as f32;
    if request.detections.iter().any(|d| {
        d.class != 0
            || !d.score.is_finite()
            || !(REMOVAL_PERSON_MIN_SCORE..=1.0).contains(&d.score)
            || d.bounds.iter().any(|v| !v.is_finite())
            || d.bounds[0] < 0.0
            || d.bounds[1] < 0.0
            || d.bounds[2] > w
            || d.bounds[3] > h
            || d.bounds[0] >= d.bounds[2]
            || d.bounds[1] >= d.bounds[3]
    }) {
        return Err("person mask suggestions: require reviewed source-frame detections".into());
    }
    let total = request
        .mask_lengths
        .iter()
        .try_fold(0usize, |sum, n| sum.checked_add(*n))
        .ok_or("person mask suggestions: mask lengths overflow")?;
    if total != bytes.len() {
        return Err("person mask suggestions: mask lengths differ from input".into());
    }
    let mut offset = 0;
    let masks = request
        .mask_lengths
        .iter()
        .map(|length| {
            let asset = &bytes[offset..offset + length];
            offset += length;
            if asset.is_empty() {
                return Ok(None);
            }
            let mask = packed_removal_mask(asset)?;
            if mask.source_width != request.source_width
                || mask.source_height != request.source_height
            {
                return Err("person mask suggestions: mask source differs".into());
            }
            Ok((!mask.is_empty()).then_some(mask))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut roles = role_defaults(&request.detections);
    let missing_subject = roles
        .iter()
        .zip(&masks)
        .any(|(role, mask)| *role == PersonRole::Subject && mask.is_none());
    for (role, mask) in roles.iter_mut().zip(&masks) {
        if mask.is_none() || (missing_subject && *role == PersonRole::Background) {
            *role = PersonRole::Uncertain;
        }
    }
    protect_overlaps(&mut roles, |a, b| match (&masks[a], &masks[b]) {
        (Some(a), Some(b)) => overlap(a, b),
        _ => intersection(&request.detections[a], &request.detections[b]) > 0.0,
    });
    serialize_suggestions(request.detections, roles)
}

fn overlap(a: &PackedRemovalMask<'_>, b: &PackedRemovalMask<'_>) -> bool {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let end_x = (a.x + a.width).min(b.x + b.width);
    let end_y = (a.y + a.height).min(b.y + b.height);
    (y..end_y).any(|y| (x..end_x).any(|x| a.selected(x, y) && b.selected(x, y)))
}

#[cfg(test)]
#[path = "removal_people_masks_tests.rs"]
mod tests;
