//! Rec.709 Cb/Cr vectorscope histogram (#3272). 128×128 bins over
//! `[-0.5, 0.5]²`, integer counts in 1/255 fixed point so a feathered mask
//! edge contributes fractionally, exactly what the WGSL twin
//! (`raw-gpu/src/scope_vectorscope.wgsl`) accumulates with integer atomics.

use crate::image::Image;

pub const VECTORSCOPE_BINS: usize = 128;
pub const WEIGHT_SCALE: f32 = 255.0;

#[derive(Clone, Debug, PartialEq)]
pub struct VectorscopeHistogram {
    /// Row-major `[cr_bin][cb_bin]`, `VECTORSCOPE_BINS²` entries.
    pub bins: Vec<u32>,
    /// Sum of every weight added, same fixed point as `bins`.
    pub total: u32,
}

/// Rec.709 chroma of a display-encoded RGB triple (each channel nominally 0…1).
#[inline]
pub fn cb_cr_rec709(rgb: [f32; 3]) -> (f32, f32) {
    let [r, g, b] = rgb;
    (
        -0.114572 * r - 0.385428 * g + 0.5 * b,
        0.5 * r - 0.454153 * g - 0.045847 * b,
    )
}

/// Bin of a chroma pair: `cb` selects the column, `cr` the row; both axes map
/// `[-0.5, 0.5)` onto `0..BINS` and clamp outside it.
#[inline]
pub fn bin_index(cb: f32, cr: f32) -> usize {
    let axis = |v: f32| -> usize {
        let scaled = ((v + 0.5) * VECTORSCOPE_BINS as f32).max(0.0);
        (scaled as usize).min(VECTORSCOPE_BINS - 1)
    };
    axis(cr) * VECTORSCOPE_BINS + axis(cb)
}

#[inline]
fn fixed_weight(w: f32) -> u32 {
    (w.clamp(0.0, 1.0) * WEIGHT_SCALE).round() as u32
}

fn accumulate(bins: &mut [u32], total: &mut u32, rgb: [f32; 3], w: u32) {
    if w == 0 {
        return;
    }
    let (cb, cr) = cb_cr_rec709(rgb);
    bins[bin_index(cb, cr)] += w;
    *total += w;
}

/// Histogram of `img` (display-encoded), optionally weighted per pixel
/// (`weights.len() == pixel count`; `None` = weight 1 everywhere).
pub fn vectorscope_histogram(img: &Image, weights: Option<&[f32]>) -> VectorscopeHistogram {
    let mut bins = vec![0u32; VECTORSCOPE_BINS * VECTORSCOPE_BINS];
    let mut total = 0u32;
    for (i, p) in img.pixels.iter().enumerate() {
        let w = weights
            .map(|ws| fixed_weight(ws[i]))
            .unwrap_or(WEIGHT_SCALE as u32);
        accumulate(&mut bins, &mut total, *p, w);
    }
    VectorscopeHistogram { bins, total }
}

/// The interleaved-RGBA sibling for GPU parity tests: alpha is the weight when
/// `use_alpha`, else every pixel weighs 1.
pub fn vectorscope_histogram_rgba(rgba: &[f32], use_alpha: bool) -> VectorscopeHistogram {
    let mut bins = vec![0u32; VECTORSCOPE_BINS * VECTORSCOPE_BINS];
    let mut total = 0u32;
    for px in rgba.chunks_exact(4) {
        let w = if use_alpha {
            fixed_weight(px[3])
        } else {
            WEIGHT_SCALE as u32
        };
        accumulate(&mut bins, &mut total, [px[0], px[1], px[2]], w);
    }
    VectorscopeHistogram { bins, total }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::{ColorSpace, Image};

    #[test]
    fn grey_lands_in_the_centre_bin() {
        let (cb, cr) = cb_cr_rec709([0.5, 0.5, 0.5]);
        assert!(cb.abs() < 1e-6 && cr.abs() < 1e-6);
        assert_eq!(bin_index(cb, cr), 64 * VECTORSCOPE_BINS + 64);
    }

    #[test]
    fn pure_red_has_positive_cr_and_negative_cb() {
        let (cb, cr) = cb_cr_rec709([1.0, 0.0, 0.0]);
        assert!(cr > 0.49 && cr <= 0.5, "cr {cr}");
        assert!(cb < 0.0, "cb {cb}");
        let idx = bin_index(cb, cr);
        assert_eq!(idx / VECTORSCOPE_BINS, VECTORSCOPE_BINS - 1, "top row");
    }

    #[test]
    fn extremes_clamp_into_the_grid() {
        assert_eq!(bin_index(-0.75, -0.75), 0);
        assert_eq!(
            bin_index(0.75, 0.75),
            VECTORSCOPE_BINS * VECTORSCOPE_BINS - 1
        );
    }

    #[test]
    fn unweighted_histogram_counts_255_per_pixel() {
        let mut img = Image::new(3, 2, ColorSpace::DisplayEncodedSrgb);
        img.pixels = vec![[0.5, 0.5, 0.5]; 6];
        let h = vectorscope_histogram(&img, None);
        assert_eq!(h.total, 6 * 255);
        assert_eq!(h.bins[64 * VECTORSCOPE_BINS + 64], 6 * 255);
        assert_eq!(h.bins.iter().map(|b| *b as u64).sum::<u64>(), 6 * 255);
    }

    #[test]
    fn weights_scale_counts_in_fixed_point_and_zero_weight_drops_the_pixel() {
        let mut img = Image::new(2, 1, ColorSpace::DisplayEncodedSrgb);
        img.pixels = vec![[0.5, 0.5, 0.5], [1.0, 0.0, 0.0]];
        let h = vectorscope_histogram(&img, Some(&[0.5, 0.0]));
        assert_eq!(h.total, 128);
        assert_eq!(h.bins[64 * VECTORSCOPE_BINS + 64], 128);
    }

    #[test]
    fn rgba_variant_reads_alpha_as_the_weight_only_when_asked() {
        let rgba = [0.5, 0.5, 0.5, 0.25, 0.5, 0.5, 0.5, 1.0];
        let with = vectorscope_histogram_rgba(&rgba, true);
        let without = vectorscope_histogram_rgba(&rgba, false);
        assert_eq!(with.total, 64 + 255);
        assert_eq!(without.total, 510);
    }
}
