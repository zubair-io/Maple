//! Simple feathered-alpha blender — the "no Laplacian, no ringing"
//! alternative to `MultiBandBlender::blend_n`.
//!
//! ## Why
//!
//! `MultiBandBlender` uses a Laplacian pyramid to combine images at
//! multiple scales. That hides low-frequency exposure differences at
//! seams, but it has an inherent failure mode: the high-frequency
//! Laplacian band rings at validity boundaries (sharp 1 → 0 step in
//! the per-image weight). The reconstructed pixel can overshoot
//! above gamut on one channel and undershoot below 0 on another,
//! which after Rec.2020 → sRGB conversion clips to pure-magenta /
//! cyan / yellow bands at every image-to-image seam.
//!
//! The fix at the symptom level (mask feathering, RGB extrapolation,
//! post-blend repair) is a hack that catches some artefacts but not
//! all. The fix at the root level is to not use a Laplacian pyramid:
//! just do a per-pixel feathered alpha blend.
//!
//! ## Trade-off
//!
//! Multi-band hides low-frequency seams (e.g. exposure mismatches
//! that the gain solver couldn't fully equalise). Simple alpha
//! blends in the input space directly — if two adjacent images have
//! a 5 % brightness difference, the simple blend produces a smooth
//! linear ramp across the overlap region. That's visible if you
//! look closely, but it's a soft gradient (no sharp seam) and never
//! produces clipped artefact colours.
//!
//! Pre-conditions for clean output with this blender:
//! - GainMap vignetting correction is applied (else dark corners
//!   abut bright neighbours and the gradient is more visible).
//! - Per-image gain compensation runs before blending (else
//!   exposure mismatches show as overlap-region banding).
//!
//! Both are already in the pano-smoke pipeline as of Phase 1.1.

use rayon::prelude::*;

use crate::error::PanoError;
use crate::types::PanoImage;

/// Simple feathered-alpha blender. Each output pixel is the
/// validity-weighted average of contributing inputs:
///
/// ```text
/// out[px] = Σ_i (mask_i[px] · img_i[px]) / Σ_i mask_i[px]
/// ```
///
/// Output validity is the per-pixel union of input validities. By
/// construction this blender never produces an out-of-gamut pixel
/// when the inputs are in-gamut: each output channel is a convex
/// combination of input channels (weights all ≥ 0, summing to 1).
#[derive(Debug, Clone, Default)]
pub struct SimpleAlphaBlender;

impl SimpleAlphaBlender {
    pub fn new() -> Self {
        Self
    }

