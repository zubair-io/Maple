//! Separate distant painted areas without splitting a connected selection (#3984).
//! This is cold authoring work, never a slider stage or semantic person grouping.
use super::removal_proposal_plan::context_axis;
use super::{plan_removal_generation, removal_mask_to_bytes};
use crate::types::{accepted_removal::SourceAnchor, removal_mask::RemovalMask};

fn fits(bounds: [u32; 4], source: [u32; 2], radius: u32) -> bool {
    context_axis(bounds[0], bounds[2] - bounds[0], source[0], radius).is_ok()
        && context_axis(bounds[1], bounds[3] - bounds[1], source[1], radius).is_ok()
}

fn bounds(mask: &RemovalMask) -> [u32; 4] {
    [mask.x, mask.y, mask.x + mask.width, mask.y + mask.height]
}

fn union(a: [u32; 4], b: [u32; 4]) -> [u32; 4] {
    [
        a[0].min(b[0]),
        a[1].min(b[1]),
        a[2].max(b[2]),
        a[3].max(b[3]),
    ]
}

/// Small selections retain exact MIMF bytes. Otherwise, enumerate eight-connected
/// components in source scan order and greedily pack complete components into
/// native contexts. Every group is planned before any result is returned. One
/// oversized connected component refuses the entire operation, without cropping,
/// thinning, downsampling or submitting a successful prefix to inference.
pub fn paint_generation_intents(
    source: &str,
    intent: &[u8],
    hole_radius: u32,
    fringe_radius: f32,
) -> Result<Vec<Vec<u8>>, String> {
    let anchor: SourceAnchor = serde_json::from_str(source).map_err(|e| e.to_string())?;
    anchor.original.validate()?;
    anchor.decode.validate()?;
    let mask = super::removal_mask_store::packed_removal_mask(intent)?;
    let size = [anchor.width, anchor.height];
    if [mask.source_width, mask.source_height] != size {
        return Err("removal generation: selection source geometry changed".into());
    }
    let frame = [mask.x, mask.y, mask.x + mask.width, mask.y + mask.height];
    if fits(frame, size, hole_radius) {
        plan_removal_generation(source, intent, hole_radius, fringe_radius)?;
        return Ok(vec![intent.to_vec()]);
    }
    // Work on packed bits rather than expanding a potentially 100MP sparse
    // intent to one byte or one integer label per native source pixel.
    let mut pending = mask.bits.to_vec();
    let selected = |bits: &[u8], index: usize| bits[index / 8] & (1 << (index % 8)) != 0;
    let clear = |bits: &mut [u8], index: usize| bits[index / 8] &= !(1 << (index % 8));
    let mut groups: Vec<Vec<u8>> = Vec::new();
    let mut next_byte = 0;
    while let Some(offset) = pending[next_byte..].iter().position(|byte| *byte != 0) {
        next_byte += offset;
        let seed = next_byte * 8 + pending[next_byte].trailing_zeros() as usize;
        clear(&mut pending, seed);
        let mut points = vec![seed];
        let mut cursor = 0;
        let mut component = [anchor.width, anchor.height, 0, 0];
        while cursor < points.len() {
            let index = points[cursor];
            cursor += 1;
            let x = (index % mask.width as usize) as u32;
            let y = (index / mask.width as usize) as u32;
            component = union(
                component,
                [mask.x + x, mask.y + y, mask.x + x + 1, mask.y + y + 1],
            );
            if !fits(component, size, hole_radius) {
                return Err("removal generation: one connected painted area and its expansion exceed native context; refine that area before removing".into());
            }
            for ny in y.saturating_sub(1)..=(y + 1).min(mask.height - 1) {
                for nx in x.saturating_sub(1)..=(x + 1).min(mask.width - 1) {
                    let next = ny as usize * mask.width as usize + nx as usize;
                    if selected(&pending, next) {
                        clear(&mut pending, next);
                        points.push(next);
                    }
                }
            }
        }
        let [x, y, right, bottom] = component;
        let (width, height) = (right - x, bottom - y);
        let mut pixels = vec![0; width as usize * height as usize];
        for index in points {
            let sx = mask.x + (index % mask.width as usize) as u32;
            let sy = mask.y + (index / mask.width as usize) as u32;
            pixels[(sy - y) as usize * width as usize + (sx - x) as usize] = 255;
        }
        let component = RemovalMask {
            source_width: anchor.width,
            source_height: anchor.height,
            x,
            y,
            width,
            height,
            pixels,
        };
        let mut destination = None;
        for (index, group) in groups.iter().enumerate() {
            let group = super::removal_mask_store::packed_removal_mask(group)?;
            let group_bounds = [
                group.x,
                group.y,
                group.x + group.width,
                group.y + group.height,
            ];
            if fits(union(group_bounds, bounds(&component)), size, hole_radius) {
                destination = Some(index);
                break;
            }
        }
        let bytes = removal_mask_to_bytes(&component)?;
        if let Some(index) = destination {
            groups[index] =
                crate::stages::removal_selection::combine_masks(&groups[index], &bytes, false)?;
        } else {
            groups.push(bytes);
        }
    }
    if groups.is_empty() {
        return Err("removal generation: empty painted selection".into());
    }
    for group in &groups {
        plan_removal_generation(source, group, hole_radius, fringe_radius)?;
    }
    Ok(groups)
}

/// Ephemeral C/WASM transport: little-endian u32 count, then u32 byte length
/// and exact MIMF bytes per group. Durable assets remain ordinary MIMF records.
pub fn paint_generation_intents_packed(
    source: &str,
    intent: &[u8],
    hole_radius: u32,
    fringe_radius: f32,
) -> Result<Vec<u8>, String> {
    let groups = paint_generation_intents(source, intent, hole_radius, fringe_radius)?;
    let count = u32::try_from(groups.len()).map_err(|_| "removal generation: too many groups")?;
    let mut result = count.to_le_bytes().to_vec();
    for group in groups {
        let length =
            u32::try_from(group.len()).map_err(|_| "removal generation: group too large")?;
        result.extend_from_slice(&length.to_le_bytes());
        result.extend_from_slice(&group);
    }
    Ok(result)
}

#[cfg(test)]
#[path = "removal_paint_groups_tests.rs"]
mod tests;
