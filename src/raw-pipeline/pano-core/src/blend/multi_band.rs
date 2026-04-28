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
use crate::color::ColorSpace;
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

    /// Single-pass N-image blend using a streaming accumulator.
    ///
    /// `weight_masks[i]` is a per-pixel f32 mask for image `i`. The masks
    /// MUST partition unity (Σ_i weight_i(x, y) = 1.0 at every pixel),
    /// or the output will be over-/under-bright at seam transitions.
    ///
    /// Algorithm:
    /// 1. Pre-allocate N_levels output Laplacian bands (each holds the
    ///    weighted sum of all images' contributions at that band).
    /// 2. Stream one image at a time:
    ///    a. Build that image's Laplacian pyramid (drops after this image).
    ///    b. Build the Gaussian pyramid of its weight mask.
    ///    c. For each band: `out_band += img_band × mask_band` (per-pixel).
    /// 3. Collapse the accumulated pyramid to produce the output.
    ///
    /// Peak memory: O(N_levels × canvas) for the accumulator plus
    /// O(canvas) for the current image's pyramid (which gets dropped
    /// after each image). This is dramatically lower than the naive
    /// "build all N pyramids first, then combine" approach (which
    /// would be O(N × N_levels × canvas)) and is what production
    /// stitchers (AliceVision, OpenCV) use.
    ///
    /// Validity: a pixel in the output is valid if any input image
    /// is valid at that pixel.
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

        let levels = self.levels;

        // ------------------------------------------------------------
        // 1. Pre-allocate output bands. Each is a PanoImage at the
        //    appropriate level resolution; pixels start at 0.0.
        // ------------------------------------------------------------
        let mut output_bands: Vec<PanoImage> = Vec::with_capacity(levels);
        let mut bw = w;
        let mut bh = h;
        for _ in 0..levels {
            output_bands.push(PanoImage::new(bw, bh, color));
            // Halve dims for next level (ceiling for odd sizes —
            // matches gaussian_down's behaviour).
            bw = (bw + 1) / 2;
            bh = (bh + 1) / 2;
        }

        // Track validity union: any input valid → output valid.
        let mut valid_union = bitvec::vec::BitVec::repeat(false, n_pixels);

        // ------------------------------------------------------------
        // 2. Stream each image's contribution.
        // ------------------------------------------------------------
        for i in 0..n_images {
            let img = images[i];

            // Build this image's Laplacian pyramid.
            let lap_i = laplacian_pyramid(img, levels);

            // Build the Gaussian pyramid of the weight mask. Encode
            // the mask in all 3 channels so we can reuse the existing
            // gaussian_pyramid helper, then extract the R channel
            // back at each level.
            let mask_img = mask_vec_to_image(&weight_masks[i], w, h, color);
            let mask_pyr = gaussian_pyramid(&mask_img, levels);

            // Accumulate per band.
            for b in 0..levels {
                let band = &lap_i[b];
                let mask_band = extract_mask_channel(&mask_pyr[b]);
                let band_pixels = (band.width * band.height) as usize;
                debug_assert_eq!(mask_band.len(), band_pixels);
                debug_assert_eq!(output_bands[b].width, band.width);
                debug_assert_eq!(output_bands[b].height, band.height);

                let out = &mut output_bands[b];
                // Parallelise across pixels.
                out.pixels
                    .par_chunks_exact_mut(3)
                    .zip(band.pixels.par_chunks_exact(3))
                    .zip(mask_band.par_iter())
                    .for_each(|((out_px, in_px), &w_b)| {
                        out_px[0] += in_px[0] * w_b;
                        out_px[1] += in_px[1] * w_b;
                        out_px[2] += in_px[2] * w_b;
                    });
            }

            // Update validity union.
            for px in 0..n_pixels {
                if img.validity[px] {
                    valid_union.set(px, true);
                }
            }

            // lap_i and mask_pyr drop here, freeing their memory
            // before the next iteration allocates more.
        }

        // ------------------------------------------------------------
        // 3. Collapse the accumulated Laplacian pyramid.
        // ------------------------------------------------------------
        let mut result = collapse_laplacian(&output_bands);
        result.validity = valid_union;
        Ok(result)
    }
}

