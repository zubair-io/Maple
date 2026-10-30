//! Stage 0 of a full-resolution stitch (#5554): every frame is developed
//! once, band by band, into the stitch's [`FrameStore`], and its proxy is
//! read back from the store. Every later stage reads the store's rows, so
//! no RAW is decoded twice and no stage holds a full-resolution frame it
//! does not need.

use std::path::{Path, PathBuf};

use raw_core::PanoBandedIngest;

use crate::error::PanoError;
use crate::frame_store::{FrameRows, FrameStore};
use crate::ingest::proxy::proxy_from_row_windows;
use crate::ingest::{FrameMeta, FramePriors};

use super::StitchError;

/// Develop band height: ~150 MB of working set on a 100 MP frame.
const BAND_ROWS: u32 = 1024;

/// Develop every input into a new store and build each frame's proxy and
/// metadata from it.
pub(super) fn decode_into_store(
    inputs: &[PathBuf],
    proxy_long_edge: u32,
    progress: &mut dyn FnMut(u32, f32),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<(FrameStore, Vec<FrameMeta>), StitchError> {
    let mut metas = Vec::with_capacity(inputs.len());
    let store = fill_store_with(inputs, progress, is_cancelled, |store, idx, ingest| {
        metas.push(frame_meta(
            store,
            idx,
            ingest,
            proxy_long_edge,
            &inputs[idx],
        )?);
        Ok(())
    })?;
    Ok((store, metas))
}

/// Develop every input into a new store, for a tail running from a reused
/// alignment that needs no proxies.
pub(super) fn fill_store(
    inputs: &[PathBuf],
    progress: &mut dyn FnMut(u32, f32),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<FrameStore, StitchError> {
    fill_store_with(inputs, progress, is_cancelled, |_, _, _| Ok(()))
}

fn fill_store_with(
    inputs: &[PathBuf],
    progress: &mut dyn FnMut(u32, f32),
    is_cancelled: &dyn Fn() -> bool,
    mut each: impl FnMut(&FrameStore, usize, PanoBandedIngest) -> Result<(), StitchError>,
) -> Result<FrameStore, StitchError> {
    progress(0, 0.0);
    let mut store = open_store(inputs)?;
    for (idx, path) in inputs.iter().enumerate() {
        if is_cancelled() {
            return Err(StitchError::Cancelled);
        }
        let ingest = store
            .ingest_file(idx, path, BAND_ROWS)
            .map_err(|e| store_error(path, e))?;
        each(&store, idx, ingest)?;
        progress(0, (idx + 1) as f32 / inputs.len() as f32);
    }
    Ok(store)
}

/// An empty store in the system temp directory, sized from each input's
/// header so the free-space check runs before anything is developed.
fn open_store(inputs: &[PathBuf]) -> Result<FrameStore, StitchError> {
    let dims = inputs
        .iter()
        .map(|path| {
            raw_core::raw_dimensions::from_file(path)
                .map(|[w, h]| (w, h))
                .map_err(|e| StitchError::Decode {
                    path: path.clone(),
                    cause: e.to_string(),
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let parent = std::env::temp_dir();
    FrameStore::create(&parent, &dims).map_err(|e| store_error(&parent, e))
}

fn frame_meta(
    store: &FrameStore,
    idx: usize,
    ingest: PanoBandedIngest,
    proxy_long_edge: u32,
    path: &Path,
) -> Result<FrameMeta, StitchError> {
    let (full_width, full_height) = store.frame_dims(idx).map_err(|e| store_error(path, e))?;
    let proxy = proxy_from_row_windows(full_width, full_height, proxy_long_edge, |y0, rows| {
        store.read_rows(idx, y0, rows)
    })
    .map_err(|e| store_error(path, e))?;
    Ok(FrameMeta {
        proxy_scale_x: full_width as f64 / proxy.width() as f64,
        proxy_scale_y: full_height as f64 / proxy.height() as f64,
        proxy,
        full_width,
        full_height,
        priors: FramePriors::from_metadata(&ingest.metadata),
        camera_make: ingest.metadata.camera_make,
        camera_model: ingest.metadata.camera_model,
        applied_opcodes: ingest.applied_opcodes,
        falloff_correction: ingest.falloff_correction,
    })
}

/// A store failure as the stitch reports it: out of scratch space keeps its
/// own variant, anything else is attributed to `path`.
pub(super) fn store_error(path: &Path, e: PanoError) -> StitchError {
    match e {
        PanoError::InsufficientScratchSpace {
            path,
            needed,
            available,
        } => StitchError::InsufficientScratchSpace {
            path,
            needed,
            available,
        },
        other => StitchError::Decode {
            path: path.to_path_buf(),
            cause: other.to_string(),
        },
    }
}
