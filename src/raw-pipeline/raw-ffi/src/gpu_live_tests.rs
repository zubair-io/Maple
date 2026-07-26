//! Host parity for the gpu-gated LIVE-session FFI (epic #925, P4b-core / #1027).
//!
//! The FFI entry (`maple_gpu_live_open` → `maple_gpu_live_render`) drives
//! `raw_gpu::LiveSession` through the C ABI; its u8 output must match the CPU
//! pipeline — the SAME scene-linear stage subset composed CPU-side (the real
//! `raw-core` stage fns, short-circuiting at no-op thresholds) + the view tail +
//! `dither_and_quantize` — within `1e-4`-equivalent (byte-level: the per-channel
//! u8 delta is ≤ 1, since the underlying f32 chain is `< 1e-4` vs the CPU and the
//! dither quantize is the same on both sides). Mirrors `gpu.rs`'s
//! `gpu_exposure_parity_within_1e_4`, but for the full live chain across a mild +
//! an aggressive `AdjustmentModel`.
//!
//! The reference is the same-subset CPU composition (NOT a fresh develop from
//! RAW): the FFI takes an already-decoded scene-linear f32 buffer, so apples-to-
//! apples is that buffer through the matching CPU stages + dither.
//!
//! DEHAZE stays OFF in this file's models (#1098): the FFI's default session
//! measures the dehaze airlight ON-GPU (#1033), and on this file's
//! `scene_linear_rgba` fixture the dark channel is degenerate (a saturated
//! primary every 11 px), so the GPU-vs-CPU airlight comparison is meaningless
//! there. Dehaze host parity rides the sibling `gpu_live_airlight_tests.rs`,
//! on the hazy 128×128 fixture; the re-render gate below keeps dehaze engaged
//! (FFI-vs-FFI, airlight-comparison-free).

use super::*;
use raw_core::image::{ColorSpace, Image};
use raw_core::types::{ToneCurve, ToneCurveMode, WbMethod};
use raw_core::view::auto_profile::apply::apply_curve;
use raw_core::view::auto_profile::curve::{ChannelCurve, ProfileCurve};
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::AdjustmentModel;
// Shared fixtures/param builders live in `gpu_live_test_support.rs` (600-LOC
// budget split); re-exported here so sibling test files keep their existing
// `super::gpu_live_tests::{..}` imports.
pub(super) use super::gpu_live_test_support::{
    make_params, nonidentity_curve, nonidentity_lut, owned_arrays, scene_linear_rgba, OwnedArrays,
};

pub(super) fn cpu_reference(
    input: &[f32],
    w: u32,
    h: u32,
    model: &AdjustmentModel,
    wb_method: WbMethod,
    curve: &ProfileCurve,
    lut: &ColorLut,
) -> Vec<u8> {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in input.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }

    // Scene-linear stages, develop order (capture_sharpening omitted — the FFI
    // cases leave it disabled, matching the decode-boundary contract).
    raw_core::stages::white_balance::apply(&mut img, model.temperature, model.tint, wb_method);
    raw_core::stages::scene_tone_controls::apply(&mut img, model);
    raw_core::stages::tone_curves::apply(&mut img, model);
    raw_core::stages::vibrance::apply(&mut img, model.vibrance);
    raw_core::stages::saturation::apply(&mut img, model.saturation);
    raw_core::stages::clarity::apply(&mut img, model.clarity);
    raw_core::stages::texture::apply(&mut img, model.texture);
    raw_core::stages::dehaze::apply(&mut img, model.dehaze);
    // Local adjustments (#1698) — develop's 12b slot. Empty on the mild and
    // aggressive models here, so this reference is unchanged for them; the
    // sibling `gpu_live_local_adjustment_tests.rs` drives it non-empty.
    raw_core::stages::local_adjustments::apply(&mut img, &model.local_adjustments);
    raw_core::stages::sharpen::apply(
        &mut img,
        model.sharpen_amount,
        model.sharpen_radius,
        model.sharpen_detail,
        model.sharpen_masking,
    );
    raw_core::stages::noise_reduction::apply_luminance(&mut img, model.nr_luminance, None, 100);
    raw_core::stages::noise_reduction::apply_color(&mut img, model.nr_color, None, 100);

    // View tail: agx → rec2020_to_srgb → srgb_gamma_encode → curve → LUT.
    raw_core::view::agx::apply(&mut img, model.contrast);
    raw_core::view::encode::rec2020_to_srgb(&mut img);
    raw_core::view::encode::srgb_gamma_encode(&mut img);
    let mut rgb: Vec<f32> = Vec::with_capacity(img.pixels.len() * 3);
    for p in &img.pixels {
        rgb.extend_from_slice(&[p[0], p[1], p[2]]);
    }
    apply_curve(&mut rgb, curve);
    lut.apply(&mut rgb);

    // Repack to RGBA (alpha 1) and dither+quantize to u8 — the terminal the GPU
    // session runs (`dither_and_quantize` is byte-identical GPU-vs-CPU, C2).
    let mut rgba = Vec::with_capacity(input.len());
    for px in rgb.chunks_exact(3) {
        rgba.extend_from_slice(&[px[0], px[1], px[2], 1.0]);
    }
    raw_gpu::dither_and_quantize(&rgba, w as usize, h as usize)
}

