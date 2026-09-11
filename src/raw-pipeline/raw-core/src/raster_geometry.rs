//! Geometry ops on `RasterImage` (#3501): extract a window, mirror it, pad it,
//! rotate it. Every op is channel-agnostic — it moves whole pixels, so a
//! 4-channel image comes out 4-channel with its alpha in the right places.

use crate::error::Result;
use crate::raster::RasterImage;

impl RasterImage {
    /// sharp's `extract({ left, top, width, height })`. A thin, differently
    /// named front for [`RasterImage::crop`] so the recipe op and the package
    /// method read the same way sharp's do.
    pub fn extract(&self, left: u32, top: u32, width: u32, height: u32) -> Result<Self> {
        self.crop(left, top, width, height)
    }

    /// Mirror about the horizontal axis (sharp's `flip`).
    pub fn flip(&self) -> Self {
        let row_len = self.width as usize * self.channels as usize;
        let data = (0..self.height as usize)
            .rev()
            .flat_map(|y| self.data[y * row_len..(y + 1) * row_len].iter().copied())
            .collect();
        Self {
            data,
            ..self.clone()
        }
    }

    /// Mirror about the vertical axis (sharp's `flop`).
    pub fn flop(&self) -> Self {
        let c = self.channels as usize;
        let row_len = self.width as usize * c;
        let data = (0..self.height as usize)
            .flat_map(|y| {
                let row = &self.data[y * row_len..(y + 1) * row_len];
                (0..self.width as usize)
                    .rev()
                    .flat_map(move |x| row[x * c..x * c + c].iter().copied())
            })
            .collect();
        Self {
            data,
            ..self.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 3x2 RGB with a distinct value per pixel, so a transform that swaps
    /// rows or columns is visible in the bytes.
    fn ramp_rgb() -> RasterImage {
        RasterImage::new_rgb(
            3,
            2,
            vec![
                1, 1, 1, 2, 2, 2, 3, 3, 3, // row 0
                4, 4, 4, 5, 5, 5, 6, 6, 6, // row 1
            ],
        )
    }

    fn firsts(img: &RasterImage) -> Vec<u8> {
        img.data
            .chunks_exact(img.channels as usize)
            .map(|p| p[0])
            .collect()
    }

    #[test]
    fn extract_takes_the_named_window() {
        let out = ramp_rgb().extract(1, 0, 2, 2).unwrap();
        assert_eq!((out.width, out.height), (2, 2));
        assert_eq!(firsts(&out), vec![2, 3, 5, 6]);
    }

    #[test]
    fn extract_rejects_a_window_past_the_edge() {
        assert!(ramp_rgb().extract(2, 0, 2, 1).is_err());
        assert!(ramp_rgb().extract(0, 0, 0, 1).is_err());
    }

    #[test]
    fn extract_keeps_the_alpha_channel() {
        let src = RasterImage::new_rgba(
            3,
            2,
            vec![
                1, 1, 1, 10, 2, 2, 2, 20, 3, 3, 3, 30, // row 0
                4, 4, 4, 40, 5, 5, 5, 50, 6, 6, 6, 60, // row 1
            ],
        );
        let out = src.extract(1, 0, 2, 2).unwrap();
        assert_eq!((out.width, out.height, out.channels), (2, 2, 4));
        assert_eq!(
            out.data,
            vec![2, 2, 2, 20, 3, 3, 3, 30, 5, 5, 5, 50, 6, 6, 6, 60]
        );
    }

    #[test]
    fn flip_mirrors_vertically() {
        assert_eq!(firsts(&ramp_rgb().flip()), vec![4, 5, 6, 1, 2, 3]);
    }

    #[test]
    fn flop_mirrors_horizontally() {
        assert_eq!(firsts(&ramp_rgb().flop()), vec![3, 2, 1, 6, 5, 4]);
    }

    #[test]
    fn flip_and_flop_preserve_the_alpha_channel() {
        let rgba = RasterImage::new_rgba(2, 1, vec![1, 1, 1, 10, 2, 2, 2, 20]);
        let flopped = rgba.flop();
        assert_eq!(flopped.channels, 4);
        assert_eq!(flopped.data, vec![2, 2, 2, 20, 1, 1, 1, 10]);
        assert_eq!(rgba.flip().data, rgba.data, "a 1-row flip is identity");
    }
}
