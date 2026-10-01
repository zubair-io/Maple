//! Logical layers in the append-only mask-group wire (#3408). A group
//! header and its following components form ONE layer and one scope target.

use super::wire::{
    COMPONENT_CODE_COUNT, COMPONENT_COMBINE_STRIDE, KIND_COMPONENT_BASE, KIND_GROUP,
};
use super::{KIND_BITMAP, LAYER_FLAT_LEN};

/// Decode a component discriminant to its leaf kind. Reject future or
/// malformed records rather than treating them as linear masks.
pub fn component_leaf_kind(kind: f32) -> Option<f32> {
    let code = kind - KIND_COMPONENT_BASE;
    (code.is_finite() && code.fract() == 0.0 && (0.0..COMPONENT_CODE_COUNT as f32).contains(&code))
        .then_some((code as u32 % COMPONENT_COMBINE_STRIDE) as f32)
}

pub fn is_bitmap_record(kind: f32) -> bool {
    kind == KIND_BITMAP || component_leaf_kind(kind) == Some(KIND_BITMAP)
}

/// Stop at the first invalid layer, matching raw-core's flat decoder. No
/// component can escape its group and apply controls independently.
pub fn logical_layers(mut flat: &[f32]) -> impl Iterator<Item = &[f32]> {
    std::iter::from_fn(move || {
        if flat.len() < LAYER_FLAT_LEN {
            return None;
        }
        let kind = flat[6];
        let records = if kind == KIND_GROUP {
            let count = flat[0];
            if !count.is_finite()
                || count < 0.0
                || count.fract() != 0.0
                || count > (flat.len() / LAYER_FLAT_LEN - 1) as f32
            {
                flat = &[];
                return None;
            }
            1 + count as usize
        } else if kind.is_finite() && kind.fract() == 0.0 && (0.0..4.0).contains(&kind) {
            1
        } else {
            flat = &[];
            return None;
        };
        let (layer, rest) = flat.split_at(records * LAYER_FLAT_LEN);
        if kind == KIND_GROUP
            && layer[LAYER_FLAT_LEN..]
                .chunks_exact(LAYER_FLAT_LEN)
                .any(|component| component_leaf_kind(component[6]).is_none())
        {
            flat = &[];
            return None;
        }
        flat = rest;
        Some(layer)
    })
}
