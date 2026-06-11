//! Long-edge-capped proxy downscale for feature extraction (#1156).
//!
//! Per the eng design memory plan (§6), feature detection runs on a
//! downsampled proxy while full-res pixels are only touched again by
//! warp. This helper produces that proxy.
//!
//! # Algorithm (documented per the ticket)
//!
//! **Area averaging over integer source spans** — the same scheme as
//! `raw_core::pipeline::downsample_image_area`, applied per plane:
//! destination pixel `(x, y)` averages the source rectangle
//! `[⌊x·sw/dw⌋, ⌊(x+1)·sw/dw⌋) × [⌊y·sh/dh⌋, ⌊(y+1)·sh/dh⌋)` (spans
//! forced non-empty and clamped to the frame). For integer ratios this
//! is an exact box filter — every source pixel contributes to exactly
//! one destination pixel with equal weight, so plane means are preserved
//! bit-stably in the exact-ratio case (see tests). Scene-linear f32 in,
//! scene-linear f32 out: averaging linear light is the physically
//! correct reduction, no gamma considerations apply.
//!
//! Target dims preserve aspect: the long edge becomes `max_long_edge`,
//! the short edge rounds to nearest (min 1) — the same rounding as the
//! raw-core helper. **Never upscales**: a frame already inside the cap
//! is returned as a copy at original size.
//!
//! # Validity
//!
//! Conservative AND: a proxy pixel is valid only when **every**
//! contributing source pixel is valid. Descriptors must never be
//! computed over data that is partially invalid — a mixed pixel would
//! blend real scene with undefined content. (Ingest-produced frames are
//! fully valid today, so this is the all-true fast path; the rule is
//! pinned by a test for when warped/masked buffers pass through here.)

use super::{PlanarImage, ValidityMask};

