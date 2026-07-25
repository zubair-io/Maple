//! Byte-exact integer transpose / flip for 90 / 180 / 270 ° rotations.
//!
//! Selected via [`super::snap_orthogonal`] when the user's straighten angle
//! falls within `EXACT_ANGLE_EPS` of an orthogonal multiple. Producing a
//! pixel-exact result for these angles is load-bearing for the round-trip
//! UI use case (a user toggling between 0° and 90° expects pixel identity,
//! not bilinear-blurred sub-pixel drift).

use super::sample::Sample;
use super::OrthogonalSnap;

pub(super) fn orthogonal_f32_rgba(
    src: &[f32],
    w: u32,
    h: u32,
    snap: OrthogonalSnap,
) -> (u32, u32, Vec<f32>) {
    let (sw, sh) = (w as usize, h as usize);
    let (new_w, new_h) = match snap {
        OrthogonalSnap::Cw90 | OrthogonalSnap::Cw270 => (h, w),
        _ => (w, h),
    };
    let (dw, dh) = (new_w as usize, new_h as usize);
    let mut out = vec![0.0f32; dw * dh * 4];
    for yp in 0..dh {
        for xp in 0..dw {
            // (sx, sy) is the source pixel that lands at destination (xp, yp).
            let (sx, sy) = match snap {
                OrthogonalSnap::Cw90 => (yp, sh - 1 - xp),
                OrthogonalSnap::Cw180 => (sw - 1 - xp, sh - 1 - yp),
                OrthogonalSnap::Cw270 => (sw - 1 - yp, xp),
                _ => unreachable!("orthogonal_f32_rgba called with non-orthogonal snap"),
            };
            let si = (sy * sw + sx) * 4;
            let di = (yp * dw + xp) * 4;
            out[di] = src[si];
            out[di + 1] = src[si + 1];
            out[di + 2] = src[si + 2];
            out[di + 3] = src[si + 3];
        }
    }
    (new_w, new_h, out)
}

/// Orthogonal rotate for interleaved integer RGB at either display depth
/// (#943). Pure index permutation, so both depths stay pixel-exact.
pub(super) fn orthogonal_rgb<T: Sample>(
    src: &[T],
    w: u32,
    h: u32,
    snap: OrthogonalSnap,
) -> (u32, u32, Vec<T>) {
    let (sw, sh) = (w as usize, h as usize);
    let (new_w, new_h) = match snap {
        OrthogonalSnap::Cw90 | OrthogonalSnap::Cw270 => (h, w),
        _ => (w, h),
    };
    let (dw, dh) = (new_w as usize, new_h as usize);
    let mut out = vec![T::default(); dw * dh * 3];
    for yp in 0..dh {
        for xp in 0..dw {
            let (sx, sy) = match snap {
                OrthogonalSnap::Cw90 => (yp, sh - 1 - xp),
                OrthogonalSnap::Cw180 => (sw - 1 - xp, sh - 1 - yp),
                OrthogonalSnap::Cw270 => (sw - 1 - yp, xp),
                _ => unreachable!("orthogonal_rgb called with non-orthogonal snap"),
            };
            let si = (sy * sw + sx) * 3;
            let di = (yp * dw + xp) * 3;
            out[di] = src[si];
            out[di + 1] = src[si + 1];
            out[di + 2] = src[si + 2];
        }
    }
    (new_w, new_h, out)
}
