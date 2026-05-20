//! Area-average f32 RGB downsample used by the sized and tile entries.
//!
//! Same algorithm as `api::downsample_to_rgba` but in f32 RGB: integer
//! source-row spans are averaged into each destination pixel. No
//! premultiplied-alpha or gamma considerations because the buffer is
//! straight scene-linear with no alpha channel. A higher-quality Lanczos
//! or Mitchell variant lands as a follow-up (ticket 06 Milestone 3).

/// Area-average downsample an `Image`'s f32 RGB pixel buffer to fit within
/// `max_long_edge` on its long edge while preserving the aspect ratio.
/// **Never upscales** (ticket 06 § Product Requirements 1) — if the source
/// long edge is already <= `max_long_edge`, returns the image unmodified.
///
/// Same algorithm as `api::downsample_to_rgba` but in f32 RGB: integer
/// source-row spans are averaged into each destination pixel, no
/// premultiplied-alpha or gamma considerations because the buffer is
/// straight scene-linear with no alpha channel. A higher-quality Lanczos
/// or Mitchell variant lands as a follow-up (ticket 06 Milestone 3).
///
/// Mutates `image` in place; updates `image.width` and `image.height` to
/// the new dimensions.
pub fn downsample_image_area(image: &mut crate::image::Image, max_long_edge: u32) {
    let (sw, sh) = (image.width, image.height);
    let long_edge = sw.max(sh);
    if long_edge <= max_long_edge { return; }
    let (dw, dh) = if sw >= sh {
        let scale = max_long_edge as f64 / sw as f64;
        (max_long_edge, ((sh as f64 * scale).round() as u32).max(1))
    } else {
        let scale = max_long_edge as f64 / sh as f64;
        (((sw as f64 * scale).round() as u32).max(1), max_long_edge)
    };
    let sw_u = sw as usize;
    let mut out: Vec<[f32; 3]> = Vec::with_capacity((dw as usize) * (dh as usize));
    for y in 0..dh {
        let y0 = ((y as u64) * (sh as u64) / (dh as u64)) as usize;
        let y1 = (((y + 1) as u64) * (sh as u64) / (dh as u64)).max((y0 + 1) as u64) as usize;
        let y1 = y1.min(sh as usize);
        for x in 0..dw {
            let x0 = ((x as u64) * (sw as u64) / (dw as u64)) as usize;
            let x1 = (((x + 1) as u64) * (sw as u64) / (dw as u64)).max((x0 + 1) as u64) as usize;
            let x1 = x1.min(sw as usize);
            let (mut sr, mut sg, mut sb, mut n) = (0.0f32, 0.0f32, 0.0f32, 0u32);
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let p = image.pixels[sy * sw_u + sx];
                    sr += p[0]; sg += p[1]; sb += p[2]; n += 1;
                }
            }
            let nf = n.max(1) as f32;
            out.push([sr / nf, sg / nf, sb / nf]);
        }
    }
    image.pixels = out;
    image.width = dw;
    image.height = dh;
}
