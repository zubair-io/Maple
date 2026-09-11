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

/// sharp's documented sigma range for `blur`. `sharpen` (`raster_sharpen.rs`)
/// has its own, different sigma domain (sharp's `lib/operation.js`), so this
/// stays private to this file rather than shared.
const MIN_SIGMA: f64 = 0.3;
const MAX_SIGMA: f64 = 1000.0;

/// libvips' `vips_gaussmat` default amplitude cutoff (its `min_ampl`): the
/// kernel is truncated at the last tap whose value is still >= this
/// fraction of the peak, rather than at a fixed multiple of sigma. See
/// `vips_gaussmat`/`vips_gaussblur` in libvips.
const MIN_AMPL: f64 = 0.2;

/// Kernel radius for `MIN_AMPL`: the largest `i` such that
/// `exp(-i²/2σ²) >= MIN_AMPL`, i.e. `i <= σ·sqrt(-2·ln(MIN_AMPL))`, rounded
/// up so the cutoff tap is never excluded, minimum 1. This is libvips'
/// amplitude-based sizing (see `MIN_AMPL` above), not a fixed multiple of
/// sigma — it's what makes Maple's blur radius match sharp/libvips' for the
/// same sigma, which earlier `sharpen` (#3504) and any caller comparing
/// pixels against a libvips render both depend on.
fn kernel_radius(sigma: f64) -> i64 {
    let scale = (-2.0 * MIN_AMPL.ln()).sqrt();
    ((sigma * scale).ceil() as i64).max(1)
}

/// Clamp-to-edge index into `0..len`. `pub(crate)` so `raster_filter_ops.rs`
/// (median/threshold/convolve, #3504 task E3) can share it rather than
/// redefine it.
#[inline]
pub(crate) fn clamp_index(i: i64, len: usize) -> usize {
    i.clamp(0, len as i64 - 1) as usize
}

/// Normalised 1-D Gaussian kernel, sized by [`kernel_radius`] (libvips'
/// amplitude cutoff, not a fixed multiple of sigma — see its doc comment).
///
/// At sigma 1.5 (the impulse fixture below) that's radius 3, and the
/// pre-rounding float sum across the blurred 9x9 impulse is 254.99999... —
/// i.e. convolution at this radius loses essentially none of the impulse's
/// mass to boundary clamping. What the *rounded* `u8` total falls slightly
/// short of 255 by is ordinary rounding bias: the blurred impulse spreads
/// into many small fractional values, most of them below 0.5, and rounding
/// each one down individually loses a little energy even though the float
/// total was exact. That bias only gets worse as the radius grows past the
/// image's own half-width — at radius 5 (the literal `ceil(3·sigma)` this
/// file used before this fix) taps starting reading the same clamped edge
/// pixel more than once while their matching *output* positions fall off
/// the far edge and are simply never written, which is a real (if small)
/// loss of mass on top of the rounding bias, and together are why that
/// radius failed conservation outright.
pub(crate) fn gaussian_kernel(sigma: f64) -> Vec<f64> {
    let radius = kernel_radius(sigma);
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
    ///
    /// An out-of-range sigma is a caller-parameter error, not a decode
    /// failure, so it's reported as [`Error::Pipeline`] rather than
    /// [`Error::Decode`] (whose message reads "rawler failed to decode
    /// `<memory>`: …", which would be misleading here). The rest of the
    /// `raster_*` family (`raster_composite`'s layer-size and offset checks
    /// among them) still reports parameter errors as `Error::Decode` for the
    /// same `"<memory>"` placeholder reason — that's a pre-existing
    /// inconsistency this task doesn't fix crate-wide, only in this file.
    pub fn blur(&self, sigma: Option<f64>) -> Result<Self> {
        let kernel = match sigma {
            None => vec![1.0 / 3.0; 3],
            Some(s) if (MIN_SIGMA..=MAX_SIGMA).contains(&s) => gaussian_kernel(s),
            Some(s) => {
                return Err(Error::Pipeline(format!(
                    "blur sigma {s} is outside [{MIN_SIGMA}, {MAX_SIGMA}]"
                )))
            }
        };
        let premultiplied = premultiply(self);
        let blurred = convolve_separable(&premultiplied, &kernel, false);
        Ok(unpremultiply(&blurred))
    }
}

#[cfg(test)]
#[path = "raster_filter_tests.rs"]
mod tests;
