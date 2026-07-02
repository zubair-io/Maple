use crate::cancel::CancelToken;
use crate::image::{CfaPattern, ColorSpace, Image};
use rayon::prelude::*;

/// Half-resolution quad demosaic per spec § 3.3.2.
/// Each output pixel is the centred average of a 4×4 mosaic window — 4 R
/// samples, 8 G samples, 4 B samples — collapsing two Bayer quads in
/// each axis into one RGB output pixel. Output is half-width and
/// half-height. Input must be `CameraNativeMosaic`.
///
/// Fast path for large sensors (spec says 100MP Hasselblad drops to 25MP).
/// Non-even sensor dimensions crop one row/column as needed.
///
/// **Why a 4×4 window, not the natural 2×2 Bayer quad.**
///
/// The naive "one quad per output pixel" form (R from the single R-position,
/// B from the single B-position, average the two Gs) gives every output
/// pixel a single mosaic sample per chroma channel. There is no spatial
/// smoothing, so per-pixel sensor shot noise propagates 1:1 into the
/// preview. On RAWs with strong channel imbalance (e.g. Hasselblad H5D-40,
/// where the as-shot WB ratios are ~[0.40, 1.0, 0.77]), the inv(CM) stage
/// later amplifies any chroma jitter and it surfaces as visible per-pixel
/// chroma noise on saturated patches. test_0004's Digital ColorChecker SG
/// renders the worst-case here — vivid red and yellow patches show
/// chromatic static at preview quality, while the full-resolution
/// Hamilton-Adams demosaic (which averages over a wider window) is clean.
///
/// The 4×4 form averages over the *four* Bayer quads centred at the
/// output pixel, giving 4 R + 8 G + 4 B samples per output. The mean is
/// unchanged on uniform patches; the variance drops by ≥4× per channel
/// (standard √N noise reduction). The sample positions for output (x, y)
/// span input columns 2x-1..2x+2 and rows 2y-1..2y+2 — the centroid of
/// that window is (2x+0.5, 2y+0.5), identical to the legacy 2×2 form,
/// so the spatial alignment doesn't shift.
///
/// At image borders we clamp to the in-bounds rectangle [0, in_w-1] ×
/// [0, in_h-1]; output pixels with fewer in-bounds samples just average
/// the available ones. That matches the bilinear demosaic's mirror /
/// clamp border treatment in spirit (no out-of-range reads, no
/// disproportionate weighting).
/// Non-cancellable wrapper — forwards to [`half_res_cancellable`] with a
/// never-cancel token, so its output is bit-identical to the pre-#951 kernel.
#[inline]
pub fn half_res(mosaic: &Image, cfa: CfaPattern) -> Image {
    half_res_cancellable(mosaic, cfa, CancelToken::never())
}

