use super::*;
use crate::{
    buffers::{
        maple_free_scene_linear_buffer, maple_free_scene_linear_buffer_f32, MapleSceneLinearBuffer,
        MapleSceneLinearBufferF32,
    },
    handle::{
        maple_close_raw_handle, maple_render_handle_scene_linear_tile,
        maple_render_handle_scene_linear_tile_ae_f32, MapleRawHandle,
    },
};
use raw_core::{test_support::synth_chart::SyntheticColorChart, xmp::AutoExposureMode};

struct OwnedHandle(*mut MapleRawHandle);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe { maple_close_raw_handle(self.0) };
    }
}
fn handle(auto_ca: bool) -> OwnedHandle {
    let bytes = SyntheticColorChart {
        patch_size: 80,
        guard: 8,
        ..Default::default()
    }
    .write_to_bytes();
    let mut raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
    // Real synthetic Bayer photosites, including a clipped red region whose
    // recovery consumes the frame scene prior rather than a viewport prior.
    for y in 100..200 {
        for x in 180..260 {
            if raw.cfa.color_at(x, y) == 0 {
                raw.raw_data[(y * raw.width + x) as usize] = raw.white_level as u16;
            }
        }
    }
    let model = AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        auto_lateral_ca: if auto_ca {
            raw_core::types::adjustment::AutoLateralCa::On
        } else {
            raw_core::types::adjustment::AutoLateralCa::Off
        },
        ..Default::default()
    };
    let original = raw_core::types::accepted_removal::ContentDigest::for_bytes(&[]);
    let inner = Box::new(MapleRawHandleInner::new(raw, model, original));
    OwnedHandle(Box::into_raw(Box::new(MapleRawHandle {
        inner: Box::into_raw(inner).cast(),
    })))
}
fn inner(handle: &OwnedHandle) -> &MapleRawHandleInner {
    unsafe { &*((*handle.0).inner as *const MapleRawHandleInner) }
}
fn rect(x: u32) -> TileRect {
    TileRect {
        src_x: x,
        src_y: 117,
        src_w: 101,
        src_h: 101,
        out_w: 101,
        out_h: 101,
    }
}
fn fp16(handle: &OwnedHandle, rect: TileRect, preview: i32) -> Vec<u16> {
    let mut buffer: MapleSceneLinearBuffer = unsafe { std::mem::zeroed() };
    let rc = unsafe {
        maple_render_handle_scene_linear_tile(
            handle.0,
            rect.src_x,
            rect.src_y,
            rect.src_w,
            rect.src_h,
            rect.out_w,
            rect.out_h,
            preview,
            0.0,
            0.0,
            &mut buffer,
        )
    };
    assert_eq!(rc, 0);
    let pixels =
        unsafe { std::slice::from_raw_parts(buffer.fp16_rgba, buffer.len_bytes / 2) }.to_vec();
    unsafe { maple_free_scene_linear_buffer(&mut buffer) };
    pixels
}
fn f32_tile(handle: &OwnedHandle, rect: TileRect, preview: i32) -> (i32, Vec<f32>) {
    let mut buffer = MapleSceneLinearBufferF32::empty();
    let rc = unsafe {
        maple_render_handle_scene_linear_tile_ae_f32(
            handle.0,
            rect.src_x,
            rect.src_y,
            rect.src_w,
            rect.src_h,
            rect.out_w,
            rect.out_h,
            preview,
            0.0,
            0.0,
            1.25,
            &mut buffer,
        )
    };
    let pixels = if rc == 0 {
        unsafe { std::slice::from_raw_parts(buffer.f32_rgba, buffer.len_bytes / 4) }.to_vec()
    } else {
        Vec::new()
    };
    unsafe { maple_free_scene_linear_buffer_f32(&mut buffer) };
    (rc, pixels)
}

#[test]
fn retained_handle_reuses_context_across_both_packing_routes_and_pans() {
    let handle = handle(false);
    let context = inner(&handle)
        .frame_context(RenderQuality::Full)
        .unwrap()
        .unwrap();
    for x in [133, 181, 205] {
        let rect = rect(x);
        let (rc, actual) = f32_tile(&handle, rect, 0);
        assert_eq!(rc, 0);
        let (_, _, expected) =
            pipeline::render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_and_ae_gain_f32(
                &inner(&handle).raw,
                &inner(&handle).model,
                rect,
                RenderQuality::Full,
                None,
                1.25,
            )
            .unwrap();
        assert_eq!(
            actual.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            expected.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
        );
        let (_, _, expected) =
            pipeline::render_scene_linear_tile_from_raw_with_quality_and_wb_anchor(
                &inner(&handle).raw,
                &inner(&handle).model,
                rect,
                RenderQuality::Full,
                None,
            )
            .unwrap();
        assert_eq!(fp16(&handle, rect, 0), expected);
        assert!(Arc::ptr_eq(
            &context,
            &inner(&handle)
                .frame_context(RenderQuality::Full)
                .unwrap()
                .unwrap()
        ));
    }
}

#[test]
fn retained_handle_quality_switch_preserves_legacy_nonzero_preview_mapping() {
    let handle = handle(false);
    let old = inner(&handle)
        .frame_context(RenderQuality::Full)
        .unwrap()
        .unwrap();
    let old_weak = Arc::downgrade(&old);
    drop(old);
    // Legacy C callers treat any nonzero value as Preview, including 2.
    let actual = fp16(&handle, rect(133), 2);
    let (_, _, expected) = pipeline::render_scene_linear_tile_from_raw_with_quality_and_wb_anchor(
        &inner(&handle).raw,
        &inner(&handle).model,
        rect(133),
        RenderQuality::Preview,
        None,
    )
    .unwrap();
    assert_eq!(actual, expected);
    assert!(old_weak.upgrade().is_none());
    let preview = inner(&handle)
        .frame_context(RenderQuality::Preview)
        .unwrap()
        .unwrap();
    assert_eq!(preview.quality(), RenderQuality::Preview);
}

#[test]
fn retained_handle_invalid_request_recovers_and_source_retires_with_context() {
    let handle = handle(false);
    let raw = Arc::downgrade(&inner(&handle).raw);
    let context = inner(&handle)
        .frame_context(RenderQuality::Full)
        .unwrap()
        .unwrap();
    assert_eq!(
        f32_tile(
            &handle,
            TileRect {
                src_x: u32::MAX,
                ..rect(133)
            },
            0
        )
        .0,
        9
    );
    assert_eq!(f32_tile(&handle, rect(133), 0).0, 0);
    assert!(Arc::ptr_eq(
        &context,
        &inner(&handle)
            .frame_context(RenderQuality::Full)
            .unwrap()
            .unwrap()
    ));
    drop(handle);
    assert!(raw.upgrade().is_some(), "active context owns the source");
    drop(context);
    assert!(
        raw.upgrade().is_none(),
        "retired context must release the source"
    );
}

#[test]
fn retained_handle_preserves_automatic_lateral_ca_fallback_error() {
    let handle = handle(true);
    assert!(inner(&handle)
        .frame_context(RenderQuality::Full)
        .unwrap()
        .is_none());
    assert_eq!(f32_tile(&handle, rect(133), 0).0, 10);
    assert!(inner(&handle).frame.0.lock().unwrap().is_none());
}
