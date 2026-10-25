//! The retargeted HueSatMap on the GPU live WB drag (#5099): params
//! marshalling, real-Metal parity against the CPU chain's own math, and the
//! fixture-gated live-vs-refine seam and slider-tick cost on test_0007.

use super::gpu_live_tests::{make_params, owned_arrays, scene_linear_rgba};
use super::gpu_live_wb_frame_tests::{gpu_render, set_frame, synthetic_frame_with_render_profile};
use super::*;
use raw_core::color::hsm::{HsmEncoding, HsmTable};
use raw_core::image::{ColorSpace, Image};
use raw_core::stages::wb_camera::{HsmRetargetView, SliderFrameExport, WbHsmRetarget};
use raw_core::types::WbMethod;
use raw_core::view::auto_profile::curve::ProfileCurve;
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::AdjustmentModel;

/// An endpoint wire (`WbHsmRetarget::wire` layout) over the synthetic
/// render profile's 2856 K / 6504 K endpoints, with clearly different
/// cold and warm tables.
fn synthetic_hsm_wire() -> Vec<f32> {
    let table = |phase: f32, hue_amp: f32| -> HsmTable {
        let data = (0..12)
            .flat_map(|h| (0..5).map(move |s| (h, s)))
            .flat_map(|(h, s)| {
                let angle = h as f32 / 12.0 * std::f32::consts::TAU + phase;
                let sat = s as f32 / 4.0;
                [
                    hue_amp * angle.sin() * sat,
                    1.0 + 0.2 * angle.cos() * sat,
                    1.0 - 0.05 * angle.sin() * sat,
                ]
            })
            .collect();
        HsmTable::new([12, 5, 1], data, HsmEncoding::Linear).unwrap()
    };
    let (cold, warm) = (table(0.0, 10.0), table(1.4, -8.0));
    [12.0, 5.0, 1.0, 0.0, 2856.0, 6504.0]
        .into_iter()
        .chain(cold.data)
        .chain(warm.data)
        .collect()
}

fn wb_model(target: (f32, f32)) -> AdjustmentModel {
    AdjustmentModel {
        temperature: target.0,
        tint: target.1,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        ..AdjustmentModel::default()
    }
}

fn set_hsm(p: &mut MapleGpuLiveParams, wire: &[f32], as_shot_cct: f32, exposure_gain: f32) {
    p.wb_hsm_ptr = wire.as_ptr();
    p.wb_hsm_len = wire.len();
    p.wb_hsm_as_shot_cct = as_shot_cct;
    p.wb_hsm_exposure_gain = exposure_gain;
}

fn null_auto(p: &mut MapleGpuLiveParams) {
    p.profile_curve_ptr = std::ptr::null();
    p.profile_curve_len = 0;
    p.residual_lut_size = 0;
    p.residual_lut_ptr = std::ptr::null();
    p.residual_lut_len = 0;
}

/// The CPU chain's WB step (with the HueSatMap) + the live view tail +
/// identity Auto artifacts + the shared dither, as `cpu_reference_frame_wb`.
fn cpu_reference(
    input: &[f32],
    (w, h): (u32, u32),
    frame: &SliderFrameExport,
    hsm: Option<HsmRetargetView<'_>>,
    slider: ((f32, f32), (f32, f32)),
) -> Vec<u8> {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (p, c) in img.pixels.iter_mut().zip(input.chunks_exact(4)) {
        *p = [c[0], c[1], c[2]];
    }
    frame.apply_delta_rec2020_with_hsm(&mut img, slider.0, slider.1, hsm);
    display_u8(&img, true)
}

fn display_u8(img: &Image, auto_identity: bool) -> Vec<u8> {
    let mut img = img.clone();
    raw_core::view::agx::apply(&mut img, 0.0, 0.0);
    raw_core::view::encode::rec2020_to_srgb(&mut img);
    raw_core::view::encode::srgb_gamma_encode(&mut img);
    let mut rgb: Vec<f32> = img.pixels.iter().flatten().copied().collect();
    if auto_identity {
        raw_core::view::auto_profile::apply::apply_curve(&mut rgb, &ProfileCurve::identity());
        ColorLut::identity(2).apply(&mut rgb);
    }
    let rgba: Vec<f32> = rgb
        .chunks_exact(3)
        .flat_map(|c| [c[0], c[1], c[2], 1.0])
        .collect();
    raw_gpu::dither_and_quantize(&rgba, img.width as usize, img.height as usize)
}

