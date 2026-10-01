//! Cold file-backed saved-edit consumption (#3955). Companion I/O belongs to
//! the host and never runs in retained slider/detail rendering.
use raw_core::{
    image::RawImage,
    pipeline::{RawInput, RenderQuality, ResolvedCalibrationRemovals},
    types::accepted_removal::ContentDigest,
    xmp::AdjustmentModel,
};
use std::{collections::BTreeMap, path::Path};

/// Return None for the historical unedited path, preserving its exact caller
/// semantics. A saved stack requires all immutable companions and source checks;
/// inability to resolve them cannot become a successful unedited render.
pub(crate) fn prepare_saved(
    raw: &RawImage,
    source_bytes: &[u8],
    model: &AdjustmentModel,
    directory: Option<&Path>,
) -> Option<raw_core::Result<(ResolvedCalibrationRemovals, ContentDigest)>> {
    if model.inpaint_removals.is_empty() {
        return None;
    }
    Some((|| {
        let directory = directory.ok_or_else(|| {
            raw_core::Error::Pipeline(
                "saved removals require a companion directory or bundle".into(),
            )
        })?;
        let encoded = raw_core::types::inpaint::encode_removals(&model.inpaint_removals)
            .map_err(raw_core::Error::Pipeline)?;
        let names =
            raw_core::pipeline::removal_asset_names(&encoded).map_err(raw_core::Error::Pipeline)?;
        let assets = names
            .into_iter()
            .map(|name| {
                let path = directory.join(".maple/inpaint").join(&name);
                std::fs::read(&path)
                    .map(|bytes| (name, bytes))
                    .map_err(|error| {
                        raw_core::Error::Pipeline(format!(
                            "saved companion {}: {error}",
                            path.display()
                        ))
                    })
            })
            .collect::<raw_core::Result<BTreeMap<_, _>>>()?;
        let original = ContentDigest::for_bytes(source_bytes);
        let saved =
            ResolvedCalibrationRemovals::prepare(raw, &original, &model.inpaint_removals, &assets)
                .map_err(raw_core::Error::Pipeline)?;
        Ok((saved, original))
    })())
}

pub(crate) fn render_saved(
    raw: &RawImage,
    source_bytes: &[u8],
    model: &AdjustmentModel,
    directory: Option<&Path>,
    source: Option<RawInput<'_>>,
    quality: RenderQuality,
    film: Option<&raw_core::film::FilmLut>,
) -> Option<raw_core::Result<(u32, u32, Vec<u8>)>> {
    prepare_saved(raw, source_bytes, model, directory).map(|saved| {
        saved.and_then(|(saved, original)| {
            saved.render_display(raw, &original, model, quality, source, None, film)
        })
    })
}
