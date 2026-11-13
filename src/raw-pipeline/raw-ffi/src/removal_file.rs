//! Cold file-backed saved-edit consumption (#3955). Companion I/O belongs to
//! the host and never runs in retained slider/detail rendering.
use raw_core::{
    image::RawImage,
    pipeline::{CaptureBase, CaptureRender, RawInput, RenderQuality, ResolvedCalibrationRemovals},
    types::accepted_removal::ContentDigest,
    xmp::AdjustmentModel,
};
use std::{borrow::Cow, collections::BTreeMap, path::Path};

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

/// Cold file decode can use a cached mosaic, but accepted records still bind
/// to the actual original bytes. Empty stacks incur no extra file read.
pub(crate) fn render_saved_scene_from_path(
    raw: &RawImage,
    path: &Path,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cap: Option<u32>,
    cancel: raw_core::CancelToken<'_>,
) -> Option<raw_core::Result<(u32, u32, Vec<f32>, f32, f32, f32)>> {
    if model.inpaint_removals.is_empty() {
        return None;
    }
    Some(
        std::fs::read(path)
            .map_err(|source| raw_core::Error::Io {
                path: path.to_owned(),
                source,
            })
            .and_then(|bytes| {
                render_saved_scene(raw, &bytes, model, path.parent(), quality, cap, cancel)
                    .expect("nonempty stack requires verification")
            }),
    )
}

pub(crate) fn render_saved_scene(
    raw: &RawImage,
    bytes: &[u8],
    model: &AdjustmentModel,
    directory: Option<&Path>,
    quality: RenderQuality,
    cap: Option<u32>,
    cancel: raw_core::CancelToken<'_>,
) -> Option<raw_core::Result<(u32, u32, Vec<f32>, f32, f32, f32)>> {
    if cancel.is_cancelled() {
        return Some(Err(raw_core::Error::Cancelled));
    }
    prepare_saved(raw, bytes, model, directory).map(|prepared| {
        prepared.and_then(|(saved, original)| {
            saved.render_scene_linear_f32_with_anchors(raw, &original, model, quality, cap, cancel)
        })
    })
}

/// The capture decode with a saved stack (#5377). Only reached when `model`
/// carries accepted records: the companions resolve from the RAW's directory
/// for a file and from the sidecar's for bytes, as the scene-linear entries do.
pub(crate) fn render_saved_capture(
    raw: &RawImage,
    source: &crate::capture_f32::Source,
    xmp_path: Option<&str>,
    (loaded, model): (&AdjustmentModel, &AdjustmentModel),
    (quality, max_long_edge): (RenderQuality, Option<u32>),
    with_base: bool,
    cancel: raw_core::CancelToken<'_>,
) -> raw_core::Result<(CaptureRender, Option<CaptureBase>)> {
    if cancel.is_cancelled() {
        return Err(raw_core::Error::Cancelled);
    }
    let (bytes, directory) = match source {
        crate::capture_f32::Source::Path(path) => {
            let path = Path::new(path);
            let bytes = std::fs::read(path).map_err(|source| raw_core::Error::Io {
                path: path.to_owned(),
                source,
            })?;
            (Cow::Owned(bytes), path.parent())
        }
        crate::capture_f32::Source::Bytes { bytes, .. } => (
            Cow::Borrowed(bytes.as_slice()),
            xmp_path.and_then(|path| Path::new(path).parent()),
        ),
    };
    let (saved, original) = prepare_saved(raw, &bytes, model, directory)
        .expect("nonempty stack requires verification")?;
    if with_base {
        saved
            .render_capture_with_base(
                raw,
                &original,
                (loaded, model),
                quality,
                max_long_edge,
                cancel,
            )
            .map(|(capture, base)| (capture, Some(base)))
    } else {
        saved
            .render_capture(raw, &original, model, quality, max_long_edge, cancel)
            .map(|capture| (capture, None))
    }
}
