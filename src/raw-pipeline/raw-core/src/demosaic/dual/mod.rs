//! Dual demosaic — a detail-first kernel and [`super::vng4`] blended per
//! pixel by local contrast (#3413).
//!
//! ## Why
//!
//! AMaZE and RCD earn their cost by committing to an interpolation
//! direction, which is what resolves the last of the fine detail and what
//! keeps moiré off fabric and façades. In a region with no detail in it —
//! sky, a wall, an out-of-focus background — the direction they commit to is
//! chosen from sensor noise, and the reconstruction turns that noise into
//! maze patterning and false colour. VNG4 has the opposite failure mode: it
//! averages every direction that passes its threshold, which is quiet in
//! flat regions and soft on detail.
//!
//! Neither is wrong; they simply want different parts of the same frame. The
//! dual mode measures which part each pixel is in ([`weight`]) and hands it
//! to the kernel that suits it, cross-fading between them so no pixel sits
//! on a hard boundary between two reconstructions.
//!
//! RawTherapee and darktable both ship a dual demosaic on this principle.
//! The kernels here are this repository's own (see each module's provenance
//! note), and so is the mask formulation in [`weight`].
//!
//! ## Structure, and why it is not the obvious one
//!
//! The obvious implementation runs both kernels to completion and blends two
//! full-frame planes. On the 100 MP reference that is 1.2 GB of `[f32; 3]`
//! *twice*, on top of everything the develop chain already holds — the same
//! peak that jetsam-killed iOS on large RAWs before #1637 moved the sized
//! path to a half-res demosaic.
//!
//! So only the detail-first reconstruction is materialised full-frame; it is
//! also the output buffer. VNG4 is then rendered one [`BAND`] of rows at a
//! time into per-task scratch — it reads the shared read-only CFA plane
//! directly, so no sub-image copy is needed — and blended into the output in
//! place. Peak extra memory is one band's scratch per rayon task, a few tens
//! of megabytes rather than a second gigabyte.
//!
//! Each band renders [`weight::HALO`] extra rows on each side so the mask's
//! box filters see real data rather than a band edge; those rows are
//! computed and discarded, which is under 10 % of the band's work.

mod weight;

#[cfg(test)]
mod tests;

use super::flatten_mosaic;
use super::{amaze::amaze, rcd::rcd_cancellable, vng4};
use crate::cancel::CancelToken;
use crate::image::{CfaPattern, ColorSpace, Image};
use rayon::prelude::*;

pub use weight::{contrast_weights, CONTRAST_THRESHOLD, EDGE_RATIO};

/// Output rows per rayon task during the blend. Matches [`super::vng4`]'s
/// own band height, so a task's VNG4 work is one band's worth plus the
/// mask halo.
const BAND: usize = 64;

/// AMaZE in detailed regions, VNG4 in flat ones. The export-quality dual:
/// the best detail reconstruction available paired with the quietest.
///
/// AMaZE has no cancellable entry (it is not on the interactive cold-open
/// path), so neither does this.
pub fn dual_amaze_vng4(mosaic: &Image, cfa: CfaPattern) -> Image {
    let detailed = amaze(mosaic, cfa);
    blend_vng4_into(detailed, mosaic, cfa, CancelToken::never())
}

/// RCD in detailed regions, VNG4 in flat ones — the faster dual, for paths
/// that cannot afford AMaZE.
#[inline]
pub fn dual_rcd_vng4(mosaic: &Image, cfa: CfaPattern) -> Image {
    dual_rcd_vng4_cancellable(mosaic, cfa, CancelToken::never())
}

/// Cancellable variant of [`dual_rcd_vng4`]. The RCD pass and the blend both
/// honour `cancel`; a cancelled blend leaves that band at whatever RCD
/// produced, and the develop chain discards the whole buffer at its
/// post-demosaic bail either way.
pub fn dual_rcd_vng4_cancellable(
    mosaic: &Image,
    cfa: CfaPattern,
    cancel: CancelToken<'_>,
) -> Image {
    let detailed = rcd_cancellable(mosaic, cfa, cancel);
    blend_vng4_into(detailed, mosaic, cfa, cancel)
}

/// Blend the VNG4 reconstruction into `detailed` in place, band by band.
fn blend_vng4_into(
    mut detailed: Image,
    mosaic: &Image,
    cfa: CfaPattern,
    cancel: CancelToken<'_>,
) -> Image {
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let w = mosaic.width as usize;
    let h = mosaic.height as usize;

    // Nothing to blend: below VNG4's own minimum the two kernels are the
    // same bilinear reconstruction, and `par_chunks_mut(0)` panics on an
    // empty frame.
    if w == 0 || h == 0 || w < vng4::MIN_DIM || h < vng4::MIN_DIM {
        return detailed;
    }

    let cfa_flat = flatten_mosaic(mosaic, cfa);
    detailed
        .pixels
        .par_chunks_mut(w * BAND)
        .enumerate()
        .for_each(|(band_idx, band)| {
            if cancel.is_cancelled() {
                return;
            }
            blend_band(band, band_idx * BAND, mosaic, &cfa_flat, cfa, w, h);
        });
    detailed
}

/// Render VNG4 over one band plus its mask halo, derive the weights, and
/// cross-fade the band's own rows of `band` toward the smooth result.
fn blend_band(
    band: &mut [[f32; 3]],
    y0: usize,
    mosaic: &Image,
    cfa_flat: &[f32],
    cfa: CfaPattern,
    w: usize,
    h: usize,
) {
    let rows = band.len() / w;
    let sy0 = y0.saturating_sub(weight::HALO);
    let sy1 = (y0 + rows + weight::HALO).min(h);
    let scratch_rows = sy1 - sy0;

    let mut smooth = vec![[0.0f32; 3]; scratch_rows * w];
    vng4::render_band(&mut smooth, sy0, mosaic, cfa_flat, cfa, w, h);

    let green: Vec<f32> = smooth.iter().map(|p| p[1]).collect();
    let weights = weight::contrast_weights(&green, w, scratch_rows);

    for r in 0..rows {
        let sr = y0 + r - sy0;
        for x in 0..w {
            let t = weights[sr * w + x];
            let s = smooth[sr * w + x];
            let out = &mut band[r * w + x];
            for ch in 0..3 {
                out[ch] = s[ch] + t * (out[ch] - s[ch]);
            }
        }
    }
}
