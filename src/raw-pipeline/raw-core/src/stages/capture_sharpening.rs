//! Capture sharpening — Richardson–Lucy deconvolution against a true
//! Gaussian PSF, applied to a luminance plane so chroma noise doesn't get
//! amplified.
//!
//! The PSF is an exact separable Gaussian of `sigma` pixels, windowed to
//! `±ceil(3·sigma)` taps and renormalized so the kernel sums to 1.0. Two
//! 1D convolutions (horizontal then vertical) replace the previous
//! tripled-box-blur approximation — at the small sigmas this stage uses
//! (0.5..2.0 px) the box-blur fit was visibly different from a real
//! Gaussian, and the integer-radius round-off prevented sub-pixel tuning.
//! The kernel builder + separable convolution moved to `stages::blur`
//! (`gaussian_kernel_1d` / `gaussian_blur_plane_sigma`) in #1083 so the
//! sharpen stage — whose integer box radius had the exact same round-off
//! bug, collapsed all the way to a radius no-op — shares one copy.
//!
//! Off by default: the helper at `pipeline::capture_sharpening_helper`
//! returns `None` when `amount == 0`, so this stage is never called and
//! the pre-#427 baseline is bit-identical. At `strength == 0.0` the
//! algorithm itself is also a bit-exact no-op — verified in the tests
//! below.
//!
//! Asserts `ColorSpace::SceneLinearRec2020` since every other stage here
//! lives in that space. Rec.709 luminance weights are still a reasonable
//! approximation for Rec.2020 at the small magnitudes capture sharpening
//! operates on; a Rec.2020-exact vector can be swapped in later if the
//! parity harness flags it.

use crate::{
    cancel::CancelToken,
    error::{Error, Result},
    image::{ColorSpace, Image},
    stages::blur::{gaussian_blur_plane_sigma, MAX_GAUSSIAN_SIGMA_PX},
};
use rayon::prelude::*;

#[derive(Clone, Copy, Debug)]
pub struct CaptureSharpeningParams {
    /// Gaussian PSF sigma in pixels. The kernel is windowed to
    /// `±ceil(3·sigma)` taps and renormalized; `sigma <= 0`, non-finite, or
    /// `> MAX_SIGMA_PX_STAGE` (50 px) short-circuits the stage to a no-op.
    pub sigma: f32,
    /// Number of Richardson–Lucy iterations. Reference default: 2.
    pub iterations: u32,
    /// Above this luminance, fade sharpening to avoid amplifying near-clipped
    /// highlights into ringing.
    pub highlight_threshold: f32,
    /// Strength multiplier. 1.0 = full effect; 0.0 = off (bit-identical no-op).
    pub strength: f32,
    /// Noise floor for dampened Richardson–Lucy. The RL update ratio is
    /// suppressed when the blurred estimate falls below this value, preventing
    /// noise amplification in dark regions. Setting to 0.0 disables dampening
    /// (classic RL). Default: 3e-4 (tuned for 14-bit linear scene data).
    pub noise_floor: f32,
}

impl Default for CaptureSharpeningParams {
    fn default() -> Self {
        Self {
            sigma: 0.68,
            iterations: 2,
            highlight_threshold: 0.99,
            strength: 1.0,
            noise_floor: 3e-4,
        }
    }
}

/// Estimate the diffraction-limited PSF sigma from EXIF lens metadata.
///
/// The Airy disk first-zero radius (in sensor-plane µm) is:
///   r_airy ≈ 1.22 · λ · N
/// where λ = 550 nm (mid-visible) and N = f-number. The PSF sigma in
/// *pixels* is roughly r_airy / pixel_pitch, scaled by an empirical
/// factor (0.42 ≈ σ/r_first_zero for a Gaussian approximation of Airy).
///
/// `pixel_pitch_um` is derived from `sensor_width_px` and physical sensor
/// width (available in EXIF as `FocalPlaneXResolution` or estimated from
/// crop factor). When unavailable, callers can use a reasonable default
/// (e.g. 3.76 µm for APS-C, 5.9 µm for full-frame 24 MP).
///
/// Returns `None` if the inputs are non-positive / non-finite.
pub fn estimate_diffraction_sigma(f_number: f32, pixel_pitch_um: f32) -> Option<f32> {
    if !f_number.is_finite()
        || f_number <= 0.0
        || !pixel_pitch_um.is_finite()
        || pixel_pitch_um <= 0.0
    {
        return None;
    }
    // λ = 0.55 µm (550 nm, green midpoint)
    let lambda_um = 0.55_f32;
    // Airy first-zero radius in µm
    let r_airy_um = 1.22 * lambda_um * f_number;
    // Gaussian sigma approximation of the Airy PSF
    let sigma_um = 0.42 * r_airy_um;
    // Convert to pixels
    let sigma_px = sigma_um / pixel_pitch_um;
    if sigma_px > MAX_GAUSSIAN_SIGMA_PX || sigma_px <= 0.0 {
        return None;
    }
    Some(sigma_px)
}

