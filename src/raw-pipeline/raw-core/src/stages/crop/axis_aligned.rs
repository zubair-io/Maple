//! Byte-exact integer-indexed slice for axis-aligned crop rects.
//!
//! Used by both render paths when `angle == 0`: each output row is a
//! `copy_from_slice` of the matching source row's rect — no resampling,
//! no smoothing, no allocation beyond the destination buffer. Also used
//! by the orthogonal-rotate path as the rect-extraction pre-step.

pub(super) fn slice_f32_rgba(
    rgba: &[f32],
    src_w: u32,
    rect_x: u32,
    rect_y: u32,
    rect_w: u32,
    rect_h: u32,
) -> (u32, u32, Vec<f32>) {
    let sw = src_w as usize;
    let rw = rect_w as usize;
    let rh = rect_h as usize;
    let rx = rect_x as usize;
    let ry = rect_y as usize;
    let mut out = vec![0.0f32; rw * rh * 4];
    for yy in 0..rh {
        let src_row_start = ((ry + yy) * sw + rx) * 4;
        let dst_row_start = yy * rw * 4;
        let row_len = rw * 4;
        out[dst_row_start..dst_row_start + row_len]
            .copy_from_slice(&rgba[src_row_start..src_row_start + row_len]);
    }
    (rect_w, rect_h, out)
}

pub(super) fn slice_u8_rgb(
    rgb: &[u8],
    src_w: u32,
    rect_x: u32,
    rect_y: u32,
    rect_w: u32,
    rect_h: u32,
) -> (u32, u32, Vec<u8>) {
    let sw = src_w as usize;
    let rw = rect_w as usize;
    let rh = rect_h as usize;
    let rx = rect_x as usize;
    let ry = rect_y as usize;
    let mut out = vec![0u8; rw * rh * 3];
    for yy in 0..rh {
        let src_row_start = ((ry + yy) * sw + rx) * 3;
        let dst_row_start = yy * rw * 3;
        let row_len = rw * 3;
        out[dst_row_start..dst_row_start + row_len]
            .copy_from_slice(&rgb[src_row_start..src_row_start + row_len]);
    }
    (rect_w, rect_h, out)
}
