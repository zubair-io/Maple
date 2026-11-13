//! The crop overlay over FFI (#5715): the CPU rasterizer the fallback path
//! draws its overlay surface with, and the handle centres hosts position
//! their accessible elements from. The GPU present of the same overlay is
//! `maple_gpu_present_crop_overlay` (Apple, `gpu` feature).

use crate::canvas_crop::{handle_from_code, MapleCanvasCrop};
use crate::canvas_math::{MapleCanvasPoint, MapleCanvasSize};
use crate::error::{catch_panic, catch_panic_rc, set_last_error};
use raw_core::canvas::{
    crop_handle_centers, crop_overlay, rasterize_overlay, CanvasOverlay, CropOverlayInput,
    RasterizeError, CROP_OVERLAY_OVERSCAN,
};

/// Everything the crop overlay depends on: the crop, the viewport in points,
/// the oriented image size in pixels, overlay-surface pixels per point, and
/// the `MAPLE_CANVAS_CROP_HANDLE_*` code being dragged (`NONE` when idle).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasCropOverlayInput {
    pub crop: MapleCanvasCrop,
    pub viewport: MapleCanvasSize,
    pub image_size: MapleCanvasSize,
    pub pixel_scale: f64,
    pub active_handle: u32,
}

impl From<MapleCanvasCropOverlayInput> for CropOverlayInput {
    fn from(input: MapleCanvasCropOverlayInput) -> Self {
        Self {
            crop: input.crop.into(),
            viewport: input.viewport.into(),
            image: input.image_size.into(),
            pixel_scale: input.pixel_scale,
            active: handle_from_code(input.active_handle),
        }
    }
}

pub(crate) fn overlay_from_input(input: MapleCanvasCropOverlayInput) -> CanvasOverlay {
    crop_overlay(input.into())
}

/// Rasterize the crop overlay into `out` as premultiplied RGBA8, `stride`
/// bytes per row, `width × height` pixels. Allocates nothing.
///
/// Returns 0 on success; -1 `out` null, -2 `stride` below `width * 4`,
/// -3 `out_len` below `stride * height`, 99 a contained panic.
///
/// # Safety
/// `out` must be valid for `out_len` byte writes.
#[no_mangle]
pub unsafe extern "C" fn maple_canvas_crop_overlay_rasterize(
    input: MapleCanvasCropOverlayInput,
    width: u32,
    height: u32,
    stride: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    if out.is_null() {
        set_last_error("canvas_crop_overlay_rasterize: out null".into());
        return -1;
    }
    let bytes = std::slice::from_raw_parts_mut(out, out_len);
    catch_panic_rc(
        "maple_canvas_crop_overlay_rasterize",
        || match rasterize_overlay(&overlay_from_input(input), width, height, stride, bytes) {
            Ok(()) => 0,
            Err(RasterizeError::StrideTooSmall) => {
                set_last_error(format!(
                    "canvas_crop_overlay_rasterize: stride {stride} < {width} * 4"
                ));
                -2
            }
            Err(RasterizeError::BufferTooSmall) => {
                set_last_error(format!(
                    "canvas_crop_overlay_rasterize: {out_len} bytes < {stride} * {height}"
                ));
                -3
            }
        },
    )
}

/// Points the crop overlay surface extends past the viewport on every side.
/// The host sizes the surface to the viewport plus twice this per axis and
/// places it this far above and left of the viewport.
#[no_mangle]
pub extern "C" fn maple_canvas_crop_overlay_overscan() -> f64 {
    catch_panic(
        "maple_canvas_crop_overlay_overscan",
        CROP_OVERLAY_OVERSCAN,
        || CROP_OVERLAY_OVERSCAN,
    )
}

