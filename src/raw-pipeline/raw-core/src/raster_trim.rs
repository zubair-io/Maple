//! `trim` (#3501): crop away a border of pixels similar to a background
//! colour, defaulting to the colour of the top-left pixel — sharp's
//! behaviour, which is libvips `find_trim`.
//!
//! A pixel is CONTENT when the largest absolute per-channel difference from
//! the background exceeds `threshold`. When the image has an alpha channel,
//! the alpha difference counts too, which is what sharp means by "the
//! combined bounding box of alpha and non-alpha channels".
//!
//! If trimming would remove everything, the image is returned unchanged —
//! also sharp's documented behaviour.
//!
//! sharp's `lineArt` option selects a different libvips algorithm and is NOT
//! in #3501; the recipe layer rejects it by name rather than ignoring it.

use crate::error::Result;
use crate::raster::RasterImage;

/// sharp's `trim` options, minus `lineArt` (see the module doc).
#[derive(Clone, Copy, Debug)]
pub struct TrimOptions {
    /// `None` = use the top-left pixel, which is what sharp defaults to.
    pub background: Option<[u8; 4]>,
    pub threshold: f64,
    pub margin: u32,
}

impl Default for TrimOptions {
    fn default() -> Self {
        Self {
            background: None,
            threshold: 10.0,
            margin: 0,
        }
    }
}

impl RasterImage {
    pub fn trim(&self, options: &TrimOptions) -> Result<Self> {
        let c = self.channels as usize;
        let top_left: [u8; 4] = {
            let mut px = [0u8, 0, 0, 255];
            px[..c].copy_from_slice(&self.data[..c]);
            px
        };
        let background = options.background.unwrap_or(top_left);
        let is_content = |i: usize| {
            (0..c).any(|ch| {
                (self.data[i + ch] as f64 - background[ch] as f64).abs() > options.threshold
            })
        };
        let bounds = (0..self.height).fold(None, |acc: Option<(u32, u32, u32, u32)>, y| {
            (0..self.width).fold(acc, |acc, x| {
                let i = ((y as usize * self.width as usize) + x as usize) * c;
                if !is_content(i) {
                    return acc;
                }
                Some(match acc {
                    None => (x, y, x, y),
                    Some((l, t, r, b)) => (l.min(x), t.min(y), r.max(x), b.max(y)),
                })
            })
        });
        // Nothing differed from the background: sharp leaves the image alone.
        let Some((left, top, right, bottom)) = bounds else {
            return Ok(self.clone());
        };
        let m = options.margin;
        let x0 = left.saturating_sub(m);
        let y0 = top.saturating_sub(m);
        let x1 = (right + m).min(self.width - 1);
        let y1 = (bottom + m).min(self.height - 1);
        self.crop(x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `w`x`h` of `border`, with a `cw`x`ch` block of `fill` at (`cx`, `cy`).
    fn framed(
        w: u32,
        h: u32,
        border: [u8; 3],
        cx: u32,
        cy: u32,
        cw: u32,
        ch: u32,
        fill: [u8; 3],
    ) -> RasterImage {
        let data = (0..h)
            .flat_map(|y| {
                (0..w).flat_map(move |x| {
                    let inside = x >= cx && x < cx + cw && y >= cy && y < cy + ch;
                    if inside {
                        fill
                    } else {
                        border
                    }
                })
            })
            .collect();
        RasterImage::new_rgb(w, h, data)
    }

    #[test]
    fn trims_a_uniform_border_down_to_the_content() {
        let img = framed(6, 6, [255, 255, 255], 2, 1, 2, 3, [0, 0, 0]);
        let out = img.trim(&TrimOptions::default()).unwrap();
        assert_eq!((out.width, out.height), (2, 3));
        assert!(out.data.iter().all(|&v| v == 0));
    }

    #[test]
    fn an_explicit_background_wins_over_the_top_left_pixel() {
        let img = framed(5, 5, [255, 255, 255], 1, 1, 2, 2, [0, 0, 0]);
        // Ask it to trim BLACK instead: the black block is now the border to
        // remove, and since it does not reach any edge nothing is trimmed.
        let out = img
            .trim(&TrimOptions {
                background: Some([0, 0, 0, 255]),
                ..TrimOptions::default()
            })
            .unwrap();
        assert_eq!((out.width, out.height), (5, 5));
    }

    #[test]
    fn the_threshold_controls_sensitivity() {
        let img = framed(4, 4, [255, 255, 255], 1, 1, 2, 2, [250, 250, 250]);
        // Default threshold 10 treats 250 as "similar to 255" → nothing left,
        // so the image is returned unchanged.
        assert_eq!(img.trim(&TrimOptions::default()).unwrap().width, 4);
        // A tight threshold sees the 5-unit difference as content.
        let tight = img
            .trim(&TrimOptions {
                threshold: 1.0,
                ..TrimOptions::default()
            })
            .unwrap();
        assert_eq!((tight.width, tight.height), (2, 2));
    }

    #[test]
    fn margin_leaves_a_border_around_the_content() {
        let img = framed(6, 6, [255, 255, 255], 2, 2, 2, 2, [0, 0, 0]);
        let out = img
            .trim(&TrimOptions {
                margin: 1,
                ..TrimOptions::default()
            })
            .unwrap();
        assert_eq!((out.width, out.height), (4, 4));
    }

    #[test]
    fn a_fully_uniform_image_is_returned_unchanged() {
        let img = RasterImage::new_rgb(3, 3, vec![120; 27]);
        let out = img.trim(&TrimOptions::default()).unwrap();
        assert_eq!((out.width, out.height), (3, 3));
    }

    #[test]
    fn alpha_alone_is_enough_to_mark_content() {
        // Every pixel is the same colour; only alpha differs. The opaque
        // 2x2 block in the middle must survive.
        let data = (0..4u32)
            .flat_map(|y| {
                (0..4u32).flat_map(move |x| {
                    let inside = (1..3).contains(&x) && (1..3).contains(&y);
                    [80u8, 80, 80, if inside { 255 } else { 0 }]
                })
            })
            .collect();
        let img = RasterImage::new_rgba(4, 4, data);
        let out = img.trim(&TrimOptions::default()).unwrap();
        assert_eq!((out.width, out.height, out.channels), (2, 2, 4));
        assert!(out.data.chunks_exact(4).all(|p| p[3] == 255));
    }
}
