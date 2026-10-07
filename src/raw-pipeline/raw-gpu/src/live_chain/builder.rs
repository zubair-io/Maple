use super::*;
use crate::chain::Pass;

pub(crate) trait LivePassSink<'a> {
    fn push<T: Pass + 'a>(&mut self, pass: T);
    /// The boxed fallback separates prefix/suffix; a single-submit encoder
    /// deliberately continues its existing ping-pong sequence across this point.
    fn start_suffix(&mut self) {}
}
struct BoxedSink<'a> {
    prefix: BoxedPasses<'a>,
    suffix: BoxedPasses<'a>,
    in_suffix: bool,
}
impl<'a> LivePassSink<'a> for BoxedSink<'a> {
    fn push<T: Pass + 'a>(&mut self, pass: T) {
        let destination = if self.in_suffix {
            &mut self.suffix
        } else {
            &mut self.prefix
        };
        destination.push(Box::new(pass));
    }
    fn start_suffix(&mut self) {
        self.in_suffix = true;
    }
}

/// Push the local-adjustments stage (#1698) in whichever of its two shapes
/// this model needs.
///
/// * NO layer sets a spatial control (#3407) — the common case, and every
///   model that existed before #3407: ONE [`LocalAdjustmentsPass`] running
///   the whole stack in a single dispatch, unchanged.
/// * Some layer does: one pass PER LAYER, in order, so a layer's spatial
///   group can be applied to that layer's own output before the next layer
///   starts. Splitting the point dispatch per layer is exactly equivalent to
///   fusing it — the equivalence the fused form is built on — so the only
///   thing that changes is where the spatial kernels get to run.
fn push_local_adjustments<'a>(suffix: &mut impl LivePassSink<'a>, inputs: &'a FullChainInputs<'_>) {
    let flat = &inputs.local_adjustments;
    if !local_adjustments_are_active(flat, inputs.scope.layer) {
        return;
    }
    if !local_adjustments_need_spatial(flat) {
        suffix.push(
            LocalAdjustmentsPass::new(flat, &inputs.mask_rasters)
                .with_scope_layer(inputs.scope.layer),
        );
        return;
    }
    for (index, layer) in logical_layers(flat).enumerate() {
        let is_scope_target = inputs.scope.layer >= 0 && inputs.scope.layer as usize == index;
        if layer_needs_spatial(layer) {
            suffix.push(LocalSpatialPass::new(
                layer,
                &inputs.mask_rasters,
                is_scope_target,
            ));
            continue;
        }
        // A point-only layer still needs its own dispatch so the layers stay
        // in order; `-1` unless it is the scope target, and `0` when it is
        // (this pass sees a one-layer stack).
        let scope = if is_scope_target { 0 } else { -1 };
        suffix.push(LocalAdjustmentsPass::new(layer, &inputs.mask_rasters).with_scope_layer(scope));
    }
}

/// Build the LIVE develop+view chain for `inputs`, OMITTING every no-op pass
/// (the gated counterpart to [`crate::build_full_chain_passes`]). A neutral
/// `AdjustmentModel` yields only the always-on view tail; each engaged slider
/// adds exactly its pass. The view tail's `dither` terminal (P4b) is appended by
/// the live session, not here — this builder stays f32-RGBA, like `build_split`.
///
/// `airlight` selects the `DehazePass`'s airlight source (only built when dehaze
/// is engaged). The LIVE loop passes [`AirlightSource::OnGpu`] (#1033): A is
/// computed on-device with NO GPU→CPU readback, so the dehaze-active chain runs in
/// ONE submit. The headless gate passes [`AirlightSource::Cpu`] of the pre-dehaze
/// buffer (the byte-exact-vs-raw-core reference path).
pub fn build_live_chain<'a>(
    inputs: &'a FullChainInputs<'_>,
    airlight: AirlightSource,
) -> BoxedPasses<'a> {
    let (prefix, suffix) = build_live_split(inputs, airlight);
    let mut all = prefix;
    all.extend(suffix);
    all
}

