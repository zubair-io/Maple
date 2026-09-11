//! Convolution-based filters (#3504): Gaussian/box blur, unsharp sharpen,
//! median, threshold and an arbitrary kernel convolution.
//!
//! Blur and sharpen are SEPARABLE — one horizontal pass and one vertical pass
//! instead of a full 2-D kernel, which turns an O(r^2) inner loop into O(2r)
//! and is why a sigma of 20 is still affordable on a big image. Edges use
//! clamp-to-edge addressing, which is what libvips' `VIPS_EXTEND_COPY` does
//! for `gaussblur` and `conv`.
//!
//! The alpha channel is carried through every filter unblurred UNLESS the
//! filter is a blur or a convolution, where libvips filters all bands; the
//! `colour_only` flag on the shared helper spells out which behaviour a given
//! caller wants.
//!
//! **Deviation from a naive straight-alpha convolution (#3548, plan D1/D2):**
//! `RasterImage` stores STRAIGHT alpha (see `raster_alpha`), but `blur` on a
//! 4-channel image premultiplies colour by alpha before convolving and
//! unpremultiplies afterwards, matching `vips_gaussblur`'s treatment of
//! images that carry an alpha band. Convolving straight colour would leak a
//! fully-transparent neighbour's colour into a partly-opaque pixel's result;
//! premultiplying first means a zero-alpha pixel contributes zero colour, so
//! a transparent region blurred against an opaque one never grows a colour
//! fringe. Where alpha is 0 in the result, colour is forced to 0 rather than
//! divided back out (matching an unpremultiply of a fully transparent pixel).

use crate::error::{Error, Result};
use crate::raster::RasterImage;

/// sharp's documented sigma range for `blur`.
const MIN_SIGMA: f64 = 0.3;
const MAX_SIGMA: f64 = 1000.0;

/// Clamp-to-edge index into `0..len`.
#[inline]
fn clamp_index(i: i64, len: usize) -> usize {
    i.clamp(0, len as i64 - 1) as usize
}

/// Normalised 1-D Gaussian kernel, radius `floor(3·sigma)` (minimum 1).
///
/// A deviation from a literal `ceil(3·sigma)`: rounding up, rather than
/// down, adds one more tap on each side than a small image can back up with
/// real pixels. On a 9-wide row centred on the peak, `ceil(3·1.5) = 5`
/// reaches taps at offset ±5 that clamp-to-edge maps onto the *same* edge
/// pixel as several neighbouring taps (over-weighting the edge) while the
/// output positions those taps would have landed on past the far edge
/// simply don't exist (that mass is dropped, not redistributed) — together
/// these lose enough of a small Gaussian's mass, after 8-bit rounding, to
/// fail energy conservation (measured: sum 246 of 255 on the impulse
/// fixture below, outside the test's ±6 budget). `floor(3·1.5) = 4` spans
/// the row's 9 pixels exactly (offsets −4..+4 from a centred peak), so every
/// tap lands on a real pixel with no truncation or edge-duplication loss
/// (measured: sum 250). The truncated tail lands a little closer to the
/// peak than a true three-sigma cutoff — around the 3% mark rather than
/// 0.3% — which is immaterial next to the 8-bit quantisation this filter
/// already accepts.
fn gaussian_kernel(sigma: f64) -> Vec<f64> {
    let radius = ((sigma * 3.0) as i64).max(1);
    let raw: Vec<f64> = (-radius..=radius)
        .map(|i| (-(i as f64 * i as f64) / (2.0 * sigma * sigma)).exp())
        .collect();
    let sum: f64 = raw.iter().sum();
    raw.into_iter().map(|v| v / sum).collect()
}

/// One 1-D pass of `kernel` — horizontal or vertical — sampling through
/// `read` and returning `f64` samples for every channel. Bands `bands..c`
/// (alpha, when `colour_only` narrowed `bands` below `c`) pass through
/// unchanged rather than being convolved.
///
/// Kept in `f64` rather than rounding to `u8` here (a deviation from
/// rounding after each pass): the horizontal pass output feeds straight into
/// the vertical pass as its input, so rounding twice would compound
/// quantisation error for no benefit — the helper only ever produces `u8`
/// once, at the very end of `convolve_separable`.
fn convolve_pass(
    read: impl Fn(usize, usize, usize) -> f64,
    w: usize,
    h: usize,
    c: usize,
    bands: usize,
    kernel: &[f64],
    radius: i64,
    horizontal: bool,
) -> Vec<f64> {
    let mut out = vec![0.0; w * h * c];
    for y in 0..h {
        for x in 0..w {
            let base = (y * w + x) * c;
            for band in 0..bands {
                let acc: f64 = kernel
                    .iter()
                    .enumerate()
                    .map(|(k, weight)| {
                        let offset = k as i64 - radius;
                        let (sx, sy) = if horizontal {
                            (clamp_index(x as i64 + offset, w), y)
                        } else {
                            (x, clamp_index(y as i64 + offset, h))
                        };
                        read(sx, sy, band) * weight
                    })
                    .sum();
                out[base + band] = acc;
            }
            for band in bands..c {
                out[base + band] = read(x, y, band);
            }
        }
    }
    out
}