fn max_byte_delta(a: &[u8], b: &[u8]) -> u8 {
    a.iter()
        .zip(b)
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap_or(0)
}

#[test]
fn hsm_params_reach_the_wb_pass_only_on_a_frame_anchored_drag() {
    let frame = synthetic_frame_with_render_profile();
    let wire = synthetic_hsm_wire();
    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);
    let anchor = (frame.scene_cct, frame.as_shot_tint);
    let params_for = |target: (f32, f32), wire: &[f32]| {
        let model = wb_model(target);
        let arr = owned_arrays(&model, &curve, &lut);
        let mut p = make_params(&[], &model, WbMethod::Cat16, 2, &arr);
        p.decoded_temperature = anchor.0;
        p.decoded_tint = anchor.1;
        set_frame(&mut p, &frame);
        set_hsm(&mut p, wire, frame.scene_cct, 1.3);
        p
    };
    let drag = (anchor.0 + 900.0, anchor.1 - 15.0);

    let p = params_for(drag, &wire);
    let inputs = unsafe { params::inputs_from_params(&p) }.unwrap();
    let hsm = inputs
        .wb_hsm
        .as_ref()
        .expect("a frame-anchored drag carries the HueSatMap");
    let view = HsmRetargetView::from_wire(&wire, frame.scene_cct, 1.3).unwrap();
    let delta = view
        .live_delta(
            &frame,
            frame.rec2020_delta_matrix(drag, anchor),
            drag,
            anchor,
        )
        .unwrap();
    assert_eq!(hsm.tables.as_slice(), view.tables);
    assert_eq!(
        hsm.tables.as_slice().as_ptr(),
        view.tables.as_ptr(),
        "borrowed, not copied"
    );
    assert_eq!(
        (hsm.w_target, hsm.w_anchor),
        (delta.w_target, delta.w_anchor)
    );
    assert_ne!(hsm.w_target, hsm.w_anchor);
    assert_eq!(hsm.delta_pro, delta.delta_pro.0);
    assert_eq!(
        (hsm.to_pro, hsm.from_pro),
        (delta.to_pro.0, delta.from_pro.0),
        "the exposure gain reaches the pass"
    );

    let p = params_for(anchor, &wire);
    assert!(
        unsafe { params::inputs_from_params(&p) }
            .unwrap()
            .wb_hsm
            .is_none(),
        "identity band"
    );

    let mut p = params_for(drag, &wire);
    p.wb_hsm_ptr = std::ptr::null();
    p.wb_hsm_len = 0;
    assert!(
        unsafe { params::inputs_from_params(&p) }
            .unwrap()
            .wb_hsm
            .is_none(),
        "stale host"
    );

    let p = params_for(drag, &wire[..wire.len() - 3]);
    assert!(
        unsafe { params::inputs_from_params(&p) }
            .unwrap()
            .wb_hsm
            .is_none(),
        "malformed wire"
    );

    let mut p = params_for(drag, &wire);
    p.input_shape = 1;
    assert!(
        unsafe { params::inputs_from_params(&p) }
            .unwrap()
            .wb_hsm
            .is_none(),
        "non-RAW input"
    );

    let mut p = params_for(drag, &wire);
    p.decoded_temperature = 0.0;
    assert!(
        unsafe { params::inputs_from_params(&p) }
            .unwrap()
            .wb_hsm
            .is_none(),
        "absolute contract"
    );
}

/// Real Metal: the live chain with the HueSatMap matches the CPU chain's own
/// composition within one display step, and visibly departs from the plain
/// 3×3 — so the kernel is engaged and correct end to end through the FFI.
#[test]
fn gpu_live_hsm_wb_matches_cpu_chain() {
    let (w, h) = (16u32, 16u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let frame = synthetic_frame_with_render_profile();
    let wire = synthetic_hsm_wire();
    let view = HsmRetargetView::from_wire(&wire, frame.scene_cct, 1.6).unwrap();
    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);
    let anchor = (frame.scene_cct, frame.as_shot_tint);

    for target in [(anchor.0 + 900.0, anchor.1 - 15.0), (2400.0, 10.0)] {
        let model = wb_model(target);
        let arr = owned_arrays(&model, &curve, &lut);
        let mut p = make_params(&input, &model, WbMethod::Cat16, 2, &arr);
        p.decoded_temperature = anchor.0;
        p.decoded_tint = anchor.1;
        set_frame(&mut p, &frame);
        set_hsm(&mut p, &wire, frame.scene_cct, 1.6);

        let gpu = gpu_render(&input, w, h, &p);
        let with_hsm = cpu_reference(&input, (w, h), &frame, Some(view), (target, anchor));
        let plain = cpu_reference(&input, (w, h), &frame, None, (target, anchor));
        let parity = max_byte_delta(&gpu, &with_hsm);
        let departure = max_byte_delta(&gpu, &plain);
        eprintln!("{target:?}: GPU vs CPU-with-HSM {parity}, vs plain 3x3 {departure}");
        assert!(
            parity <= 1,
            "{target:?}: GPU vs CPU HueSatMap WB max byte delta {parity}"
        );
        assert!(
            departure >= 3,
            "{target:?}: the HueSatMap must move the render"
        );
    }
}