/// A mild model (several stages just past threshold). Dehaze stays OFF — the
/// 8×8 fixture's flat dark channel makes the GPU-vs-CPU airlight comparison
/// degenerate (module doc); dehaze parity rides `gpu_live_airlight_tests.rs`.
fn mild_model() -> AdjustmentModel {
    AdjustmentModel {
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
    }
}

/// A masked model (#1698): the mild model plus two local-adjustment layers, one
/// feathered linear gradient carrying every wired control and one radial. This
/// is the case that proves the vector-mask rasterizer runs on the live path —
/// through the C ABI, in chain position, against the CPU pipeline.
fn masked_model() -> AdjustmentModel {
    use raw_core::types::{LocalAdjustment, Mask, PartialAdjustments, Point2};
    AdjustmentModel {
        local_adjustments: vec![
            LocalAdjustment {
                mask: Mask::Linear {
                    start: Point2::new(0.1, 0.2),
                    end: Point2::new(0.9, 0.8),
                    feather: 0.5,
                },
                adjustments: PartialAdjustments {
                    exposure: Some(0.5),
                    contrast: Some(20.0),
                    highlights: Some(-30.0),
                    shadows: Some(25.0),
                    whites: Some(10.0),
                    blacks: Some(-15.0),
                    saturation: Some(30.0),
                    vibrance: Some(20.0),
                    temperature: Some(1500.0),
                    tint: Some(6.0),
                },
            },
            LocalAdjustment {
                mask: Mask::Radial {
                    center: Point2::new(0.45, 0.55),
                    radii: Point2::new(0.3, 0.2),
                    angle: 0.5,
                    feather: 0.6,
                    invert: true,
                },
                adjustments: PartialAdjustments {
                    exposure: Some(-0.4),
                    saturation: Some(-25.0),
                    ..Default::default()
                },
            },
        ],
        ..mild_model()
    }
}

/// An aggressive model (every gated stage except dehaze engaged + a luma point
/// curve). Dehaze stays OFF here too (module doc) — it rides
/// `gpu_live_airlight_tests.rs` for host parity, and the re-render gate below
/// for the pooled-path coverage.
fn aggressive_model() -> AdjustmentModel {
    AdjustmentModel {
        temperature: 4800.0,
        tint: 18.0,
        exposure: 0.4,
        brightness: -30.0,
        contrast: 35.0,
        highlights: -40.0,
        shadows: 30.0,
        whites: 20.0,
        blacks: -15.0,
        parametric_shadows: 20.0,
        parametric_lights: 15.0,
        tone_curve_luma: ToneCurve::new(vec![(0.0, 0.0), (0.25, 0.18), (0.75, 0.82), (1.0, 1.0)]),
        tone_curve_mode: ToneCurveMode::RatioPreserving,
        vibrance: 35.0,
        saturation: 25.0,
        clarity: 40.0,
        texture: 30.0,
        sharpen_amount: 80.0,
        sharpen_radius: 1.5,
        sharpen_detail: 30.0,
        sharpen_masking: 20.0,
        nr_luminance: 30.0,
        nr_color: 40.0,
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        ..AdjustmentModel::default()
    }
}