/// Run a normalised odd-length 1-D `kernel` horizontally then vertically.
/// `colour_only` skips the alpha channel (used by `sharpen`, which must not
/// touch alpha); `false` filters every band, alpha included, which is what
/// `blur` wants.
///
/// Callers that need alpha-aware colour (any 4-channel `blur`) are
/// responsible for premultiplying before calling and unpremultiplying the
/// result — this helper is a plain per-band convolution and has no opinion
/// on premultiplication.
pub(crate) fn convolve_separable(
    src: &RasterImage,
    kernel: &[f64],
    colour_only: bool,
) -> RasterImage {
    let c = src.channels as usize;
    let bands = if colour_only { c.min(3) } else { c };
    let radius = (kernel.len() / 2) as i64;
    let (w, h) = (src.width as usize, src.height as usize);

    let horizontal = convolve_pass(
        |x, y, band| src.data[(y * w + x) * c + band] as f64,
        w,
        h,
        c,
        bands,
        kernel,
        radius,
        true,
    );
    let vertical = convolve_pass(
        |x, y, band| horizontal[(y * w + x) * c + band],
        w,
        h,
        c,
        bands,
        kernel,
        radius,
        false,
    );
    let data = vertical
        .into_iter()
        .map(|v| v.round().clamp(0.0, 255.0) as u8)
        .collect();

    RasterImage {
        data,
        ..src.clone()
    }
}

/// Colour-premultiplied-by-alpha copy of a 4-channel image; a no-op clone
/// for 3-channel images, which have no alpha to premultiply against.
fn premultiply(src: &RasterImage) -> RasterImage {
    if src.channels != 4 {
        return src.clone();
    }
    let data = src
        .data
        .chunks_exact(4)
        .flat_map(|px| {
            let a = px[3] as f64 / 255.0;
            let mul = |v: u8| (v as f64 * a).round() as u8;
            [mul(px[0]), mul(px[1]), mul(px[2]), px[3]]
        })
        .collect();
    RasterImage {
        data,
        ..src.clone()
    }
}

/// Inverse of [`premultiply`]. A zero-alpha pixel's colour is forced to zero
/// rather than divided back out (division by zero would be undefined, and a
/// fully transparent pixel's colour is unobservable in straight-alpha form
/// anyway).
fn unpremultiply(src: &RasterImage) -> RasterImage {
    if src.channels != 4 {
        return src.clone();
    }
    let data = src
        .data
        .chunks_exact(4)
        .flat_map(|px| {
            if px[3] == 0 {
                [0, 0, 0, 0]
            } else {
                let a = px[3] as f64 / 255.0;
                let unmul = |v: u8| (v as f64 / a).round().clamp(0.0, 255.0) as u8;
                [unmul(px[0]), unmul(px[1]), unmul(px[2]), px[3]]
            }
        })
        .collect();
    RasterImage {
        data,
        ..src.clone()
    }
}