/// Downscale `src` so its long edge is at most `max_long_edge` (≥ 1).
/// See module docs for algorithm, rounding, and validity semantics.
pub fn proxy_to_long_edge(src: &PlanarImage, max_long_edge: u32) -> PlanarImage {
    let max_long_edge = max_long_edge.max(1);
    let (sw, sh) = (src.width(), src.height());
    if sw.max(sh) <= max_long_edge {
        return src.clone();
    }
    let (dw, dh) = if sw >= sh {
        let scale = max_long_edge as f64 / sw as f64;
        (max_long_edge, ((sh as f64 * scale).round() as u32).max(1))
    } else {
        let scale = max_long_edge as f64 / sh as f64;
        (((sw as f64 * scale).round() as u32).max(1), max_long_edge)
    };

    let (sw_us, dw_us, dh_us) = (sw as usize, dw as usize, dh as usize);
    let mut r = vec![0.0f32; dw_us * dh_us];
    let mut g = vec![0.0f32; dw_us * dh_us];
    let mut b = vec![0.0f32; dw_us * dh_us];
    let mut validity = ValidityMask::new_filled(dw, dh, true);

    for y in 0..dh_us {
        let y0 = (y as u64 * sh as u64 / dh as u64) as usize;
        let y1 = ((y as u64 + 1) * sh as u64 / dh as u64).max(y0 as u64 + 1) as usize;
        let y1 = y1.min(sh as usize);
        for x in 0..dw_us {
            let x0 = (x as u64 * sw as u64 / dw as u64) as usize;
            let x1 = ((x as u64 + 1) * sw as u64 / dw as u64).max(x0 as u64 + 1) as usize;
            let x1 = x1.min(sw as usize);
            let (mut sr, mut sg, mut sb, mut n) = (0.0f64, 0.0f64, 0.0f64, 0u32);
            let mut all_valid = true;
            for sy in y0..y1 {
                let row = sy * sw_us;
                for sx in x0..x1 {
                    sr += src.r[row + sx] as f64;
                    sg += src.g[row + sx] as f64;
                    sb += src.b[row + sx] as f64;
                    n += 1;
                    all_valid &= src.validity.get(sx as u32, sy as u32);
                }
            }
            let nf = n.max(1) as f64;
            let di = y * dw_us + x;
            r[di] = (sr / nf) as f32;
            g[di] = (sg / nf) as f32;
            b[di] = (sb / nf) as f32;
            if !all_valid {
                validity.set(x as u32, y as u32, false);
            }
        }
    }
    PlanarImage::from_planes(dw, dh, r, g, b, validity)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn planar_from_fn(w: u32, h: u32, f: impl Fn(u32, u32) -> [f32; 3]) -> PlanarImage {
        let n = (w as usize) * (h as usize);
        let (mut r, mut g, mut b) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        for y in 0..h {
            for x in 0..w {
                let p = f(x, y);
                r.push(p[0]);
                g.push(p[1]);
                b.push(p[2]);
            }
        }
        PlanarImage::from_planes(w, h, r, g, b, ValidityMask::new_filled(w, h, true))
    }

    #[test]
    fn exact_two_to_one_ratio_is_an_exact_box_filter() {
        // 8×4 → cap 4 → 4×2; each destination pixel is the mean of a
        // disjoint 2×2 block. Values chosen f32-exact (multiples of 0.25).
        let src = planar_from_fn(8, 4, |x, y| {
            let v = (y * 8 + x) as f32 * 0.25;
            [v, v + 100.0, v + 200.0]
        });
        let p = proxy_to_long_edge(&src, 4);
        assert_eq!((p.width(), p.height()), (4, 2));
        for y in 0..2u32 {
            for x in 0..4u32 {
                // Mean of the 2×2 block with corners (2x, 2y)..(2x+1, 2y+1).
                let vals = [
                    (2 * y * 8 + 2 * x) as f32,
                    (2 * y * 8 + 2 * x + 1) as f32,
                    ((2 * y + 1) * 8 + 2 * x) as f32,
                    ((2 * y + 1) * 8 + 2 * x + 1) as f32,
                ];
                let mean = vals.iter().sum::<f32>() * 0.25 * 0.25;
                let di = (y * 4 + x) as usize;
                assert_eq!(p.r[di], mean, "R at ({x},{y})");
                assert_eq!(p.g[di], mean + 100.0, "G at ({x},{y})");
                assert_eq!(p.b[di], mean + 200.0, "B at ({x},{y})");
            }
        }
        assert!(p.validity.all_valid());
    }

    #[test]
    fn exact_three_to_one_ratio_preserves_plane_mean() {
        // 6×3 → cap 2 → 2×1; the two destination pixels partition the
        // source into two 3×3 blocks, so the overall mean is preserved.
        let src = planar_from_fn(6, 3, |x, y| {
            let v = ((x + y * 6) % 5) as f32;
            [v, 2.0 * v, 0.5 * v]
        });
        let p = proxy_to_long_edge(&src, 2);
        assert_eq!((p.width(), p.height()), (2, 1));
        let src_mean: f64 = src.r.iter().map(|&v| v as f64).sum::<f64>() / 18.0;
        let dst_mean: f64 = p.r.iter().map(|&v| v as f64).sum::<f64>() / 2.0;
        assert!(
            (src_mean - dst_mean).abs() < 1e-6,
            "{src_mean} vs {dst_mean}"
        );
    }

    #[test]
    fn never_upscales_and_copies_within_cap() {
        let src = planar_from_fn(10, 6, |x, y| [(x + y) as f32, 0.0, 0.0]);
        let p = proxy_to_long_edge(&src, 10);
        assert_eq!((p.width(), p.height()), (10, 6));
        assert_eq!(p.r, src.r);
        let p2 = proxy_to_long_edge(&src, 4096);
        assert_eq!((p2.width(), p2.height()), (10, 6));
    }

    #[test]
    fn portrait_orientation_caps_the_long_edge() {
        let src = planar_from_fn(6, 12, |_, _| [1.0, 1.0, 1.0]);
        let p = proxy_to_long_edge(&src, 6);
        assert_eq!((p.width(), p.height()), (3, 6));
        assert!(
            p.r.iter().all(|&v| v == 1.0),
            "constant image stays constant"
        );
    }

    #[test]
    fn non_integer_ratio_spans_cover_every_source_pixel_once() {
        // 5×3 → cap 2 (landscape): dw=2, dh=round(3·2/5)=1. The two
        // destination spans are [0,2)×[0,3) and [2,5)×[0,3) — a partition,
        // so a constant image stays exactly constant and the weighted mean
        // (per-pixel weight = its span population) equals the source mean.
        let src = planar_from_fn(5, 3, |_, _| [0.75, 0.5, 0.25]);
        let p = proxy_to_long_edge(&src, 2);
        assert_eq!((p.width(), p.height()), (2, 1));
        for &v in &p.r {
            assert_eq!(v, 0.75);
        }
        for &v in &p.b {
            assert_eq!(v, 0.25);
        }
    }

    #[test]
    fn validity_is_conservative_and() {
        // Invalidate one source pixel; exactly the destination pixel whose
        // span contains it must go invalid.
        let mut src = planar_from_fn(8, 4, |_, _| [1.0, 1.0, 1.0]);
        src.validity.set(5, 1, false); // lands in dst (2, 0) for 2×2 spans
        let p = proxy_to_long_edge(&src, 4);
        assert!(
            !p.validity.get(2, 0),
            "dst pixel covering the invalid source must be invalid"
        );
        assert_eq!(
            p.validity.count_valid(),
            4 * 2 - 1,
            "exactly one destination pixel goes invalid"
        );
    }

    #[test]
    fn short_edge_rounds_to_nearest() {
        // 7×5 → cap 3: dh = round(5·3/7) = round(2.142…) = 2 — the
        // round-to-nearest documented in the module docs (same rule that
        // takes the DJI 5272×3948 frame to 1024×767 at cap 1024).
        let src = planar_from_fn(7, 5, |_, _| [0.5; 3]);
        let p = proxy_to_long_edge(&src, 3);
        assert_eq!((p.width(), p.height()), (3, 2));
    }
}
