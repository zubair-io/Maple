//! `LiveSession`'s double-buffered scope readback (#3272): one tick late,
//! never blocking, matching the CPU histogram of the frame it actually
//! sampled. Split out of `tests.rs` (600-LOC budget); reuses `super::limits`
//! (`pub(super)` there) the same way the parent file's own tests do.

use super::*;
use crate::full_chain::oracle::{identity_curve, identity_lut, scene_linear_rgba, Case};
use crate::{CancelToken, GpuContext, ScopeRequest};
use raw_core::scope::vectorscope_histogram_rgba;
use raw_core::types::adjustment::AutoExposureMode;
use raw_core::types::WbMethod;
use raw_core::xmp::AdjustmentModel;

/// A case with a couple of sliders past their thresholds — enough that the
/// chain isn't a bare view-tail passthrough, without needing to reach for
/// `full_chain::tests::tests_cases`'s `pub(super)` (not reachable from here).
fn scope_test_case() -> Case {
    let model = AdjustmentModel {
        exposure: 0.3,
        contrast: 10.0,
        vibrance: 15.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };
    Case {
        model,
        capture: None,
        curve: identity_curve(),
        lut: identity_lut(9),
        wb_method: WbMethod::Cat16,
        film_lut: None,
        film_strength: 0.0,
    }
}

/// Copy `src` (a ping-pong buffer — `STORAGE | COPY_SRC | COPY_DST`, no
/// `MAP_READ`) into a fresh staging buffer and map THAT, since a ping-pong
/// buffer can't be mapped directly. Mirrors what `dehaze_split.rs` already
/// does for the airlight fallback's mid-chain readback.
fn read_f32_buffer(ctx: &GpuContext, src: &wgpu::Buffer, byte_len: u64) -> Vec<f32> {
    let staging = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("scope-test-readback-staging"),
        size: byte_len,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("scope-test-readback-encoder"),
        });
    encoder.copy_buffer_to_buffer(src, 0, &staging, 0, byte_len);
    ctx.queue.submit(Some(encoder.finish()));
    pollster::block_on(limits::map_f32_readback(ctx, &staging)).expect("readback map")
}

#[test]
fn scope_stats_arrive_one_tick_late_and_match_the_cpu_histogram_of_the_presented_frame() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (32u32, 24u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let session = LiveSession::new(&ctx, &input, w, h).expect("session");
    let mut inputs = scope_test_case().gpu_inputs();
    inputs.scope = ScopeRequest {
        layer: -1,
        enabled: true,
    };
    let cancel = CancelToken::new();
    let byte_len = (w as u64) * (h as u64) * 4 * std::mem::size_of::<f32>() as u64;

    // Tick 1: nothing to take yet (no previous tick's map could have landed).
    let idx1 = session
        .render_chain_to_f32(&ctx, &inputs, &cancel)
        .unwrap()
        .unwrap();
    assert!(session.take_scope_stats(&ctx).is_none());

    // Oracle: read tick 1's f32 buffer back NOW, before tick 2 overwrites the
    // OTHER ping-pong slot and potentially reuses this one on a future tick.
    let frame1 = read_f32_buffer(&ctx, session.ping_pong_buffer(idx1), byte_len);

    // Tick 2: the stats of tick 1 are ready. `take_scope_stats` only POLLS
    // (never blocks — the live path can't stall a render on a readback), so
    // whether tick 1's async map has actually completed by the time we ask
    // is a real GPU-timing race, not something either side controls. A
    // deliberate BLOCKING wait here (unlike the non-blocking contract the
    // real API keeps) is what makes the test itself deterministic.
    let _ = session
        .render_chain_to_f32(&ctx, &inputs, &cancel)
        .unwrap()
        .unwrap();
    ctx.device.poll(wgpu::Maintain::Wait);
    let stats = session.take_scope_stats(&ctx).expect("tick-1 stats");
    assert_eq!(stats.frame, 1);

    let want = vectorscope_histogram_rgba(&frame1, false);
    assert_eq!(stats.total, want.total, "whole-frame weight: no alpha lane");
    let l1: u64 = stats
        .bins
        .iter()
        .zip(&want.bins)
        .map(|(a, b)| (*a as i64 - *b as i64).unsigned_abs())
        .sum();
    assert!(
        (l1 as f32 / want.total.max(1) as f32) < 0.005,
        "bins drift beyond boundary-rounding tolerance"
    );
}

