//! Each stored frame's 1/[`MIP_FACTOR`] box-filtered mip (#6057). The
//! exposure field and the seam masks warp frames onto a ~1 MP canvas; for
//! a large panorama that canvas is many source pixels per canvas pixel, so
//! they read the mip, about 1/64 of the frame, instead of every full row.

/// Source pixels per mip pixel along each axis.
pub const MIP_FACTOR: u32 = 8;

/// Where a frame's mip sits in it: mip pixel `(j, i)` averages source
/// pixels `x0 + 8j .. x0 + 8j + 8` × `y0 + 8i .. y0 + 8i + 8`. The source
/// remainder is trimmed evenly from both sides, so the mip's centre is the
/// frame's (to within half a source pixel when the remainder is odd).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MipGeometry {
    pub width: u32,
    pub height: u32,
    x0: u32,
    y0: u32,
}

impl MipGeometry {
    /// The mip of a `w × h` frame, `None` when the frame is smaller than
    /// one mip pixel on either axis.
    pub fn of(w: u32, h: u32) -> Option<Self> {
        let (width, height) = (w / MIP_FACTOR, h / MIP_FACTOR);
        (width > 0 && height > 0).then_some(Self {
            width,
            height,
            x0: (w % MIP_FACTOR) / 2,
            y0: (h % MIP_FACTOR) / 2,
        })
    }

    fn cell(origin: u32, len: u32, at: u32) -> Option<usize> {
        let off = at.checked_sub(origin)? / MIP_FACTOR;
        (off < len).then_some(off as usize)
    }
}

/// Box sums of a frame's mip, filled block by block as the develop writes
/// the frame.
pub(super) struct MipBuilder {
    geometry: MipGeometry,
    sums: Vec<[f32; 3]>,
}

impl MipBuilder {
    pub(super) fn new(w: u32, h: u32) -> Option<Self> {
        let geometry = MipGeometry::of(w, h)?;
        Some(Self {
            sums: vec![[0.0; 3]; geometry.width as usize * geometry.height as usize],
            geometry,
        })
    }

    /// Add `pixels`, a `width`-wide block at `(x0, y0)` of the frame.
    pub(super) fn add_block(&mut self, x0: u32, y0: u32, width: u32, pixels: &[[f32; 3]]) {
        let g = self.geometry;
        for (k, row) in pixels.chunks_exact(width.max(1) as usize).enumerate() {
            let Some(my) = MipGeometry::cell(g.y0, g.height, y0 + k as u32) else {
                continue;
            };
            let sums = &mut self.sums[my * g.width as usize..(my + 1) * g.width as usize];
            for (dx, p) in row.iter().enumerate() {
                if let Some(mx) = MipGeometry::cell(g.x0, g.width, x0 + dx as u32) {
                    let s = &mut sums[mx];
                    *s = [s[0] + p[0], s[1] + p[1], s[2] + p[2]];
                }
            }
        }
    }

    /// The mip's pixels, row-major.
    pub(super) fn finish(self) -> Vec<[f32; 3]> {
        let area = (MIP_FACTOR * MIP_FACTOR) as f32;
        self.sums.into_iter().map(|s| s.map(|c| c / area)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mip_averages_centred_blocks_in_any_write_order() {
        let (w, h) = (21u32, 18u32);
        let px = |x: u32, y: u32| [x as f32, y as f32, (x * y) as f32];
        let frame: Vec<[f32; 3]> = (0..h).flat_map(|y| (0..w).map(move |x| px(x, y))).collect();
        let g = MipGeometry::of(w, h).unwrap();
        assert_eq!((g.width, g.height, g.x0, g.y0), (2, 2, 2, 1));
        let mut whole = MipBuilder::new(w, h).unwrap();
        whole.add_block(0, 0, w, &frame);
        let mut columns = MipBuilder::new(w, h).unwrap();
        for x in (0..w).rev() {
            let col: Vec<[f32; 3]> = (0..h).map(|y| px(x, y)).collect();
            columns.add_block(x, 0, 1, &col);
        }
        let (a, b) = (whole.finish(), columns.finish());
        assert_eq!(a, b);
        let expect = |mx: u32, my: u32| {
            let xs = 2 + 8 * mx..2 + 8 * mx + 8;
            let ys = 1 + 8 * my..1 + 8 * my + 8;
            let mean = |f: &dyn Fn(u32, u32) -> f32| {
                ys.clone()
                    .flat_map(|y| xs.clone().map(move |x| (x, y)))
                    .map(|(x, y)| f(x, y))
                    .sum::<f32>()
                    / 64.0
            };
            [
                mean(&|x, _| x as f32),
                mean(&|_, y| y as f32),
                mean(&|x, y| (x * y) as f32),
            ]
        };
        assert_eq!(a[3], expect(1, 1));
        assert_eq!(a[0][0], expect(0, 0)[0]);
        assert!(MipGeometry::of(7, 100).is_none());
    }
}
