//! [`FrameRows`]: frame pixels by index and row window, the one interface
//! every full-resolution stitch stage reads through (#5554) — the stitch's
//! [`FrameStore`], [`InMemory`] frames, or a kept-frame [`Subset`] of either.

use crate::error::PanoError;
use crate::ingest::{PlanarImage, ValidityMask};

use super::FrameStore;

pub trait FrameRows: Sync {
    fn frame_count(&self) -> usize;
    /// `(width, height)` of frame `idx`.
    fn frame_dims(&self, idx: usize) -> Result<(u32, u32), PanoError>;
    /// Rows `y0..y0 + rows` of frame `idx`.
    fn read_rows(&self, idx: usize, y0: u32, rows: u32) -> Result<PlanarImage, PanoError>;

    fn read_frame(&self, idx: usize) -> Result<PlanarImage, PanoError> {
        let (_, height) = self.frame_dims(idx)?;
        self.read_rows(idx, 0, height)
    }
}

impl FrameRows for FrameStore {
    fn frame_count(&self) -> usize {
        self.planned.len()
    }

    fn frame_dims(&self, idx: usize) -> Result<(u32, u32), PanoError> {
        self.stored(idx).map(|(_, dims)| dims)
    }

    fn read_rows(&self, idx: usize, y0: u32, rows: u32) -> Result<PlanarImage, PanoError> {
        self.read_planar_rows(idx, y0, rows)
    }
}

/// Frames already decoded into memory (tests, and the preview's proxies).
#[derive(Clone, Copy)]
pub struct InMemory<'a>(pub &'a [PlanarImage]);

impl FrameRows for InMemory<'_> {
    fn frame_count(&self) -> usize {
        self.0.len()
    }

    fn frame_dims(&self, idx: usize) -> Result<(u32, u32), PanoError> {
        self.0
            .get(idx)
            .map(|f| (f.width(), f.height()))
            .ok_or_else(|| out_of_range(idx, self.0.len()))
    }

    fn read_rows(&self, idx: usize, y0: u32, rows: u32) -> Result<PlanarImage, PanoError> {
        let frame = self
            .0
            .get(idx)
            .ok_or_else(|| out_of_range(idx, self.0.len()))?;
        if y0 + rows > frame.height() {
            return Err(PanoError::InvalidOptions(format!(
                "frame {idx}: rows {y0}..{} past its {} rows",
                y0 + rows,
                frame.height()
            )));
        }
        let w = frame.width() as usize;
        let range = y0 as usize * w..(y0 + rows) as usize * w;
        let mut validity = ValidityMask::new_filled(frame.width(), rows, true);
        (0..rows).for_each(|y| {
            (0..frame.width()).for_each(|x| validity.set(x, y, frame.validity.get(x, y0 + y)))
        });
        Ok(PlanarImage::from_planes(
            frame.width(),
            rows,
            frame.r[range.clone()].to_vec(),
            frame.g[range.clone()].to_vec(),
            frame.b[range].to_vec(),
            validity,
        ))
    }

    fn read_frame(&self, idx: usize) -> Result<PlanarImage, PanoError> {
        self.0
            .get(idx)
            .cloned()
            .ok_or_else(|| out_of_range(idx, self.0.len()))
    }
}

/// Frames `indices[k]` of `inner`, as frame `k`.
pub struct Subset<'a> {
    pub inner: &'a dyn FrameRows,
    pub indices: &'a [usize],
}

impl FrameRows for Subset<'_> {
    fn frame_count(&self) -> usize {
        self.indices.len()
    }

    fn frame_dims(&self, idx: usize) -> Result<(u32, u32), PanoError> {
        self.inner.frame_dims(self.inner_index(idx)?)
    }

    fn read_rows(&self, idx: usize, y0: u32, rows: u32) -> Result<PlanarImage, PanoError> {
        self.inner.read_rows(self.inner_index(idx)?, y0, rows)
    }

    fn read_frame(&self, idx: usize) -> Result<PlanarImage, PanoError> {
        self.inner.read_frame(self.inner_index(idx)?)
    }
}

impl Subset<'_> {
    fn inner_index(&self, idx: usize) -> Result<usize, PanoError> {
        self.indices
            .get(idx)
            .copied()
            .ok_or_else(|| out_of_range(idx, self.indices.len()))
    }
}

fn out_of_range(idx: usize, len: usize) -> PanoError {
    PanoError::InvalidOptions(format!("frame {idx} out of range for {len} frames"))
}