/// `render_to_buffer` (the u8-readback family `maple_gpu_live_render` calls,
/// distinct from the f32-resident `render_chain_to_f32` family the test
/// above drives) shares the exact same `encode_scope` / `scope_after_submit`
/// hooks — this only re-proves the WIRING reaches this family too, not the
/// readback mechanism itself (already proven above).
///
/// Deliberately does NOT cross-check `stats.bins` against a CPU histogram of
/// this render's OWN dithered u8 output the way the sibling test above does
/// against a raw f32 readback: the scope pass samples the chain's F32 buffer
/// BEFORE dither, by design (`render_single` encodes the scope pass ahead of
/// `encode_dither`, both reading the same buffer) — that is what makes the
/// scope MORE precise than the presented pixels, not a discrepancy to
/// tolerate. Measured while diagnosing this test: even a smooth synthetic
/// gradient with every per-pixel channel delta under 0.004 (squarely inside
/// ordinary ±0.5-LSB dither noise) can put 10-40% of the total bin weight in
/// a different 1/128-wide Cb/Cr bin after quantization, because a cluster of
/// pixels that starts near a shared bin boundary in high precision crosses
/// it together in 8-bit. That is not a bug in either side — it is why a
/// dithered-and-requantized reconstruction is not a valid oracle for a
/// vectorscope histogram, only a full-precision readback is.
#[test]
fn render_to_buffer_also_produces_scope_stats() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (16u32, 12u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let session = LiveSession::new(&ctx, &input, w, h).expect("session");
    let mut inputs = scope_test_case().gpu_inputs();
    inputs.scope = ScopeRequest {
        layer: -1,
        enabled: true,
    };
    let cancel = CancelToken::new();

    session.render_to_buffer(&ctx, &inputs, &cancel).unwrap();
    assert!(session.take_scope_stats(&ctx).is_none());
    session.render_to_buffer(&ctx, &inputs, &cancel).unwrap();
    ctx.device.poll(wgpu::Maintain::Wait);
    let stats = session.take_scope_stats(&ctx).expect("tick-1 stats");
    assert_eq!(stats.frame, 1);
    assert!(stats.total > 0);
}

#[test]
fn scope_disabled_never_produces_stats() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (16u32, 12u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let session = LiveSession::new(&ctx, &input, w, h).expect("session");
    let inputs = scope_test_case().gpu_inputs(); // scope left at ScopeRequest::default() — disabled
    let cancel = CancelToken::new();
    for _ in 0..3 {
        session.render_chain_to_f32(&ctx, &inputs, &cancel).unwrap();
        assert!(session.take_scope_stats(&ctx).is_none());
    }
}

/// A half-sized image covers the center quarter of the canvas. Geometry must
/// move the bitmap's scope weights with its pixels, leaving zero mask weight
/// in uncovered black borders. Whole-frame scope still counts those borders.
#[test]
fn geometry_scope_excludes_uncovered_pixels_from_bitmap_weight() {
    use crate::local_adjustments::GpuMaskRaster;
    use raw_core::stages::geometry::Geometry;
    use raw_core::types::{layers_to_flat, LocalAdjustment, Mask, PartialAdjustments};

    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (32u32, 24u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let session = LiveSession::new(&ctx, &input, w, h).expect("session");
    let mut inputs = scope_test_case().gpu_inputs();
    inputs.geometry_inverse = Some(
        Geometry {
            scale: 0.5,
            ..Geometry::default()
        }
        .forward(w, h)
        .unwrap()
        .inverse()
        .unwrap()
        .0,
    );
    inputs.local_adjustments = layers_to_flat(&[LocalAdjustment {
        mask: Mask::Bitmap {
            recipe: Default::default(),
            raster_id: 7,
        },
        range: None,
        adjustments: PartialAdjustments::default(),
    }]);
    let weight = 128.0 / 255.0;
    inputs.mask_rasters = vec![GpuMaskRaster {
        id: 7,
        width: 2,
        height: 2,
        data: vec![weight; 4],
    }];
    let byte_len = u64::from(w * h) * 4 * std::mem::size_of::<f32>() as u64;
    let cancel = CancelToken::new();
    let mut selected_rgb = None;
    for layer in [0, -1] {
        inputs.scope = ScopeRequest {
            layer,
            enabled: true,
        };
        let index = session
            .render_chain_to_f32(&ctx, &inputs, &cancel)
            .unwrap()
            .unwrap();
        let frame = read_f32_buffer(&ctx, session.ping_pong_buffer(index), byte_len);
        for (index, pixel) in frame.chunks_exact(4).enumerate() {
            let x = index as u32 % w;
            let y = index as u32 / w;
            let covered = (w / 4..3 * w / 4).contains(&x) && (h / 4..3 * h / 4).contains(&y);
            let expected_alpha = if !covered {
                assert_eq!(&pixel[..3], &[0.0; 3], "uncovered pixels stay black");
                0.0
            } else if layer == 0 {
                weight
            } else {
                1.0
            };
            assert!((pixel[3] - expected_alpha).abs() < 1e-6);
        }
        let rgb: Vec<f32> = frame
            .chunks_exact(4)
            .flat_map(|pixel| &pixel[..3])
            .copied()
            .collect();
        if let Some(expected) = &selected_rgb {
            assert_eq!(
                &rgb, expected,
                "scope selection must not change rendered RGB"
            );
        } else {
            selected_rgb = Some(rgb);
        }
        session.render_chain_to_f32(&ctx, &inputs, &cancel).unwrap();
        ctx.device.poll(wgpu::Maintain::Wait);
        let stats = session.take_scope_stats(&ctx).expect("previous tick scope");
        let expected_total = if layer == 0 {
            w * h / 4 * 128
        } else {
            w * h * 255
        };
        assert_eq!(stats.total, expected_total);
    }
}