/// THE HOST-PARITY GATE: the FFI live-render entry's u8 output matches the CPU
/// pipeline (same stage subset + view tail + dither) for both a mild and an
/// aggressive model — dehaze off (module doc); its host parity is gated in
/// `gpu_live_airlight_tests.rs`. The underlying f32 chain is `< 1e-4` vs the
/// CPU (C1) and the dither quantize is identical GPU-vs-CPU (C2), so the byte
/// surfaces agree within ≤ 1 LSB per channel — asserted as a tight
/// max-byte-delta + a near-zero mismatch fraction. Mirrors `gpu.rs`'s exposure
/// parity, for the whole live chain.
#[test]
fn gpu_live_render_matches_cpu_within_tolerance() {
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let lut_size = 9usize;
    let curve = nonidentity_curve();
    let lut = nonidentity_lut(lut_size);

    for (name, model, wb_method) in [
        ("mild", mild_model(), WbMethod::Cat16),
        ("aggressive", aggressive_model(), WbMethod::Cat16),
        ("masked", masked_model(), WbMethod::Cat16),
    ] {
        let arr = owned_arrays(&model, &curve, &lut);
        let params = make_params(&model, wb_method, lut_size, &arr);

        // Open → render → close.
        let mut handle = MapleGpuLiveSession {
            inner: std::ptr::null_mut(),
        };
        let rc = unsafe { maple_gpu_live_open(input.as_ptr(), w, h, &mut handle) };
        assert_eq!(rc, 0, "[{name}] gpu_live_open rc {rc}");

        let mut out = vec![0u8; (w * h * 3) as usize];
        let rc = unsafe { maple_gpu_live_render(&handle, &params, out.as_mut_ptr()) };
        assert_eq!(rc, 0, "[{name}] gpu_live_render rc {rc}");
        unsafe { maple_gpu_live_close(&mut handle) };

        // (1) MARSHALING gate (byte-exact): the FFI output must equal a DIRECT
        //     `raw_gpu::LiveSession` render built from the same FullChainInputs —
        //     this isolates "did the C-ABI marshaling reproduce the inputs
        //     exactly" from the (looser) f32→u8 quantization-boundary noise.
        let direct = direct_raw_gpu(&input, w, h, &model, wb_method, &curve, &lut);
        let marshal_mismatches = out.iter().zip(&direct).filter(|(a, b)| a != b).count();
        assert_eq!(
            marshal_mismatches, 0,
            "[{name}] FFI output differs from a direct raw_gpu::LiveSession render in \
             {marshal_mismatches} bytes — the C-ABI marshaling diverges"
        );

        // (2) HOST-PARITY gate (vs the CPU pipeline): the underlying f32 chain
        //     is < 1e-4 vs CPU (C1) and the dither is identical (C2), so the u8
        //     surface agrees to ≤ 1 LSB on at most a handful of pixels that
        //     straddle a quantize boundary the Bayer dither (±0.5 LSB) tips
        //     across. Bit-exactness isn't the gate post-dither — but with dehaze
        //     (the one stage whose airlight measurement legitimately differs
        //     GPU-vs-CPU, #1098) excluded here, boundary noise is all that's left.
        let want = cpu_reference(&input, w, h, &model, wb_method, &curve, &lut);
        assert_eq!(out.len(), want.len(), "[{name}] length mismatch");
        let max_delta = out
            .iter()
            .zip(&want)
            .map(|(a, b)| (*a as i32 - *b as i32).unsigned_abs())
            .max()
            .unwrap_or(0);
        let mismatches = out.iter().zip(&want).filter(|(a, b)| a != b).count();
        let frac = mismatches as f32 / want.len() as f32;
        eprintln!(
            "FFI LIVE PARITY [{name}]: vs-direct = {marshal_mismatches} bytes; vs-CPU max byte \
             delta = {max_delta}, {mismatches} / {} bytes differ ({:.1}%)",
            want.len(),
            frac * 100.0
        );
        assert!(
            max_delta <= 1,
            "[{name}] FFI vs CPU max byte delta {max_delta} > 1 — beyond f32→u8 boundary noise"
        );
        assert!(
            frac < 0.05,
            "[{name}] {:.1}% of bytes differ from CPU — too many for boundary noise (a real divergence)",
            frac * 100.0
        );
    }
}

