//! Crop + straighten / rotate per spec § 3.12 (ticket #277).
//!
//! Operates on a typed RGBA (f32) or RGB (u8) display-oriented buffer after
//! [`crate::image::apply_orientation`] (or the f32 RGBA mirror). Pipeline
//! contract: the develop chain still produces a full-frame buffer for
//! viewport / preview parity; the crop stage clips that buffer at the tail
//! so the cropped image is the user-visible result.
//!
//! ## Code paths
//!
//! Three are selected at apply time:
//!
//! 1. **Identity** — [`Crop::is_identity`] true (or invalid rect with zero
//!    angle): the input is returned unchanged (modulo one defensive copy).
//!    No resampling, no allocation perturbation in the parity-harness
//!    baseline.
//! 2. **Axis-aligned slice** — `angle == 0` with a well-formed rect:
//!    [`axis_aligned`] copies pixels row-by-row from the source rect into a
//!    new buffer using integer indices. Byte-exact; no resampling.
//! 3. **Rotated** — `angle != 0`:
//!    - If the angle snaps to an orthogonal multiple of 90°
//!      ([`snap_orthogonal`]), [`rotate`] does a byte-exact integer
//!      transpose / flip on the (post-rect) buffer.
//!    - Otherwise, [`bilinear`] inverse-warps each output pixel through
//!      `R(-θ)` around the original-image centre (in display coords) and
//!      bilinear-samples from the source. Out-of-source reads land in the
//!      "empty corner" channel default that the spec acknowledges large
//!      rotations may expose.
//!
//! ### Why bilinear and not bicubic?
//!
//! Straighten typically uses angles ≤ 5°. The visible quality difference
//! between bilinear and bicubic at small angles is well under the perceptual
//! noise floor on developed photos — the AgX view transform and the
//! downstream display-encode gamma both flatten the high-frequency delta
//! that distinguishes the two kernels. Bilinear keeps the inner loop to two
//! multiplies per axis with no negative-lobe arithmetic, matching the WebGL
//! `LINEAR` filter so the cross-platform parity gate stays trivial. Bicubic
//! would add 12+ multiplies per pixel and a ringing signature that's easier
//! to see than the resolution it preserves at the angles this stage is
//! actually used at. Revisit if a feature adds large-angle creative tilts.

mod axis_aligned;
mod bilinear;
mod rotate;
mod sample;

#[cfg(test)]
mod tests;

pub use sample::Sample;

use crate::types::Crop;

/// Tolerance for snapping the user-driven straighten angle onto an exact
/// orthogonal rotation. 0.01° is well below any UI-detectable slop and
/// above the f32 ULP noise that creeps in when serializing through XMP
/// (text representation can introduce ~1e-7 error).
const EXACT_ANGLE_EPS: f32 = 0.01;

/// Apply the crop to a packed `[f32; 4]` RGBA buffer (straight alpha; alpha
/// lane carried through). Returns the new `(width, height, buffer)` triple,
/// matching the convention used by [`crate::pipeline::orient`] et al. so the
/// caller can substitute it inline.
///
/// Identity is an explicit short-circuit — the input `Vec<f32>` is returned
/// via `to_vec()` only when a copy is forced, avoiding an unnecessary
/// allocation in the no-op case the parity harness exercises on every
/// baseline render.
pub fn apply_f32_rgba(rgba: &[f32], w: u32, h: u32, crop: &Crop) -> (u32, u32, Vec<f32>) {
    debug_assert_eq!(
        rgba.len(),
        (w as usize) * (h as usize) * 4,
        "RGBA f32 buffer size mismatch ({}, expected {})",
        rgba.len(),
        (w as usize) * (h as usize) * 4,
    );

    if !needs_apply(crop) {
        return (w, h, rgba.to_vec());
    }

    let snapped = snap_orthogonal(crop.angle);
    let (rect_x, rect_y, rect_w, rect_h) = rect_in_pixels(crop, w, h);
    let rect = axis_aligned::SliceRect {
        x: rect_x,
        y: rect_y,
        w: rect_w,
        h: rect_h,
    };

    if snapped == OrthogonalSnap::Zero {
        return axis_aligned::slice_f32_rgba(rgba, w, rect);
    }
    if snapped != OrthogonalSnap::Off {
        let (sw, sh, sliced) = axis_aligned::slice_f32_rgba(rgba, w, rect);
        return rotate::orthogonal_f32_rgba(&sliced, sw, sh, snapped);
    }
    bilinear::rotate_and_slice_f32_rgba(rgba, w, h, crop)
}

/// Apply the crop to an interleaved `u8` RGB buffer. Mirror of
/// [`apply_f32_rgba`] for the legacy display-encoded path
/// (`pipeline::render::render_from_raw_with_quality`).
///
/// For axis-aligned rects in u8 the slice is byte-exact — same integer
/// indexing as the f32 path. The rotated path uses bilinear in u8 (rounding
/// to nearest), which is acceptable for the legacy display path; the FFI
/// path that Apple / Web actually drive runs through `apply_f32_rgba` on
/// the scene-linear buffer instead.
pub fn apply_u8_rgb(rgb: &[u8], w: u32, h: u32, crop: &Crop) -> (u32, u32, Vec<u8>) {
    apply_int_rgb(rgb, w, h, crop)
}