/// The centre, in viewport points, of the corner or edge handle `handle`
/// (a `MAPLE_CANVAS_CROP_HANDLE_*` code); the origin for `MOVE`, `NONE` or an
/// unknown code.
#[no_mangle]
pub extern "C" fn maple_canvas_crop_handle_center(
    input: MapleCanvasCropOverlayInput,
    handle: u32,
) -> MapleCanvasPoint {
    catch_panic(
        "maple_canvas_crop_handle_center",
        MapleCanvasPoint::default(),
        || {
            let wanted = handle_from_code(handle);
            crop_handle_centers(input.into())
                .into_iter()
                .find(|(candidate, _)| Some(*candidate) == wanted)
                .map(|(_, point)| point.into())
                .unwrap_or_default()
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas_crop::{
        MAPLE_CANVAS_CROP_HANDLE_BOTTOM_RIGHT, MAPLE_CANVAS_CROP_HANDLE_MOVE,
        MAPLE_CANVAS_CROP_HANDLE_NONE, MAPLE_CANVAS_CROP_HANDLE_TOP,
    };

    fn input(active_handle: u32) -> MapleCanvasCropOverlayInput {
        MapleCanvasCropOverlayInput {
            crop: MapleCanvasCrop {
                top: 0.2,
                left: 0.1,
                bottom: 0.8,
                right: 0.9,
                angle: 0.0,
            },
            viewport: MapleCanvasSize {
                width: 300.0,
                height: 200.0,
            },
            image_size: MapleCanvasSize {
                width: 600.0,
                height: 400.0,
            },
            pixel_scale: 2.0,
            active_handle,
        }
    }

    #[test]
    fn rasterize_matches_the_core_rasterizer() {
        let (width, height) = (600_u32, 400_u32);
        let mut via_ffi = vec![0_u8; 600 * 400 * 4];
        let rc = unsafe {
            maple_canvas_crop_overlay_rasterize(
                input(MAPLE_CANVAS_CROP_HANDLE_TOP),
                width,
                height,
                2400,
                via_ffi.as_mut_ptr(),
                via_ffi.len(),
            )
        };
        assert_eq!(rc, 0);
        let mut direct = vec![0_u8; via_ffi.len()];
        rasterize_overlay(
            &crop_overlay(input(MAPLE_CANVAS_CROP_HANDLE_TOP).into()),
            width,
            height,
            2400,
            &mut direct,
        )
        .unwrap();
        assert!(via_ffi == direct);
        assert!(via_ffi.iter().any(|&b| b != 0));
    }

    #[test]
    fn rasterize_reports_bad_buffers() {
        let mut out = vec![0_u8; 16];
        let call = |stride, out: &mut [u8], len| unsafe {
            maple_canvas_crop_overlay_rasterize(input(0), 2, 2, stride, out.as_mut_ptr(), len)
        };
        assert_eq!(
            unsafe {
                maple_canvas_crop_overlay_rasterize(input(0), 2, 2, 8, std::ptr::null_mut(), 0)
            },
            -1
        );
        assert_eq!(call(7, &mut out, 16), -2);
        assert_eq!(call(8, &mut out, 15), -3);
        assert_eq!(call(8, &mut out, 16), 0);
    }

    #[test]
    fn handle_centers_follow_the_crop_rect() {
        // 600×400 fits 300×200 exactly; the crop spans x 30..270, y 40..160.
        let corner = maple_canvas_crop_handle_center(
            input(MAPLE_CANVAS_CROP_HANDLE_NONE),
            MAPLE_CANVAS_CROP_HANDLE_BOTTOM_RIGHT,
        );
        assert!((corner.x - 270.0).abs() < 1e-9 && (corner.y - 160.0).abs() < 1e-9);
        let top = maple_canvas_crop_handle_center(input(0), MAPLE_CANVAS_CROP_HANDLE_TOP);
        assert!((top.x - 150.0).abs() < 1e-9 && (top.y - 40.0).abs() < 1e-9);
        assert_eq!(
            maple_canvas_crop_handle_center(input(0), MAPLE_CANVAS_CROP_HANDLE_MOVE),
            MapleCanvasPoint::default()
        );
    }
}