/// A DIRECT `raw_gpu::LiveSession` render (no FFI) from the same model/curve/LUT —
/// the marshaling-gate reference. Builds `FullChainInputs` exactly as the FFI
/// does, so the only difference from the FFI path is the C-ABI pointer round-trip.
#[allow(clippy::too_many_arguments)]
pub(super) fn direct_raw_gpu(
    input: &[f32],
    w: u32,
    h: u32,
    model: &AdjustmentModel,
    wb_method: WbMethod,
    curve: &ProfileCurve,
    lut: &ColorLut,
) -> Vec<u8> {
    use raw_gpu::{CurveMode, FullChainInputs, GpuContext, LiveSession, ToneCurveInputs};

    let wb_matrix = match wb_method {
        WbMethod::Cat16 => {
            raw_core::stages::white_balance::wb_cat16_matrix(model.temperature, model.tint).0
        }
        WbMethod::DiagonalRec2020 => {
            let g = raw_core::stages::white_balance::wb_gains(model.temperature, model.tint);
            [[g[0], 0.0, 0.0], [0.0, g[1], 0.0], [0.0, 0.0, g[2]]]
        }
    };
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
        // HSL 8-band adjustments (#1112) — pass through from the model.
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
        // sRGB primaries (#1337 default).
        target_primaries: 0,
        // RAW shape — full chain including WB (pre-#1331 default).
        input_shape: raw_gpu::InputShape::PostDcpRec2020Fp16,
        // Auto/AgX view tail (#1722 default, value 0).
        profile_id: 0,
    };
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let session = LiveSession::new(&ctx, input, w, h).expect("session");
    let cancel = raw_gpu::CancelToken::new();
    session
        .render_to_buffer(&ctx, &inputs, &cancel)
        .expect("direct render ok")
        .expect("direct render returns Some")
}

/// A re-render through the FFI is byte-identical (the upload-once + pooled path).
#[test]
fn gpu_live_rerender_is_byte_identical() {
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    // Dehaze rides along here even though the HOST gate can't compare it on this
    // 8×8 fixture (degenerate dark channel — module doc): this gate is FFI-vs-FFI
    // on ONE session, GPU-deterministic regardless, so re-adding it keeps the
    // dehaze sub-DAG covered on the pooled re-render path.
    let model = AdjustmentModel {
        dehaze: 45.0,
        ..aggressive_model()
    };
    let curve = nonidentity_curve();
    let lut = nonidentity_lut(9);
    let arr = owned_arrays(&model, &curve, &lut);
    let params = make_params(&model, WbMethod::Cat16, 9, &arr);

    let mut handle = MapleGpuLiveSession {
        inner: std::ptr::null_mut(),
    };
    assert_eq!(
        unsafe { maple_gpu_live_open(input.as_ptr(), w, h, &mut handle) },
        0
    );
    let mut a = vec![0u8; (w * h * 3) as usize];
    let mut b = vec![0u8; (w * h * 3) as usize];
    assert_eq!(
        unsafe { maple_gpu_live_render(&handle, &params, a.as_mut_ptr()) },
        0
    );
    assert_eq!(
        unsafe { maple_gpu_live_render(&handle, &params, b.as_mut_ptr()) },
        0
    );
    unsafe { maple_gpu_live_close(&mut handle) };
    assert_eq!(a, b, "FFI re-render at same inputs must be byte-identical");
}

// Panic-containment barrier test + P3 target-primaries FFI parity tests (#1337)
// live in the sibling `gpu_live_p3_tests.rs` (600-LOC file budget — same pattern
// as `gpu_live_airlight_tests.rs` for the dehaze split).