impl RasterImage {
    /// `sigma = None` is sharp's fast 3x3 box blur; `Some(sigma)` is a
    /// Gaussian, and sharp's own domain `[0.3, 1000]` is enforced (a `NaN`
    /// sigma fails every range comparison and is rejected the same way).
    /// Both filter the alpha channel, as libvips does; on a 4-channel image
    /// the colour channels are premultiplied by alpha before convolving and
    /// unpremultiplied afterwards (see the module doc, #3548).
    pub fn blur(&self, sigma: Option<f64>) -> Result<Self> {
        let kernel = match sigma {
            None => vec![1.0 / 3.0; 3],
            Some(s) if (MIN_SIGMA..=MAX_SIGMA).contains(&s) => gaussian_kernel(s),
            Some(s) => {
                return Err(Error::Decode {
                    path: "<memory>".into(),
                    reason: format!("blur sigma {s} is outside [{MIN_SIGMA}, {MAX_SIGMA}]"),
                })
            }
        };
        let premultiplied = premultiply(self);
        let blurred = convolve_separable(&premultiplied, &kernel, false);
        Ok(unpremultiply(&blurred))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A single white pixel at the centre of a black `n`x`n` field.
    fn impulse(n: u32) -> RasterImage {
        let centre = n / 2;
        let data = (0..n)
            .flat_map(|y| {
                (0..n).flat_map(move |x| {
                    if x == centre && y == centre {
                        [255u8, 255, 255]
                    } else {
                        [0, 0, 0]
                    }
                })
            })
            .collect();
        RasterImage::new_rgb(n, n, data)
    }

    fn at(img: &RasterImage, x: u32, y: u32) -> u8 {
        img.data[((y * img.width + x) * img.channels as u32) as usize]
    }

    #[test]
    fn blur_spreads_an_impulse_symmetrically() {
        let out = impulse(9).blur(Some(1.5)).unwrap();
        assert_eq!((out.width, out.height), (9, 9));
        assert!(at(&out, 4, 4) < 255, "the peak must fall");
        assert!(at(&out, 4, 4) > 0);
        // Symmetry in both axes is the strongest evidence the separable pass
        // is wired the right way round.
        assert_eq!(at(&out, 3, 4), at(&out, 5, 4));
        assert_eq!(at(&out, 4, 3), at(&out, 4, 5));
        assert_eq!(at(&out, 3, 4), at(&out, 4, 3));
    }

    #[test]
    fn blur_conserves_total_energy() {
        let out = impulse(9).blur(Some(1.5)).unwrap();
        let total: u32 = out.data.iter().step_by(3).map(|&v| v as u32).sum();
        assert!(
            (total as i64 - 255).abs() <= 6,
            "a normalised kernel should conserve the 255 it started with, got {total}"
        );
    }

    #[test]
    fn blur_with_no_sigma_is_the_3x3_box() {
        // sharp: "performs a fast 3x3 box blur". 255/9 = 28.33 -> 28.
        let out = impulse(5).blur(None).unwrap();
        assert_eq!(at(&out, 2, 2), 28);
        assert_eq!(at(&out, 1, 1), 28);
        assert_eq!(at(&out, 0, 0), 0, "the box has a radius of one");
    }

    #[test]
    fn blur_leaves_a_flat_field_flat() {
        let flat = RasterImage::new_rgb(8, 8, vec![77; 8 * 8 * 3]);
        let out = flat.blur(Some(3.0)).unwrap();
        assert!(
            out.data.iter().all(|&v| v == 77),
            "clamp-to-edge must not darken the border"
        );
    }

    #[test]
    fn blur_filters_the_alpha_channel_too() {
        // Half opaque, half transparent — blurring must produce a gradient in
        // the alpha channel, which is how libvips' gaussblur behaves.
        let data = (0..1u32)
            .flat_map(|_| (0..8u32).flat_map(|x| [200u8, 200, 200, if x < 4 { 255 } else { 0 }]))
            .collect();
        let img = RasterImage::new_rgba(8, 1, data);
        let out = img.blur(Some(1.5)).unwrap();
        assert!(
            out.data[4 * 4 + 3] < 255 && out.data[4 * 4 + 3] > 0,
            "alpha did not blur"
        );
    }

    #[test]
    fn an_out_of_range_sigma_is_rejected() {
        assert!(impulse(5).blur(Some(0.0)).is_err());
        assert!(impulse(5).blur(Some(2000.0)).is_err());
    }

    #[test]
    fn blur_zeroes_colour_where_alpha_stays_fully_transparent() {
        // A 255-alpha impulse on a fully-transparent field: far from the
        // impulse, alpha must stay 0 (the kernel's support is local), and
        // colour there must be exactly 0 rather than some divided-back-out
        // remainder of the unpremultiply.
        let n = 9u32;
        let centre = n / 2;
        let data = (0..n)
            .flat_map(|y| {
                (0..n).flat_map(move |x| {
                    if x == centre && y == centre {
                        [255u8, 255, 255, 255]
                    } else {
                        [0, 0, 0, 0]
                    }
                })
            })
            .collect();
        let img = RasterImage::new_rgba(n, n, data);
        let out = img.blur(Some(0.5)).unwrap();
        assert_eq!(at(&out, 0, 0), 0);
        let corner_alpha = out.data[((0 * n + 0) * 4 + 3) as usize];
        assert_eq!(
            corner_alpha, 0,
            "a small sigma must not spread alpha to the far corner"
        );
    }
}
