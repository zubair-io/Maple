//! The crop tool's overlay from the shared Rust overlay surface (#5715): the same
//! mask, frame, rule-of-thirds grid and corner dots Apple draws, rasterized by
//! raw-core's CPU reference, plus the handle centres for accessible elements.
use raw_core::canvas::{
    crop_handle_centers, crop_overlay, rasterize_overlay, CropEdges, CropHandle, CropOverlayInput,
    Size, CROP_OVERLAY_OVERSCAN,
};
use std::slice;

/// Android `CropHandle` ordinals: TL, TR, BL, BR, T, B, L, R, Move; -1 is idle.
const HANDLES: [CropHandle; 9] = [
    CropHandle::TopLeft,
    CropHandle::TopRight,
    CropHandle::BottomLeft,
    CropHandle::BottomRight,
    CropHandle::Top,
    CropHandle::Bottom,
    CropHandle::Left,
    CropHandle::Right,
    CropHandle::Move,
];

/// `params`: top, left, bottom, right, angle, viewport width/height (points),
/// image width/height, surface pixels per point.
unsafe fn input(params: *const f64, active: i32) -> Result<CropOverlayInput, String> {
    if params.is_null() {
        return Err("Missing crop overlay parameters".into());
    }
    let p = slice::from_raw_parts(params, 10);
    if p.iter().any(|value| !value.is_finite()) {
        return Err("Crop overlay parameters must be finite".into());
    }
    Ok(CropOverlayInput {
        crop: CropEdges {
            top: p[0],
            left: p[1],
            bottom: p[2],
            right: p[3],
            angle: p[4],
        },
        viewport: Size::new(p[5], p[6]),
        image: Size::new(p[7], p[8]),
        pixel_scale: p[9],
        active: usize::try_from(active)
            .ok()
            .and_then(|i| HANDLES.get(i).copied()),
    })
}

#[no_mangle]
pub extern "C" fn maple_android_crop_overlay_overscan() -> f64 {
    CROP_OVERLAY_OVERSCAN
}

/// Rasterizes premultiplied RGBA8 into `out` (an RGBA_8888 bitmap's pixels).
#[no_mangle]
pub unsafe extern "C" fn maple_android_crop_overlay(
    params: *const f64,
    active: i32,
    width: u32,
    height: u32,
    stride: usize,
    out: *mut u8,
    out_len: usize,
) -> bool {
    crate::guarded(false, || {
        if out.is_null() {
            return Err("Missing crop overlay surface".into());
        }
        let overlay = crop_overlay(input(params, active)?);
        rasterize_overlay(
            &overlay,
            width,
            height,
            stride,
            slice::from_raw_parts_mut(out, out_len),
        )
        .map_err(|error| format!("Crop overlay surface: {error:?}"))?;
        Ok(true)
    })
}

/// Writes the eight handle centres (x, y in viewport points) in Android ordinal order.
#[no_mangle]
pub unsafe extern "C" fn maple_android_crop_handle_centers(
    params: *const f64,
    out: *mut f64,
) -> bool {
    crate::guarded(false, || {
        if out.is_null() {
            return Err("Missing crop handle output".into());
        }
        let centers = crop_handle_centers(input(params, -1)?);
        let output = slice::from_raw_parts_mut(out, 16);
        for (index, handle) in HANDLES[..8].iter().enumerate() {
            let (_, point) = centers
                .iter()
                .find(|(h, _)| h == handle)
                .ok_or("Missing crop handle")?;
            output[index * 2] = point.x;
            output[index * 2 + 1] = point.y;
        }
        Ok(true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> [f64; 10] {
        [0.1, 0.2, 0.9, 0.8, 0.0, 300.0, 200.0, 3000.0, 2000.0, 2.0]
    }

    #[test]
    fn rasterizes_exactly_the_shared_reference_bytes() {
        let p = params();
        let pad = (CROP_OVERLAY_OVERSCAN * 2.0 * 2.0) as u32;
        let (w, h) = (600 + pad, 400 + pad);
        let mut ours = vec![0u8; (w * h * 4) as usize];
        assert!(unsafe {
            maple_android_crop_overlay(
                p.as_ptr(),
                0,
                w,
                h,
                w as usize * 4,
                ours.as_mut_ptr(),
                ours.len(),
            )
        });
        let mut reference = vec![0u8; ours.len()];
        let shared = crop_overlay(unsafe { input(p.as_ptr(), 0) }.unwrap());
        rasterize_overlay(&shared, w, h, w as usize * 4, &mut reference).unwrap();
        assert_eq!(ours, reference);
        assert!(
            ours.chunks_exact(4).any(|px| px[3] > 0),
            "the overlay draws something"
        );
        let mut short = vec![0u8; 16];
        assert!(!unsafe {
            maple_android_crop_overlay(
                p.as_ptr(),
                -1,
                w,
                h,
                w as usize * 4,
                short.as_mut_ptr(),
                short.len(),
            )
        });
    }

    #[test]
    fn handle_centres_follow_the_android_ordinals() {
        let p = params();
        let mut out = [0.0f64; 16];
        assert!(unsafe { maple_android_crop_handle_centers(p.as_ptr(), out.as_mut_ptr()) });
        // 3000×2000 fits 300×200 exactly; the crop spans x 60..240, y 20..180.
        let expected = [
            (0, 60.0, 20.0),
            (3, 240.0, 180.0),
            (4, 150.0, 20.0),
            (7, 240.0, 100.0),
        ];
        for (handle, x, y) in expected {
            assert!((out[handle * 2] - x).abs() < 1e-9, "handle {handle} x");
            assert!((out[handle * 2 + 1] - y).abs() < 1e-9, "handle {handle} y");
        }
    }
}