/// The split form of [`build_live_chain`], mirroring [`crate::build_split`]'s
/// `(prefix, suffix)` shape so the airlight readback path (C5a) can run the
/// pre-dehaze prefix, derive the airlight, then build the dehaze+suffix.
///
/// Returns `(prefix, suffix)` where:
///   - `prefix` = the gated scene-linear stages BEFORE dehaze (capture_sharpening
///     through texture), each included only if engaged.
///   - `suffix` = dehaze (only if engaged) + sharpen + NR (each gated) + the
///     always-on view tail.
///
/// DEGENERATE-DEHAZE NOTE: when dehaze is omitted (`|dehaze| < 1e-3`), the suffix
/// simply has no `DehazePass` at its head — it is still a coherent, runnable Vec
/// (sharpen/NR/view-tail). The `airlight` argument is ignored when dehaze is
/// omitted.
///
/// AIRLIGHT SOURCE (#1033): with [`AirlightSource::OnGpu`] (the live path) the
/// `DehazePass` measures A on-device from its `src` — which in this chain IS the
/// post-prefix buffer (dehaze is the first suffix pass) — so the old C5a
/// prefix→readback→suffix split is no longer needed for the live loop; the whole
/// chain runs in one submit. With [`AirlightSource::Cpu`] the caller supplies A
/// (the readback fallback / the headless reference path).
pub fn build_live_split<'a>(
    inputs: &'a FullChainInputs<'_>,
    airlight: AirlightSource,
) -> (BoxedPasses<'a>, BoxedPasses<'a>) {
    let mut sink = BoxedSink {
        prefix: Vec::new(),
        suffix: Vec::new(),
        in_suffix: false,
    };
    visit_live_chain(inputs, airlight, &mut sink);
    (sink.prefix, sink.suffix)
}

