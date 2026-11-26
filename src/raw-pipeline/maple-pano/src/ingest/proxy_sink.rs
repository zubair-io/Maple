//! A frame's proxy built straight from a banded develop's blocks, so the
//! full-resolution frame is never resident (P2 of the panorama memory
//! review). Bit-identical to [`super::proxy::proxy_to_long_edge`] of the
//! whole frame: every proxy pixel sums its source rectangle in the same
//! row-major order, once all of that rectangle has arrived.
//!
//! [`raw_core::develop_banded_for_pano`] writes full-width row blocks, or
//! full-height column blocks under a 90°/270° orientation, in either
//! direction. A proxy line whose source span straddles two blocks keeps the
//! first block's share of that span (a few rows or columns) until the rest
//! arrives.

use raw_core::PanoBlockSink;

use super::proxy::{proxy_dims, source_span, Proxy};
use super::PlanarImage;

/// The [`PanoBlockSink`] side of [`super::proxy::proxy_to_long_edge`].
#[derive(Default)]
pub struct ProxySink {
    max_long_edge: u32,
    state: Option<Building>,
}

struct Building {
    src: (u32, u32),
    proxy: Proxy,
    axis: Option<Axis>,
    pending: Vec<Piece>,
    lines_done: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Axis {
    /// Full-width blocks; a line is a proxy row.
    Rows,
    /// Full-height blocks; a line is a proxy column.
    Cols,
}

/// Source lines `start..start + len` along the axis, whole across the other
/// axis, row-major `len` wide for columns and frame-wide for rows.
struct Piece {
    start: u32,
    len: u32,
    pixels: Vec<[f32; 3]>,
}

impl ProxySink {
    pub fn new(max_long_edge: u32) -> Self {
        Self {
            max_long_edge,
            state: None,
        }
    }

    /// The finished proxy and the developed frame's `(width, height)`.
    pub fn finish(self) -> raw_core::Result<(PlanarImage, (u32, u32))> {
        let building = self
            .state
            .ok_or_else(|| invalid("the develop wrote no frame"))?;
        let expected = match building.axis {
            Some(Axis::Cols) => building.proxy.dw,
            _ => building.proxy.dh,
        };
        if building.lines_done != expected || !building.pending.is_empty() {
            return Err(invalid("the develop ended before the frame was complete"));
        }
        Ok((building.proxy.finish(), building.src))
    }
}

impl PanoBlockSink for ProxySink {
    fn begin(&mut self, width: u32, height: u32) -> raw_core::Result<()> {
        let (dw, dh) = proxy_dims(width, height, self.max_long_edge).unwrap_or((width, height));
        self.state = Some(Building {
            src: (width, height),
            proxy: Proxy::new(dw, dh),
            axis: None,
            pending: Vec::new(),
            lines_done: 0,
        });
        Ok(())
    }

    fn put_block(
        &mut self,
        x0: u32,
        y0: u32,
        width: u32,
        pixels: &[[f32; 3]],
    ) -> raw_core::Result<()> {
        let building = self
            .state
            .as_mut()
            .ok_or_else(|| invalid("a block arrived before begin"))?;
        let rows = pixels.len() / (width as usize).max(1);
        if width == 0 || rows * width as usize != pixels.len() {
            return Err(invalid("a block is not whole rows"));
        }
        let (sw, sh) = building.src;
        let fits_rows = x0 == 0 && width == sw;
        let fits_cols = y0 == 0 && rows == sh as usize;
        let axis = *building
            .axis
            .get_or_insert(if fits_rows { Axis::Rows } else { Axis::Cols });
        let piece = match axis {
            Axis::Rows if fits_rows => Piece {
                start: y0,
                len: rows as u32,
                pixels: pixels.to_vec(),
            },
            Axis::Cols if fits_cols => Piece {
                start: x0,
                len: width,
                pixels: pixels.to_vec(),
            },
            _ => {
                return Err(invalid(
                    "a block spans neither the frame's width nor its height",
                ))
            }
        };
        building.add(axis, piece);
        Ok(())
    }
}

impl Building {
    fn add(&mut self, axis: Axis, piece: Piece) {
        let merged = self.merge_adjacent(axis, piece);
        let (src_len, dst_len) = self.extents(axis);
        let end = merged.start + merged.len;
        let first = line_of(merged.start, src_len, dst_len);
        let last = line_of(end - 1, src_len, dst_len);
        for line in first..=last {
            let (lo, hi) = source_span(line, src_len, dst_len);
            if lo as u32 >= merged.start && hi as u32 <= end {
                self.fill_line(axis, line, &merged);
                self.lines_done += 1;
            }
        }
        let keep = |line: u32| {
            let (lo, hi) = source_span(line, src_len, dst_len);
            (lo as u32) < merged.start || hi as u32 > end
        };
        let kept: Vec<(u32, u32)> = [first, last]
            .into_iter()
            .filter(|&line| keep(line))
            .map(|line| {
                let (lo, hi) = source_span(line, src_len, dst_len);
                ((lo as u32).max(merged.start), (hi as u32).min(end))
            })
            .fold(Vec::new(), |mut spans, span| {
                if spans.last() != Some(&span) {
                    spans.push(span);
                }
                spans
            });
        let other = self.other_extent(axis);
        self.pending.extend(
            kept.into_iter()
                .map(|(lo, hi)| slice(axis, &merged, other, lo, hi)),
        );
    }

