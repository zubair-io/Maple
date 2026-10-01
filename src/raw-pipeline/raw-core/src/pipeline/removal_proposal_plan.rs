//! Concrete native-1024 authoring plan (#3941 / #3943). No source resizing.
use crate::stages::removal_generation::GenerationMaskRequest;
use crate::types::accepted_removal::{NativeWindow, SourceAnchor};

/// Select a bounded context containing the complete intent and hole expansion.
/// Large selections fail explicitly rather than losing native detail.
pub fn plan_removal_generation(
    source: &str,
    intent: &[u8],
    hole_radius: u32,
    fringe_radius: f32,
) -> Result<String, String> {
    let source: SourceAnchor = serde_json::from_str(source).map_err(|e| e.to_string())?;
    source.original.validate()?;
    source.decode.validate()?;
    let mask = super::removal_mask_from_bytes(intent)?;
    if (mask.source_width, mask.source_height) != (source.width, source.height) {
        return Err("removal generation: selection source geometry changed".into());
    }
    fn axis(origin: u32, length: u32, source: u32, radius: u32) -> Result<(u32, u32), String> {
        let low = origin.saturating_sub(radius);
        let high = origin
            .saturating_add(length)
            .saturating_add(radius)
            .min(source);
        let size = source.min(1024);
        if high - low > size {
            return Err("removal generation: selection and expansion exceed native context".into());
        }
        let centered = (low + (high - low) / 2).saturating_sub(size / 2);
        Ok((
            centered.clamp(high.saturating_sub(size), low.min(source - size)),
            size,
        ))
    }
    let (x, width) = axis(mask.x, mask.width, source.width, hole_radius)?;
    let (y, height) = axis(mask.y, mask.height, source.height, hole_radius)?;
    let request = GenerationMaskRequest {
        schema: 1,
        window: NativeWindow {
            x,
            y,
            width,
            height,
        },
        hole_radius,
        fringe_radius,
    };
    // One validator owns expansion, empty selection and fringe constraints.
    crate::stages::removal_generation::prepare(&request, &mask, None)?;
    serde_json::to_string(&request).map_err(|e| e.to_string())
}
