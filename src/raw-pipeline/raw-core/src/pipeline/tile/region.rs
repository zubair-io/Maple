//! Geometry helpers for the tile path: pad / clamp the mosaic crop rect,
//! crop a `CameraNativeMosaic` to a sub-rectangle, and trim a developed
//! `Image` back to the inner (overlap-stripped) region.
//!
//! Kept separate from `super::mod` so the tile entry stays under the
//! file-size budget (#114). The padding logic enforces Bayer phase by
//! rounding the start corners DOWN to even multiples — the demosaic stage
//! relies on it.

/// Pad a `(src_x, src_y, src_w, src_h)` source-pixel rect by `pad` pixels on
/// each edge, clamp to `(0..mosaic_w, 0..mosaic_h)`, and round the resulting
/// rect's start corners DOWN to the nearest even multiple to preserve
/// Bayer phase for `demosaic::half_res` and `cfa.color_at`. End corners
/// round UP within bounds so the inner rect is fully covered. Returns the
/// padded rect `(x, y, w, h)` plus the `(left_pad, top_pad)` actually
/// applied — the trim step at the end of the tile entry uses these to
/// compute the inner-image-relative crop after the development chain runs
/// on the padded buffer.
pub(super) fn pad_and_clamp_mosaic_rect(
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
    pad: u32,
    mosaic_w: u32,
    mosaic_h: u32,
) -> ((u32, u32, u32, u32), (u32, u32)) {
    let pre_x = src_x.saturating_sub(pad);
    let pre_y = src_y.saturating_sub(pad);
    let pre_x_end = (src_x.saturating_add(src_w).saturating_add(pad)).min(mosaic_w);
    let pre_y_end = (src_y.saturating_add(src_h).saturating_add(pad)).min(mosaic_h);
    // Round start corners DOWN to even (Bayer phase). End corners round UP
    // within bounds so the inner rect remains fully covered.
    let x = pre_x & !1u32;
    let y = pre_y & !1u32;
    let x_end_aligned = ((pre_x_end + 1) & !1u32).min(mosaic_w);
    let y_end_aligned = ((pre_y_end + 1) & !1u32).min(mosaic_h);
    let w = x_end_aligned.saturating_sub(x);
    let h = y_end_aligned.saturating_sub(y);
    let left_pad = src_x.saturating_sub(x);
    let top_pad = src_y.saturating_sub(y);
    ((x, y, w, h), (left_pad, top_pad))
}

/// Crop a `CameraNativeMosaic` `Image` to a sub-rectangle. Returns a fresh
/// mosaic `Image` at the cropped dimensions; the CFA pattern is preserved
/// because `(x, y)` are guaranteed even (see `pad_and_clamp_mosaic_rect`).
#[allow(dead_code)] // kept for diagnostic / future use; the live tile path linearises directly to the crop
fn crop_mosaic_to_padded_rect(
    mosaic: &crate::image::Image,
    rect: (u32, u32, u32, u32),
) -> crate::image::Image {
    use crate::image::ColorSpace;
    let (cx, cy, cw, ch) = rect;
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let mut out = crate::image::Image::new(cw, ch, ColorSpace::CameraNativeMosaic);
    let sw = mosaic.width as usize;
    for y in 0..(ch as usize) {
        let src_off = ((cy as usize) + y) * sw + (cx as usize);
        let dst_off = y * (cw as usize);
        out.pixels[dst_off..dst_off + cw as usize]
            .copy_from_slice(&mosaic.pixels[src_off..src_off + cw as usize]);
    }
    out
}