    /// `piece` joined with every pending piece it touches, removed from
    /// `pending`.
    fn merge_adjacent(&mut self, axis: Axis, piece: Piece) -> Piece {
        let other = self.other_extent(axis);
        let mut merged = piece;
        while let Some(i) = self
            .pending
            .iter()
            .position(|p| p.start + p.len == merged.start || merged.start + merged.len == p.start)
        {
            let neighbour = self.pending.swap_remove(i);
            merged = if neighbour.start < merged.start {
                join(axis, neighbour, merged, other)
            } else {
                join(axis, merged, neighbour, other)
            };
        }
        merged
    }

    /// `(source, proxy)` extent along `axis`.
    fn extents(&self, axis: Axis) -> (u32, u32) {
        match axis {
            Axis::Rows => (self.src.1, self.proxy.dh),
            Axis::Cols => (self.src.0, self.proxy.dw),
        }
    }

    fn other_extent(&self, axis: Axis) -> u32 {
        match axis {
            Axis::Rows => self.src.0,
            Axis::Cols => self.src.1,
        }
    }

    /// Proxy line `line`, whose whole source span `piece` holds.
    fn fill_line(&mut self, axis: Axis, line: u32, piece: &Piece) {
        let (sw, sh) = self.src;
        let (dw, dh) = (self.proxy.dw, self.proxy.dh);
        let at = |sx: usize, sy: usize| match axis {
            Axis::Rows => piece.pixels[(sy - piece.start as usize) * sw as usize + sx],
            Axis::Cols => piece.pixels[sy * piece.len as usize + (sx - piece.start as usize)],
        };
        let cells: Vec<(u32, u32)> = match axis {
            Axis::Rows => (0..dw).map(|x| (x, line)).collect(),
            Axis::Cols => (0..dh).map(|y| (line, y)).collect(),
        };
        for (x, y) in cells {
            let (y0, y1) = source_span(y, sh, dh);
            let (x0, x1) = source_span(x, sw, dw);
            let (mut sr, mut sg, mut sb, mut n) = (0.0f64, 0.0f64, 0.0f64, 0u32);
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let p = at(sx, sy);
                    sr += p[0] as f64;
                    sg += p[1] as f64;
                    sb += p[2] as f64;
                    n += 1;
                }
            }
            self.proxy.set(x, y, sr, sg, sb, n);
        }
    }
}

/// The proxy line whose source span holds source line `r`: the largest `i`
/// with `⌊i·s/d⌋ ≤ r`.
fn line_of(r: u32, s: u32, d: u32) -> u32 {
    (((r as u64 + 1) * d as u64 - 1) / s as u64) as u32
}

fn join(axis: Axis, a: Piece, b: Piece, other: u32) -> Piece {
    let len = a.len + b.len;
    let pixels = match axis {
        Axis::Rows => [a.pixels, b.pixels].concat(),
        Axis::Cols => (0..other as usize)
            .flat_map(|y| {
                let ra = &a.pixels[y * a.len as usize..(y + 1) * a.len as usize];
                let rb = &b.pixels[y * b.len as usize..(y + 1) * b.len as usize];
                ra.iter().chain(rb).copied()
            })
            .collect(),
    };
    Piece {
        start: a.start,
        len,
        pixels,
    }
}

/// Source lines `lo..hi` of `piece`.
fn slice(axis: Axis, piece: &Piece, other: u32, lo: u32, hi: u32) -> Piece {
    let (from, to) = ((lo - piece.start) as usize, (hi - piece.start) as usize);
    let pixels = match axis {
        Axis::Rows => piece.pixels[from * other as usize..to * other as usize].to_vec(),
        Axis::Cols => (0..other as usize)
            .flat_map(|y| {
                let row = y * piece.len as usize;
                piece.pixels[row + from..row + to].iter().copied()
            })
            .collect(),
    };
    Piece {
        start: lo,
        len: hi - lo,
        pixels,
    }
}

fn invalid(reason: &str) -> raw_core::Error {
    raw_core::Error::Recipe(format!("pano proxy: {reason}"))
}

#[cfg(test)]
#[path = "proxy_sink_tests.rs"]
mod tests;
