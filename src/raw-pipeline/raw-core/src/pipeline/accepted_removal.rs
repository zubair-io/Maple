//! Validate durable accepted assets and frozen context dependencies (#3936).
//! Hosts read/publish bytes; the shared core owns identities and geometry.
use crate::types::accepted_removal::{
    AcceptedRemoval, ContentDigest, RemovalDependency, SourceAnchor,
};
use crate::types::{InpaintPatch, Removal};

pub fn removal_record_digest(removal: &Removal) -> Result<ContentDigest, String> {
    let canonical = crate::types::inpaint::encode_removals(std::slice::from_ref(removal))?;
    Ok(ContentDigest::for_bytes(canonical.as_bytes()))
}

/// The preceding intersecting records in composition order. Call at generation
/// time; comparing again on open/edit identifies stale context without changing
/// baked pixels. Non-intersecting edits do not invalidate a result.
pub fn removal_context_dependencies(
    prior: &[Removal],
    accepted: &AcceptedRemoval,
) -> Result<Vec<RemovalDependency>, String> {
    accepted.validate()?;
    for removal in prior {
        crate::types::inpaint::validate_removal(removal)?;
    }
    let context = accepted
        .context_window
        .region(accepted.source.width, accepted.source.height);
    prior
        .iter()
        .filter(|r| intersects(r.region, context))
        .map(|r| {
            Ok(RemovalDependency {
                record: removal_record_digest(r)?,
                patch: ContentDigest::parse(&r.patch_ref)?,
            })
        })
        .collect()
}

pub fn removal_needs_review(removal: &Removal, prior: &[Removal]) -> Result<bool, String> {
    crate::types::inpaint::validate_removal(removal)?;
    let Some(accepted) = &removal.accepted else {
        return Ok(false);
    };
    if prior
        .iter()
        .filter(|r| {
            intersects(
                r.region,
                accepted
                    .context_window
                    .region(accepted.source.width, accepted.source.height),
            )
        })
        .any(|r| {
            r.accepted
                .as_ref()
                .is_some_and(|a| a.source != accepted.source)
        })
    {
        return Ok(true);
    }
    Ok(accepted.dependencies != removal_context_dependencies(prior, accepted)?)
}

/// Verify both companion identities and native geometry before making an edit
/// available for complete render/export. Missing bytes are an error; callers
/// must expose recovery rather than rendering an image with an omitted edit.
pub fn resolve_accepted_removal(
    removal: &Removal,
    source: &SourceAnchor,
    mask_bytes: &[u8],
    patch_bytes: &[u8],
) -> Result<InpaintPatch, String> {
    crate::types::inpaint::validate_removal(removal)?;
    let accepted = removal
        .accepted
        .as_ref()
        .ok_or_else(|| "legacy removal needs its legacy resolver".to_string())?;
    if &accepted.source != source {
        return Err("removal source or decode anchor changed".into());
    }
    accepted.mask.verify(mask_bytes)?;
    ContentDigest::parse(&removal.patch_ref)?.verify(patch_bytes)?;
    let mask = super::removal_mask_from_bytes(mask_bytes)?;
    let patch = super::patch_from_bytes(patch_bytes)?;
    let window = accepted.patch_window;
    let mask_window = crate::types::accepted_removal::NativeWindow {
        x: mask.x,
        y: mask.y,
        width: mask.width,
        height: mask.height,
    };
    if mask.source_width != source.width
        || mask.source_height != source.height
        || !window.contains(&mask_window)
        || patch.width != window.width
        || patch.height != window.height
        || [
            patch.origin[0],
            patch.origin[1],
            patch.extent[0],
            patch.extent[1],
        ] != removal.region
    {
        return Err("removal companions disagree with native source geometry".into());
    }
    for y in 0..mask.height {
        for x in 0..mask.width {
            if mask.pixels[y as usize * mask.width as usize + x as usize] == 255 {
                let i = ((mask.y - window.y + y) as usize) * window.width as usize
                    + (mask.x - window.x + x) as usize;
                if patch.coverage[i] != 1.0 {
                    return Err(
                        "selected removal pixels must have opaque replacement coverage".into(),
                    );
                }
            }
        }
    }
    Ok(patch)
}

fn intersects(a: [f32; 4], b: [f32; 4]) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

#[cfg(test)]
#[path = "accepted_removal_tests.rs"]
mod tests;
