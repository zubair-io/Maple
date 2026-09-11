//! `trim` (#3501): crop away a border of pixels similar to a background
//! colour, defaulting to the colour of the top-left pixel — sharp's
//! behaviour, which is libvips `find_trim`.
//!
//! A pixel is CONTENT when the largest absolute per-channel difference from
//! the background exceeds `threshold`. When the image has an alpha channel,
//! the alpha difference counts too, which is what sharp means by "the
//! combined bounding box of alpha and non-alpha channels".
//!
//! If trimming would remove everything — an image that is entirely
//! background — the image is returned unchanged. This is a deliberate
//! divergence from sharp, which throws ("Image to trim was empty...") in
//! that case; Maple prefers a no-op to an exception for a caller that trims
//! speculatively.
//!
//! sharp's `lineArt` option selects a different libvips algorithm and is NOT
//! in #3501; the recipe layer rejects it by name rather than ignoring it.

use crate::error::{Error, Result};
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
        // A non-finite threshold (NaN in particular) makes every `>`
        // comparison in `is_content` false, which silently returns the image
        // unchanged instead of erroring; a negative one would classify pixels
        // that exactly match the background as content. Both are caller bugs
        // to report, not behaviours to guess through.
        if !options.threshold.is_finite() || options.threshold < 0.0 {
            return Err(Error::Decode {
                path: "<memory>".into(),
                reason: format!(
                    "trim threshold must be a finite, non-negative number (got {})",
                    options.threshold
                ),
            });
        }
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
        // Nothing differed from the background: an all-background image is
        // returned unchanged rather than erroring (see the module doc).
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
    fn trim_rejects_a_nan_threshold() {
        let img = RasterImage::new_rgb(2, 2, vec![0; 12]);
        let err = img
            .trim(&TrimOptions {
                threshold: f64::NAN,
                ..TrimOptions::default()
            })
            .unwrap_err();
        assert!(format!("{err}").contains("NaN"), "got: {err}");
    }

    #[test]
    fn trim_rejects_a_negative_threshold() {
        let img = RasterImage::new_rgb(2, 2, vec![0; 12]);
        let err = img
            .trim(&TrimOptions {
                threshold: -1.0,
                ..TrimOptions::default()
            })
            .unwrap_err();
        assert!(format!("{err}").contains("-1"), "got: {err}");
    }

    #[test]
    fn content_touching_the_top_edge_is_not_trimmed_on_that_side() {
        // 4x4 white border, 2x2 black block starting at row 0 — the content
        // already reaches the top edge, so trim must not eat into it there.
        let img = framed(4, 4, [255, 255, 255], 1, 0, 2, 2, [0, 0, 0]);
        let out = img.trim(&TrimOptions::default()).unwrap();
        assert_eq!((out.width, out.height), (2, 2));
        assert_eq!(out.data, vec![0u8; 12]);
    }

    #[test]
    fn content_in_the_bottom_right_corner_is_found() {
        let img = framed(4, 4, [255, 255, 255], 2, 2, 2, 2, [0, 0, 0]);
        let out = img.trim(&TrimOptions::default()).unwrap();
        assert_eq!((out.width, out.height), (2, 2));
        assert_eq!(out.data, vec![0u8; 12]);
    }

    #[test]
    fn a_margin_wider_than_the_border_clamps_to_the_image() {
        // The content sits 2px in from every edge; asking for a margin of 10
        // must clamp back to the full 6x6 image rather than underflow or run
        // past its bounds.
        let img = framed(6, 6, [255, 255, 255], 2, 2, 2, 2, [0, 0, 0]);
        let out = img
            .trim(&TrimOptions {
                margin: 10,
                ..TrimOptions::default()
            })
            .unwrap();
        assert_eq!((out.width, out.height), (6, 6));
        assert_eq!(out.data, img.data);
    }

    #[test]
    fn trim_of_a_1x1_image_is_a_no_op() {
        let img = RasterImage::new_rgb(1, 1, vec![10, 20, 30]);
        let out = img
            .trim(&TrimOptions {
                background: Some([0, 0, 0, 255]),
                ..TrimOptions::default()
            })
            .unwrap();
        assert_eq!((out.width, out.height), (1, 1));
        assert_eq!(out.data, vec![10, 20, 30]);
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