/// Fixture-gated, real Metal: test_0007's GPU live drag over the as-shot
/// bake vs a fresh develop at the target (the refine), with the HueSatMap
/// carried, and the plain 3×3 it replaces measured on the same cases.
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn gpu_live_vs_refine_seam_carries_the_hsm_on_test_0007() {
    use raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable as render_sized;
    use raw_core::pipeline::RenderQuality;
    use raw_core::CancelToken;

    let path = raw_core::test_support::fixtures::require_raw("test_0007.DNG");
    let raw = raw_core::decode::decode(&path).expect("decode test_0007");
    let exports = crate::scene_linear_f32::wb_exports(&raw);
    let frame = exports.frame;
    let hsm: WbHsmRetarget = exports
        .hsm
        .expect("test_0007 exports its HueSatMap endpoints");
    let anchor = (frame.scene_cct, frame.as_shot_tint);
    // The editor bake leaves WB unseen: the develop resolves as-shot.
    let model_bake = AdjustmentModel {
        temperature_seen: false,
        tint_seen: false,
        ..wb_model(anchor)
    };
    let never = CancelToken::never();
    let (w, h, bake) = render_sized(
        &raw,
        &model_bake,
        RenderQuality::Preview,
        512,
        never.clone(),
    )
    .expect("as-shot bake");
    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);

    // Every case's ceiling: mean ΔE00 0.02, at most 8 pixels past 1 ΔE00,
    // max 13 u8 steps (the CPU chain's own landing, `wb_hsm_live_fixture_tests`).
    let cases = [
        ("warm-500", (anchor.0 + 500.0, anchor.1 + 8.0)),
        ("cool-800", (anchor.0 - 800.0, anchor.1 - 10.0)),
        ("temperature_min", (2000.0, 0.0)),
        ("tungsten", (2850.0, 0.0)),
        ("temperature_max", (50000.0, 0.0)),
    ];
    let mut failures = Vec::new();
    for (name, target) in cases {
        let model = AdjustmentModel {
            temperature_seen: true,
            tint_seen: true,
            ..wb_model(target)
        };
        let (_, _, refine) = render_sized(&raw, &model, RenderQuality::Preview, 512, never.clone())
            .expect("refine develop");
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for (p, c) in img.pixels.iter_mut().zip(refine.chunks_exact(4)) {
            *p = [c[0], c[1], c[2]];
        }
        let refine_u8 = display_u8(&img, false);

        let arr = owned_arrays(&model, &curve, &lut);
        let mut p = make_params(&bake, &model, WbMethod::Cat16, 2, &arr);
        p.decoded_temperature = anchor.0;
        p.decoded_tint = anchor.1;
        null_auto(&mut p);
        set_frame(&mut p, &frame);
        let plain = seam(&gpu_render(&bake, w, h, &p), &refine_u8);
        set_hsm(&mut p, hsm.wire(), hsm.as_shot_cct(), 1.0);
        let live = seam(&gpu_render(&bake, w, h, &p), &refine_u8);
        eprintln!("test_0007 GPU live-vs-refine [{name}] @ {target:?}: HSM {live:?} | plain 3x3 {plain:?}");
        if live.0 > 0.02 || live.1 > 8 || live.2 > 13 {
            failures.push(format!("[{name}] {live:?}"));
        }
    }
    assert!(
        failures.is_empty(),
        "GPU live-vs-refine seam over budget: {failures:?}"
    );
}

