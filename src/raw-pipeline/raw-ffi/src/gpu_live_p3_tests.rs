//! P3 target-primaries FFI parity (#1337) + ancillary GPU entry guards, split
//! from `gpu_live_tests.rs` (600-LOC file budget — same pattern as the
//! `gpu_live_airlight_tests.rs` dehaze split).
//!
//! Tests here cover:
//!   - `target_primaries = 1` (Display P3) marshaling through the C ABI.
//!   - Null-pointer / dimension guards on `maple_gpu_live_open`.
//!   - Panic containment barrier (`catch_panic_rc`, #1079).

use super::gpu_live_tests::{
    direct_raw_gpu, make_params, nonidentity_curve, nonidentity_lut, owned_arrays,
    scene_linear_rgba,
};
use super::*;
use raw_core::types::WbMethod;
use raw_core::xmp::AdjustmentModel;

/// DISPLAY P3 FFI PARITY GATE (#1337): when `target_primaries = 1` (Display P3)
/// is set in `MapleGpuLiveParams`, the C-ABI output must be byte-identical to a
/// direct `raw_gpu::LiveSession` render built with `target_primaries: 1` in
/// `FullChainInputs` — confirming the field is marshaled through the params struct
/// and wired into `live_chain` correctly.
///
/// Uses a mild default model (dehaze off — module doc in `gpu_live_tests.rs`).
/// The sRGB vs P3 primaries diverge on saturated Rec.2020 content; the
/// `scene_linear_rgba` fixture includes a saturated primary every 11 px, so the
/// marshaling gate is non-trivial.
#[test]
fn gpu_live_render_p3_primaries_marshals_correctly() {
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let lut_size = 9usize;
    let curve = nonidentity_curve();
    let lut = nonidentity_lut(lut_size);

    let model = AdjustmentModel {
        temperature: 6000.0,
        tint: 3.0,
        exposure: 0.1,
        brightness: 8.0,
        contrast: 8.0,
        highlights: -5.0,
        shadows: 5.0,
        vibrance: 6.0,
        saturation: 5.0,
        sharpen_amount: 50.0,
        sharpen_radius: 1.0,
        sharpen_detail: 25.0,
        nr_color: 15.0,
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };

    let arr = owned_arrays(&model, &curve, &lut);
    // Override target_primaries to 1 (Display P3).
    let mut params = make_params(&model, WbMethod::Cat16, lut_size, &arr);
    params.target_primaries = 1;

    let mut handle = MapleGpuLiveSession {
        inner: std::ptr::null_mut(),
    };
    let rc = unsafe { maple_gpu_live_open(input.as_ptr(), w, h, &mut handle) };
    assert_eq!(rc, 0, "gpu_live_open rc {rc}");

    let mut out = vec![0u8; (w * h * 3) as usize];
    let rc = unsafe { maple_gpu_live_render(&handle, &params, out.as_mut_ptr()) };
    assert_eq!(rc, 0, "gpu_live_render rc {rc}");
    unsafe { maple_gpu_live_close(&mut handle) };

    // MARSHALING gate (byte-exact): the FFI output with P3 must match a DIRECT
    // `raw_gpu::LiveSession` render with `target_primaries: 1` — the only
    // difference is the C-ABI round-trip, not the primaries selector.
    let direct = {
        use raw_core::types::ToneCurveMode;
        use raw_gpu::{CurveMode, FullChainInputs, GpuContext, LiveSession, ToneCurveInputs};
        let wb_matrix =
            raw_core::stages::white_balance::wb_cat16_matrix(model.temperature, model.tint).0;
        let inputs = FullChainInputs {
            wb_matrix,
            wb_temperature: model.temperature,
            wb_tint: model.tint,
            tone: [
                model.exposure,
                model.brightness,
                model.highlights,
                model.shadows,
                model.whites,
                model.blacks,
            ],
            tone_curves: ToneCurveInputs {
                parametric: [
                    model.parametric_shadows,
                    model.parametric_darks,
                    model.parametric_lights,
                    model.parametric_highlights,
                ],
                luma: model.tone_curve_luma.points.clone(),
                red: model.tone_curve_red.points.clone(),
                green: model.tone_curve_green.points.clone(),
                blue: model.tone_curve_blue.points.clone(),
                mode: match model.tone_curve_mode {
                    ToneCurveMode::RatioPreserving => CurveMode::RatioPreserving,
                    ToneCurveMode::PerChannel => CurveMode::PerChannel,
                },
            },
            vibrance: model.vibrance,
            saturation: model.saturation,
            hsl_hue: [
                model.hue_adjustment_red,
                model.hue_adjustment_orange,
                model.hue_adjustment_yellow,
                model.hue_adjustment_green,
                model.hue_adjustment_aqua,
                model.hue_adjustment_blue,
                model.hue_adjustment_purple,
                model.hue_adjustment_magenta,
            ],
            hsl_sat: [
                model.saturation_adjustment_red,
                model.saturation_adjustment_orange,
                model.saturation_adjustment_yellow,
                model.saturation_adjustment_green,
                model.saturation_adjustment_aqua,
                model.saturation_adjustment_blue,
                model.saturation_adjustment_purple,
                model.saturation_adjustment_magenta,
            ],
            hsl_lum: [
                model.luminance_adjustment_red,
                model.luminance_adjustment_orange,
                model.luminance_adjustment_yellow,
                model.luminance_adjustment_green,
                model.luminance_adjustment_aqua,
                model.luminance_adjustment_blue,
                model.luminance_adjustment_purple,
                model.luminance_adjustment_magenta,
            ],
            // Black & white mix (#276) — same band order.
            bw_mix: [
                model.gray_mixer_red,
                model.gray_mixer_orange,
                model.gray_mixer_yellow,
                model.gray_mixer_green,
                model.gray_mixer_aqua,
                model.gray_mixer_blue,
                model.gray_mixer_purple,
                model.gray_mixer_magenta,
            ],
            bw_active: model.black_white == raw_core::types::BlackWhiteMode::On,
            clarity: model.clarity,
            texture: model.texture,
            dehaze: model.dehaze,
            local_adjustments: raw_core::types::layers_to_flat(&model.local_adjustments),
            vignette_amount: model.vignette_amount,
            vignette_feather: model.vignette_feather,
            grain_amount: model.grain_amount,
            grain_size: model.grain_size,
            grain_roughness: model.grain_roughness,
            split_tone_shadow_hue: model.split_tone_shadow_hue,
            split_tone_shadow_saturation: model.split_tone_shadow_saturation,
            split_tone_highlight_hue: model.split_tone_highlight_hue,
            split_tone_highlight_saturation: model.split_tone_highlight_saturation,
            split_tone_balance: model.split_tone_balance,
            color_grade_shadow_luminance: model.color_grade_shadow_luminance,
            color_grade_midtone_hue: model.color_grade_midtone_hue,
            color_grade_midtone_saturation: model.color_grade_midtone_saturation,
            color_grade_midtone_luminance: model.color_grade_midtone_luminance,
            color_grade_highlight_luminance: model.color_grade_highlight_luminance,
            color_grade_global_hue: model.color_grade_global_hue,
            color_grade_global_saturation: model.color_grade_global_saturation,
            color_grade_global_luminance: model.color_grade_global_luminance,
            sharpen_amount: model.sharpen_amount,
            sharpen_radius: model.sharpen_radius,
            sharpen_detail: model.sharpen_detail,
            sharpen_masking: model.sharpen_masking,
            nr_luminance: model.nr_luminance,
            nr_color: model.nr_color,
            contrast: model.contrast,
            capture_sharpening: None,
            profile_curve_flat: curve.to_flat(),
            residual_lut_size: lut.size,
            residual_lut_data: lut.data.clone(),
            // Display P3 (#1337).
            target_primaries: 1,
            input_shape: raw_gpu::InputShape::PostDcpRec2020Fp16,
            // Auto/AgX view tail (#1722 default, value 0).
            profile_id: 0,
        };
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let session = LiveSession::new(&ctx, &input, w, h).expect("session");
        let cancel = raw_gpu::CancelToken::new();
        session
            .render_to_buffer(&ctx, &inputs, &cancel)
            .expect("direct P3 render ok")
            .expect("direct P3 render returns Some")
    };

    let marshal_mismatches = out.iter().zip(&direct).filter(|(a, b)| a != b).count();
    assert_eq!(
        marshal_mismatches, 0,
        "P3 FFI output differs from direct raw_gpu::LiveSession (target_primaries=1) in \
         {marshal_mismatches} bytes — C-ABI marshaling of target_primaries diverges"
    );

    // Sanity: P3 and sRGB renders must differ on this fixture (has saturated
    // primaries every 11 px). If they're identical, the field is being silently
    // dropped somewhere in the chain.
    let srgb_direct = direct_raw_gpu(&input, w, h, &model, WbMethod::Cat16, &curve, &lut);
    let p3_vs_srgb_diff = out.iter().zip(&srgb_direct).filter(|(a, b)| a != b).count();
    assert!(
        p3_vs_srgb_diff > 0,
        "P3 render byte-identical to sRGB render — target_primaries=1 is not being applied"
    );
}