/// Rec 709 luminance weights. Close enough to Rec.2020 for the tiny
/// corrections capture sharpening applies; replace with Rec.2020 exact
/// coefficients (0.2627, 0.6780, 0.0593) if parity calls for it.
const LUM_WEIGHTS: [f32; 3] = [0.2126, 0.7152, 0.0722];

/// Hard ceiling on the Gaussian sigma this stage will accept, in pixels.
/// The pipeline helper already clamps XMP-sourced sigma to `MAX_SIGMA_PX`
/// (8.0 px today). This second ceiling is defense-in-depth for any direct
/// caller of the stage API — e.g. an integration test or a future entry
/// point — so an unbounded `sigma` can never expand the kernel size into
/// an OOM/DoS region.
///
/// At `sigma = 50.0` the kernel is `2 * ceil(3 * 50) + 1 = 301` taps, which
/// is large but bounded; anything above that is treated as bogus and the
/// stage exits early. The value is single-sourced with the kernel builder's
/// own clamp in `stages::blur` (#1083 moved both there).
const MAX_SIGMA_PX_STAGE: f32 = MAX_GAUSSIAN_SIGMA_PX;

/// Apply capture sharpening in place.
///
/// No-op when any of the following holds:
/// - `sigma` is non-finite, `<= 0`, or beyond `MAX_SIGMA_PX_STAGE` (defense
///   in depth — the pipeline helper already clamps to 8 px, but a direct
///   caller could pass an unbounded value),
/// - `strength` or `highlight_threshold` is non-finite,
/// - `iterations == 0` or `strength <= 0`.
///
/// `strength == 0.0` is a bit-exact no-op — see `disabled_at_zero_strength`.
/// `highlight_threshold` is internally clamped to `< 1.0` so the highlight
/// fade can never hit a `1.0 / (1.0 - 1.0)` division-by-zero edge.
///
/// Non-cancellable wrapper — forwards to [`apply_capture_sharpening_cancellable`]
/// with a never-cancel token. A never-cancel token never touches the atomic and
/// never reorders the pixel math, so this is **bit-identical** to the pre-#1089
/// serial stage (verified in `cancel_tests::never_cancel_is_bit_identical` and
/// the `RAYON_NUM_THREADS=1` byte-identity test).
pub fn apply_capture_sharpening(image: &mut Image, params: &CaptureSharpeningParams) {
    // The never-cancel variant can only return `Ok(())` — the early-bail
    // `Err(Cancelled)` paths are unreachable without a host-flipped flag, so
    // discarding the result here loses nothing.
    let _ = apply_capture_sharpening_cancellable(image, params, CancelToken::never());
}

