//! The capture-first live chain through the FFI (#5377): a capture result
//! and its `MapleCaptureCreative` rendered by `maple_gpu_live_render` match
//! the CPU creative stage and the CPU per-tick chain, a white-balance drag
//! allocates no GPU resource after its first tick, and deriving a tick's plan
//! allocates no host memory.

use super::gpu_live_tests::{make_params, owned_arrays};
use super::gpu_live_wb_frame_tests::gpu_render;
use super::*;
use crate::capture_creative::MapleCaptureCreative;
use raw_core::image::{ColorSpace, Image};
use raw_core::pipeline::CreativeStage;
use raw_core::test_support::creative::{creative_stage, fallback_stage, Tables};
use raw_core::types::WbMethod;
use raw_core::view::auto_profile::curve::ProfileCurve;
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::{AdjustmentModel, HighlightRecoveryMode};

/// A signed, out-of-gamut and HDR capture result, as the capture stages
/// leave it in the as-shot basis.
pub(super) fn capture_rgba(w: u32, h: u32) -> Vec<f32> {
    (0..w * h)
        .flat_map(|i| {
            let t = i as f32 / (w * h) as f32;
            let level = 0.02 + 1.3 * t;
            let mut p = [
                level * (0.4 + 0.6 * (i as f32 * 0.37).sin().abs()),
                level * (0.3 + 0.7 * (i as f32 * 0.21).cos().abs()),
                level * (0.2 + 0.8 * (i as f32 * 0.53).sin().abs()),
            ];
            if i % 7 == 0 {
                p[(i % 3) as usize] = -0.03;
            }
            if i % 11 == 0 {
                p = p.map(|v| v * 5.0);
            }
            [p[0], p[1], p[2], 1.0]
        })
        .collect()
}

pub(super) fn neutral_tail(temperature: f32, tint: f32) -> AdjustmentModel {
    AdjustmentModel {
        temperature,
        tint,
        temperature_seen: true,
        tint_seen: true,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        ..AdjustmentModel::default()
    }
}

pub(super) fn no_auto_profile(p: &mut MapleGpuLiveParams) {
    p.profile_curve_ptr = std::ptr::null();
    p.profile_curve_len = 0;
    p.residual_lut_size = 0;
    p.residual_lut_ptr = std::ptr::null();
    p.residual_lut_len = 0;
}

/// The CPU view tail the live chain runs at a neutral model, then the
/// terminal dither.
pub(super) fn view_u8(mut img: Image) -> Vec<u8> {
    raw_core::view::agx::apply(&mut img, 0.0, 0.0);
    raw_core::view::encode::rec2020_to_srgb(&mut img);
    raw_core::view::encode::srgb_gamma_encode(&mut img);
    let rgba: Vec<f32> = img
        .pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], 1.0])
        .collect();
    raw_gpu::dither_and_quantize(&rgba, img.width as usize, img.height as usize)
}

pub(super) fn image_of(rgba: &[f32], w: u32, h: u32) -> Image {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (p, px) in img.pixels.iter_mut().zip(rgba.chunks_exact(4)) {
        *p = [px[0], px[1], px[2]];
    }
    img
}

pub(super) fn max_step(a: &[u8], b: &[u8]) -> u8 {
    a.iter()
        .zip(b)
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap_or(0)
}

fn flat_creative(stage: &CreativeStage, recovery: HighlightRecoveryMode) -> MapleCaptureCreative {
    let (header, wire) = stage.transport(recovery).unwrap();
    MapleCaptureCreative::new(
        &header,
        crate::wb_frame_flat::intern_table_wire(wire.floats()),
    )
}

/// The slider pairs a drag visits: the as-shot point and both sides of it.
fn white_balances(stage: &CreativeStage) -> Vec<(f32, f32)> {
    let as_shot = stage
        .frame
        .as_ref()
        .map_or((6500.0, 0.0), |f| (f.scene_cct, f.scene_tint));
    vec![
        as_shot,
        (as_shot.0 + 800.0, as_shot.1),
        (as_shot.0 - 800.0, as_shot.1),
        (2000.0, 12.0),
        (50000.0, -9.0),
    ]
}

