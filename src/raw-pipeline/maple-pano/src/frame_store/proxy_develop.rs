//! A preview's per-frame develop (P2 of the panorama memory review): each
//! frame is developed band by band, pass 1's sensor rows parked in one temp
//! file reused frame after frame, and the developed blocks area-averaged
//! straight into the proxy by [`ProxySink`]. Neither the frame nor the
//! develop's full-frame planes are ever resident, and the proxy is
//! bit-identical to the full-frame `ingest_file_proxy` (the banded develop
//! is bit-identical to `decode_for_pano`, and `ProxySink` to
//! `proxy_to_long_edge`).

use std::fs::File;
use std::path::{Path, PathBuf};

use crate::error::PanoError;
use crate::ingest::{FrameMeta, FramePriors, ProxySink};

use super::{
    create_file, io, FileScratch, DIR_PREFIX, SCRATCH_BYTES_PER_PIXEL, SCRATCH_RESERVE_EIGHTHS,
};

/// Develops one frame at a time into its proxy.
pub struct ProxyDevelop {
    dir: PathBuf,
    scratch: Option<File>,
    scratch_path: PathBuf,
}

impl ProxyDevelop {
    /// A develop under `parent` for frames no larger than `largest_dims`
    /// (output pixels), failing with [`PanoError::InsufficientScratchSpace`]
    /// before anything is written when its volume can't hold one frame's
    /// pass-1 rows.
    pub fn create(parent: &Path, largest_dims: (u32, u32)) -> Result<Self, PanoError> {
        super::FrameStore::sweep_orphans(parent);
        let needed = largest_dims.0 as u64
            * largest_dims.1 as u64
            * SCRATCH_BYTES_PER_PIXEL
            * SCRATCH_RESERVE_EIGHTHS
            / 8;
        let available = io::available_bytes(parent).map_err(|e| PanoError::io(parent, e))?;
        if available < needed {
            return Err(PanoError::InsufficientScratchSpace {
                path: parent.to_path_buf(),
                needed,
                available,
            });
        }
        let dir = io::create_unique_dir(parent, DIR_PREFIX)?;
        let scratch_path = dir.join("proxy-scratch.rgbf32");
        match create_file(&scratch_path) {
            Ok(scratch) => Ok(Self {
                dir,
                scratch: Some(scratch),
                scratch_path,
            }),
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                Err(e)
            }
        }
    }

    /// `path` developed in `band_rows`-row bands to its `proxy_long_edge`
    /// proxy and metadata. `is_cancelled` is polled between bands.
    pub fn develop(
        &self,
        path: &Path,
        band_rows: u32,
        proxy_long_edge: u32,
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<FrameMeta, PanoError> {
        let bytes = std::fs::read(path).map_err(|e| PanoError::io(path, e))?;
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        let mut scratch = FileScratch {
            file: self.scratch.as_ref().expect("scratch lives until drop"),
            path: &self.scratch_path,
            width: 0,
        };
        let mut sink = ProxySink::new(proxy_long_edge);
        let decode_error = |source| PanoError::RawDecode {
            context: path.display().to_string(),
            source,
        };
        let ingest = raw_core::develop_banded_for_pano(
            bytes,
            &ext,
            band_rows,
            &mut scratch,
            &mut sink,
            is_cancelled,
        )
        .map_err(decode_error)?;
        let (proxy, (full_width, full_height)) = sink.finish().map_err(decode_error)?;
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
}

impl Drop for ProxyDevelop {
    fn drop(&mut self) {
        self.scratch = None;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
