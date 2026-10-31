//! Where a compositor's finished canvas goes (#5452). The compositors hand
//! over full-width strips of finished rows, top to bottom, as soon as no
//! later work can change them, so a caller that encodes as it goes never
//! holds the whole canvas.

use crate::error::PanoError;
use crate::ingest::{PlanarImage, ValidityMask};

pub trait CanvasSink {
    /// Called once, before the first strip, with the canvas size.
    fn begin(&mut self, width: u32, height: u32) -> Result<(), PanoError>;
    /// The next full-width strip of finished rows. Uncovered pixels are
    /// zero and invalid.
    fn rows(&mut self, strip: &PlanarImage) -> Result<(), PanoError>;
}

/// Forwards to `inner` until `is_cancelled` reports true, then fails the
/// next strip with [`PanoError::Cancelled`] — the compositors' per-strip
/// cancellation checkpoint.
pub(crate) struct CancellableSink<'a> {
    inner: &'a mut dyn CanvasSink,
    is_cancelled: &'a dyn Fn() -> bool,
}

impl<'a> CancellableSink<'a> {
    pub fn new(inner: &'a mut dyn CanvasSink, is_cancelled: &'a dyn Fn() -> bool) -> Self {
        Self {
            inner,
            is_cancelled,
        }
    }

    fn checkpoint(&self) -> Result<(), PanoError> {
        if (self.is_cancelled)() {
            Err(PanoError::Cancelled)
        } else {
            Ok(())
        }
    }
}

impl CanvasSink for CancellableSink<'_> {
    fn begin(&mut self, width: u32, height: u32) -> Result<(), PanoError> {
        self.checkpoint()?;
        self.inner.begin(width, height)
    }

    fn rows(&mut self, strip: &PlanarImage) -> Result<(), PanoError> {
        self.checkpoint()?;
        self.inner.rows(strip)
    }
}

/// Forwards to `inner`, counting the pixels no frame covered.
pub(crate) struct UncoveredCount<'a> {
    inner: &'a mut dyn CanvasSink,
    pub(crate) uncovered: u64,
}

impl<'a> UncoveredCount<'a> {
    pub fn new(inner: &'a mut dyn CanvasSink) -> Self {
        Self {
            inner,
            uncovered: 0,
        }
    }
}

impl CanvasSink for UncoveredCount<'_> {
    fn begin(&mut self, width: u32, height: u32) -> Result<(), PanoError> {
        self.inner.begin(width, height)
    }

    fn rows(&mut self, strip: &PlanarImage) -> Result<(), PanoError> {
        let pixels = strip.width() as u64 * strip.height() as u64;
        self.uncovered += pixels - strip.validity.count_valid() as u64;
        self.inner.rows(strip)
    }
}

/// Assembles the strips into one whole-canvas image, for callers that need
/// it in memory (the quick preview, tests, evidence tools).
pub struct CanvasCollector {
    width: u32,
    height: u32,
    planes: [Vec<f32>; 3],
    validity: ValidityMask,
    next_row: u32,
}

impl Default for CanvasCollector {
    fn default() -> Self {
        Self {
            width: 0,
            height: 0,
            planes: Default::default(),
            validity: ValidityMask::new_filled(0, 0, false),
            next_row: 0,
        }
    }
}

impl CanvasCollector {
    /// The assembled canvas; empty (0 × 0) if nothing was composited.
    pub fn into_image(self) -> PlanarImage {
        let [r, g, b] = self.planes;
        PlanarImage::from_planes(self.width, self.height, r, g, b, self.validity)
    }
}

impl CanvasSink for CanvasCollector {
    fn begin(&mut self, width: u32, height: u32) -> Result<(), PanoError> {
        let n = width as usize * height as usize;
        self.width = width;
        self.height = height;
        self.planes.iter_mut().for_each(|p| p.reserve_exact(n));
        self.validity = ValidityMask::new_filled(width, height, false);
        Ok(())
    }

    fn rows(&mut self, strip: &PlanarImage) -> Result<(), PanoError> {
        for (plane, src) in self.planes.iter_mut().zip([&strip.r, &strip.g, &strip.b]) {
            plane.extend_from_slice(src);
        }
        let y0 = self.next_row;
        for y in 0..strip.height() {
            for x in (0..strip.width()).filter(|&x| strip.validity.get(x, y)) {
                self.validity.set(x, y0 + y, true);
            }
        }
        self.next_row += strip.height();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[test]
    fn a_cancelled_sink_refuses_the_next_strip_without_forwarding_it() {
        let strip = PlanarImage::from_planes(
            2,
            1,
            vec![0.5; 2],
            vec![0.5; 2],
            vec![0.5; 2],
            ValidityMask::new_filled(2, 1, true),
        );
        let cancelled = Cell::new(false);
        let is_cancelled = || cancelled.get();
        let mut collector = CanvasCollector::default();
        {
            let mut sink = CancellableSink::new(&mut collector, &is_cancelled);
            sink.begin(2, 2).expect("begin");
            sink.rows(&strip).expect("first strip");
            cancelled.set(true);
            assert!(matches!(sink.rows(&strip), Err(PanoError::Cancelled)));
        }
        assert_eq!(collector.next_row, 1);
    }
}
