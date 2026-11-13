//! Windows of a stored frame that keep frame coordinates (#5560).
//!
//! [`SourceView`] bounds-checks a tap against the **full** frame exactly as
//! a whole-frame sampler does and only offsets the index into the window's
//! pixels, so a sampler that reads through a window covering every tap it
//! touches gives bit-identical results to reading the whole frame.

use crate::error::PanoError;
use crate::ingest::{PlanarImage, ValidityMask};

use super::{FrameRect, FrameRows};

/// Three `f32` planes plus a validity bit, rounded up.
pub(crate) const WINDOW_BYTES_PER_PX: u64 = 13;

/// Pixels of one frame read for one region of work, in frame coordinates.
pub(crate) struct SourceWindow {
    pixels: PlanarImage,
    x0: u32,
    y0: u32,
    frame_w: u32,
    frame_h: u32,
}

impl SourceWindow {
    pub(crate) fn view(&self) -> SourceView<'_> {
        SourceView {
            pixels: &self.pixels,
            x0: i64::from(self.x0),
            y0: i64::from(self.y0),
            frame_w: i64::from(self.frame_w),
            frame_h: i64::from(self.frame_h),
        }
    }
}

/// A borrowed window: `pixels` hold frame pixels from `(x0, y0)` on, of a
/// `frame_w × frame_h` frame.
#[derive(Clone, Copy)]
pub(crate) struct SourceView<'a> {
    pixels: &'a PlanarImage,
    x0: i64,
    y0: i64,
    frame_w: i64,
    frame_h: i64,
}

impl<'a> SourceView<'a> {
    /// A whole in-memory frame as its own window.
    pub(crate) fn whole(frame: &'a PlanarImage) -> Self {
        Self {
            pixels: frame,
            x0: 0,
            y0: 0,
            frame_w: i64::from(frame.width()),
            frame_h: i64::from(frame.height()),
        }
    }

    pub(crate) fn frame_dims(&self) -> (i64, i64) {
        (self.frame_w, self.frame_h)
    }

    /// Index into the planes of frame pixel `(col, row)`, `None` when it is
    /// invalid. The caller has already checked it lies inside the frame.
    #[inline]
    pub(crate) fn valid_index(&self, col: i64, row: i64) -> Option<usize> {
        let (x, y) = (col - self.x0, row - self.y0);
        let (w, h) = (
            i64::from(self.pixels.width()),
            i64::from(self.pixels.height()),
        );
        if x < 0 || y < 0 || x >= w || y >= h {
            debug_assert!(false, "tap ({col}, {row}) outside the read window");
            return None;
        }
        self.pixels
            .validity
            .get(x as u32, y as u32)
            .then_some((y * w + x) as usize)
    }

    pub(crate) fn pixels(&self) -> &'a PlanarImage {
        self.pixels
    }
}

impl SourceWindow {
    /// Frame `idx`'s pixels inside `rect`; `None` reads nothing and gives
    /// an empty window of a `frame_dims` frame.
    pub(crate) fn read(
        frames: &dyn FrameRows,
        idx: usize,
        rect: Option<FrameRect>,
        frame_dims: (u32, u32),
    ) -> Result<Self, PanoError> {
        let pixels = match rect {
            Some(rect) => frames.read_rect(idx, rect)?,
            None => PlanarImage::from_planes(
                0,
                0,
                Vec::new(),
                Vec::new(),
                Vec::new(),
                ValidityMask::new_filled(0, 0, false),
            ),
        };
        let (x0, y0) = rect.map_or((0, 0), |r| (r.x0, r.y0));
        Ok(Self {
            pixels,
            x0,
            y0,
            frame_w: frame_dims.0,
            frame_h: frame_dims.1,
        })
    }
}