/// Trim an `Image` to its inner `(left_pad, top_pad, inner_w, inner_h)` rect.
/// Used after the development chain runs on the padded crop — we discard
/// the overlap region and keep only the requested source-pixel area.
/// Note: this runs in fp32 RGB, AFTER `nr_color` and BEFORE downsampling.
pub(super) fn trim_image_to_inner(
    img: &crate::image::Image,
    left_pad: u32,
    top_pad: u32,
    inner_w: u32,
    inner_h: u32,
) -> crate::image::Image {
    let space = img.space;
    let mut out = crate::image::Image::new(inner_w, inner_h, space);
    let sw = img.width as usize;
    for y in 0..(inner_h as usize) {
        let src_off = ((top_pad as usize) + y) * sw + (left_pad as usize);
        let dst_off = y * (inner_w as usize);
        out.pixels[dst_off..dst_off + inner_w as usize]
            .copy_from_slice(&img.pixels[src_off..src_off + inner_w as usize]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::TILE_OVERLAP_PX;
    use super::*;

    /// `pad_and_clamp_mosaic_rect` rounds the start corners DOWN to even
    /// multiples (Bayer-phase preservation for `demosaic::half_res`).
    #[test]
    fn pad_and_clamp_mosaic_rect_rounds_start_to_even() {
        // Odd start coords with plenty of room — pad pulls back to even.
        let ((x, y, _w, _h), (lp, tp)) =
            pad_and_clamp_mosaic_rect(1025, 1025, 512, 512, 35, 8000, 8000);
        assert_eq!(x & 1, 0, "x must be even, got {}", x);
        assert_eq!(y & 1, 0, "y must be even, got {}", y);
        // 1025 - 35 = 990, already even → x = 990. left_pad = 1025 - 990 = 35.
        assert_eq!(x, 990);
        assert_eq!(y, 990);
        assert_eq!(lp, 35);
        assert_eq!(tp, 35);

        // Even start coords with plenty of room — pad lands on even
        // already, no further snap.
        let ((x2, y2, _w2, _h2), (lp2, tp2)) =
            pad_and_clamp_mosaic_rect(1024, 1024, 512, 512, 35, 8000, 8000);
        // 1024 - 35 = 989, snap down to 988. left_pad = 1024 - 988 = 36.
        assert_eq!(x2 & 1, 0);
        assert_eq!(y2 & 1, 0);
        assert_eq!(x2, 988);
        assert_eq!(y2, 988);
        assert_eq!(lp2, 36);
        assert_eq!(tp2, 36);
    }

    /// `pad_and_clamp_mosaic_rect` clamps to image bounds rather than
    /// overshooting. Tests the four edge cases: top-left corner, top-right
    /// corner, bottom-right corner, and a tile bigger than the mosaic.
    #[test]
    fn pad_and_clamp_mosaic_rect_clamps_to_image_bounds() {
        // Top-left corner: src starts at (0, 0). Pre-pad goes to (-35, -35)
        // saturating to 0. Even-snap leaves (0, 0). left_pad = top_pad = 0.
        let ((x, y, w, h), (lp, tp)) = pad_and_clamp_mosaic_rect(0, 0, 512, 512, 35, 4000, 4000);
        assert_eq!(x, 0);
        assert_eq!(y, 0);
        assert_eq!(lp, 0, "left_pad must be 0 at left edge");
        assert_eq!(tp, 0, "top_pad must be 0 at top edge");
        // Right edge: 512 + 35 = 547, +1 = 548, masked to 548 (even). Within bounds.
        assert_eq!(w, 548);
        assert_eq!(h, 548);

        // Bottom-right corner: src ends exactly at the image boundary.
        // The padded right edge clamps to mosaic_w; no overshoot.
        let mosaic_w = 4000u32;
        let mosaic_h = 4000u32;
        let ((x2, y2, w2, h2), _) = pad_and_clamp_mosaic_rect(
            mosaic_w - 512,
            mosaic_h - 512,
            512,
            512,
            35,
            mosaic_w,
            mosaic_h,
        );
        assert!(
            x2 + w2 <= mosaic_w,
            "x+w overshoots mosaic width: {}+{} > {}",
            x2,
            w2,
            mosaic_w
        );
        assert!(
            y2 + h2 <= mosaic_h,
            "y+h overshoots mosaic height: {}+{} > {}",
            y2,
            h2,
            mosaic_h
        );

        // Tile larger than image: src_w > mosaic_w. Result still inside
        // bounds (no overshoot), even-aligned, non-zero size.
        let ((x3, y3, w3, h3), _) = pad_and_clamp_mosaic_rect(0, 0, 10000, 10000, 35, 1024, 1024);
        assert_eq!(x3, 0);
        assert_eq!(y3, 0);
        assert!(x3 + w3 <= 1024);
        assert!(y3 + h3 <= 1024);
        assert!(w3 > 0 && h3 > 0);
    }

    /// Tile-stencil reachability test: with `src` placed well inside the
    /// mosaic and `pad = TILE_OVERLAP_PX`, every pixel within `pad` of
    /// the inner rect must lie inside the padded crop. This is the
    /// geometric check that the clarity stencil (effective reach
    /// `CLARITY_GUIDED_REACH_PX = 2 * CLARITY_GUIDED_RADIUS = 40` px)
    /// sits inside the trimmed region's overlap — equivalently, no
    /// clarity sample at the inner-rect boundary reaches outside the
    /// mosaic crop unless the src is itself clipped by the image edge.
    #[test]
    fn pad_and_clamp_mosaic_rect_overlap_covers_clarity_stencil() {
        let mosaic_w = 8000u32;
        let mosaic_h = 8000u32;
        let (src_x, src_y, src_w, src_h) = (1024u32, 1024u32, 512u32, 512u32);
        let pad = TILE_OVERLAP_PX;
        let ((x, y, w, h), (lp, tp)) =
            pad_and_clamp_mosaic_rect(src_x, src_y, src_w, src_h, pad, mosaic_w, mosaic_h);
        // Inner src rect is at (lp, tp) inside the cropped mosaic.
        // The padded crop must extend at least `pad` pixels on every side
        // of the inner rect (this is the geometric invariant — when not
        // clipped by the mosaic boundary).
        assert!(lp >= pad, "left overlap {} < pad {}", lp, pad);
        assert!(tp >= pad, "top overlap {} < pad {}", tp, pad);
        let right_overlap = w.saturating_sub(lp + src_w);
        let bottom_overlap = h.saturating_sub(tp + src_h);
        assert!(
            right_overlap >= pad,
            "right overlap {} < pad {}",
            right_overlap,
            pad
        );
        assert!(
            bottom_overlap >= pad,
            "bottom overlap {} < pad {}",
            bottom_overlap,
            pad
        );
        // Padded crop sits inside the mosaic — does not overshoot.
        assert!(x + w <= mosaic_w, "padded crop overshoots width");
        assert!(y + h <= mosaic_h, "padded crop overshoots height");
        // Locks the binding stencil: clarity now uses a guided filter
        // at radius `CLARITY_GUIDED_RADIUS` with effective reach
        // `2 * radius = CLARITY_GUIDED_REACH_PX`. The const assertion
        // at module scope pins `TILE_OVERLAP_PX` to this value; check
        // the runtime relation here too.
        let clarity_reach = crate::stages::clarity::CLARITY_GUIDED_REACH_PX;
        assert!(
            (pad as usize) >= clarity_reach,
            "TILE_OVERLAP_PX {} must cover clarity tail {}",
            pad,
            clarity_reach
        );
    }
}