    /// Blend N images by per-pixel weighted average. `weight_masks[i]`
    /// is a flat row-major `Vec<f32>` of size `width × height`, with
    /// values in `[0, 1]` (typically partition-of-unity but doesn't
    /// have to be — output normalises by the per-pixel weight sum).
    pub fn blend_n(
        &self,
        images: &[&PanoImage],
        weight_masks: &[Vec<f32>],
    ) -> Result<PanoImage, PanoError> {
        let n_images = images.len();
        if n_images == 0 {
            return Err(PanoError::Blend("blend_n: no inputs".into()));
        }
        if weight_masks.len() != n_images {
            return Err(PanoError::Blend(format!(
                "blend_n: image/mask count mismatch ({} vs {})",
                n_images,
                weight_masks.len()
            )));
        }
        let (w, h) = (images[0].width, images[0].height);
        let n_pixels = (w as usize) * (h as usize);
        let color = images[0].color;

        for (i, img) in images.iter().enumerate() {
            if img.width != w || img.height != h {
                return Err(PanoError::Blend(format!(
                    "blend_n: image[{i}] size mismatch ({}×{} vs {w}×{h})",
                    img.width, img.height
                )));
            }
            if weight_masks[i].len() != n_pixels {
                return Err(PanoError::Blend(format!(
                    "blend_n: weight_masks[{i}].len() = {}, expected {n_pixels}",
                    weight_masks[i].len()
                )));
            }
        }

        let mut out = PanoImage::new(w, h, color);

        // Parallelise per output pixel via par_chunks_exact_mut. Each
        // thread reads from all input images at the same pixel index.
        out.pixels
            .par_chunks_exact_mut(3)
            .enumerate()
            .for_each(|(px, out_px)| {
                let mut sum_r = 0.0_f32;
                let mut sum_g = 0.0_f32;
                let mut sum_b = 0.0_f32;
                let mut sum_w = 0.0_f32;
                for i in 0..n_images {
                    let wi = weight_masks[i][px];
                    if wi > 1e-12 {
                        let base = px * 3;
                        sum_r += wi * images[i].pixels[base];
                        sum_g += wi * images[i].pixels[base + 1];
                        sum_b += wi * images[i].pixels[base + 2];
                        sum_w += wi;
                    }
                }
                if sum_w > 1e-12 {
                    out_px[0] = sum_r / sum_w;
                    out_px[1] = sum_g / sum_w;
                    out_px[2] = sum_b / sum_w;
                }
            });

        // Validity union: any input valid here → output valid.
        // Serial because BitVec doesn't support per-bit parallel writes.
        for px in 0..n_pixels {
            let mut any_valid = false;
            for img in images.iter() {
                if img.validity[px] {
                    any_valid = true;
                    break;
                }
            }
            out.validity.set(px, any_valid);
        }

        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;

    fn make_constant_image(w: u32, h: u32, rgb: [f32; 3]) -> PanoImage {
        let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
        for px in 0..(w * h) as usize {
            img.pixels[px * 3] = rgb[0];
            img.pixels[px * 3 + 1] = rgb[1];
            img.pixels[px * 3 + 2] = rgb[2];
        }
        for i in 0..(w * h) as usize {
            img.validity.set(i, true);
        }
        img
    }

    /// Two images with constant colour, equal weights → output is
    /// the per-channel arithmetic mean.
    #[test]
    fn equal_weights_produce_arithmetic_mean() {
        let w = 4;
        let h = 4;
        let n = (w * h) as usize;
        let img_a = make_constant_image(w, h, [1.0, 0.0, 0.0]);
        let img_b = make_constant_image(w, h, [0.0, 1.0, 0.0]);
        let mask_a = vec![0.5_f32; n];
        let mask_b = vec![0.5_f32; n];

        let blender = SimpleAlphaBlender::new();
        let out = blender
            .blend_n(&[&img_a, &img_b], &[mask_a, mask_b])
            .unwrap();

        for px in 0..n {
            assert!((out.pixels[px * 3] - 0.5).abs() < 1e-6);
            assert!((out.pixels[px * 3 + 1] - 0.5).abs() < 1e-6);
            assert!((out.pixels[px * 3 + 2] - 0.0).abs() < 1e-6);
        }
    }

    /// Output values are guaranteed to be in [0, 1] when inputs are
    /// — the blend is a convex combination so it can't overshoot.
    /// This is the property that prevents magenta clipping by construction.
    #[test]
    fn output_stays_in_gamut() {
        let w = 8;
        let h = 8;
        let n = (w * h) as usize;
        // Three saturated primary inputs.
        let img_r = make_constant_image(w, h, [1.0, 0.0, 0.0]);
        let img_g = make_constant_image(w, h, [0.0, 1.0, 0.0]);
        let img_b = make_constant_image(w, h, [0.0, 0.0, 1.0]);
        // Asymmetric weights.
        let mask_r = vec![0.6_f32; n];
        let mask_g = vec![0.3_f32; n];
        let mask_b = vec![0.1_f32; n];

        let blender = SimpleAlphaBlender::new();
        let out = blender
            .blend_n(&[&img_r, &img_g, &img_b], &[mask_r, mask_g, mask_b])
            .unwrap();

        for px in 0..n {
            for c in 0..3 {
                let v = out.pixels[px * 3 + c];
                assert!(
                    (0.0..=1.0).contains(&v),
                    "out-of-gamut at px={px} c={c}: {v}"
                );
            }
        }
    }

    /// Pixel where one image's weight is zero → output is the other
    /// image's value exactly (no contamination).
    #[test]
    fn zero_weight_excludes_image() {
        let w = 4;
        let h = 4;
        let n = (w * h) as usize;
        let img_a = make_constant_image(w, h, [0.7, 0.7, 0.7]);
        let img_b = make_constant_image(w, h, [0.1, 0.1, 0.1]);
        let mask_a = vec![1.0_f32; n];
        let mask_b = vec![0.0_f32; n];

        let blender = SimpleAlphaBlender::new();
        let out = blender
            .blend_n(&[&img_a, &img_b], &[mask_a, mask_b])
            .unwrap();
        for px in 0..n {
            assert!((out.pixels[px * 3] - 0.7).abs() < 1e-6);
        }
    }

    /// All masks zero → output stays at default (zero).
    #[test]
    fn all_zero_weights_leaves_default_output() {
        let w = 4;
        let h = 4;
        let n = (w * h) as usize;
        let img = make_constant_image(w, h, [0.5, 0.5, 0.5]);
        let mask = vec![0.0_f32; n];

        let blender = SimpleAlphaBlender::new();
        let out = blender.blend_n(&[&img], &[mask]).unwrap();
        for px in 0..n {
            assert_eq!(out.pixels[px * 3], 0.0);
            assert_eq!(out.pixels[px * 3 + 1], 0.0);
            assert_eq!(out.pixels[px * 3 + 2], 0.0);
        }
    }

    /// Validity is the union: any image valid at a pixel → output valid.
    #[test]
    fn validity_union() {
        let w = 4;
        let h = 4;
        let n = (w * h) as usize;
        let mut img_a = make_constant_image(w, h, [0.5, 0.5, 0.5]);
        let mut img_b = make_constant_image(w, h, [0.5, 0.5, 0.5]);
        // A: only top half valid.
        for i in (n / 2)..n {
            img_a.validity.set(i, false);
        }
        // B: only bottom half valid.
        for i in 0..(n / 2) {
            img_b.validity.set(i, false);
        }
        let mask = vec![1.0_f32; n];
        let blender = SimpleAlphaBlender::new();
        let out = blender
            .blend_n(&[&img_a, &img_b], &[mask.clone(), mask])
            .unwrap();
        // All output pixels should be valid (every pixel had at least one valid input).
        for i in 0..n {
            assert!(out.validity[i], "pixel {i} should be valid");
        }
    }

    /// Size mismatch errors out cleanly.
    #[test]
    fn rejects_size_mismatch() {
        let img_a = make_constant_image(4, 4, [0.5, 0.5, 0.5]);
        let img_b = make_constant_image(8, 8, [0.5, 0.5, 0.5]);
        let mask = vec![1.0_f32; 16];
        let blender = SimpleAlphaBlender::new();
        assert!(blender
            .blend_n(&[&img_a, &img_b], &[mask.clone(), mask])
            .is_err());
    }
}
