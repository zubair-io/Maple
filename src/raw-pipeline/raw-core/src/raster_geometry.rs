//! Geometry ops on `RasterImage` (#3501): extract a window, mirror it, pad it,
//! rotate it. Every op is channel-agnostic — it moves whole pixels, so a
//! 4-channel image comes out 4-channel with its alpha in the right places.

use crate::error::{Error, Result};
use crate::raster::RasterImage;

/// sharp's per-edge `extend` counts, in pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExtendEdges {
    pub top: u32,
    pub bottom: u32,
    pub left: u32,
    pub right: u32,
}

/// sharp's documented ceiling on a single `extend` edge.
const MAX_EXTEND_EDGE: u32 = 10_000;

impl ExtendEdges {
    fn validate(self) -> Result<Self> {
        let over = [self.top, self.bottom, self.left, self.right]
            .into_iter()
            .find(|&e| e > MAX_EXTEND_EDGE);
        match over {
            Some(e) => Err(Error::Decode {
                path: "<memory>".into(),
                reason: format!("extend edge {e} exceeds the {MAX_EXTEND_EDGE}px limit"),
            }),
            None => Ok(self),
        }
    }
}

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

    /// Pad the edges with `background`. A background with alpha < 255 forces
    /// the result to 4 channels, because an opaque container cannot express
    /// the pad the caller asked for. On a 3-channel source with an opaque
    /// background, the fourth (alpha) byte of `background` is ignored.
    ///
    /// sharp's `extendWith` modes other than `background` (`copy`, `repeat`,
    /// `mirror`) are not in #3501 and are rejected at the recipe layer rather
    /// than silently treated as `background`.
    pub fn extend(&self, edges: ExtendEdges, background: [u8; 4]) -> Result<Self> {
        let edges = edges.validate()?;
        if edges == ExtendEdges::default() {
            return Ok(self.clone());
        }
        let src = if background[3] == 255 {
            self.clone()
        } else {
            self.ensure_alpha(255)
        };
        let c = src.channels as usize;
        let pad: Vec<u8> = background[..c].to_vec();
        let overflow = |reason: String| Error::Decode {
            path: "<memory>".into(),
            reason,
        };
        let width = src
            .width
            .checked_add(edges.left)
            .and_then(|w| w.checked_add(edges.right))
            .ok_or_else(|| {
                overflow(format!(
                    "extend width {} + {} left + {} right overflows",
                    src.width, edges.left, edges.right
                ))
            })?;
        let height = src
            .height
            .checked_add(edges.top)
            .and_then(|h| h.checked_add(edges.bottom))
            .ok_or_else(|| {
                overflow(format!(
                    "extend height {} + {} top + {} bottom overflows",
                    src.height, edges.top, edges.bottom
                ))
            })?;
        let row_of_pad = |n: u32| pad.iter().copied().cycle().take(n as usize * c);
        let src_row_len = src.width as usize * c;
        let data: Vec<u8> = (0..height)
            .flat_map(|y| {
                let inside = y >= edges.top && y < edges.top + src.height;
                if inside {
                    let sy = (y - edges.top) as usize;
                    row_of_pad(edges.left)
                        .chain(
                            src.data[sy * src_row_len..(sy + 1) * src_row_len]
                                .iter()
                                .copied(),
                        )
                        .chain(row_of_pad(edges.right))
                        .collect::<Vec<u8>>()
                } else {
                    row_of_pad(width).collect::<Vec<u8>>()
                }
            })
            .collect();
        Ok(Self {
            width,
            height,
            channels: src.channels,
            data,
            orientation: src.orientation,
        })
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

    #[test]
    fn extend_pads_each_edge_with_the_background() {
        let src = RasterImage::new_rgb(1, 1, vec![9, 9, 9]);
        let out = src
            .extend(
                ExtendEdges {
                    top: 1,
                    bottom: 0,
                    left: 2,
                    right: 0,
                },
                [1, 2, 3, 255],
            )
            .unwrap();
        assert_eq!((out.width, out.height, out.channels), (3, 2, 3));
        // Row 0 is all background; row 1 is background, background, source.
        assert_eq!(&out.data[..9], &[1, 2, 3, 1, 2, 3, 1, 2, 3]);
        assert_eq!(&out.data[9..], &[1, 2, 3, 1, 2, 3, 9, 9, 9]);
    }

    #[test]
    fn extend_with_a_transparent_background_promotes_rgb_to_rgba() {
        let src = RasterImage::new_rgb(1, 1, vec![9, 9, 9]);
        let out = src
            .extend(
                ExtendEdges {
                    top: 0,
                    bottom: 0,
                    left: 1,
                    right: 0,
                },
                [0, 0, 0, 0],
            )
            .unwrap();
        assert_eq!(out.channels, 4, "a transparent pad needs an alpha channel");
        assert_eq!(&out.data[..4], &[0, 0, 0, 0]);
        assert_eq!(&out.data[4..], &[9, 9, 9, 255]);
    }

    #[test]
    fn extend_preserves_alpha_on_an_rgba_source() {
        let src = RasterImage::new_rgba(1, 1, vec![9, 9, 9, 42]);
        let out = src
            .extend(
                ExtendEdges {
                    top: 0,
                    bottom: 0,
                    left: 1,
                    right: 0,
                },
                [1, 2, 3, 200],
            )
            .unwrap();
        assert_eq!((out.width, out.height, out.channels), (2, 1, 4));
        assert_eq!(
            &out.data[..4],
            &[1, 2, 3, 200],
            "pad carries the given alpha"
        );
        assert_eq!(
            &out.data[4..],
            &[9, 9, 9, 42],
            "source alpha survives the pad"
        );
    }

    #[test]
    fn extend_by_zero_on_every_edge_is_identity() {
        let src = ramp_rgb();
        let out = src
            .extend(
                ExtendEdges {
                    top: 0,
                    bottom: 0,
                    left: 0,
                    right: 0,
                },
                [0, 0, 0, 255],
            )
            .unwrap();
        assert_eq!(out.data, src.data);
    }

    #[test]
    fn extend_rejects_an_absurd_edge() {
        let src = ramp_rgb();
        assert!(src
            .extend(
                ExtendEdges {
                    top: 10_001,
                    bottom: 0,
                    left: 0,
                    right: 0,
                },
                [0, 0, 0, 255]
            )
            .is_err());
    }
}