/// Cancellable variant of [`half_res`]. Identical math; additionally checks
/// `cancel` at the top of each parallel output-row closure and skips that
/// row's fill when cancellation is requested. The partially-filled buffer is
/// discarded by the develop chain (which returns `Err(Cancelled)` right after
/// demosaic). With a never-cancel token the per-row load is a no-op branch
/// and the output is bit-identical to [`half_res`].
pub fn half_res_cancellable(mosaic: &Image, cfa: CfaPattern, cancel: CancelToken<'_>) -> Image {
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let in_w = mosaic.width as usize;
    let in_h = mosaic.height as usize;
    let out_w = in_w / 2;
    let out_h = in_h / 2;
    let mut out = Image::new(
        out_w as u32,
        out_h as u32,
        ColorSpace::CameraNativeLinearRgb,
    );

    // Degenerate input (< 2 px on an axis) halves to a zero dimension, and
    // `par_chunks_mut(0)` below panics ("chunk_size must not be zero").
    // Such mosaics can't carry a full Bayer quad and are rejected at decode
    // (`decode_bytes` enforces ≥ 2×2 — #1087), so this is defense in depth
    // for direct callers: return the (empty) half-size image instead of
    // aborting the process. Falling back to `bilinear` here is not an
    // option — its mirror-border sampling also assumes ≥ 2 px per axis.
    if out_w == 0 || out_h == 0 {
        return out;
    }

    // Sample a 4×4 window around each output pixel and accumulate by
    // channel. The window column range is 2x-1..=2x+2 (4 inputs); same
    // for rows. Border pixels clamp to the in-bounds range; the count
    // arrays divide out the actual number of samples used for each
    // channel so a smaller-window output pixel is still the correct
    // unweighted mean of its samples (no disproportionate weighting on
    // edge / corner output pixels).
    out.pixels
        .par_chunks_mut(out_w)
        .enumerate()
        .for_each(|(y, row)| {
            // Per-row cancel check. Skipping leaves this row zero-init; the
            // develop chain discards the whole buffer on Err(Cancelled).
            if cancel.is_cancelled() {
                return;
            }
            for (x, out_px) in row.iter_mut().enumerate() {
                let mut sum = [0.0f32; 3];
                let mut count = [0u32; 3];

                // Window covers mosaic rows 2y-1..=2y+2 and cols 2x-1..=2x+2.
                // i32 arithmetic so the y == 0 / x == 0 edges don't underflow.
                let x0 = (2 * x as i32) - 1;
                let y0 = (2 * y as i32) - 1;
                for dy in 0..4i32 {
                    let py = y0 + dy;
                    if py < 0 || (py as usize) >= in_h {
                        continue;
                    }
                    let py_us = py as usize;
                    let row_off = py_us * in_w;
                    for dx in 0..4i32 {
                        let px = x0 + dx;
                        if px < 0 || (px as usize) >= in_w {
                            continue;
                        }
                        let px_us = px as usize;
                        let c = cfa.color_at(px as u32, py as u32) as usize;
                        // `mosaic.pixels[i][c]` is the only channel populated
                        // at that mosaic position — every other channel of
                        // the same pixel slot is zero by construction.
                        sum[c] += mosaic.pixels[row_off + px_us][c];
                        count[c] += 1;
                    }
                }

                let mut rgb = [0.0f32; 3];
                for c in 0..3 {
                    rgb[c] = if count[c] > 0 {
                        sum[c] / count[c] as f32
                    } else {
                        0.0
                    };
                }
                *out_px = rgb;
            }
        });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rggb_uniform(w: u32, h: u32, r: f32, g: f32, b: f32) -> Image {
        let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
        let cfa = CfaPattern::Rggb;
        for y in 0..h {
            for x in 0..w {
                let c = cfa.color_at(x, y) as usize;
                let v = match c {
                    0 => r,
                    1 => g,
                    2 => b,
                    _ => 0.0,
                };
                img.pixels[(y * w + x) as usize][c] = v;
            }
        }
        img
    }

    #[test]
    fn half_res_of_uniform_is_uniform() {
        let mosaic = rggb_uniform(8, 8, 0.3, 0.5, 0.7);
        let out = half_res(&mosaic, CfaPattern::Rggb);
        assert_eq!(out.width, 4);
        assert_eq!(out.height, 4);
        for p in &out.pixels {
            assert!((p[0] - 0.3).abs() < 1e-5);
            assert!((p[1] - 0.5).abs() < 1e-5);
            assert!((p[2] - 0.7).abs() < 1e-5);
        }
    }

    #[test]
    fn half_res_output_space_is_rgb() {
        let mosaic = rggb_uniform(4, 4, 0.1, 0.1, 0.1);
        let out = half_res(&mosaic, CfaPattern::Rggb);
        assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
    }

    #[test]
    fn half_res_bggr_works() {
        let mut img = Image::new(4, 4, ColorSpace::CameraNativeMosaic);
        let cfa = CfaPattern::Bggr;
        for y in 0..4u32 {
            for x in 0..4u32 {
                let c = cfa.color_at(x, y) as usize;
                let v = match c {
                    0 => 0.8,
                    1 => 0.4,
                    2 => 0.2,
                    _ => 0.0,
                };
                img.pixels[(y * 4 + x) as usize][c] = v;
            }
        }
        let out = half_res(&img, CfaPattern::Bggr);
        for p in &out.pixels {
            assert!((p[0] - 0.8).abs() < 1e-5);
            assert!((p[1] - 0.4).abs() < 1e-5);
            assert!((p[2] - 0.2).abs() < 1e-5);
        }
    }

    /// Regression test for #1087 — a 1-px-wide (or 1-px-tall) mosaic halves
    /// to a zero output dimension; pre-fix the 1-px-wide case panicked in
    /// `par_chunks_mut(0)` ("chunk_size must not be zero"). Degenerate
    /// mosaics are rejected at decode (`decode_bytes` enforces ≥ 2×2), so
    /// for direct callers `half_res` now just returns the empty half-size
    /// image instead of aborting the process.
    #[test]
    fn one_px_axis_mosaic_returns_empty_image_without_panicking() {
        let out = half_res(&rggb_uniform(1, 8, 0.3, 0.5, 0.7), CfaPattern::Rggb);
        assert_eq!((out.width, out.height), (0, 4));
        assert!(out.pixels.is_empty());

        let out = half_res(&rggb_uniform(8, 1, 0.3, 0.5, 0.7), CfaPattern::Rggb);
        assert_eq!((out.width, out.height), (4, 0));
        assert!(out.pixels.is_empty());
    }

    /// Regression test for the test_0004 (Hasselblad H5D-40 Digital ColorChecker
    /// SG card) "chromatic noise on saturated patches" bug. With per-Bayer
    /// shot noise on an otherwise uniform colored patch, the legacy
    /// 1-quad-per-output demosaic propagates the per-pixel sensor noise
    /// directly into the output (only 1 R + 2 G + 1 B sample per output
    /// pixel; no spatial smoothing). On real RAWs of saturated SG patches
    /// this rendered as visible per-pixel chroma noise after the inv(CM)
    /// stage amplified the chroma deltas — the artifact the user reported.
    ///
    /// The fix smooths each channel over a wider window of mosaic samples
    /// (4 R's, 8 G's, 4 B's per output pixel) so per-pixel shot noise
    /// averages out before the heavy color math. Pre-fix this test fails:
    /// output variance ≈ noise^2 (per-pixel = unchanged from input). After
    /// the fix the variance drops by the averaging factor (4× for R/B,
    /// 8× for G).
    #[test]
    fn half_res_smooths_per_quad_shot_noise_on_uniform_patch() {
        // A larger uniform colored patch (mimics the SG yellow / red square)
        // with a deterministic per-pixel "shot noise" jitter on every
        // mosaic sample. Truly uniform reflectance, but each sensor sample
        // varies by ±10% — exactly what RAW capture looks like.
        let w = 32u32;
        let h = 32u32;
        let cfa = CfaPattern::Rggb;
        let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
        // True patch reflectance: vivid red — exactly the case that breaks
        // on test_0004 (channel imbalance amplifies chroma noise).
        let true_r = 0.8;
        let true_g = 0.3;
        let true_b = 0.2;
        // Deterministic noise: linear-congruential per pixel for reproducibility.
        for y in 0..h {
            for x in 0..w {
                let c = cfa.color_at(x, y) as usize;
                let true_v = match c {
                    0 => true_r,
                    1 => true_g,
                    2 => true_b,
                    _ => 0.0,
                };
                // ±10% deterministic jitter. 32-pixel period — guaranteed
                // to wash out at any reasonable averaging window.
                let seed = (x.wrapping_mul(2654435761) ^ y.wrapping_mul(40503)) % 2000;
                let jitter = ((seed as f32) - 1000.0) / 10000.0; // [-0.1, +0.1]
                img.pixels[(y * w + x) as usize][c] = true_v * (1.0 + jitter);
            }
        }
        let out = half_res(&img, cfa);

        // Per-channel variance of the output. For the bug-version this
        // matches the input noise variance (~0.0006 for ±10% on 0.8). After
        // the fix it should drop by ≥4× (averaging 4 R-samples = var/4).
        let n = out.pixels.len() as f32;
        let mean = {
            let mut s = [0.0f32; 3];
            for p in &out.pixels {
                s[0] += p[0];
                s[1] += p[1];
                s[2] += p[2];
            }
            [s[0] / n, s[1] / n, s[2] / n]
        };
        let var = {
            let mut s = [0.0f32; 3];
            for p in &out.pixels {
                s[0] += (p[0] - mean[0]).powi(2);
                s[1] += (p[1] - mean[1]).powi(2);
                s[2] += (p[2] - mean[2]).powi(2);
            }
            [s[0] / n, s[1] / n, s[2] / n]
        };
        // Mean must still equal the true patch colour.
        assert!(
            (mean[0] - true_r).abs() < 0.02,
            "R mean drifted: {} vs {}",
            mean[0],
            true_r
        );
        assert!(
            (mean[1] - true_g).abs() < 0.02,
            "G mean drifted: {} vs {}",
            mean[1],
            true_g
        );
        assert!(
            (mean[2] - true_b).abs() < 0.02,
            "B mean drifted: {} vs {}",
            mean[2],
            true_b
        );
        // The unsmoothed input has per-channel variance ≈ ((0.1*v)^2)/3 for
        // a uniform jitter. For R = 0.8 ± 0.08 the variance is ~0.0021. After
        // averaging 4 R-samples per output pixel the variance drops by 4×
        // to ~5e-4. We require ≤ 1e-3 (≥2× reduction) which the legacy
        // 1-sample-per-output implementation FAILS — its variance equals
        // the input variance ~0.0021.
        let smoothed_var_budget_r = 1.0e-3;
        let smoothed_var_budget_g = 5.0e-4; // tighter: 8 G samples averaged
        let smoothed_var_budget_b = 1.0e-3;
        assert!(
            var[0] < smoothed_var_budget_r,
            "R variance {} not smoothed (budget {}) — half-res must average over neighboring quads",
            var[0],
            smoothed_var_budget_r
        );
        assert!(
            var[1] < smoothed_var_budget_g,
            "G variance {} not smoothed (budget {})",
            var[1],
            smoothed_var_budget_g
        );
        assert!(
            var[2] < smoothed_var_budget_b,
            "B variance {} not smoothed (budget {})",
            var[2],
            smoothed_var_budget_b
        );
    }
}
