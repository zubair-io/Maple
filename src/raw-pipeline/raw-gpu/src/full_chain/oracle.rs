//! Shared test-support harness for the composed-chain parity gates (epic #925,
//! P4a / P4b). Extracted from `full_chain/tests.rs` so the LIVE-chain gate
//! (`live_chain/tests.rs`, P4b / #1027) drives the SAME CPU oracle, `Case`
//! builder, and scene-linear fixture rather than a copy that could drift.
//!
//! Declared once (`pub(crate) mod oracle` in `full_chain.rs`, test+native only)
//! and reached by both test files through `crate::full_chain::oracle::*`. Holds
//! NO `#[test]` fns — only the fixtures and the CPU reference both gates share:
//!
//! - [`scene_linear_rgba`] — the structured scene-linear Rec.2020 RGBA fixture
//!   (the kind the post-DCP develop chain produces).
//! - [`Case`] — the one-source-of-truth `AdjustmentModel` + per-image data; both
//!   the GPU [`FullChainInputs`] and the CPU oracle derive from it.
//! - [`cpu_oracle`] — runs the SAME stages in develop order via the real
//!   `raw-core` stage fns, INCLUDING each stage's no-op short-circuit (the
//!   `apply` fns early-return at default values). This is what makes the LIVE
//!   gate honest: a neutral `Case` → `cpu_oracle` runs only the view tail (every
//!   scene-linear `apply` short-circuits), so the gated `build_live_chain` (which
//!   OMITS those passes) must match it, while the ungated `build_full_chain_passes`
//!   (which runs them unconditionally) diverges. See `live_chain/tests.rs`.
//! - [`nonidentity_curve`] / [`nonidentity_lut`] / [`identity_curve`] /
//!   [`identity_lut`] — Auto Profile curve + residual LUT fixtures (non-identity
//!   for the loaded cases; identity for the pure-neutral gating case so the only
//!   surviving passes are genuinely unavoidable).
//! - [`max_abs_diff`] / [`moved`] — the diff metrics both gates report.

use crate::capture_sharpening::CaptureSharpeningParams;
use crate::tone_curves::{CurveMode, ToneCurveInputs};
use crate::FullChainInputs;

use raw_core::image::{ColorSpace, Image};
use raw_core::types::{BlackWhiteMode, ToneCurveMode, WbMethod};
use raw_core::view::auto_profile::apply::apply_curve;
use raw_core::view::auto_profile::curve::{ChannelCurve, ProfileCurve};
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::AdjustmentModel;

/// A scene-linear Rec.2020 RGBA test buffer (the kind the post-DCP develop chain
/// produces). Spans the full working range every stage cares about:
///   - shadow / midtone / highlight greys (tone, curve, NR),
///   - saturated primaries (Oklab vibrance/saturation, WB channel coupling, the
///     AgX hue-restoring sigmoid + the display-encode gamut compression),
///   - HDR scene-headroom values > 1 (AgX sigmoid + compress_input soft-knee),
///   - a slightly-negative channel (clamp paths),
///   - spatial neighbours that differ from their surround (so the guided-filter /
///     dehaze / sharpen / NLM kernels are non-vacuous — a flat field is a
///     near-fixed-point for every spatial stage).
///
/// 8×8 = 64 pixels so the 15×15 dehaze window and radius-20 clarity box-blur
/// have a meaningful interior + border (smaller and the shrinking-window border
/// policy dominates; this keeps both regions exercised).
pub fn scene_linear_rgba(w: usize, h: usize) -> Vec<f32> {
    let mut v = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            // A deterministic, structured field: smooth gradients with a few
            // sharp local features so spatial kernels see real edges.
            let t = i as f32 / (w * h) as f32; // 0..1 ramp
            let edge = if (x + y) % 5 == 0 { 0.6 } else { 0.0 }; // periodic edges
            let r = (0.05 + t * 1.3 + edge).max(-0.02);
            let g = 0.04 + (1.0 - t) * 0.9 + 0.5 * ((x as f32 * 0.7).sin().abs());
            let b = 0.03 + t * 0.5 + 0.4 * ((y as f32 * 0.9).cos().abs());
            // Seed a couple of saturated primaries + an HDR value explicitly.
            let (r, g, b) = match i % 11 {
                0 => (0.80, 0.10, 0.10), // saturated red
                3 => (0.10, 0.80, 0.10), // saturated green
                5 => (0.10, 0.10, 0.80), // saturated blue
                7 => (5.00, 3.00, 1.50), // HDR scene-headroom
                _ => (r, g, b),
            };
            v.extend_from_slice(&[r, g, b, 1.0]);
        }
    }
    v
}

