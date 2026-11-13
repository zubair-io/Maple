//! [`FrameRows`]: frame pixels by index and row or rectangle window, the
//! one interface every full-resolution stitch stage reads through (#5554,
//! #5560) — the stitch's
//! [`FrameStore`], [`InMemory`] frames, or a kept-frame [`Subset`] of either.

use crate::error::PanoError;
use crate::ingest::{PlanarImage, ValidityMask};

use super::FrameStore;

/// A pixel rectangle `x0..x0 + width` × `y0..y0 + height` of one frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameRect {
    pub x0: u32,
    pub y0: u32,
    pub width: u32,
    pub height: u32,
}

impl FrameRect {
    pub(crate) fn fits(&self, frame_w: u32, frame_h: u32) -> bool {
        self.x0
            .checked_add(self.width)
            .is_some_and(|x1| x1 <= frame_w)
            && self
                .y0
                .checked_add(self.height)
                .is_some_and(|y1| y1 <= frame_h)
    }
}

pub trait FrameRows: Sync {
    fn frame_count(&self) -> usize;
    /// `(width, height)` of frame `idx`.
    fn frame_dims(&self, idx: usize) -> Result<(u32, u32), PanoError>;
    /// Rows `y0..y0 + rows` of frame `idx`.
    fn read_rows(&self, idx: usize, y0: u32, rows: u32) -> Result<PlanarImage, PanoError>;
    /// The pixels of frame `idx` inside `rect`.
    fn read_rect(&self, idx: usize, rect: FrameRect) -> Result<PlanarImage, PanoError>;

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

    fn read_rect(&self, idx: usize, rect: FrameRect) -> Result<PlanarImage, PanoError> {
        self.read_planar_rect(idx, rect)
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

    fn read_rect(&self, idx: usize, rect: FrameRect) -> Result<PlanarImage, PanoError> {
        let frame = self
            .0
            .get(idx)
            .ok_or_else(|| out_of_range(idx, self.0.len()))?;
        if !rect.fits(frame.width(), frame.height()) {
            return Err(PanoError::InvalidOptions(format!(
                "frame {idx}: {rect:?} past its {}x{} pixels",
                frame.width(),
                frame.height()
            )));
        }
        let fw = frame.width() as usize;
        let ys = rect.y0..rect.y0 + rect.height;
        let crop = |plane: &[f32]| -> Vec<f32> {
            ys.clone()
                .flat_map(|y| {
                    let start = y as usize * fw + rect.x0 as usize;
                    plane[start..start + rect.width as usize].iter().copied()
                })
                .collect()
        };
        let mut validity = ValidityMask::new_filled(rect.width, rect.height, true);
        (0..rect.height).for_each(|y| {
            (0..rect.width)
                .for_each(|x| validity.set(x, y, frame.validity.get(rect.x0 + x, rect.y0 + y)))
        });
        Ok(PlanarImage::from_planes(
            rect.width,
            rect.height,
            crop(&frame.r),
            crop(&frame.g),
            crop(&frame.b),
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

    fn read_rect(&self, idx: usize, rect: FrameRect) -> Result<PlanarImage, PanoError> {
        self.inner.read_rect(self.inner_index(idx)?, rect)
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