/// Apply the crop to an interleaved integer RGB buffer at either display
/// depth (#943). [`apply_u8_rgb`] is the 8-bit alias kept for existing
/// callers; the 16-bit export deliverable instantiates this directly, so the
/// two depths cannot disagree about geometry.
pub fn apply_int_rgb<T: Sample>(rgb: &[T], w: u32, h: u32, crop: &Crop) -> (u32, u32, Vec<T>) {
    debug_assert_eq!(
        rgb.len(),
        (w as usize) * (h as usize) * 3,
        "RGB buffer size mismatch ({}, expected {})",
        rgb.len(),
        (w as usize) * (h as usize) * 3,
    );

    if !needs_apply(crop) {
        return (w, h, rgb.to_vec());
    }

    let snapped = snap_orthogonal(crop.angle);
    let (rect_x, rect_y, rect_w, rect_h) = rect_in_pixels(crop, w, h);
    let rect = axis_aligned::SliceRect {
        x: rect_x,
        y: rect_y,
        w: rect_w,
        h: rect_h,
    };

    if snapped == OrthogonalSnap::Zero {
        return axis_aligned::slice_rgb(rgb, w, rect);
    }
    if snapped != OrthogonalSnap::Off {
        let (sw, sh, sliced) = axis_aligned::slice_rgb(rgb, w, rect);
        return rotate::orthogonal_rgb(&sliced, sw, sh, snapped);
    }
    bilinear::rotate_and_slice_rgb(rgb, w, h, crop)
}

// ---------------------------------------------------------------------------
// Shared helpers (used by the submodules + tests)
// ---------------------------------------------------------------------------

/// True when the crop is meaningfully non-identity AND well-formed. An
/// inverted / empty rect is treated as identity per spec § 3.12 edge cases.
pub(super) fn needs_apply(crop: &Crop) -> bool {
    if crop.is_identity() {
        return false;
    }
    // Rect could be identity (full frame) but with a non-zero angle —
    // that's a pure straighten and still needs the bilinear path. So
    // `rect_is_valid` only gates the rect itself, not the angle.
    if !crop.rect_is_valid() {
        return crop.angle.abs() >= EXACT_ANGLE_EPS;
    }
    true
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub(super) enum OrthogonalSnap {
    /// Angle is so close to zero we treat it as axis-aligned (no rotate).
    Zero,
    /// Angle is within tolerance of 90° clockwise.
    Cw90,
    /// Angle is within tolerance of 180°.
    Cw180,
    /// Angle is within tolerance of 270° clockwise (== 90° anticlockwise).
    Cw270,
    /// General (non-orthogonal) angle — use bilinear.
    Off,
}

/// Snap the user-driven angle onto an exact orthogonal rotation when it
/// lies within `EXACT_ANGLE_EPS`. Handles wrap-around (`angle = 360 + ε` and
/// `angle = -ε` both snap to `Zero`).
pub(super) fn snap_orthogonal(angle_deg: f32) -> OrthogonalSnap {
    let wrapped = ((angle_deg % 360.0) + 360.0) % 360.0;
    if wrapped <= EXACT_ANGLE_EPS || wrapped >= 360.0 - EXACT_ANGLE_EPS {
        OrthogonalSnap::Zero
    } else if (wrapped - 90.0).abs() <= EXACT_ANGLE_EPS {
        OrthogonalSnap::Cw90
    } else if (wrapped - 180.0).abs() <= EXACT_ANGLE_EPS {
        OrthogonalSnap::Cw180
    } else if (wrapped - 270.0).abs() <= EXACT_ANGLE_EPS {
        OrthogonalSnap::Cw270
    } else {
        OrthogonalSnap::Off
    }
}

/// Compute the integer rect corresponding to `crop` against a `w × h` image
/// in display coordinates. Saturates against the image bounds and guarantees
/// `rect_w >= 1`, `rect_h >= 1` so the slice path always has at least one
/// row / column to copy.
pub(super) fn rect_in_pixels(crop: &Crop, w: u32, h: u32) -> (u32, u32, u32, u32) {
    // Treat invalid rects (caught upstream by `needs_apply`) as full frame,
    // for the bilinear-rotate path which can be invoked with rect = identity.
    let (top, left, bottom, right) = if crop.rect_is_valid() {
        (crop.top, crop.left, crop.bottom, crop.right)
    } else {
        (0.0, 0.0, 1.0, 1.0)
    };
    let fw = w as f32;
    let fh = h as f32;
    // round() gives the user-perceived snap-to-nearest-pixel behaviour the
    // overlay UI implies; the same rounding rule must run on Apple + Web
    // mirrors when they pre-round before sending crop coords through XMP.
    let x = (left * fw).round().clamp(0.0, fw - 1.0) as u32;
    let y = (top * fh).round().clamp(0.0, fh - 1.0) as u32;
    let r = (right * fw).round().clamp((x as f32) + 1.0, fw) as u32;
    let b = (bottom * fh).round().clamp((y as f32) + 1.0, fh) as u32;
    let rw = r.saturating_sub(x);
    let rh = b.saturating_sub(y);
    (x, y, rw, rh)
}