/// Derive the same 3×3 WB matrix raw-core's `apply` uses, single-sourced from
/// raw-core (`wb_cat16_matrix` / `wb_gains`) — so the GPU `WhiteBalancePass`
/// matmul is pinned to the CPU stage.
pub fn wb_matrix(temperature: f32, tint: f32, method: WbMethod) -> [[f32; 3]; 3] {
    match method {
        WbMethod::Cat16 => raw_core::stages::white_balance::wb_cat16_matrix(temperature, tint).0,
        WbMethod::DiagonalRec2020 => {
            let g = raw_core::stages::white_balance::wb_gains(temperature, tint);
            [[g[0], 0.0, 0.0], [0.0, g[1], 0.0], [0.0, 0.0, g[2]]]
        }
    }
}

/// Bridge a raw-gpu `CaptureSharpeningParams` to its raw-core twin (field-for-
/// field; same names) so the CPU oracle calls the real stage with matching args.
pub fn rc_capture(
    p: &CaptureSharpeningParams,
) -> raw_core::stages::capture_sharpening::CaptureSharpeningParams {
    raw_core::stages::capture_sharpening::CaptureSharpeningParams {
        sigma: p.sigma,
        iterations: p.iterations,
        highlight_threshold: p.highlight_threshold,
        strength: p.strength,
        noise_floor: p.noise_floor,
    }
}

/// The one-source-of-truth case: an `AdjustmentModel` + per-image data. The GPU
/// [`FullChainInputs`] (via [`Case::gpu_inputs`]) AND the CPU oracle (via
/// [`cpu_oracle`]) both derive from this, so the two sides can never disagree on
/// *what* each stage does — only on the float arithmetic the parity gate bounds.
pub struct Case {
    pub model: AdjustmentModel,
    pub capture: Option<CaptureSharpeningParams>,
    pub curve: ProfileCurve,
    pub lut: ColorLut,
    /// WB method (the model carries temp/tint; method is a separate enum field).
    pub wb_method: WbMethod,
}

