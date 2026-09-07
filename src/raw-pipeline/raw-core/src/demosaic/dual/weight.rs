//! The local-contrast weight that decides, per pixel, which of the two
//! reconstructions the dual demosaic hands the caller (#3413).
//!
//! ## What it measures
//!
//! One number per pixel in `[0, 1]`: 0 means "this neighbourhood is flat —
//! use the smooth kernel", 1 means "there is real structure here — use the
//! detail-first kernel", and everything between is a linear cross-fade.
//!
//! The measure is **relative** contrast: the gradient magnitude of the green
//! plane divided by the local mean level. Absolute gradient would be the
//! wrong quantity — a bright sky and a dim sky are equally flat, but the
//! bright one's noise is numerically larger, so an absolute threshold would
//! send highlights to the detail kernel and shadows to the smooth one purely
//! on exposure. Dividing by the local mean makes the measure invariant to
//! scene brightness, which is what lets one threshold constant hold across
//! every fixture. A floor on the denominator keeps deep shadow, where the
//! mean approaches zero, from producing an unbounded ratio.
//!
//! ## Which green
//!
//! The green plane handed in is the **smooth kernel's reconstruction**, not
//! the raw CFA green samples. Green is sampled on a quincunx, so any
//! gradient operator applied to the raw plane alternates between measured
//! and missing sites and reports a checkerboard that has nothing to do with
//! the scene. The smooth reconstruction is defined at every site, is already
//! computed by the time the blend runs, and — being the noise-averaged one —
//! is the reconstruction least likely to report noise as structure.
//!
//! ## Shape of the response
//!
//! Below [`CONTRAST_THRESHOLD`] the weight is exactly 0; at
//! [`EDGE_RATIO`] × that, exactly 1; between them a smoothstep, whose zero
//! derivative at both ends is what stops the transition from drawing its own
//! contour into the image.
//!
//! Two spatial passes finish it. First a 3×3 **dilation** — each pixel takes
//! the largest weight in its neighbourhood — then a 3×3 box smooth. The
//! order matters and the dilation is not optional: a gradient operator
//! reports a hard edge on a two-pixel-wide ridge, and smoothing that ridge
//! directly would average a weight of 1 with its two zero neighbours and
//! hand a third of the sharpest edge in the frame to the smooth kernel.
//! Dilating first widens the protected region by one pixel so the smooth
//! only rounds the shoulder *outward*, into the flat side, where softening
//! the transition is exactly what is wanted.
//!
//! The formulation is this repository's own. darktable and RawTherapee both
//! blend their dual demosaic by a local-contrast mask of the green plane;
//! nothing about how theirs is computed was read or copied.

/// Relative contrast at or below which the pixel is entirely the smooth
/// kernel's. 3 % local modulation is comfortably above the read noise of a
/// base-ISO frame at mid-grey and comfortably below any structure a viewer
/// would call detail.
pub const CONTRAST_THRESHOLD: f32 = 0.03;

/// Multiple of [`CONTRAST_THRESHOLD`] at which the pixel is entirely the
/// detail-first kernel's. A factor of 4 puts the whole cross-fade inside two
/// stops of contrast, so a soft edge is blended rather than switched.
pub const EDGE_RATIO: f32 = 4.0;

/// Floor added to the local mean before dividing. 2 % of full scale — below
/// that level a sensor is reading its own noise floor, and the relative
/// contrast of noise about zero is meaningless.
const LEVEL_FLOOR: f32 = 0.02;

/// Radius of the box that estimates the local mean level.
const MEAN_RADIUS: usize = 2;

/// Radius of the dilation that protects a thin edge from being averaged
/// away by the smoothing pass below.
const DILATE_RADIUS: usize = 1;

/// Radius of the final smoothing box applied to the weight itself.
const SMOOTH_RADIUS: usize = 1;

/// Rows and columns of halo the caller must supply around the region whose
/// weights it intends to use. A weight reads the dilation and smooth
/// neighbourhoods around it, and each raw weight reads the local-mean box
/// (which is wider than the gradient's own single-pixel reach).
pub(super) const HALO: usize = MEAN_RADIUS + DILATE_RADIUS + SMOOTH_RADIUS;

/// Hermite cross-fade with zero derivative at both ends.
#[inline]
fn smoothstep(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// One clamped index along an axis of length `n`, for a filter of the given
/// radius at tap `k` around `i`.
#[inline]
fn tap(i: usize, k: usize, radius: usize, n: usize) -> usize {
    (i + k).saturating_sub(radius).min(n - 1)
}

/// Horizontal pass of a box mean.
fn h_mean(src: &[f32], dst: &mut [f32], w: usize, h: usize, radius: usize) {
    let taps = (2 * radius + 1) as f32;
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0.0f32;
            for k in 0..=(2 * radius) {
                sum += src[y * w + tap(x, k, radius, w)];
            }
            dst[y * w + x] = sum / taps;
        }
    }
}

