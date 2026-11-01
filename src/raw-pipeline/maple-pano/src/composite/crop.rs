//! Auto Crop (#5573): the largest axis-aligned rectangle of the output whose
//! every pixel is covered, found one row at a time in O(width) memory, and
//! the sink that keeps only that rectangle.

use crate::canvas::CanvasSpec;
use crate::error::PanoError;
use crate::ingest::{PlanarImage, ValidityMask};

use super::CanvasSink;

/// A rectangle of output pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl CropRect {
    fn area(&self) -> u64 {
        self.width as u64 * self.height as u64
    }
}

/// What Auto Crop did to one output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AutoCropReport {
    /// The kept rectangle, in uncropped output pixels; `None` when no
    /// covered rectangle exists and the output was left uncropped.
    pub rect: Option<CropRect>,
    /// Uncovered pixels inside the kept rectangle.
    pub invalid_px: u64,
}

/// Which rectangles a crop may keep. A 360° canvas keeps its whole
/// periodic axis, so the crop trims only the other one and the wrap
/// survives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CropAxes {
    Both,
    /// Every column kept: a standard 360° canvas, periodic in columns.
    FullWidth,
    /// Every row kept: a transverse 360° canvas, periodic in rows.
    FullHeight,
}

impl CropAxes {
    pub fn for_canvas(canvas: &CanvasSpec) -> Self {
        match (canvas.is_full_wrap(), canvas.projection.is_transverse()) {
            (false, _) => Self::Both,
            (true, false) => Self::FullWidth,
            (true, true) => Self::FullHeight,
        }
    }
}

/// The size of an output `canvas` pixels big after `auto_crop`.
pub(crate) fn output_size(auto_crop: Option<AutoCropReport>, canvas: (u32, u32)) -> (u32, u32) {
    auto_crop
        .and_then(|c| c.rect)
        .map_or(canvas, |r| (r.width, r.height))
}

/// The largest all-covered rectangle of a coverage mask streamed top to
/// bottom: each column's run of covered rows ending at the current row is
/// a histogram, and a monotone stack finds the largest rectangle under it.
pub(crate) struct LargestRect {
    heights: Vec<u32>,
    stack: Vec<(u32, u32)>,
    axes: CropAxes,
    rows: u32,
    best: Option<CropRect>,
}

impl LargestRect {
    pub fn new(width: u32, axes: CropAxes) -> Self {
        Self {
            heights: vec![0; width as usize],
            stack: Vec::with_capacity(width as usize + 1),
            axes,
            rows: 0,
            best: None,
        }
    }

    pub fn push_row(&mut self, covered: &[bool]) {
        debug_assert_eq!(covered.len(), self.heights.len());
        for (h, &c) in self.heights.iter_mut().zip(covered) {
            *h = if c { *h + 1 } else { 0 };
        }
        self.rows += 1;
        match self.axes {
            CropAxes::Both => self.scan_histogram(),
            CropAxes::FullWidth => {
                let height = self.heights.iter().copied().min().unwrap_or(0);
                self.consider(0, self.heights.len() as u32, height);
            }
            CropAxes::FullHeight => {}
        }
    }

    /// Several rows at once, row-major `width` pixels each.
    pub fn push_rows(&mut self, covered: &[bool]) {
        let width = self.heights.len().max(1);
        covered
            .chunks_exact(width)
            .for_each(|row| self.push_row(row));
    }

    pub fn finish(mut self) -> Option<CropRect> {
        if self.axes == CropAxes::FullHeight {
            self.widest_full_columns();
        }
        self.best
    }

    /// The widest run of columns covered in every row.
    fn widest_full_columns(&mut self) {
        let width = self.heights.len() as u32;
        let mut start = 0;
        for x in 0..=width {
            let full = self.heights.get(x as usize) == Some(&self.rows);
            if !full {
                self.consider(start, x - start, self.rows);
                start = x + 1;
            }
        }
    }

    fn scan_histogram(&mut self) {
        let width = self.heights.len() as u32;
        self.stack.clear();
        for x in 0..=width {
            let h = self.heights.get(x as usize).copied().unwrap_or(0);
            let mut start = x;
            while let Some(&(s, sh)) = self.stack.last() {
                if sh < h {
                    break;
                }
                self.stack.pop();
                self.consider(s, x - s, sh);
                start = s;
            }
            if h > 0 {
                self.stack.push((start, h));
            }
        }
    }

    fn consider(&mut self, x: u32, width: u32, height: u32) {
        let rect = CropRect {
            x,
            y: self.rows - height,
            width,
            height,
        };
        if rect.area() > self.best.map_or(0, |b| b.area()) {
            self.best = Some(rect);
        }
    }
}

/// Forwards only `rect`'s rows and columns of each strip to `inner`, so
/// every kept pixel is the uncropped output's pixel; everything when `rect`
/// is `None`.
pub(crate) struct CropSink<'a> {
    inner: &'a mut dyn CanvasSink,
    rect: Option<CropRect>,
    next_row: u32,
}

impl<'a> CropSink<'a> {
    pub fn new(inner: &'a mut dyn CanvasSink, rect: Option<CropRect>) -> Self {
        Self {
            inner,
            rect,
            next_row: 0,
        }
    }
}

impl CanvasSink for CropSink<'_> {
    fn begin(&mut self, width: u32, height: u32) -> Result<(), PanoError> {
        let (w, h) = self.rect.map_or((width, height), |r| (r.width, r.height));
        self.inner.begin(w, h)
    }

    fn rows(&mut self, strip: &PlanarImage) -> Result<(), PanoError> {
        let y0 = self.next_row;
        self.next_row += strip.height();
        let Some(rect) = self.rect else {
            return self.inner.rows(strip);
        };
        let first = rect.y.max(y0);
        let end = (rect.y + rect.height).min(self.next_row);
        if first >= end {
            return Ok(());
        }
        let (rows, sw) = (end - first, strip.width() as usize);
        let (cols, row_range) = (
            rect.x as usize..(rect.x + rect.width) as usize,
            (first - y0) as usize..(end - y0) as usize,
        );
        let [r, g, b] = [&strip.r, &strip.g, &strip.b].map(|plane| {
            row_range
                .clone()
                .flat_map(|y| {
                    plane[y * sw + cols.start..y * sw + cols.end]
                        .iter()
                        .copied()
                })
                .collect::<Vec<_>>()
        });
        let mut validity = ValidityMask::new_filled(rect.width, rows, false);
        for (ky, sy) in row_range.enumerate() {
            for (kx, sx) in cols.clone().enumerate() {
                if strip.validity.get(sx as u32, sy as u32) {
                    validity.set(kx as u32, ky as u32, true);
                }
            }
        }
        self.inner.rows(&PlanarImage::from_planes(
            rect.width, rows, r, g, b, validity,
        ))
    }
}

/// The largest rectangle of `image` whose every pixel is valid: what Auto
/// Crop must keep of an uncropped output.
#[cfg(test)]
pub(crate) fn largest_valid_rect(image: &PlanarImage, axes: CropAxes) -> Option<CropRect> {
    let mut search = LargestRect::new(image.width(), axes);
    for y in 0..image.height() {
        let row: Vec<bool> = (0..image.width())
            .map(|x| image.validity.get(x, y))
            .collect();
        search.push_row(&row);
    }
    search.finish()
}

#[cfg(test)]
#[path = "crop_tests.rs"]
mod tests;