/// Cancellable variant of [`apply_capture_sharpening`].
///
/// Identical math; additionally observes `cancel` (a relaxed atomic load)
/// between Richardson–Lucy iterations and once per output row inside each
/// per-pixel sweep, returning `Err(Error::Cancelled)` promptly when the host
/// requests cancellation. A row-granular relaxed load is free and does not
/// perturb the result — with a never-cancel token this is **bit-identical** to
/// [`apply_capture_sharpening`].
///
/// On a cancelled return `image.pixels` may be left partially written; that's
/// fine for the same reason it is in `sharpen` / `noise_reduction`: the develop
/// chain checks the same token immediately after this stage and returns
/// `Err(Cancelled)`, so the half-written buffer is discarded and never packed
/// into a result.
///
/// Parallelism (#1089): every per-pixel sweep — luminance extraction, the RL
/// ratio map, the estimate update, and the final channel rescale — runs over
/// disjoint output elements via rayon. Each output pixel is computed from the
/// same inputs (`original[i]`, `blur_*[i]`, `estimate[i]`) in isolation, with
/// no cross-pixel float accumulation, so the result is byte-for-byte identical
/// to the serial form regardless of thread count. The two Gaussian blurs are
/// already rayon-parallel and bit-identical (`gaussian_blur_plane_sigma`).
pub fn apply_capture_sharpening_cancellable(
    image: &mut Image,
    params: &CaptureSharpeningParams,
    cancel: CancelToken<'_>,
) -> Result<()> {
    if !params.sigma.is_finite()
        || params.sigma <= 0.0
        || params.sigma > MAX_SIGMA_PX_STAGE
        || params.iterations == 0
        || !params.strength.is_finite()
        || params.strength <= 0.0
        || !params.highlight_threshold.is_finite()
    {
        return Ok(());
    }
    image.assert_space(ColorSpace::SceneLinearRec2020);

    let w = image.width as usize;
    let h = image.height as usize;
    if w == 0 || h == 0 {
        return Ok(());
    }
    let n = w * h;

    // Extract luminance. Per-pixel independent → parallel over rows. The dot
    // product order (R, G, B) is unchanged, so the value at each index is
    // bit-identical to the serial loop.
    let mut original = vec![0.0_f32; n];
    if cancellable_plane_map_rows(&mut original, w, &image.pixels, cancel, |p| {
        LUM_WEIGHTS[0] * p[0] + LUM_WEIGHTS[1] * p[1] + LUM_WEIGHTS[2] * p[2]
    }) {
        return Err(Error::Cancelled);
    }

    // Richardson–Lucy: estimate = estimate * blur(original / blur(estimate)).
    // Two iterations by default — matches the reference engine's behaviour.
    let mut estimate = original.clone();
    for _ in 0..params.iterations {
        // Cancellation between iterations: each iteration is two full-image
        // Gaussian blurs plus two per-pixel sweeps — seconds of work at 100 MP.
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let blur_est = gaussian_blur_plane_sigma(&estimate, w, h, params.sigma);

        // Dampened Richardson–Lucy ratio: suppress the update in regions
        // where the blurred estimate is near the noise floor, preventing
        // the classic RL noise-amplification failure mode in shadows.
        //
        // ratio[i] = dampen(original[i] / max(blur_est[i], ε), blur_est[i])
        // where dampen(r, b) = 1 + (r - 1) · b² / (b² + noise²)
        //
        // When noise_floor ≤ 0 this reduces to the undampened ratio.
        let noise2 = params.noise_floor * params.noise_floor;
        let mut ratio = vec![0.0_f32; n];
        if cancellable_plane_zip_rows(&mut ratio, w, &original, &blur_est, cancel, |&o, &b| {
            let denom = b.max(1e-6);
            let raw_ratio = (o / denom).clamp(0.0, 100.0);
            if noise2 > 0.0 {
                // Dampened: suppress deviations from 1 in low-signal regions
                let b2 = b * b;
                let dampen = b2 / (b2 + noise2);
                1.0 + (raw_ratio - 1.0) * dampen
            } else {
                raw_ratio
            }
        }) {
            return Err(Error::Cancelled);
        }

        let blur_ratio = gaussian_blur_plane_sigma(&ratio, w, h, params.sigma);

        // estimate[i] *= blur_ratio[i]. In-place, per-element → parallel rows.
        if cancellable_plane_mul_assign_rows(&mut estimate, w, &blur_ratio, cancel) {
            return Err(Error::Cancelled);
        }
    }

    // Scale each channel by (new_Y / old_Y), blending toward no-op near
    // clipped highlights. Small-`y_old` pixels are left alone to avoid
    // divide-by-zero noise amplification in shadows.
    //
    // `highlight_threshold` is clamped to a tight ceiling below 1.0 so the
    // `(1.0 - y_old) / (1.0 - hi_thresh)` ramp never divides by zero when an
    // upstream caller hands us `hi_thresh == 1.0` (and `y_old == 1.0`). The
    // 0.999 ceiling matches the default (0.99) head-room and the spec
    // language "near-clipped highlights".
    //
    // Per-pixel independent (px[i] reads only original[i] / estimate[i]) →
    // parallel over rows. The early-`continue` shadow/zero-blend guards become
    // per-element returns inside the closure; the arithmetic is unchanged.
    let strength = params.strength;
    let hi_thresh = params.highlight_threshold.min(0.999);
    let cancelled = image
        .pixels
        .par_chunks_mut(w)
        .enumerate()
        .map(|(row, px_row)| {
            // One relaxed load per row — free, no-op on a never token.
            if cancel.is_cancelled() {
                return true;
            }
            let base = row * w;
            for (x, px) in px_row.iter_mut().enumerate() {
                let i = base + x;
                let y_old = original[i];
                if y_old < 1e-6 {
                    continue;
                }
                let blend = if y_old < hi_thresh {
                    strength
                } else {
                    let t = ((1.0 - y_old) / (1.0 - hi_thresh)).clamp(0.0, 1.0);
                    strength * t
                };
                if blend <= 0.0 {
                    continue;
                }
                let y_new = estimate[i];
                let y_target = y_old * (1.0 - blend) + y_new * blend;
                let scale = y_target / y_old;
                px[0] *= scale;
                px[1] *= scale;
                px[2] *= scale;
            }
            false
        })
        .reduce(|| false, |a, b| a || b);
    if cancelled {
        return Err(Error::Cancelled);
    }

    Ok(())
}

