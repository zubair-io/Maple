//! Composite baked synthetic-raw patches into the scene-linear working buffer
//! at the pre-user-grade seam (design doc §4). `out = lerp(scene, patch,
//! coverage)`, with the patch bilinearly resampled onto the current buffer
//! resolution via its normalized placement. Empty / invalid patches are
//! bit-identical no-ops so the parity baseline is unchanged when no removal is
//! active.

use crate::image::{ColorSpace, Image};
use crate::types::InpaintPatch;

#[inline]
fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

/// Bilinear bracket: `(x0, y0, x1, y1, tx, ty)` for sampling at `(fx, fy)`,
/// clamped to the buffer extent.
#[inline]
fn bilinear_idx(w: u32, h: u32, fx: f32, fy: f32) -> (u32, u32, u32, u32, f32, f32) {
    let fx = fx.clamp(0.0, (w - 1) as f32);
    let fy = fy.clamp(0.0, (h - 1) as f32);
    let x0 = fx.floor() as u32;
    let y0 = fy.floor() as u32;
    let x1 = (x0 + 1).min(w - 1);
    let y1 = (y0 + 1).min(h - 1);
    (x0, y0, x1, y1, fx - x0 as f32, fy - y0 as f32)
}

fn sample_rgb(pixels: &[[f32; 3]], w: u32, h: u32, fx: f32, fy: f32) -> [f32; 3] {
    let (x0, y0, x1, y1, tx, ty) = bilinear_idx(w, h, fx, fy);
    let at = |x: u32, y: u32| pixels[(y * w + x) as usize];
    let top = lerp3(at(x0, y0), at(x1, y0), tx);
    let bot = lerp3(at(x0, y1), at(x1, y1), tx);
    lerp3(top, bot, ty)
}

fn sample_cov(cov: &[f32], w: u32, h: u32, fx: f32, fy: f32) -> f32 {
    let (x0, y0, x1, y1, tx, ty) = bilinear_idx(w, h, fx, fy);
    let at = |x: u32, y: u32| cov[(y * w + x) as usize];
    let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
    let bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
    top + (bot - top) * ty
}