/// Null-pointer / dimension guards on the open entry.
#[test]
fn gpu_live_open_rejects_bad_args() {
    let mut handle = MapleGpuLiveSession {
        inner: std::ptr::null_mut(),
    };
    // null handle_out.
    assert_eq!(
        unsafe { maple_gpu_live_open(std::ptr::null(), 8, 8, std::ptr::null_mut()) },
        -1
    );
    // null pixels.
    assert_eq!(
        unsafe { maple_gpu_live_open(std::ptr::null(), 8, 8, &mut handle) },
        -2
    );
    assert!(handle.inner.is_null(), "handle must be null on error");
    // zero dimension.
    let px = vec![0.0f32; 4];
    assert_eq!(
        unsafe { maple_gpu_live_open(px.as_ptr(), 0, 8, &mut handle) },
        -3
    );
}

/// PANIC CONTAINMENT (#1079): the gpu entries wrap their bodies in
/// `catch_panic_rc`, mirroring the CPU entries' worker-panic rc-99 pattern in
/// `error.rs`. A panic inside the body must surface as rc 99 + a
/// `maple_last_error` message, NOT unwind through the `extern "C"` frame (which
/// aborts the app on Apple). Exercised directly on the barrier — provoking a
/// real wgpu panic through valid FFI args would require GPU fault injection.
#[test]
fn catch_panic_rc_contains_panics_as_rc_99() {
    let rc = crate::error::catch_panic_rc("test_entry", || {
        panic!("synthetic wgpu validation failure");
    });
    assert_eq!(
        rc,
        crate::error::RC_PANICKED,
        "a contained panic must map to rc 99"
    );

    let msg = unsafe {
        let p = crate::error::maple_last_error();
        assert!(
            !p.is_null(),
            "last error must be set after a contained panic"
        );
        std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned()
    };
    assert!(
        msg.contains("test_entry") && msg.contains("synthetic wgpu validation failure"),
        "last error must carry the entry name + panic payload, got: {msg}"
    );

    // A non-panicking body passes its rc through untouched.
    assert_eq!(crate::error::catch_panic_rc("test_entry", || -7), -7);
}