/// Fill `out` (row-major `w`-wide) from `src` via `f`, parallel over rows,
/// checking `cancel` once per row. Returns `true` if any row observed
/// cancellation (so the caller can bail with `Err(Cancelled)`); on `true` the
/// buffer is partially written, which is fine — the partial result is
/// discarded upstream. With a never-cancel token every row runs `f`, so the
/// fill is identical to the serial loop it replaces.
#[inline]
fn cancellable_plane_map_rows<T: Sync>(
    out: &mut [f32],
    w: usize,
    src: &[T],
    cancel: CancelToken<'_>,
    f: impl Fn(&T) -> f32 + Sync,
) -> bool {
    out.par_chunks_mut(w)
        .enumerate()
        .map(|(row, out_row)| {
            if cancel.is_cancelled() {
                return true;
            }
            let base = row * w;
            for (x, o) in out_row.iter_mut().enumerate() {
                *o = f(&src[base + x]);
            }
            false
        })
        .reduce(|| false, |a, b| a || b)
}

/// Like [`cancellable_plane_map_rows`] but `out[i] = f(&a[i], &b[i])`.
#[inline]
fn cancellable_plane_zip_rows(
    out: &mut [f32],
    w: usize,
    a: &[f32],
    b: &[f32],
    cancel: CancelToken<'_>,
    f: impl Fn(&f32, &f32) -> f32 + Sync,
) -> bool {
    out.par_chunks_mut(w)
        .enumerate()
        .map(|(row, out_row)| {
            if cancel.is_cancelled() {
                return true;
            }
            let base = row * w;
            for (x, o) in out_row.iter_mut().enumerate() {
                *o = f(&a[base + x], &b[base + x]);
            }
            false
        })
        .reduce(|| false, |a, b| a || b)
}

/// Like [`cancellable_plane_map_rows`] but the in-place `acc[i] *= rhs[i]`.
#[inline]
fn cancellable_plane_mul_assign_rows(
    acc: &mut [f32],
    w: usize,
    rhs: &[f32],
    cancel: CancelToken<'_>,
) -> bool {
    acc.par_chunks_mut(w)
        .enumerate()
        .map(|(row, acc_row)| {
            if cancel.is_cancelled() {
                return true;
            }
            let base = row * w;
            for (x, e) in acc_row.iter_mut().enumerate() {
                *e *= rhs[base + x];
            }
            false
        })
        .reduce(|| false, |a, b| a || b)
}

#[cfg(test)]
#[path = "capture_sharpening/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "capture_sharpening/cancel_tests.rs"]
mod cancel_tests;
