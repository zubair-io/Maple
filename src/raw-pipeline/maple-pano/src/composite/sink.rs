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
