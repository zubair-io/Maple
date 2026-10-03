//! Paired bounded RGB/coverage sampling for agent inspection (#4104).
//! The ROI addresses the encoded buffer's own row coordinates. Hosts invert
//! their top-left display coordinates once, before crossing this boundary.
use super::{cell_span, snapshot_dims};

pub fn snapshot_scope_rgba(
    rgba: &[f32],
    width: u32,
    height: u32,
    region: (u32, u32, u32, u32),
    weighted: bool,
) -> Result<(u32, u32, Vec<u8>), &'static str> {
    let (x, y, w, h) = region;
    let expected = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|n| n.checked_mul(4));
    if width == 0
        || height == 0
        || w == 0
        || h == 0
        || u64::from(x) + u64::from(w) > u64::from(width)
        || u64::from(y) + u64::from(h) > u64::from(height)
        || Some(rgba.len() as u64) != expected
        || rgba.iter().any(|v| !v.is_finite())
    {
        return Err("invalid scope frame or region");
    }
    let (dw, dh) = snapshot_dims(w, h);
    let mut output = Vec::with_capacity((dw * dh * 4) as usize);
    for oy in 0..dh {
        let (y0, y1) = cell_span(oy, h, dh);
        for ox in 0..dw {
            let (x0, x1) = cell_span(ox, w, dw);
            let mut sum = [0.0f32; 4];
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let pixel =
                        &rgba[((y + sy) as usize * width as usize + (x + sx) as usize) * 4..][..4];
                    for c in 0..4 {
                        sum[c] += pixel[c];
                    }
                }
            }
            let n = ((x1 - x0) * (y1 - y0)) as f32;
            for (c, v) in sum.iter().enumerate() {
                output.push(if c == 3 && !weighted {
                    255
                } else {
                    (v / n).clamp(0.0, 1.0).mul_add(255.0, 0.0).round() as u8
                });
            }
        }
    }
    Ok((dw, dh, output))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn asymmetric_roi_crops_pixels_and_weights_together() {
        let pixels: Vec<_> = (0..16)
            .flat_map(|i| [i as f32 / 16.0, 0.2, 0.4, i as f32 / 16.0])
            .collect();
        let (w, h, out) = snapshot_scope_rgba(&pixels, 4, 4, (2, 1, 2, 2), true).unwrap();
        assert_eq!((w, h), (2, 2));
        assert_eq!(out[0], 96);
        assert_eq!(out[3], 96);
        assert_eq!(out[12], 175);
        assert_eq!(out[15], 175);
        assert!(snapshot_scope_rgba(&pixels, 4, 4, (3, 1, 2, 2), true).is_err());
        assert!(snapshot_scope_rgba(&[], u32::MAX, u32::MAX, (0, 0, 1, 1), true).is_err());
    }
}
