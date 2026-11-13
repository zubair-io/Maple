//! The Apple canvas-overlay present (#5715): draw the crop overlay into its
//! own `CAMetalLayer` above the image layer. No live session is involved and
//! the develop chain never runs, so a crop drag redraws only this surface.

use super::{ensure_context, lock_shared};
use crate::canvas_overlay::{overlay_from_input, MapleCanvasCropOverlayInput};
use crate::error::{catch_panic_rc, set_last_error};
use raw_core::canvas::CanvasOverlay;
use std::os::raw::c_void;

/// The GPU uniform for `overlay`: the same primitives, field for field.
pub(crate) fn overlay_params(overlay: &CanvasOverlay) -> raw_gpu::OverlayParams {
    overlay.active().iter().enumerate().fold(
        raw_gpu::OverlayParams {
            count: [overlay.active().len() as u32, 0, 0, 0],
            ..raw_gpu::OverlayParams::EMPTY
        },
        |mut params, (index, primitive)| {
            params.primitives[index] = raw_gpu::OverlayPrimitive {
                rect: primitive.rect,
                clip: primitive.clip,
                color: primitive.color,
                kind: [primitive.kind, 0, 0, 0],
            };
            params
        },
    )
}

/// Draw the crop overlay for `input` into `layer` at `width × height` pixels.
///
/// `layer` is a `CAMetalLayer*` dedicated to the overlay; like the image
/// layer, its `drawableSize` is owned by the Rust side. `surface_generation`
/// keys the cached overlay surface with the layer pointer and dims; the host
/// bumps it when it registers a different layer instance. Creates the shared
/// GPU context if no live session has yet.
///
/// Returns 0 on success; -1 `layer` null, -5 GPU init failed, -4 the surface
/// could not be configured or drawn, 99 a contained panic. Any nonzero return
/// is safe to treat as "draw the overlay with the CPU rasterizer".
///
/// # Safety
/// `layer` must be a valid `CAMetalLayer*` that outlives every later call
/// passing the same pointer and generation.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_present_crop_overlay(
    input: MapleCanvasCropOverlayInput,
    layer: *mut c_void,
    surface_generation: u64,
    width: u32,
    height: u32,
) -> i32 {
    if layer.is_null() {
        set_last_error("gpu_present_crop_overlay: layer null".into());
        return -1;
    }
    catch_panic_rc("gpu_present_crop_overlay", || {
        let params = overlay_params(&overlay_from_input(input));
        let mut shared = lock_shared();
        if let Err(e) = ensure_context(&mut shared) {
            set_last_error(format!("gpu_present_crop_overlay: {e}"));
            return -5;
        }
        let state = shared.as_mut().expect("initialized above");
        match raw_gpu::present_overlay_to_surface(
            &state.ctx,
            layer,
            &mut state.overlay_surface,
            surface_generation,
            (width, height),
            &params,
        ) {
            Ok(()) => 0,
            Err(msg) => {
                set_last_error(format!("gpu_present_crop_overlay: {msg}"));
                -4
            }
        }
    })
}

/// Release the cached overlay surface drawn under `surface_generation`, if it
/// is still the cached one. Call when that overlay layer is torn down: the
/// surface holds a reference to the layer and its drawables until released
/// or replaced. Returns 0, or 99 for a contained panic.
#[no_mangle]
pub extern "C" fn maple_gpu_release_crop_overlay(surface_generation: u64) -> i32 {
    catch_panic_rc("gpu_release_crop_overlay", || {
        if let Some(state) = lock_shared().as_mut() {
            raw_gpu::release_overlay_surface(&mut state.overlay_surface, surface_generation);
        }
        0
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use raw_core::canvas::{crop_overlay, CropEdges, CropOverlayInput, Size};

    #[test]
    fn params_carry_every_primitive_in_order() {
        let overlay = crop_overlay(CropOverlayInput {
            crop: CropEdges::default(),
            viewport: Size::new(300.0, 200.0),
            image: Size::new(600.0, 400.0),
            pixel_scale: 2.0,
            active: None,
        });
        let params = overlay_params(&overlay);
        assert_eq!(params.count[0] as usize, overlay.active().len());
        for (gpu, cpu) in params.primitives.iter().zip(overlay.active()) {
            assert_eq!(
                (gpu.rect, gpu.clip, gpu.color, gpu.kind[0]),
                (cpu.rect, cpu.clip, cpu.color, cpu.kind)
            );
        }
        assert!(params.primitives[overlay.active().len()..]
            .iter()
            .all(|p| p.kind[0] == 0));
    }

    #[test]
    fn null_layer_is_refused_before_touching_the_gpu() {
        let rc = unsafe {
            maple_gpu_present_crop_overlay(Default::default(), std::ptr::null_mut(), 0, 4, 4)
        };
        assert_eq!(rc, -1);
    }

    #[test]
    fn releasing_an_unknown_generation_is_harmless() {
        assert_eq!(maple_gpu_release_crop_overlay(u64::MAX), 0);
    }
}