impl Case {
    /// Assemble the GPU-side [`FullChainInputs`] from this case's model + per-
    /// image data — the GPU stage params come straight from the CPU model.
    pub fn gpu_inputs(&self) -> FullChainInputs {
        FullChainInputs {
            wb_matrix: wb_matrix(self.model.temperature, self.model.tint, self.wb_method),
            wb_temperature: self.model.temperature,
            wb_tint: self.model.tint,
            tone: [
                self.model.exposure,
                self.model.brightness,
                self.model.highlights,
                self.model.shadows,
                self.model.whites,
                self.model.blacks,
            ],
            tone_curves: ToneCurveInputs {
                parametric: [
                    self.model.parametric_shadows,
                    self.model.parametric_darks,
                    self.model.parametric_lights,
                    self.model.parametric_highlights,
                ],
                luma: self.model.tone_curve_luma.points.clone(),
                red: self.model.tone_curve_red.points.clone(),
                green: self.model.tone_curve_green.points.clone(),
                blue: self.model.tone_curve_blue.points.clone(),
                mode: match self.model.tone_curve_mode {
                    ToneCurveMode::PerChannel => CurveMode::PerChannel,
                    ToneCurveMode::RatioPreserving => CurveMode::RatioPreserving,
                },
            },
            vibrance: self.model.vibrance,
            saturation: self.model.saturation,
            hsl_hue: [
                self.model.hue_adjustment_red,
                self.model.hue_adjustment_orange,
                self.model.hue_adjustment_yellow,
                self.model.hue_adjustment_green,
                self.model.hue_adjustment_aqua,
                self.model.hue_adjustment_blue,
                self.model.hue_adjustment_purple,
                self.model.hue_adjustment_magenta,
            ],
            hsl_sat: [
                self.model.saturation_adjustment_red,
                self.model.saturation_adjustment_orange,
                self.model.saturation_adjustment_yellow,
                self.model.saturation_adjustment_green,
                self.model.saturation_adjustment_aqua,
                self.model.saturation_adjustment_blue,
                self.model.saturation_adjustment_purple,
                self.model.saturation_adjustment_magenta,
            ],
            hsl_lum: [
                self.model.luminance_adjustment_red,
                self.model.luminance_adjustment_orange,
                self.model.luminance_adjustment_yellow,
                self.model.luminance_adjustment_green,
                self.model.luminance_adjustment_aqua,
                self.model.luminance_adjustment_blue,
                self.model.luminance_adjustment_purple,
                self.model.luminance_adjustment_magenta,
            ],
            bw_mix: [
                self.model.gray_mixer_red,
                self.model.gray_mixer_orange,
                self.model.gray_mixer_yellow,
                self.model.gray_mixer_green,
                self.model.gray_mixer_aqua,
                self.model.gray_mixer_blue,
                self.model.gray_mixer_purple,
                self.model.gray_mixer_magenta,
            ],
            bw_active: self.model.black_white == BlackWhiteMode::On,
            clarity: self.model.clarity,
            texture: self.model.texture,
            dehaze: self.model.dehaze,
            local_adjustments: raw_core::types::layers_to_flat(&self.model.local_adjustments),
            vignette_amount: self.model.vignette_amount,
            vignette_feather: self.model.vignette_feather,
            grain_amount: self.model.grain_amount,
            grain_size: self.model.grain_size,
            grain_roughness: self.model.grain_roughness,
            split_tone_shadow_hue: self.model.split_tone_shadow_hue,
            split_tone_shadow_saturation: self.model.split_tone_shadow_saturation,
            split_tone_highlight_hue: self.model.split_tone_highlight_hue,
            split_tone_highlight_saturation: self.model.split_tone_highlight_saturation,
            split_tone_balance: self.model.split_tone_balance,
            color_grade_shadow_luminance: self.model.color_grade_shadow_luminance,
            color_grade_midtone_hue: self.model.color_grade_midtone_hue,
            color_grade_midtone_saturation: self.model.color_grade_midtone_saturation,
            color_grade_midtone_luminance: self.model.color_grade_midtone_luminance,
            color_grade_highlight_luminance: self.model.color_grade_highlight_luminance,
            color_grade_global_hue: self.model.color_grade_global_hue,
            color_grade_global_saturation: self.model.color_grade_global_saturation,
            color_grade_global_luminance: self.model.color_grade_global_luminance,
            sharpen_amount: self.model.sharpen_amount,
            sharpen_radius: self.model.sharpen_radius,
            sharpen_detail: self.model.sharpen_detail,
            sharpen_masking: self.model.sharpen_masking,
            nr_luminance: self.model.nr_luminance,
            nr_color: self.model.nr_color,
            contrast: self.model.contrast,
            capture_sharpening: self.capture,
            profile_curve_flat: self.curve.to_flat(),
            residual_lut_size: self.lut.size,
            residual_lut_data: self.lut.data.clone(),
            // sRGB primaries — oracle always uses the default (#1337).
            target_primaries: 0,
            // All oracle cases are RAW — the full chain.
            input_shape: crate::full_chain::InputShape::PostDcpRec2020Fp16,
            // Oracle cases use the default profile (AgX / not AcrMatch).
            profile_id: 0,
        }
    }
}

