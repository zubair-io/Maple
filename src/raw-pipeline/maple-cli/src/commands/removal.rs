//! Cold CLI companion loading. The core verifies the complete source-bound
//! stack; this module only supplies immutable local asset bytes (#3955).
use raw_core::{
    image::RawImage, pipeline::ResolvedCalibrationRemovals, types::accepted_removal::ContentDigest,
    xmp::AdjustmentModel,
};
use std::{collections::BTreeMap, path::Path};

pub(super) fn prepare(
    raw: &RawImage,
    source: &[u8],
    model: &AdjustmentModel,
    path: &Path,
) -> Result<Option<(ResolvedCalibrationRemovals, ContentDigest)>, Box<dyn std::error::Error>> {
    if model.inpaint_removals.is_empty() {
        return Ok(None);
    }
    let encoded = raw_core::types::inpaint::encode_removals(&model.inpaint_removals)?;
    let directory = path
        .parent()
        .ok_or("saved removals require a companion directory")?
        .join(".maple/inpaint");
    let assets = raw_core::pipeline::removal_asset_names(&encoded)?
        .into_iter()
        .map(|name| {
            let path = directory.join(&name);
            std::fs::read(&path)
                .map(|bytes| (name, bytes))
                .map_err(|error| format!("saved companion {}: {error}", path.display()))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let original = ContentDigest::for_bytes(source);
    let saved =
        ResolvedCalibrationRemovals::prepare(raw, &original, &model.inpaint_removals, &assets)?;
    Ok(Some((saved, original)))
}
