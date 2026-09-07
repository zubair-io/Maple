//! Downsampled RGB snapshot of the display-encoded frame (#3251): the CPU
//! producer and parity oracle for the GPU snapshot kernel
//! (`raw-gpu/src/scope_snapshot.wgsl`). Same contract as the web render
//! worker's `readbackScopeSnapshot`: packed 8-bit RGB, long edge clamped to
//! [`SCOPE_SNAPSHOT_MAX_DIM`] — the pixel source a scopes panel reduces
//! into its luma waveform, RGB parade and histogram.
//!
//! Every output cell is the plain box mean of the source pixels it covers,
//! with integer cell bounds ([`cell_span`]) so the CPU and WGSL producers
//! visit exactly the same pixels in the same order — quantisation of the
//! mean is the only place they can differ, and only by rounding ties.

use crate::image::Image;

/// Long-edge clamp of the snapshot. Mirrors the web worker's
/// `SCOPE_READBACK_MAX_DIM`; raw-ffi's `MAPLE_SCOPE_SNAPSHOT_MAX_DIM` and
/// raw-gpu's `SCOPE_SNAPSHOT_MAX_DIM` are pinned to it by test.
pub const SCOPE_SNAPSHOT_MAX_DIM: u32 = 512;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeSnapshot {
    pub width: u32,
    pub height: u32,
    /// Packed row-major RGB, `3 * width * height` bytes.
    pub rgb: Vec<u8>,
}

/// Snapshot dims for a `width × height` frame: unchanged when the long edge
/// already fits, otherwise both edges scaled (rounded, never below 1) so
/// the long edge lands on [`SCOPE_SNAPSHOT_MAX_DIM`]. An empty frame stays
/// empty.
pub fn snapshot_dims(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (0, 0);
    }
    let long = width.max(height) as u64;
    if long <= SCOPE_SNAPSHOT_MAX_DIM as u64 {
        return (width, height);
    }
    let scale = |v: u32| -> u32 {
        let n = v as u64 * SCOPE_SNAPSHOT_MAX_DIM as u64;
        (((n + long / 2) / long) as u32).max(1)
    };
    (scale(width), scale(height))
}

/// Source span `[start, end)` that output cell `o` (of `dst` cells) covers
/// along an axis of `src` pixels. Never empty, never past `src`.
#[inline]
pub fn cell_span(o: u32, src: u32, dst: u32) -> (u32, u32) {
    let start = ((o as u64 * src as u64) / dst as u64) as u32;
    let end = (((o as u64 + 1) * src as u64) / dst as u64) as u32;
    (start, end.max(start + 1).min(src))
}