/// Encode a per-pixel f32 mask into a PanoImage's RGB channels (so
/// it round-trips through `gaussian_pyramid`).
fn mask_vec_to_image(mask: &[f32], w: u32, h: u32, color: ColorSpace) -> PanoImage {
    let mut img = PanoImage::new(w, h, color);
    let n = (w * h) as usize;
    debug_assert_eq!(mask.len(), n);
    for px in 0..n {
        img.pixels[px * 3] = mask[px];
        img.pixels[px * 3 + 1] = mask[px];
        img.pixels[px * 3 + 2] = mask[px];
    }
    img
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
    fn blend_n_three_images_partition_unity() {
        // Three solid images (red, green, blue) with masks that
        // partition the canvas into thirds horizontally. Each pixel's
        // weights sum to 1.0. The output should be red on the left,
        // green in the middle, blue on the right (with multi-band
        // blending smoothing the boundaries).
        //
        // Canvas wide enough that the gaussian-pyramid blur of mask
        // boundaries doesn't contaminate the centre of each region:
        // 60 wide / 3 regions = 20 px per colour, plenty of margin.
        let blender = MultiBandBlender::with_levels(3);
        let w = 60u32;
        let h = 8u32;
        let n_px = (w * h) as usize;
        let red = solid(w, h, 1.0, 0.0, 0.0);
        let green = solid(w, h, 0.0, 1.0, 0.0);
        let blue = solid(w, h, 0.0, 0.0, 1.0);

        let mut mask_r = vec![0.0_f32; n_px];
        let mut mask_g = vec![0.0_f32; n_px];
        let mut mask_b = vec![0.0_f32; n_px];
        for y in 0..h {
            for x in 0..w {
                let idx = (y * w + x) as usize;
                if x < w / 3 {
                    mask_r[idx] = 1.0;
                } else if x < 2 * w / 3 {
                    mask_g[idx] = 1.0;
                } else {
                    mask_b[idx] = 1.0;
                }
            }
        }

        let out = blender
            .blend_n(&[&red, &green, &blue], &[mask_r, mask_g, mask_b])
            .unwrap();

        assert_eq!(out.width, w);
        assert_eq!(out.height, h);

        // Far-left should be predominantly red, far-right predominantly blue,
        // middle predominantly green.
        let sample = |x: u32, y: u32| -> [f32; 3] {
            let i = ((y * w + x) * 3) as usize;
            [out.pixels[i], out.pixels[i + 1], out.pixels[i + 2]]
        };

        let left = sample(1, h / 2);
        assert!(left[0] > 0.7, "left expected mostly red, got {left:?}");
        assert!(left[2] < 0.2, "left expected low blue, got {left:?}");

        let middle = sample(w / 2, h / 2);
        assert!(
            middle[1] > 0.7,
            "middle expected mostly green, got {middle:?}"
        );

        let right = sample(w - 2, h / 2);
        assert!(right[2] > 0.7, "right expected mostly blue, got {right:?}");
        assert!(right[0] < 0.2, "right expected low red, got {right:?}");
    }

    #[test]
    fn blend_n_validity_union() {
        // Two images, each with half the canvas invalid. Output validity
        // should be the union (everything valid).
        let blender = MultiBandBlender::with_levels(2);
        let w = 8u32;
        let h = 4u32;
        let n_px = (w * h) as usize;
        let mut a = solid(w, h, 0.5, 0.5, 0.5);
        let mut b = solid(w, h, 0.5, 0.5, 0.5);
        // a invalid in right half, b invalid in left half.
        for y in 0..h {
            for x in (w / 2)..w {
                a.set_invalid(x, y);
            }
            for x in 0..(w / 2) {
                b.set_invalid(x, y);
            }
        }
        let mut mask_a = vec![0.0_f32; n_px];
        let mut mask_b = vec![0.0_f32; n_px];
        for y in 0..h {
            for x in 0..w {
                let idx = (y * w + x) as usize;
                if x < w / 2 {
                    mask_a[idx] = 1.0;
                } else {
                    mask_b[idx] = 1.0;
                }
            }
        }
        let out = blender.blend_n(&[&a, &b], &[mask_a, mask_b]).unwrap();
        // Every pixel should be valid (each pixel has at least one valid input).
        for px in 0..n_px {
            assert!(out.validity[px], "pixel {px} should be valid");
        }
    }

    #[test]
    fn blend_n_rejects_size_mismatch() {
        let blender = MultiBandBlender::new();
        let a = solid(8, 8, 0.0, 0.0, 0.0);
        let b = solid(8, 4, 0.0, 0.0, 0.0); // wrong height
        let mask_a = vec![0.5_f32; 8 * 8];
        let mask_b = vec![0.5_f32; 8 * 4];
        let result = blender.blend_n(&[&a, &b], &[mask_a, mask_b]);
        assert!(result.is_err());
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