/// The CPU reference: run the SAME stages in the SAME order by calling the real
/// `raw-core` stage functions on an `Image`, then the full view tail (incl.
/// `srgb_gamma_encode` in its render position). Returns a flat interleaved RGBA
/// buffer (alpha = 1.0).
///
/// CRUCIAL for the LIVE gate: every scene-linear `apply` fn here short-circuits
/// at its no-op threshold (e.g. `vibrance::apply` returns early at `|v| < 1e-3`),
/// so a neutral `Case` yields the same pixels the *gated* `build_live_chain`
/// produces (which OMITS those passes) — but NOT what the *ungated*
/// `build_full_chain_passes` produces (which runs them unconditionally). That
/// gap is exactly what `live_chain/tests.rs` measures.
pub fn cpu_oracle(input: &[f32], w: u32, h: u32, case: &Case) -> Vec<f32> {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in input.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }

    // --- scene-linear stages, in develop order (each short-circuits at its
    //     no-op threshold; that early-return is the behavior the live builder's
    //     `if` guards replicate at the pass-inclusion level) ---
    if let Some(p) = &case.capture {
        raw_core::stages::capture_sharpening::apply_capture_sharpening(&mut img, &rc_capture(p));
    }
    raw_core::stages::white_balance::apply(
        &mut img,
        case.model.temperature,
        case.model.tint,
        case.wb_method,
    );
    raw_core::stages::scene_tone_controls::apply(&mut img, &case.model);
    raw_core::stages::tone_curves::apply(&mut img, &case.model);
    raw_core::stages::vibrance::apply(&mut img, case.model.vibrance);
    raw_core::stages::saturation::apply(&mut img, case.model.saturation);
    // HSL (#1112) — after saturation, before clarity (develop order, scene-linear).
    raw_core::stages::hsl::apply_model(&mut img, &case.model);
    raw_core::stages::clarity::apply(&mut img, case.model.clarity);
    raw_core::stages::texture::apply(&mut img, case.model.texture);
    raw_core::stages::dehaze::apply(&mut img, case.model.dehaze);
    // Local adjustments (#1698) — develop's 12b slot, between dehaze and
    // vignette. Empty for every existing case, so the shared oracle stays
    // bit-identical for them.
    raw_core::stages::local_adjustments::apply(&mut img, &case.model.local_adjustments);
    raw_core::stages::vignette::apply(
        &mut img,
        case.model.vignette_amount,
        case.model.vignette_feather,
    );
    raw_core::stages::sharpen::apply(
        &mut img,
        case.model.sharpen_amount,
        case.model.sharpen_radius,
        case.model.sharpen_detail,
        case.model.sharpen_masking,
    );
    raw_core::stages::noise_reduction::apply_luminance(
        &mut img,
        case.model.nr_luminance,
        None,
        100,
    );
    raw_core::stages::noise_reduction::apply_color(&mut img, case.model.nr_color, None, 100);

    // --- view tail (agx → rec2020_to_srgb → srgb_gamma_encode → curve → LUT,
    //     matching the GPU suffix AND raw-core's render tail exactly). ALWAYS
    //     runs on both sides — even a neutral image must go through the view
    //     transform to become a display image. ---
    raw_core::view::agx::apply(&mut img, case.model.contrast);
    raw_core::stages::color_grade::apply_model(&mut img, &case.model);
    raw_core::stages::grain::apply(
        &mut img,
        case.model.grain_amount,
        case.model.grain_size,
        case.model.grain_roughness,
    );
    raw_core::view::encode::rec2020_to_srgb(&mut img);
    raw_core::view::encode::srgb_gamma_encode(&mut img);
    // Buffer is now DisplayEncodedSrgb in [0,1]. apply_curve / ColorLut operate on
    // an interleaved RGB f32 slice; run them on the same domain the GPU passes do.
    let mut rgb: Vec<f32> = Vec::with_capacity(img.pixels.len() * 3);
    for p in &img.pixels {
        rgb.extend_from_slice(&[p[0], p[1], p[2]]);
    }
    apply_curve(&mut rgb, &case.curve);
    case.lut.apply(&mut rgb);

    // Repack to RGBA (alpha 1.0) to match the GPU readback shape.
    let mut out = Vec::with_capacity(input.len());
    for px in rgb.chunks_exact(3) {
        out.extend_from_slice(&[px[0], px[1], px[2], 1.0]);
    }
    out
}

/// A non-identity Auto Profile curve: real per-channel gamma curves + a small
/// cross-channel matrix tweak, so the curve Pass's matrix + per-channel paths
/// both run (an identity-only curve would leave that path vacuous).
pub fn nonidentity_curve() -> ProfileCurve {
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
    // A small off-diagonal cross-channel mix (keeps it near-identity but
    // non-trivial so the matrix matmul is exercised).
    c.matrix = [[0.98, 0.01, 0.01], [0.01, 0.98, 0.01], [0.01, 0.01, 0.98]];
    c
}

/// A non-identity residual LUT: the identity grid warped by a mild per-node
/// gamma so the trilinear lookup carries a real residual (not a pass-through).
pub fn nonidentity_lut(size: usize) -> ColorLut {
    let mut lut = ColorLut::identity(size);
    for v in lut.data.iter_mut() {
        *v = v.clamp(0.0, 1.0).powf(0.92);
    }
    lut
}

/// The identity Auto Profile curve — for the PURE-neutral gating case, where the
/// only surviving passes must be genuinely unavoidable (the view tail). The
/// curve pass still runs (view tail always runs) but is a near-identity, so it
/// can't mask a gating bug by accidentally moving pixels.
pub fn identity_curve() -> ProfileCurve {
    ProfileCurve::identity()
}

/// The identity residual LUT — the neutral-case sibling of [`identity_curve`].
pub fn identity_lut(size: usize) -> ColorLut {
    ColorLut::identity(size)
}

/// Max absolute per-element difference between two equal-length buffers.
pub fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len(), "buffer length mismatch");
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0_f32, f32::max)
}

/// How much a chain moved the image vs the raw input (sanity floor: a gate that
/// passes only because nothing happened is vacuous).
pub fn moved(input: &[f32], out: &[f32]) -> f32 {
    max_abs_diff(input, out)
}