#[inline]
fn quantize(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn snapshot_with(width: u32, height: u32, pixel: impl Fn(usize) -> [f32; 3]) -> ScopeSnapshot {
    let (dw, dh) = snapshot_dims(width, height);
    let mut rgb = vec![0u8; (dw as usize) * (dh as usize) * 3];
    for oy in 0..dh {
        let (y0, y1) = cell_span(oy, height, dh);
        for ox in 0..dw {
            let (x0, x1) = cell_span(ox, width, dw);
            let mut sum = [0f32; 3];
            for y in y0..y1 {
                for x in x0..x1 {
                    let p = pixel((y * width + x) as usize);
                    sum[0] += p[0];
                    sum[1] += p[1];
                    sum[2] += p[2];
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f32;
            let o = ((oy * dw + ox) * 3) as usize;
            rgb[o] = quantize(sum[0] / n);
            rgb[o + 1] = quantize(sum[1] / n);
            rgb[o + 2] = quantize(sum[2] / n);
        }
    }
    ScopeSnapshot {
        width: dw,
        height: dh,
        rgb,
    }
}

/// Snapshot of a display-encoded [`Image`] (each channel nominally 0…1).
pub fn snapshot_image(img: &Image) -> ScopeSnapshot {
    snapshot_with(img.width, img.height, |i| img.pixels[i])
}

/// The interleaved-RGBA sibling for GPU parity tests: alpha is ignored.
pub fn snapshot_rgba_f32(rgba: &[f32], width: u32, height: u32) -> ScopeSnapshot {
    snapshot_with(width, height, |i| {
        [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dims_clamp_the_long_edge_and_keep_small_frames_intact() {
        assert_eq!(snapshot_dims(2466, 1850), (512, 384));
        assert_eq!(snapshot_dims(1850, 2466), (384, 512));
        assert_eq!(snapshot_dims(512, 512), (512, 512));
        assert_eq!(snapshot_dims(8, 4), (8, 4));
        assert_eq!(snapshot_dims(10_000, 10), (512, 1));
        assert_eq!(snapshot_dims(0, 5), (0, 0));
    }

    #[test]
    fn cell_spans_tile_the_source_without_gaps_or_overlap() {
        let (src, dst) = (2466u32, 512u32);
        let mut covered = 0u32;
        for o in 0..dst {
            let (s, e) = cell_span(o, src, dst);
            assert_eq!(s, covered, "cell {o} must start where the previous ended");
            assert!(e > s);
            covered = e;
        }
        assert_eq!(covered, src);
    }

    #[test]
    fn a_frame_within_the_clamp_is_quantized_pixel_for_pixel() {
        let (w, h) = (8u32, 4u32);
        let rgba: Vec<f32> = (0..w * h)
            .flat_map(|i| {
                let t = i as f32 / (w * h) as f32;
                [t, 1.0 - t, 0.25, 1.0]
            })
            .collect();
        let snap = snapshot_rgba_f32(&rgba, w, h);
        assert_eq!((snap.width, snap.height), (w, h));
        for i in 0..(w * h) as usize {
            for c in 0..3 {
                let want = (rgba[i * 4 + c].clamp(0.0, 1.0) * 255.0).round() as u8;
                assert_eq!(snap.rgb[i * 3 + c], want, "pixel {i} channel {c}");
            }
        }
    }

    /// A 1024×512 gradient halves to 512×256; every cell is the mean of its
    /// 2×2 block, checked against an independent f64 reduction.
    #[test]
    fn a_frame_past_the_clamp_is_box_averaged() {
        let (w, h) = (1024u32, 512u32);
        let px = |x: u32, y: u32| -> [f32; 3] {
            [
                x as f32 / w as f32,
                y as f32 / h as f32,
                ((x + y) % 7) as f32 / 7.0,
            ]
        };
        let rgba: Vec<f32> = (0..h)
            .flat_map(|y| (0..w).flat_map(move |x| [px(x, y)[0], px(x, y)[1], px(x, y)[2], 1.0]))
            .collect();
        let snap = snapshot_rgba_f32(&rgba, w, h);
        assert_eq!((snap.width, snap.height), (512, 256));
        for oy in [0u32, 17, 255] {
            for ox in [0u32, 300, 511] {
                let mut sum = [0f64; 3];
                for y in oy * 2..oy * 2 + 2 {
                    for x in ox * 2..ox * 2 + 2 {
                        let p = px(x, y);
                        sum[0] += p[0] as f64;
                        sum[1] += p[1] as f64;
                        sum[2] += p[2] as f64;
                    }
                }
                let o = ((oy * 512 + ox) * 3) as usize;
                for c in 0..3 {
                    let want = (sum[c] / 4.0 * 255.0).round() as i32;
                    let got = snap.rgb[o + c] as i32;
                    assert!(
                        (got - want).abs() <= 1,
                        "cell ({ox},{oy}) channel {c}: got {got}, want {want}"
                    );
                }
            }
        }
    }

    #[test]
    fn an_image_snapshot_matches_the_rgba_sibling() {
        let (w, h) = (700u32, 300u32);
        let mut img = Image::new(w, h, crate::image::ColorSpace::DisplayEncodedSrgb);
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            let t = i as f32 / (w * h) as f32;
            *p = [t, (t * 3.0).fract(), 1.0 - t];
            rgba.extend_from_slice(&[p[0], p[1], p[2], 1.0]);
        }
        assert_eq!(snapshot_image(&img), snapshot_rgba_f32(&rgba, w, h));
        assert_eq!(snapshot_image(&img).width, 512);
    }
}
