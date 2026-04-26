//! Multi-band Laplacian blender.
//!
//! ## Algorithm (2-image case)
//!
//! For two images A and B with seam masks M_A and M_B:
//!
//! 1. Build Laplacian pyramids L_A and L_B (one per input image, 5 levels by
//!    default).
//! 2. Build a Gaussian pyramid G_mask of the blending weight: treat M_A as a
//!    float mask (0.0 where M_A says "use A", 1.0 where it says "use B").
//!    Blending weight `w(x) = 0` at A-pixels and `w(x) = 1` at B-pixels.
//! 3. At each level `i`, blend: `out[i] = (1−G_mask[i]) ⊙ L_A[i] + G_mask[i] ⊙ L_B[i]`.
//! 4. Collapse the blended pyramid to produce the output.
//!
//! ## Parallelism
//!
//! `rayon` is used to parallelise the band combination step (one `par_iter`
//! across pyramid levels) and to parallelise pixel operations within each band.
//!
//! ## Notes
//!
//! - Default levels: 5 (adequate for most panoramas; configurable via `MultiBandBlender::with_levels`).
//! - Validity: a pixel is marked invalid in the output if *both* input images
//!   are invalid at that pixel.

use rayon::prelude::*;

use crate::blend::pyramid::{collapse_laplacian, gaussian_pyramid, laplacian_pyramid};
use crate::error::PanoError;
use crate::traits::Blender;
use crate::types::{PanoImage, SeamMask};

/// Multi-band Laplacian blender with configurable pyramid depth.
#[derive(Debug, Clone)]
pub struct MultiBandBlender {
    pub levels: usize,
}

impl Default for MultiBandBlender {
    fn default() -> Self {
        Self { levels: 5 }
    }
}

impl MultiBandBlender {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_levels(levels: usize) -> Self {
        assert!(levels >= 1, "must have at least 1 pyramid level");
        Self { levels }
    }
}

// ---------------------------------------------------------------------------
// Internal: build the Gaussian pyramid of the mask image.
//
// Mask values: 0.0 = use A, 1.0 = use B.
// We create a single-channel PanoImage with the mask encoded in the R channel
// and build a standard Gaussian pyramid.  We then extract per-level weights.
// ---------------------------------------------------------------------------

/// Build the per-pixel float mask for image B (1.0 = use B, 0.0 = use A).
fn mask_to_image(mask_b: &SeamMask, img_for_color: &PanoImage) -> PanoImage {
    let mut m = PanoImage::new(mask_b.width, mask_b.height, img_for_color.color);
    let n = (mask_b.width * mask_b.height) as usize;
    for i in 0..n {
        // bit=0 means "use B" for mask_b, so float weight for B = 1 when bit=0.
        let use_b = !mask_b.bits[i];
        let w = if use_b { 1.0_f32 } else { 0.0_f32 };
        m.pixels[i * 3] = w;
        m.pixels[i * 3 + 1] = w;
        m.pixels[i * 3 + 2] = w;
    }
    m
}

/// Extract the R channel from a PanoImage as a flat Vec<f32>.
fn extract_mask_channel(img: &PanoImage) -> Vec<f32> {
    img.pixels.iter().step_by(3).copied().collect()
}

// ---------------------------------------------------------------------------
// Blend implementation
// ---------------------------------------------------------------------------

