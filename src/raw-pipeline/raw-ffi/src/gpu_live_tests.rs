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

use super::*;
use raw_core::image::{ColorSpace, Image};
use raw_core::types::{ToneCurve, ToneCurveMode, WbMethod};
use raw_core::view::auto_profile::apply::apply_curve;
use raw_core::view::auto_profile::curve::{ChannelCurve, ProfileCurve};
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::AdjustmentModel;

/// A structured scene-linear Rec.2020 RGBA fixture (the kind post-DCP develop
/// produces). Mirrors the raw-gpu oracle's fixture so the two crates' parity
/// gates exercise the same content.
fn scene_linear_rgba(w: usize, h: usize) -> Vec<f32> {
    let mut v = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let t = i as f32 / (w * h) as f32;
            let edge = if (x + y) % 5 == 0 { 0.6 } else { 0.0 };
            let r = (0.05 + t * 1.3 + edge).max(-0.02);
            let g = 0.04 + (1.0 - t) * 0.9 + 0.5 * ((x as f32 * 0.7).sin().abs());
            let b = 0.03 + t * 0.5 + 0.4 * ((y as f32 * 0.9).cos().abs());
            let (r, g, b) = match i % 11 {
                0 => (0.80, 0.10, 0.10),
                3 => (0.10, 0.80, 0.10),
                5 => (0.10, 0.10, 0.80),
                7 => (5.00, 3.00, 1.50),
                _ => (r, g, b),
            };
            v.extend_from_slice(&[r, g, b, 1.0]);
        }
    }
    v
}

/// A non-identity Auto Profile curve (per-channel gammas + a small cross matrix).
fn nonidentity_curve() -> ProfileCurve {
    let gamma = |g: f32| {
        let mut c = ChannelCurve::identity();
        for a in c.anchors.iter_mut() {
            a.1 = a.0.powf(g);
        }
        c
    };
    let mut c = ProfileCurve::identity();
    c.r = gamma(0.9);
    c.g = gamma(1.05);
    c.b = gamma(0.95);
    c.matrix = [[0.98, 0.01, 0.01], [0.01, 0.98, 0.01], [0.01, 0.01, 0.98]];
    c
}

/// A non-identity residual LUT (identity grid warped by a mild per-node gamma).
fn nonidentity_lut(size: usize) -> ColorLut {
    let mut lut = ColorLut::identity(size);
    for v in lut.data.iter_mut() {
        *v = v.clamp(0.0, 1.0).powf(0.92);
    }
    lut
}