/// Composite each valid patch into `img` (scene-linear Rec.2020). No-op when
/// `patches` is empty.
pub fn apply(img: &mut Image, patches: &[InpaintPatch]) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if patches.is_empty() {
        return;
    }
    let (iw, ih) = (img.width, img.height);
    for patch in patches {
        if !patch.is_valid() {
            continue;
        }
        let [ox, oy] = patch.origin;
        let [ex, ey] = patch.extent;
        let (pw, ph) = (patch.width, patch.height);
        for y in 0..ih {
            // Pixel-center normalized v; skip rows outside the patch rect.
            let v = (y as f32 + 0.5) / ih as f32;
            if v < oy || v > oy + ey {
                continue;
            }
            // Pixel-center mapping: normalized-within-patch → source pixel
            // space `[-0.5, ph-0.5]` (centers at integers). The `- 0.5` makes a
            // matching-resolution composite an exact 1:1 read, not a half-pixel
            // blur; bilinear_idx clamps the out-of-range ends.
            let pv = ((v - oy) / ey).clamp(0.0, 1.0) * ph as f32 - 0.5;
            for x in 0..iw {
                let u = (x as f32 + 0.5) / iw as f32;
                if u < ox || u > ox + ex {
                    continue;
                }
                let pu = ((u - ox) / ex).clamp(0.0, 1.0) * pw as f32 - 0.5;
                let cov = sample_cov(&patch.coverage, pw, ph, pu, pv).clamp(0.0, 1.0);
                if cov <= 0.0 {
                    continue;
                }
                let pp = sample_rgb(&patch.pixels, pw, ph, pu, pv);
                let idx = (y * iw + x) as usize;
                img.pixels[idx] = lerp3(img.pixels[idx], pp, cov);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, c: [f32; 3]) -> Image {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = c;
        }
        img
    }

    fn full_patch(w: u32, h: u32, c: [f32; 3], cov: f32) -> InpaintPatch {
        let n = (w * h) as usize;
        InpaintPatch {
            width: w,
            height: h,
            origin: [0.0, 0.0],
            extent: [1.0, 1.0],
            pixels: vec![c; n],
            coverage: vec![cov; n],
        }
    }

    #[test]
    fn empty_patch_list_is_noop() {
        let mut img = solid(4, 4, [0.2, 0.3, 0.4]);
        let before = img.pixels.clone();
        apply(&mut img, &[]);
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn full_coverage_replaces_pixels() {
        let mut img = solid(8, 8, [0.2, 0.2, 0.2]);
        apply(&mut img, &[full_patch(8, 8, [0.7, 0.5, 0.3], 1.0)]);
        for p in &img.pixels {
            for c in 0..3 {
                assert!((p[c] - [0.7, 0.5, 0.3][c]).abs() < 1e-4, "got {:?}", p);
            }
        }
    }

    #[test]
    fn zero_coverage_leaves_unchanged() {
        let mut img = solid(8, 8, [0.2, 0.2, 0.2]);
        let before = img.pixels.clone();
        apply(&mut img, &[full_patch(8, 8, [0.9, 0.9, 0.9], 0.0)]);
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn half_coverage_lerps() {
        let mut img = solid(8, 8, [0.2, 0.2, 0.2]);
        apply(&mut img, &[full_patch(8, 8, [0.4, 0.4, 0.4], 0.5)]);
        for p in &img.pixels {
            assert!(
                (p[0] - 0.3).abs() < 1e-4,
                "expected lerp to 0.3, got {:?}",
                p
            );
        }
    }

    #[test]
    fn invalid_patch_is_skipped() {
        let mut img = solid(4, 4, [0.1, 0.1, 0.1]);
        let before = img.pixels.clone();
        let bad = InpaintPatch {
            width: 4,
            height: 4,
            origin: [0.0, 0.0],
            extent: [1.0, 1.0],
            pixels: vec![[1.0, 1.0, 1.0]; 2], // wrong length
            coverage: vec![1.0; 16],
        };
        apply(&mut img, &[bad]);
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn full_frame_matching_resolution_gradient_is_near_identity() {
        // A patch authored at the exact buffer resolution, full coverage, must
        // reproduce its pixels 1:1 (no half-pixel resample blur). A gradient
        // exposes the fencepost the constant-color tests can't.
        let w = 16u32;
        let h = 4u32;
        let n = (w * h) as usize;
        let grad: Vec<[f32; 3]> = (0..n)
            .map(|i| {
                let x = (i as u32 % w) as f32 / (w - 1) as f32;
                [x, 1.0 - x, 0.5 * x]
            })
            .collect();
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.0, 0.0, 0.0];
        }
        let patch = InpaintPatch {
            width: w,
            height: h,
            origin: [0.0, 0.0],
            extent: [1.0, 1.0],
            pixels: grad.clone(),
            coverage: vec![1.0; n],
        };
        apply(&mut img, &[patch]);
        for i in 0..n {
            for c in 0..3 {
                assert!(
                    (img.pixels[i][c] - grad[i][c]).abs() < 1e-5,
                    "pixel {i} ch{c}: {} != {} (resample not 1:1)",
                    img.pixels[i][c],
                    grad[i][c]
                );
            }
        }
    }

    #[test]
    fn subrect_patch_only_touches_its_region() {
        // Patch covers the right half (origin u=0.5, extent du=0.5).
        let mut img = solid(8, 8, [0.2, 0.2, 0.2]);
        let patch = InpaintPatch {
            width: 4,
            height: 8,
            origin: [0.5, 0.0],
            extent: [0.5, 1.0],
            pixels: vec![[0.9, 0.9, 0.9]; 32],
            coverage: vec![1.0; 32],
        };
        apply(&mut img, &[patch]);
        for y in 0..8u32 {
            for x in 0..8u32 {
                let p = img.pixels[(y * 8 + x) as usize];
                if x >= 4 {
                    assert!(
                        (p[0] - 0.9).abs() < 1e-4,
                        "right half should be patched at ({x},{y}): {:?}",
                        p
                    );
                } else {
                    assert!(
                        (p[0] - 0.2).abs() < 1e-4,
                        "left half should be untouched at ({x},{y}): {:?}",
                        p
                    );
                }
            }
        }
    }
}