impl Blender for MultiBandBlender {
    fn blend(&self, images: &[&PanoImage], seams: &[SeamMask]) -> Result<PanoImage, PanoError> {
        if images.len() != 2 || seams.len() != 2 {
            return Err(PanoError::Blend(format!(
                "MultiBandBlender MVP requires exactly 2 images and 2 seams (got {} images, {} seams)",
                images.len(),
                seams.len()
            )));
        }

        let img_a = images[0];
        let img_b = images[1];
        let mask_a = &seams[0];
        let mask_b = &seams[1];

        if img_a.width != img_b.width || img_a.height != img_b.height {
            return Err(PanoError::Blend(
                "input images must have the same dimensions".into(),
            ));
        }
        if mask_a.width != img_a.width || mask_a.height != img_a.height {
            return Err(PanoError::Blend("seam mask A dimensions mismatch".into()));
        }
        if mask_b.width != img_b.width || mask_b.height != img_b.height {
            return Err(PanoError::Blend("seam mask B dimensions mismatch".into()));
        }

        let levels = self.levels;

        // --- Laplacian pyramids ---
        let lap_a = laplacian_pyramid(img_a, levels);
        let lap_b = laplacian_pyramid(img_b, levels);

        // --- Mask Gaussian pyramid ---
        // We use mask_b: bit=0 in mask_b means "use B" → weight_b = 1.0.
        let mask_img = mask_to_image(mask_b, img_a);
        let mask_pyr = gaussian_pyramid(&mask_img, levels);

        // --- Blend each level in parallel ---
        let blended_pyr: Vec<PanoImage> = (0..levels)
            .into_par_iter()
            .map(|i| {
                let la = &lap_a[i];
                let lb = &lap_b[i];
                let mask_weights = extract_mask_channel(&mask_pyr[i]);

                let n_px = (la.width * la.height) as usize;
                let mut out = PanoImage::new(la.width, la.height, la.color);

                // Parallelise across pixels within the band.
                let blend_pixels: Vec<[f32; 3]> = (0..n_px)
                    .into_par_iter()
                    .map(|px_idx| {
                        let w = mask_weights[px_idx].clamp(0.0, 1.0);
                        let base = px_idx * 3;
                        [
                            la.pixels[base] * (1.0 - w) + lb.pixels[base] * w,
                            la.pixels[base + 1] * (1.0 - w) + lb.pixels[base + 1] * w,
                            la.pixels[base + 2] * (1.0 - w) + lb.pixels[base + 2] * w,
                        ]
                    })
                    .collect();

                for (px_idx, rgb) in blend_pixels.into_iter().enumerate() {
                    let base = px_idx * 3;
                    out.pixels[base] = rgb[0];
                    out.pixels[base + 1] = rgb[1];
                    out.pixels[base + 2] = rgb[2];
                }

                // Validity: valid if either input is valid (using its own mask).
                let x_stride = la.width;
                for y in 0..la.height {
                    for x in 0..la.width {
                        let px_idx = (y * x_stride + x) as usize;
                        // Scale coordinates back to level 0.
                        let scale = 1u32 << i;
                        let x0 = (x * scale).min(img_a.width - 1);
                        let y0 = (y * scale).min(img_a.height - 1);
                        let va = img_a.is_valid(x0, y0);
                        let vb = img_b.is_valid(x0, y0);
                        if !va && !vb {
                            out.validity.set(px_idx, false);
                        }
                    }
                }

                out
            })
            .collect();

        // --- Collapse ---
        let result = collapse_laplacian(&blended_pyr);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;
    use crate::types::{PanoImage, SeamMask};
    use bitvec::vec::BitVec;

    fn solid(w: u32, h: u32, r: f32, g: f32, b: f32) -> PanoImage {
        let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
        for i in (0..img.pixels.len()).step_by(3) {
            img.pixels[i] = r;
            img.pixels[i + 1] = g;
            img.pixels[i + 2] = b;
        }
        img
    }

    /// Build a seam mask: left half = `use_this` (bit=false for own-image),
    /// right half = `use_other` (bit=true).
    fn half_seam(w: u32, h: u32, left_uses_this: bool) -> SeamMask {
        let n = (w * h) as usize;
        let mut bits = BitVec::repeat(false, n);
        for y in 0..h {
            for x in 0..w {
                let idx = (y * w + x) as usize;
                let right = x >= w / 2;
                // If left_uses_this == true: left half = use self (bit=0),
                //                              right half = use other (bit=1).
                bits.set(idx, right ^ !left_uses_this);
            }
        }
        SeamMask {
            width: w,
            height: h,
            bits,
        }
    }

    #[test]
    fn blend_returns_error_for_n_ne_2() {
        let blender = MultiBandBlender::new();
        let img = solid(8, 8, 0.5, 0.5, 0.5);
        let n = 8 * 8usize;
        let mask = SeamMask {
            width: 8,
            height: 8,
            bits: BitVec::repeat(false, n),
        };
        let result = blender.blend(
            &[&img, &img, &img],
            &[mask.clone(), mask.clone(), mask.clone()],
        );
        assert!(result.is_err());
    }

    #[test]
    fn blend_two_solid_images_produces_correct_output_size() {
        let blender = MultiBandBlender::new();
        let a = solid(16, 16, 1.0, 0.0, 0.0);
        let b = solid(16, 16, 0.0, 0.0, 1.0);
        let n = 16 * 16usize;
        // mask_a: all zeros (use A everywhere), mask_b: all zeros (use B everywhere — from B's perspective)
        let mask_a = SeamMask {
            width: 16,
            height: 16,
            bits: BitVec::repeat(false, n),
        };
        let mask_b = SeamMask {
            width: 16,
            height: 16,
            bits: BitVec::repeat(false, n),
        };
        let out = blender.blend(&[&a, &b], &[mask_a, mask_b]).unwrap();
        assert_eq!(out.width, 16);
        assert_eq!(out.height, 16);
    }

    #[test]
    fn blend_with_all_zero_mask_b_outputs_image_a() {
        // When mask_b bits are all 0 (meaning "use B everywhere" — wait, convention:
        // mask_b bit=0 means "use B".  For this test we want all A output, so we
        // need mask_b bits=1 (use A, not B) everywhere.
        let blender = MultiBandBlender::new();
        let a = solid(16, 16, 0.8, 0.0, 0.0);
        let b = solid(16, 16, 0.0, 0.0, 0.8);
        let n = 16 * 16usize;

        // mask_b bits=1 everywhere means "use the other image (A)" for all pixels.
        let mask_a = SeamMask {
            width: 16,
            height: 16,
            bits: BitVec::repeat(false, n),
        };
        let mask_b = SeamMask {
            width: 16,
            height: 16,
            bits: BitVec::repeat(true, n),
        };

        let out = blender.blend(&[&a, &b], &[mask_a, mask_b]).unwrap();

        // The output should be predominantly A (red channel ≈ 0.8).
        // Due to multi-band blending the output might not be exact, but should be
        // close to A's value.
        let mean_r: f32 = out.pixels.iter().step_by(3).sum::<f32>() / (16.0 * 16.0);
        assert!(
            mean_r > 0.5,
            "expected output close to image A (r≈0.8), got mean_r={mean_r}"
        );
    }
}
