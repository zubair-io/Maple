//! Brush dab-series rasterization (#360): [`maple_brush_rasterize`] stamps
//! a dab series into the caller's R8 buffer — the bytes the host then
//! registers via `maple_mask_raster_register` and references from the
//! brush layer's `raster_id`. Thin marshalling only: the stamp math is
//! `raw_core::types::rasterize_brush`, so every platform's strokes
//! rasterize identically.
//!
//! Dab wire: `dab_count` dabs × [`BRUSH_DAB_STRIDE`] `f32`s —
//! `x, y, radius, feather, weight, erase`, where `erase` is exactly `0.0`
//! or `1.0`. Same field order as the `crs:Dabs` XMP series, minus the
//! string layer.

use raw_core::types::{rasterize_brush, BrushDab, Point2};

/// `f32`s per dab on the [`maple_brush_rasterize`] wire.
pub const BRUSH_DAB_STRIDE: usize = 6;

/// Rasterize `dab_count` dabs onto a `width × height` R8 grid (row-major,
/// `0` = weight 0, `255` = weight 1) into the caller's `out_ptr` buffer.
/// Runs once per stroke commit — never per tick — so the temporary `Vec`
/// this allocates is off the render path.
///
/// # Safety
/// `dabs_ptr` must be valid for `dab_count * BRUSH_DAB_STRIDE` `f32` reads
/// (or null when `dab_count == 0` — an empty series writes zeros).
/// `out_ptr` must be valid for `out_len` `u8` writes (or null when
/// `out_len == 0`).
///
/// Returns:
///    0   success
///   -1   `dabs_ptr` null with `dab_count > 0`, or `out_ptr` null with
///        `out_len > 0`
///   -2   `out_len != width * height` (or the product overflows)
///   -3   a dab has a non-finite field or an erase flag that is not exactly
///        `0.0`/`1.0` — the wire is validated loudly so a host marshalling
///        bug surfaces here rather than as a silently wrong stroke
#[no_mangle]
pub extern "C" fn maple_brush_rasterize(
    dabs_ptr: *const f32,
    dab_count: usize,
    width: u32,
    height: u32,
    out_ptr: *mut u8,
    out_len: usize,
) -> i32 {
    if (dabs_ptr.is_null() && dab_count > 0) || (out_ptr.is_null() && out_len > 0) {
        return -1;
    }
    let Some(expected_len) = (width as usize).checked_mul(height as usize) else {
        return -2;
    };
    if out_len != expected_len {
        return -2;
    }
    let wire: &[f32] = if dab_count == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(dabs_ptr, dab_count * BRUSH_DAB_STRIDE) }
    };
    let mut dabs = Vec::with_capacity(dab_count);
    for dab in wire.chunks_exact(BRUSH_DAB_STRIDE) {
        let erase = match dab[5] {
            0.0 => false,
            1.0 => true,
            _ => return -3,
        };
        if ![dab[0], dab[1], dab[2], dab[3], dab[4]]
            .iter()
            .all(|v| v.is_finite())
        {
            return -3;
        }
        dabs.push(BrushDab::new(
            Point2::new(dab[0], dab[1]),
            dab[2],
            dab[3],
            dab[4],
            erase,
        ));
    }
    let bytes = rasterize_brush(&dabs, width, height);
    if out_len > 0 {
        unsafe { std::slice::from_raw_parts_mut(out_ptr, out_len).copy_from_slice(&bytes) };
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dab(x: f32, y: f32, radius: f32, feather: f32, weight: f32, erase: f32) -> [f32; 6] {
        [x, y, radius, feather, weight, erase]
    }

    #[test]
    fn rasterize_matches_raw_core_through_the_c_abi() {
        let flat = [
            dab(0.5, 0.5, 0.2, 0.5, 0.6, 0.0),
            dab(0.5, 0.5, 0.2, 0.0, 0.5, 1.0),
        ]
        .concat();
        let dabs = [
            BrushDab::new(Point2::new(0.5, 0.5), 0.2, 0.5, 0.6, false),
            BrushDab::new(Point2::new(0.5, 0.5), 0.2, 0.0, 0.5, true),
        ];
        let mut out = vec![0u8; 51 * 51];
        let rc = maple_brush_rasterize(flat.as_ptr(), 2, 51, 51, out.as_mut_ptr(), out.len());
        assert_eq!(rc, 0);
        assert_eq!(out, rasterize_brush(&dabs, 51, 51));
        assert_eq!(out[25 * 51 + 25], (0.3f32 * 255.0).round() as u8);
    }

    #[test]
    fn empty_series_writes_zeros() {
        let mut out = vec![9u8; 16];
        let rc = maple_brush_rasterize(std::ptr::null(), 0, 4, 4, out.as_mut_ptr(), out.len());
        assert_eq!(rc, 0);
        assert!(out.iter().all(|b| *b == 0));
    }

    #[test]
    fn bad_pointers_and_lengths_are_rejected() {
        let flat = [dab(0.5, 0.5, 0.1, 0.0, 1.0, 0.0)].concat();
        let mut out = vec![0u8; 16];
        assert_eq!(
            maple_brush_rasterize(std::ptr::null(), 1, 4, 4, out.as_mut_ptr(), out.len()),
            -1
        );
        assert_eq!(
            maple_brush_rasterize(flat.as_ptr(), 1, 4, 4, std::ptr::null_mut(), 16),
            -1
        );
        assert_eq!(
            maple_brush_rasterize(flat.as_ptr(), 1, 4, 4, out.as_mut_ptr(), 15),
            -2
        );
        assert_eq!(
            maple_brush_rasterize(
                flat.as_ptr(),
                1,
                u32::MAX,
                u32::MAX,
                out.as_mut_ptr(),
                out.len()
            ),
            -2
        );
    }

    #[test]
    fn malformed_dabs_are_rejected() {
        let mut out = vec![0u8; 16];
        for wire in [
            [dab(f32::NAN, 0.5, 0.1, 0.0, 1.0, 0.0)],
            [dab(0.5, 0.5, 0.1, 0.0, f32::INFINITY, 0.0)],
            [dab(0.5, 0.5, 0.1, 0.0, 1.0, 0.7)],
        ] {
            let flat = wire.concat();
            assert_eq!(
                maple_brush_rasterize(flat.as_ptr(), 1, 4, 4, out.as_mut_ptr(), 16),
                -3
            );
        }
    }
}
