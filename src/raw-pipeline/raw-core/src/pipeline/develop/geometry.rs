//! Sensor-coordinate geometry helpers for the develop chains: applying the
//! DNG-recommended default crop and mapping raw-sensor coordinates onto the
//! post-demosaic buffer. Used by `develop`, `develop_sized`, and `pano`;
//! `develop` re-exports them (`pub(in crate::pipeline)`) so the sibling
//! chains keep addressing them as `develop::{crop_to_default, ...}`.

use crate::{
    image::{CfaPattern, CropRect, Image},
    pipeline::RenderQuality,
};

/// Crop the camera-RGB image to the DNG-recommended render rectangle.
///
/// `crop` is in raw-sensor pixel coordinates; for half-res Preview we scale
/// it by `quality_divisor` (2 for Preview, 1 for Full/Amaze) so the crop
/// lands at the right place in the half-res buffer. Out-of-range or
/// zero-sized rects fall through to a no-op (keep the buffer as-is) —
/// safety net for malformed sources that survive `CropRect::clamped`.
///
/// Cheap: one allocation of the cropped buffer plus one row-by-row copy.
/// Runs on a buffer that's still in `CameraNativeLinearRgb`, so the
/// downstream DCP / scene-linear chain operates on the smaller, post-crop
/// dimensions — saving allocator work for every later stage too.
/// Returns `Some(cropped)` when the crop actually shrinks the buffer,
/// `None` when it's a no-op (degenerate rect or full-coverage rect) so
/// the caller can keep its existing buffer without paying for an
/// `Image::clone()`. On a 100MP frame that clone is ~1.2 GB of f32 data,
/// so the no-op path matters even though it fires rarely.
pub(in crate::pipeline) fn crop_to_default(
    image: &Image,
    crop: CropRect,
    quality_divisor: u32,
) -> Option<Image> {
    // Sensor-coords → buffer-coords. Preview's demosaic halves both axes;
    // round DOWN on the origin (lose no in-frame pixels to off-by-one)
    // and round DOWN on the size (drop the trailing half-pixel rather
    // than reaching into post-crop sensor territory).
    let qd = quality_divisor.max(1);
    let cx = crop.x / qd;
    let cy = crop.y / qd;
    let cw = crop.w / qd;
    let ch = crop.h / qd;
    // Clamp to the actual buffer extent. Defensive: a half-res Preview of
    // a sensor whose crop touches the bottom-right edge can lose a row
    // to integer rounding above; let the buffer's true (w, h) win.
    let cw = cw.min(image.width.saturating_sub(cx));
    let ch = ch.min(image.height.saturating_sub(cy));
    if cw == 0 || ch == 0 {
        // Defensive no-op — caller logged the malformed-crop case at
        // decode time and we kept Some(rect), but if it survived to here
        // with degenerate post-divisor dims (e.g. a 1×1 crop on a Preview
        // path), keep the original buffer.
        return None;
    }
    if cx == 0 && cy == 0 && cw == image.width && ch == image.height {
        // The crop covers the entire buffer; no-op.
        return None;
    }
    let mut out = Image::new(cw, ch, image.space);
    let in_w = image.width as usize;
    let cw_us = cw as usize;
    let cx_us = cx as usize;
    let cy_us = cy as usize;
    for y in 0..ch as usize {
        let src_row_start = (cy_us + y) * in_w + cx_us;
        let dst_row_start = y * cw_us;
        out.pixels[dst_row_start..dst_row_start + cw_us]
            .copy_from_slice(&image.pixels[src_row_start..src_row_start + cw_us]);
    }
    Some(out)
}

/// Per-quality divisor between raw-sensor coordinates and the post-demosaic
/// buffer. `half_res` (Preview, Bayer-only) halves both axes; everything
/// else preserves. **Caller must use [`effective_quality_divisor`] in
/// CFA-aware contexts** (e.g. when X-Trans Preview routes to a full-res
/// kernel, the divisor must be 1 not 2).
pub(in crate::pipeline) fn quality_divisor(quality: RenderQuality) -> u32 {
    match quality {
        RenderQuality::Preview => 2,
        RenderQuality::Full | RenderQuality::Amaze => 1,
    }
}

/// CFA-aware variant of [`quality_divisor`]. Both the X-Trans Preview
/// path (#420) and the LinearRaw path (`CfaPattern::LinearRgb`, ticket
/// #07) bypass the Bayer half-resolution `half_res` kernel and produce
/// a full-resolution buffer regardless of `RenderQuality`. The X-Trans
/// Preview routes to a full-res `xtrans_bilinear`; LinearRaw skips the
/// mosaic path entirely via `linearraw_to_camera_rgb`. In both cases the
/// post-demosaic buffer is NOT halved at `RenderQuality::Preview`, so
/// `crop_to_default` must be called with divisor=1 to land the crop at
/// the right buffer coords for any LinearRaw DNG that carries crop
/// metadata.
pub(in crate::pipeline) fn effective_quality_divisor(
    quality: RenderQuality,
    cfa: CfaPattern,
) -> u32 {
    match cfa {
        CfaPattern::XTrans(_) | CfaPattern::LinearRgb => 1,
        _ => quality_divisor(quality),
    }
}