/// Build and immediately consume typed passes from the same canonical gates.
pub(crate) fn visit_live_chain<'a>(
    inputs: &'a FullChainInputs<'_>,
    airlight: AirlightSource,
    sink: &mut impl LivePassSink<'a>,
) {
    // --- Prefix: capture_sharpening (FIRST, develop's 04b placement) through
    //     texture. Each pass is included only when its stage is NOT a no-op,
    //     replicating develop's per-stage `if` guards / the `apply` short-circuit.
    //
    //     For `LinearRec2020Fp16` / `SrgbGammaEncoded8` input shapes the buffer
    //     is already colour-space–correct linear Rec.2020 (the 8-bit path was
    //     pre-converted at session open on the CPU side). WB and
    //     capture_sharpening have no meaning there and are unconditionally
    //     skipped regardless of slider values. ---
    // capture_sharpening is RAW-only (#1331): non-RAW shapes (pano PNG, JPEG)
    // upload a buffer that is already post-demosaic, so there was no capture
    // sharpening to apply. `PostDcpRec2020Fp16` is the historic default,
    // preserving the existing RAW behaviour exactly.
    let is_raw_shape = inputs.input_shape == InputShape::PostDcpRec2020Fp16;
    if is_raw_shape {
        if let Some(params) = inputs.capture_sharpening {
            // Already `Option`-gated in `build_split`; `Some` === develop ran the stage.
            sink.push(CaptureSharpeningPass { params });
        }
    }
    // WB stays engaged for ALL input shapes (#1331): for non-RAW assets the
    // FFI caller passes `decoded_temperature = 6500.0` / `decoded_tint = 0.0`
    // so that `apply_delta(live, decoded=6500/0)` is IDENTITY when the slider
    // is at default (6500K/0), but SHIFTS correctly as the user drags temp/tint.
    // Skipping WB for non-RAW would make the temperature/tint sliders inert.
    if !wb_is_noop(inputs.wb_temperature, inputs.wb_tint) {
        sink.push(WhiteBalancePass {
            matrix: inputs.wb_matrix,
        });
    }
    if !scene_tone_is_noop(&inputs.tone) {
        sink.push(SceneToneControlsPass {
            exposure: inputs.tone[0],
            brightness: inputs.tone[1],
            highlights: inputs.tone[2],
            shadows: inputs.tone[3],
            blacks: inputs.tone[5],
        });
    }
    if !tone_curves_is_noop(&inputs.tone_curves) {
        sink.push(ToneCurvesPass {
            inputs: &inputs.tone_curves,
        });
    }
    if inputs.vibrance.abs() >= SLIDER_EPS {
        sink.push(VibrancePass {
            vibrance: inputs.vibrance,
        });
    }
    if inputs.saturation.abs() >= SLIDER_EPS {
        sink.push(SaturationPass {
            saturation: inputs.saturation,
        });
    }
    // HSL (#1112) / black & white (#276) — gated when any of the 24 sliders
    // is engaged (same predicate as raw-core's `hsl_params` is_identity
    // flag: `abs() >= 1e-3`) or B&W is armed.
    {
        let hsl_pass = hsl_pass_for(inputs);
        if !hsl_pass.is_noop() {
            sink.push(hsl_pass);
        }
    }
    if inputs.clarity.abs() >= SLIDER_EPS {
        sink.push(ClarityPass {
            clarity: inputs.clarity,
        });
    }
    if inputs.texture.abs() >= SLIDER_EPS {
        sink.push(TexturePass {
            texture: inputs.texture,
        });
    }

    // --- Suffix: dehaze (gated; airlight from the prefix output) → sharpen → NR
    //     (gated) → the always-on view tail. ---
    sink.start_suffix();
    if inputs.dehaze.abs() >= SLIDER_EPS {
        sink.push(DehazePass {
            dehaze: inputs.dehaze,
            airlight: airlight.clone(),
        });
    }
    // Defringe (#3411) — develop's 12a position, between dehaze and local
    // adjustments. Gated on the SAME predicate raw-core's
    // `defringe::params_from_model` applies (either strength above zero),
    // carried on `FullChainInputs::defringe`.
    if inputs.defringe.is_engaged() {
        sink.push(DefringePass {
            inputs: inputs.defringe,
        });
    }
    // Local adjustments (#1698) — develop's 12b position, between dehaze and
    // vignette. See the gate-predicate note in the module docs.
    push_local_adjustments(sink, inputs);
    // Vignette (#1109) — develop's 12c position (after local_adjustments,
    // before sharpen). Same `apply` predicate as the raw-core stage's identity
    // short-circuit (`|amount| < 1e-3`); feather alone never engages the stage.
    if inputs.vignette_amount.abs() >= SLIDER_EPS {
        sink.push(VignettePass {
            amount: inputs.vignette_amount,
            feather: inputs.vignette_feather,
        });
    }
    if inputs.sharpen_amount.abs() >= SLIDER_EPS {
        sink.push(SharpenPass {
            amount: inputs.sharpen_amount,
            radius: crate::sharpen::radius_at_scale(
                inputs.sharpen_radius,
                inputs.nr_sampling_scale,
            ),
            detail: inputs.sharpen_detail,
            masking: inputs.sharpen_masking,
        });
    }
    if inputs.nr_luminance.abs() >= SLIDER_EPS {
        sink.push(NlmLumaPass {
            nr_luminance: inputs.nr_luminance,
            noise_profile: inputs.noise_profile.as_slice().into(),
            iso: inputs.iso,
        });
    }
    if inputs.nr_color.abs() >= SLIDER_EPS {
        sink.push(NlmColorPass {
            sampling_scale: inputs.nr_sampling_scale,
            nr_color: inputs.nr_color,
            noise_profile: inputs.noise_profile.as_slice().into(),
            iso: inputs.iso,
        });
    }

    // View tail. AgX is the scene→display tone-map. It runs for RAW shapes
    // (`PostDcpRec2020Fp16`), whose buffer is scene-referred. NON-RAW shapes
    // (`LinearRec2020Fp16` / `SrgbGammaEncoded8`) are ALREADY display-referred —
    // a JPEG/PNG/HEIF tone-mapped at capture — so AgX would double-tone-map them
    // (white 1.0 crushes to ~0.82, dim and warm). The CPU pipeline skips AgX for
    // non-RAW for exactly this reason (`ImageEditPipeline.processSceneLinearNonRaw`,
    // `skipAgX: true`); mirror it here so the GPU-live and CPU paths agree. The
    // rest of the tail (`display_encode` → `srgb_gamma` → …) still runs: the
    // non-RAW buffer is linear Rec.2020 and must be encoded to display sRGB. #1513
    // View tail: AgX for every profile (the AcrMatch branch was retired in
    // #2312). Non-RAW shapes (display-referred) skip the tone-map entirely
    // (#1513).
    if is_raw_shape {
        sink.push(AgxPass {
            contrast: inputs.contrast,
            whites: crate::whites_anchor::resolve(inputs.tone[4], inputs.whites_anchor_ev),
        });
    }
    // Display-referred point curves (#2232, `crs:ToneCurvePV2012*`) —
    // post-AgX, before color_grade. GATED on all four curves being
    // identity (mirrors `stages::display_tone_curve::apply`'s own
    // early-return). Runs for non-RAW shapes too — the same buffer
    // `color_grade` / `grain` already treat as display-linear regardless of
    // `is_raw_shape` (#2478's precedent, applied here since #2232 lands
    // after it).
    if !display_tone_curve_is_identity(&inputs.display_tone_curves) {
        sink.push(DisplayToneCurvePass {
            inputs: &inputs.display_tone_curves,
        });
    }
    // Colour grading (#275) — display-linear, post-AgX; GATED on every
    // wheel's saturation and luminance (all-default is a true no-op
    // regardless of hues / balance, exactly raw-core's `apply`
    // short-circuit).
    let grade = crate::full_chain::color_grade_sliders(inputs);
    if !color_grade_is_identity(&grade) {
        sink.push(ColorGradePass { sliders: grade });
    }
    // Film look (epic #2683, Task 7) — display-linear, post-color_grade,
    // pre-grain (matching raw-core's render tail position). GATED on a
    // loaded, non-empty LUT AND an engaged strength — a look with strength 0
    // is a bit-identical no-op (mirrors `film_look::apply`'s own
    // `strength <= 0.0` short-circuit) and an unloaded LUT has no grid to
    // bind.
    if inputs.film_lut_size > 0 && inputs.film_strength > SLIDER_EPS {
        sink.push(FilmLutPass {
            size: inputs.film_lut_size,
            strength: inputs.film_strength,
            data: inputs.film_lut_data.as_ref().into(),
        });
    }
    // Film grain (#1110) — display-linear, post-AgX; GATED unlike the rest
    // of the tail (grain at amount 0 is a true no-op, so the pass is
    // omitted exactly as raw-core's `apply` short-circuits). Size /
    // roughness alone never engage the stage.
    if inputs.grain_amount.abs() >= SLIDER_EPS {
        sink.push(GrainPass {
            amount: inputs.grain_amount,
            size: inputs.grain_size,
            roughness: inputs.grain_roughness,
        });
    }
    // target_primaries from FullChainInputs (#1337): 0 = sRGB (default/legacy),
    // 1 = Display P3.
    sink.push(DisplayEncodePass {
        target_primaries: inputs.target_primaries,
    });
    sink.push(SrgbGammaPass);
    // Auto-Profile curve + residual LUT are the per-image AUTO-profile LOOK
    // artifacts (fit in gamma space from a camera JPEG). NON-RAW input has no
    // JPEG to fit, so there is no look to apply — and applying the default
    // "identity" artifacts is NOT a no-op: it crushes white from 1.0 to ~0.973
    // (byte 248 instead of 255). The CPU non-RAW path runs ONLY display_encode +
    // srgb_gamma for exactly this reason. Skip them for non-RAW so the colorimetric
    // encode is the whole tail; RAW keeps them — but ONLY when actually fitted
    // (Neutral / unavailable-Auto carry empty/0 artifacts, and the CPU RAW path
    // `if let Some`s past them too). Each artifact gates independently, via the
    // same presence predicates the full composer uses.
    // #1516 (completes the #1513 non-RAW view-tail skip — AgX above + look here).
    if is_raw_shape && profile_curve_is_active(&inputs.profile_curve_flat) {
        sink.push(AutoProfileCurvePass {
            flat_curve: inputs.profile_curve_flat.as_ref().into(),
        });
    }
    if is_raw_shape && residual_lut_is_active(inputs.residual_lut_size, &inputs.residual_lut_data) {
        sink.push(ResidualLutPass {
            size: inputs.residual_lut_size,
            data: inputs.residual_lut_data.as_ref().into(),
        });
    }
}