#[test]
fn the_live_chain_renders_the_creative_stage_of_a_capture_decode() {
    let (w, h) = (24u32, 16u32);
    let input = capture_rgba(w, h);
    let (curve, lut) = (ProfileCurve::identity(), ColorLut::identity(2));
    for (stage, recovery) in [
        (
            creative_stage(Tables::DualHueSatMapAndLook, 1.6),
            HighlightRecoveryMode::OklabChromaReduction,
        ),
        (
            creative_stage(Tables::DualHueSatMap { srgb: false }, 1.0),
            HighlightRecoveryMode::Off,
        ),
        (
            fallback_stage(Tables::SingleHueSatMap, 0.8),
            HighlightRecoveryMode::Off,
        ),
    ] {
        let creative = flat_creative(&stage, recovery);
        for (temperature, tint) in white_balances(&stage) {
            let model = AdjustmentModel {
                highlight_recovery: recovery,
                ..neutral_tail(temperature, tint)
            };
            let (cpu, _) = stage.render_basis(image_of(&input, w, h), &model).unwrap();
            let arr = owned_arrays(&model, &curve, &lut);
            let mut p = make_params(&input, &model, WbMethod::Cat16, 2, &arr);
            no_auto_profile(&mut p);
            p.creative_ptr = &creative;
            let live = gpu_render(&input, w, h, &p);
            let step = max_step(&live, &view_u8(cpu));
            assert!(step <= 1, "T={temperature} tint={tint}: {step} steps");
        }
    }
}

#[test]
fn the_cpu_chain_renders_the_same_creative_stage() {
    let (w, h) = (24u32, 16u32);
    let input = capture_rgba(w, h);
    let stage = creative_stage(Tables::DualHueSatMapAndLook, 1.3);
    let creative = flat_creative(&stage, HighlightRecoveryMode::OklabChromaReduction);
    for (temperature, tint) in white_balances(&stage) {
        let model = AdjustmentModel {
            highlight_recovery: HighlightRecoveryMode::OklabChromaReduction,
            ..neutral_tail(temperature, tint)
        };
        let (want, _) = stage.render_basis(image_of(&input, w, h), &model).unwrap();
        let p = crate::scene_linear_chain::MapleAdjustmentParams {
            temperature,
            tint,
            skip_agx: 1,
            creative_ptr: &creative,
            ..crate::scene_linear_chain_tests::default_params()
        };
        let mut out = vec![0.0f32; input.len()];
        let rc = unsafe {
            crate::scene_linear_chain::maple_apply_scene_linear_chain_f32(
                input.as_ptr(),
                w,
                h,
                &p,
                out.as_mut_ptr(),
            )
        };
        assert_eq!(rc, 0);
        for (i, px) in want.pixels.iter().enumerate() {
            assert_eq!(&out[i * 4..i * 4 + 3], px, "pixel {i} at T={temperature}");
        }
    }
}

#[test]
fn a_white_balance_drag_allocates_no_gpu_resource_after_its_first_tick() {
    let (w, h) = (32u32, 24u32);
    let input = capture_rgba(w, h);
    let stage = creative_stage(Tables::DualHueSatMapAndLook, 1.2);
    let creative = flat_creative(&stage, HighlightRecoveryMode::OklabChromaReduction);
    let mut handle = MapleGpuLiveSession {
        inner: std::ptr::null_mut(),
    };
    assert_eq!(
        unsafe { maple_gpu_live_open(input.as_ptr(), w, h, &mut handle) },
        0
    );
    let (curve, lut) = (ProfileCurve::identity(), ColorLut::identity(2));
    // The pool counter is the process-wide context's, so the drag holds the
    // context for its whole length: no concurrent test can allocate inside it.
    let shared = lock_shared();
    let ctx = &shared.as_ref().expect("opened above").ctx;
    let session = &unsafe { &*(handle.inner as *const LiveHandleInner) }.session;
    let tick = |temperature: f32, tint: f32| {
        let model = AdjustmentModel {
            highlight_recovery: HighlightRecoveryMode::OklabChromaReduction,
            ..neutral_tail(temperature, tint)
        };
        let arr = owned_arrays(&model, &curve, &lut);
        let mut p = make_params(&input, &model, WbMethod::Cat16, 2, &arr);
        no_auto_profile(&mut p);
        p.creative_ptr = &creative;
        let inputs = unsafe { params::inputs_from_params(&p) }.expect("capture inputs");
        session
            .render_to_buffer(ctx, &inputs, &raw_gpu::CancelToken::new())
            .expect("render")
            .expect("not cancelled")
    };
    let first = tick(5200.0, 4.0);
    let warm = session.pool_alloc_count(ctx);
    let frames: Vec<_> = [3300.0, 4100.0, 9000.0, 2000.0, 50000.0]
        .iter()
        .map(|&t| tick(t, 6.0))
        .collect();
    assert_eq!(
        session.pool_alloc_count(ctx),
        warm,
        "a white-balance tick allocated"
    );
    assert_ne!(frames[0], first, "a white-balance tick must move pixels");
    assert_eq!(tick(5200.0, 4.0), first);
    drop(shared);
    unsafe { maple_gpu_live_close(&mut handle) };
}