/// (mean ΔE00, pixels past 1 ΔE00, max u8 channel step).
fn seam(a: &[u8], b: &[u8]) -> (f32, usize, u8) {
    use raw_core::view::acr_fit::model::{ciede2000, srgb_linear_to_lab};
    let decode = |c: u8| {
        let v = c as f32 / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    let lab = |p: &[u8]| srgb_linear_to_lab([decode(p[0]), decode(p[1]), decode(p[2])]);
    let des: Vec<f32> = a
        .chunks_exact(3)
        .zip(b.chunks_exact(3))
        .map(|(x, y)| ciede2000(lab(x), lab(y)))
        .collect();
    (
        des.iter().sum::<f32>() / des.len() as f32,
        des.iter().filter(|d| **d > 1.0).count(),
        max_byte_delta(a, b),
    )
}

/// Fixture-gated slider-tick cost on test_0007 at a 2560 px long edge (a
/// full-screen canvas): the median `maple_gpu_live_render` of a WB drag
/// with and without the HueSatMap, over one open session. Report plus the
/// 50 ms hard limit (the 16 ms target is read off the printed numbers).
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn wb_drag_tick_cost_with_and_without_hsm_test_0007() {
    use raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable as render_sized;
    use raw_core::pipeline::RenderQuality;
    use raw_core::CancelToken;

    let path = raw_core::test_support::fixtures::require_raw("test_0007.DNG");
    let raw = raw_core::decode::decode(&path).expect("decode test_0007");
    let exports = crate::scene_linear_f32::wb_exports(&raw);
    let frame = exports.frame;
    let hsm = exports.hsm.expect("HueSatMap endpoints");
    let anchor = (frame.scene_cct, frame.as_shot_tint);
    let bake_model = AdjustmentModel {
        temperature_seen: false,
        tint_seen: false,
        ..wb_model(anchor)
    };
    let (w, h, bake) = render_sized(
        &raw,
        &bake_model,
        RenderQuality::Preview,
        2560,
        CancelToken::never(),
    )
    .expect("bake");
    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);

    let mut handle = MapleGpuLiveSession {
        inner: std::ptr::null_mut(),
    };
    assert_eq!(
        unsafe { maple_gpu_live_open(bake.as_ptr(), w, h, &mut handle) },
        0
    );
    let mut out = vec![0u8; (w * h * 3) as usize];
    let median_ms = |with_hsm: bool, out: &mut Vec<u8>| {
        let mut times: Vec<f64> = (0..24)
            .map(|i| {
                let target = (anchor.0 + 200.0 + 40.0 * i as f32, anchor.1);
                let model = wb_model(target);
                let arr = owned_arrays(&model, &curve, &lut);
                let mut p = make_params(&bake, &model, WbMethod::Cat16, 2, &arr);
                p.decoded_temperature = anchor.0;
                p.decoded_tint = anchor.1;
                null_auto(&mut p);
                set_frame(&mut p, &frame);
                if with_hsm {
                    set_hsm(&mut p, hsm.wire(), hsm.as_shot_cct(), 1.0);
                }
                let start = std::time::Instant::now();
                let rc = unsafe { maple_gpu_live_render(&handle, &p, out.as_mut_ptr()) };
                assert_eq!(rc, 0);
                start.elapsed().as_secs_f64() * 1e3
            })
            .skip(4)
            .collect();
        times.sort_by(f64::total_cmp);
        times[times.len() / 2]
    };
    let plain = median_ms(false, &mut out);
    let with_hsm = median_ms(true, &mut out);
    let plain_again = median_ms(false, &mut out);
    unsafe { maple_gpu_live_close(&mut handle) };
    eprintln!(
        "test_0007 WB drag tick @ {w}x{h}: plain 3x3 median {plain:.2} ms / {plain_again:.2} ms, \
         with HueSatMap median {with_hsm:.2} ms"
    );
    assert!(
        with_hsm < 50.0,
        "HueSatMap WB tick {with_hsm:.2} ms breaks the 50 ms hard limit"
    );
}