/// Vertical pass of a box mean.
fn v_mean(src: &[f32], dst: &mut [f32], w: usize, h: usize, radius: usize) {
    let taps = (2 * radius + 1) as f32;
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0.0f32;
            for k in 0..=(2 * radius) {
                sum += src[tap(y, k, radius, h) * w + x];
            }
            dst[y * w + x] = sum / taps;
        }
    }
}

/// Horizontal pass of a box maximum.
fn h_max(src: &[f32], dst: &mut [f32], w: usize, h: usize, radius: usize) {
    for y in 0..h {
        for x in 0..w {
            let mut acc = f32::NEG_INFINITY;
            for k in 0..=(2 * radius) {
                acc = acc.max(src[y * w + tap(x, k, radius, w)]);
            }
            dst[y * w + x] = acc;
        }
    }
}

/// Vertical pass of a box maximum.
fn v_max(src: &[f32], dst: &mut [f32], w: usize, h: usize, radius: usize) {
    for y in 0..h {
        for x in 0..w {
            let mut acc = f32::NEG_INFINITY;
            for k in 0..=(2 * radius) {
                acc = acc.max(src[tap(y, k, radius, h) * w + x]);
            }
            dst[y * w + x] = acc;
        }
    }
}

/// Per-pixel blend weights for a `w × h` green plane, left in `out`:
/// 0 = all smooth kernel, 1 = all detail-first kernel.
///
/// `out` and `tmp` are caller-owned scratch, resized here and reused across
/// bands. Every pass below runs between those two buffers rather than
/// allocating its own — the blend visits a hundred-plus bands on a 100 MP
/// sensor, and a handful of fresh multi-megabyte planes per band is enough
/// page-fault and zeroing traffic to cost more than the kernels the mask
/// exists to choose between.
///
/// Edges clamp rather than wrap, so the caller may hand in a band plus a
/// [`HALO`] of real rows and read back only the interior it cares about.
pub(super) fn contrast_weights_into(
    green: &[f32],
    w: usize,
    h: usize,
    out: &mut Vec<f32>,
    tmp: &mut Vec<f32>,
) {
    out.clear();
    tmp.clear();
    if w == 0 || h == 0 {
        return;
    }
    out.resize(w * h, 0.0);
    tmp.resize(w * h, 0.0);

    // Local mean level -> `out`.
    h_mean(green, tmp, w, h, MEAN_RADIUS);
    v_mean(tmp, out, w, h, MEAN_RADIUS);

    // Raw relative-contrast response -> `tmp`, reading the level in `out`.
    let span = CONTRAST_THRESHOLD * (EDGE_RATIO - 1.0);
    for y in 0..h {
        for x in 0..w {
            let at = |dx: isize, dy: isize| -> f32 {
                let cx = (x as isize + dx).clamp(0, w as isize - 1) as usize;
                let cy = (y as isize + dy).clamp(0, h as isize - 1) as usize;
                green[cy * w + cx]
            };
            let gx = (at(1, -1) + 2.0 * at(1, 0) + at(1, 1))
                - (at(-1, -1) + 2.0 * at(-1, 0) + at(-1, 1));
            let gy = (at(-1, 1) + 2.0 * at(0, 1) + at(1, 1))
                - (at(-1, -1) + 2.0 * at(0, -1) + at(1, -1));
            let magnitude = (gx * gx + gy * gy).sqrt() * 0.125;
            let contrast = magnitude / (out[y * w + x].max(0.0) + LEVEL_FLOOR);
            tmp[y * w + x] = smoothstep((contrast - CONTRAST_THRESHOLD) / span);
        }
    }

    // Dilate, then smooth — each a two-pass ping-pong between the buffers,
    // so the level in `out` is overwritten only once it is no longer read.
    h_max(tmp, out, w, h, DILATE_RADIUS);
    v_max(out, tmp, w, h, DILATE_RADIUS);
    h_mean(tmp, out, w, h, SMOOTH_RADIUS);
    v_mean(out, tmp, w, h, SMOOTH_RADIUS);
    std::mem::swap(out, tmp);
}

/// Allocating wrapper over [`contrast_weights_into`], for callers with no
/// scratch to hand — the tests, and any single-shot use.
pub fn contrast_weights(green: &[f32], w: usize, h: usize) -> Vec<f32> {
    let (mut out, mut tmp) = (Vec::new(), Vec::new());
    contrast_weights_into(green, w, h, &mut out, &mut tmp);
    out
}