/// The CPU reference: the SAME stage subset the live chain runs, composed CPU-
/// side via the real raw-core stage fns (which short-circuit at no-op thresholds)
/// + the view tail + `dither_and_quantize`. Returns the flat `3·w·h` u8 RGB
/// surface. `model` drives the per-value stages; `curve`/`lut` the Auto Profile
/// tail.
fn cpu_reference(
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
    raw_core::stages::sharpen::apply(
        &mut img,
        model.sharpen_amount,
        model.sharpen_radius,
        model.sharpen_detail,
        model.sharpen_masking,
    );
    raw_core::stages::noise_reduction::apply_luminance(&mut img, model.nr_luminance);
    raw_core::stages::noise_reduction::apply_color(&mut img, model.nr_color);

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

/// Build a `MapleGpuLiveParams` from a model + curve/LUT, with the array pointers
/// aimed at the supplied owned buffers (which the CALLER must keep alive for the
/// render — returned alongside so they outlive the params).
struct OwnedArrays {
    luma: Vec<f32>,
    red: Vec<f32>,
    green: Vec<f32>,
    blue: Vec<f32>,
    profile: Vec<f32>,
    residual: Vec<f32>,
}

fn flat_points(c: &ToneCurve) -> Vec<f32> {
    let mut v = Vec::with_capacity(c.points.len() * 2);
    for (x, y) in &c.points {
        v.push(*x);
        v.push(*y);
    }
    v
}

fn owned_arrays(model: &AdjustmentModel, curve: &ProfileCurve, lut: &ColorLut) -> OwnedArrays {
    OwnedArrays {
        luma: flat_points(&model.tone_curve_luma),
        red: flat_points(&model.tone_curve_red),
        green: flat_points(&model.tone_curve_green),
        blue: flat_points(&model.tone_curve_blue),
        profile: curve.to_flat(),
        residual: lut.data.clone(),
    }
}

fn make_params(
    model: &AdjustmentModel,
    wb_method: WbMethod,
    lut_size: usize,
    arr: &OwnedArrays,
) -> MapleGpuLiveParams {
    let mode = match model.tone_curve_mode {
        ToneCurveMode::RatioPreserving => 1,
        ToneCurveMode::PerChannel => 0,
    };
    let wb = match wb_method {
        WbMethod::DiagonalRec2020 => 1,
        WbMethod::Cat16 => 0,
    };
    MapleGpuLiveParams {
        temperature: model.temperature,
        tint: model.tint,
        wb_method: wb,
        exposure: model.exposure,
        brightness: model.brightness,
        highlights: model.highlights,
        shadows: model.shadows,
        whites: model.whites,
        blacks: model.blacks,
        contrast: model.contrast,
        parametric_shadows: model.parametric_shadows,
        parametric_darks: model.parametric_darks,
        parametric_lights: model.parametric_lights,
        parametric_highlights: model.parametric_highlights,
        tone_curve_mode: mode,
        vibrance: model.vibrance,
        saturation: model.saturation,
        clarity: model.clarity,
        texture: model.texture,
        dehaze: model.dehaze,
        vignette_amount: model.vignette_amount,
        vignette_feather: model.vignette_feather,
        sharpen_amount: model.sharpen_amount,
        sharpen_radius: model.sharpen_radius,
        sharpen_detail: model.sharpen_detail,
        sharpen_masking: model.sharpen_masking,
        nr_luminance: model.nr_luminance,
        nr_color: model.nr_color,
        capture_sharpening_enabled: 0,
        capture_sharpening_sigma: 1.0,
        capture_sharpening_iterations: 2,
        capture_sharpening_highlight_threshold: 0.9,
        capture_sharpening_strength: 1.0,
        tone_curve_luma_ptr: arr.luma.as_ptr(),
        tone_curve_luma_len: arr.luma.len(),
        tone_curve_red_ptr: arr.red.as_ptr(),
        tone_curve_red_len: arr.red.len(),
        tone_curve_green_ptr: arr.green.as_ptr(),
        tone_curve_green_len: arr.green.len(),
        tone_curve_blue_ptr: arr.blue.as_ptr(),
        tone_curve_blue_len: arr.blue.len(),
        profile_curve_ptr: arr.profile.as_ptr(),
        profile_curve_len: arr.profile.len(),
        residual_lut_size: lut_size as u32,
        residual_lut_ptr: arr.residual.as_ptr(),
        residual_lut_len: arr.residual.len(),
    }
}

/// A mild model (several stages just past threshold).
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
        dehaze: 10.0,
        sharpen_amount: 50.0,
        sharpen_radius: 1.0,
        sharpen_detail: 25.0,
        nr_color: 15.0,
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        ..AdjustmentModel::default()
    }
}

/// An aggressive model (every gated stage engaged + a luma point curve).
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
        dehaze: 45.0,
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
/// aggressive model. The underlying f32 chain is `< 1e-4` vs the CPU (C1) and the
/// dither quantize is identical GPU-vs-CPU (C2), so the byte surfaces agree within
/// ≤ 1 LSB per channel — asserted as a tight max-byte-delta + a near-zero mismatch
/// fraction. Mirrors `gpu.rs`'s exposure parity, for the whole live chain.
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

        // (2) HOST-PARITY gate (vs the CPU pipeline): with the airlight measured
        //     post-prefix on BOTH sides (C5a — raw-core's `dehaze::apply` measures
        //     A at dehaze's position), the underlying f32 chain is < 1e-4 vs CPU
        //     (C1) and the dither is identical (C2), so the u8 surface agrees to ≤ 1
        //     LSB on at most a handful of pixels that straddle a quantize boundary
        //     the Bayer dither (±0.5 LSB) tips across. Bit-exactness isn't the gate
        //     post-dither, but the boundary noise is now ≤ 1 LSB (was ≤ 2 before
        //     C5a fixed the airlight position).
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
fn direct_raw_gpu(
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
        clarity: model.clarity,
        texture: model.texture,
        dehaze: model.dehaze,
        vignette_amount: model.vignette_amount,
        vignette_feather: model.vignette_feather,
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
    };
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let session = LiveSession::new(&ctx, input, w, h).expect("session");
    let cancel = raw_gpu::CancelToken::new();
    session
        .render_to_buffer(&ctx, &inputs, &cancel)
        .expect("direct render ok")
        .expect("direct render returns Some")
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

/// A re-render through the FFI is byte-identical (the upload-once + pooled path).
#[test]
fn gpu_live_rerender_is_byte_identical() {
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let model = aggressive_model();
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