/// Fixture-gated, end to end through the C ABI: the sized decode exports
/// test_0007's interned HueSatMap wire, the pointer outlives the freed
/// buffer, and the CPU per-tick chain entry carries it into its WB step.
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn decode_exports_the_hsm_wire_and_the_cpu_chain_entry_uses_it_test_0007() {
    use crate::buffers::{maple_free_scene_linear_buffer_f32, MapleSceneLinearBufferF32};
    use crate::scene_linear_chain::MapleAdjustmentParams;

    let path = raw_core::test_support::fixtures::require_raw("test_0007.DNG");
    let raw = raw_core::decode::decode(&path).expect("decode test_0007");
    let expected = crate::scene_linear_f32::wb_exports(&raw)
        .hsm
        .expect("HueSatMap endpoints");
    let path_c = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
    let mut buf = MapleSceneLinearBufferF32::empty();
    let rc = unsafe {
        crate::scene_linear_f32::maple_render_file_scene_linear_sized_f32(
            path_c.as_ptr(),
            std::ptr::null(),
            256,
            1,
            std::ptr::null(),
            &mut buf,
        )
    };
    assert_eq!(rc, 0, "sized decode rc {rc}");
    assert!(!buf.wb_hsm_data.is_null());
    let (wire_ptr, wire_len) = (buf.wb_hsm_data, buf.wb_hsm_len);
    assert_eq!(buf.wb_hsm_as_shot_cct, expected.as_shot_cct());
    let (as_shot_cct, ae_gain) = (buf.wb_hsm_as_shot_cct, buf.ae_gain);
    let (w, h) = (buf.width, buf.height);
    let pixels = unsafe { std::slice::from_raw_parts(buf.f32_rgba, (w * h * 4) as usize) }.to_vec();
    let mut p: MapleAdjustmentParams = unsafe { std::mem::zeroed() };
    p.wb_frame_m_cold = buf.wb_frame_m_cold;
    p.wb_frame_cct_cold = buf.wb_frame_cct_cold;
    p.wb_frame_m_warm = buf.wb_frame_m_warm;
    p.wb_frame_cct_warm = buf.wb_frame_cct_warm;
    p.wb_frame_scene_cct = buf.wb_frame_scene_cct;
    p.wb_frame_as_shot_tint = buf.wb_frame_as_shot_tint;
    p.wb_frame_render_cm = buf.wb_frame_render_cm;
    p.wb_frame_render_forward_matrix = buf.wb_frame_render_forward_matrix;
    p.wb_frame_render_scene_white_xyz = buf.wb_frame_render_scene_white_xyz;
    p.wb_frame_render_wb_already_baked = buf.wb_frame_render_wb_already_baked;
    p.wb_frame_render_cm_cold = buf.wb_frame_render_cm_cold;
    p.wb_frame_render_cct_cold = buf.wb_frame_render_cct_cold;
    p.wb_frame_render_cm_warm = buf.wb_frame_render_cm_warm;
    p.wb_frame_render_cct_warm = buf.wb_frame_render_cct_warm;
    p.wb_frame_render_fm_cold = buf.wb_frame_render_fm_cold;
    p.wb_frame_render_fm_warm = buf.wb_frame_render_fm_warm;
    p.decoded_temperature = buf.wb_frame_scene_cct;
    p.decoded_tint = buf.wb_frame_as_shot_tint;
    p.temperature = 2850.0;
    p.tint = 0.0;
    p.nr_sampling_scale = 1.0;
    unsafe { maple_free_scene_linear_buffer_f32(&mut buf) };

    let wire = unsafe { std::slice::from_raw_parts(wire_ptr, wire_len) };
    assert_eq!(
        wire,
        expected.wire(),
        "the wire stays valid after the buffer is freed"
    );

    let run = |p: &MapleAdjustmentParams| {
        let mut out = vec![0.0f32; pixels.len()];
        let rc = unsafe {
            crate::scene_linear_chain::maple_apply_scene_linear_chain_f32(
                pixels.as_ptr(),
                w,
                h,
                p,
                out.as_mut_ptr(),
            )
        };
        assert_eq!(rc, 0, "chain rc {rc}");
        out
    };
    let plain = run(&p);
    p.wb_hsm_ptr = wire_ptr;
    p.wb_hsm_len = wire_len;
    p.wb_hsm_as_shot_cct = as_shot_cct;
    p.wb_hsm_exposure_gain = ae_gain;
    let inputs = unsafe { crate::scene_linear_chain::chain_inputs_from_params(&p) }.unwrap();
    let view = inputs.wb_hsm.expect("the chain entry reads the wire");
    assert_eq!(
        view.tables.as_ptr(),
        wire[wire.len() - view.tables.len()..].as_ptr()
    );
    let with_hsm = run(&p);
    let moved = plain
        .iter()
        .zip(&with_hsm)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f32, f32::max);
    assert!(
        moved > 2e-3,
        "the HueSatMap must move the CPU chain's render ({moved})"
    );
}
