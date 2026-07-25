// GpuLiveParams.swift — map an AdjustmentModel to the wgpu live chain's
// `MapleGpuLiveParams`, honoring the DECODE-BOUNDARY CONTRACT (epic #925,
// P4b-apple / #1028).
//
// Always compiled — the `MapleGpuLiveParams` struct is in the default xcframework
// header now (gpu is the default xcframework build). Used only when the runtime
// flag is on (`GpuLiveFlag.isEnabled`); otherwise the live render path is unused.
//
// ## The decode-boundary contract (the load-bearing part)
//
// Apple decode (`maple_render_file_scene_linear_f32`) BAKES `auto_exposure` +
// `capture_sharpening` into the cached scene-linear buffer the live session
// uploads. So the live wgpu chain MUST:
//
//   * pass `capture_sharpening_enabled = 0` — it is already baked; including it
//     would double-apply (and there is zero harness coverage of that).
//   * NOT re-run auto-exposure — the chain has no AE stage; the buffer is already
//     AE-developed. (For Profile::Auto the decode runs AE-OFF and the Auto curve
//     owns the brightness mapping; for Neutral, AE-ON. The decoded buffer's AE
//     state is correct by construction — the editor's decode cache is profile-
//     keyed — so the chain just must not stack another AE.)
//   * derive WB from the live `temperature`/`tint` as a DELTA off the decoded
//     anchor the caller supplies via `asShotCCT`/`asShotTint` (#1240, #1734).
//     `MapleGpuLiveParams` carries temp/tint plus the decoded anchor; the FFI
//     composes `M_net = wb_cat16_matrix(live) · wb_cat16_matrix(decoded)⁻¹` —
//     identity when live == decoded, matching `raw_core::white_balance::apply_delta`.
//     For RAW assets the caller passes the as-shot CCT/tint (the CPU develop
//     chain's `apply_delta(live, asShot)` contract). For non-RAW assets
//     (JPEG/HEIF/pano) there is no as-shot anchor — the buffer is already at
//     D65 — so the caller (`EditSession+GpuLive.swift`) passes `6500.0/0.0`
//     explicitly. The 0/0 sentinel fallback is ALL-OR-NOTHING: a caller that
//     supplies neither, OR supplies only one of the two (a caller bug), falls
//     back to the legacy 0/0 sentinel below, which the FFI reads as "no
//     decoded anchor" and applies `M_live` absolutely — preserved for callers
//     written before #1240 that still expect the pre-delta behavior.
//   * pass the REAL `sharpen_amount` / `nr_color` / `nr_luminance` — the chain
//     runs them at their canonical scene-linear positions, REPLACING the post-AgX
//     Metal kernels (`MetalKernels.applySceneSharpen` / `applySceneNRColor`). This
//     is the sanctioned "convergence" divergence: sharpen + nr_color move from
//     display-linear (post-AgX) into the scene-linear chain.
//
// Auto Profile rides the chain's curve + residual-LUT passes (the A2
// `maple_gpu_fit_auto_profile` artifacts), NOT a pre-composed CIColorCube — wired
// at the session's render call, not here (the pointers must outlive the call).

import Foundation
import RawPipeline

extension PipelineRenderer {
    /// Build the SCALAR fields of `MapleGpuLiveParams` from `model`, applying the
    /// decode-boundary contract (see the file header). The variable-length array
    /// pointers (the Auto Profile curve, the residual LUT, and — once Swift mirrors
    /// them — point tone curves) are left NULL/zero here and wired by the caller
    /// inside a `withUnsafe…` scope where the backing buffers are alive (the FFI
    /// reads them only for the duration of the render call; storing them here would
    /// dangle).
    ///
    /// `wb_method` defaults to CAT16 (0) — the Apple model carries no WB-method
    /// field, matching `develop`'s default. `tone_curve_mode` defaults to
    /// PerChannel (0). Per-channel POINT curves are not yet mirrored on the Swift
    /// `AdjustmentModel` (only the parametric region sliders are — see
    /// `AdjustmentModel`'s tone-curve comment), so those arrays stay empty; the
    /// parametric fields carry the user's tone-region edits.
    /// `inputShape` is the `MapleGpuLiveParams.input_shape` tag (#1331): 0 =
    /// PostDcpRec2020Fp16 (RAW, all stages; the historic default), 1 =
    /// LinearRec2020Fp16 (pano PNG — capture_sharpening is skipped; WB stays
    /// engaged). Callers that don't pass it get 0 (RAW), preserving pre-#1331
    /// behaviour. The D65 WB anchor for non-RAW shapes is the CALLER's
    /// responsibility (`asShotCCT`/`asShotTint`, #1734) — this function does not
    /// infer an anchor from `inputShape`, keeping a single source of truth for
    /// the non-RAW contract at the `EditSession+GpuLive.swift` call site.
    /// `wbFrame` (#1781): the decode-exported WB slider frame. When present
    /// (and a decoded anchor is engaged) the FFI derives the WB matrix in
    /// that frame — the same `wb_camera` math the CPU develop uses — via
    /// `SliderFrameExport::rec2020_delta_matrix`, closing the
    /// live-vs-refine seam. `nil` leaves the `wb_frame_*` tail zeroed:
    /// the legacy generic-CAT16 delta, bit-identical to pre-#1781.
    public static func makeGpuLiveParams(
        from model: AdjustmentModel,
        asShotCCT: Double? = nil,
        asShotTint: Double? = nil,
        inputShape: UInt32 = 0,
        wbFrame: WbSliderFrame? = nil
    ) -> MapleGpuLiveParams {
        // Per-field assignment (not a literal init) — the Swift expression type-
        // checker hits its complexity ceiling on a ~40-field literal init, exactly
        // as `makeParams` documents for the 18-field `MapleAdjustmentParams`.
        var p = MapleGpuLiveParams()

        // --- white balance (DELTA when `asShotCCT/asShotTint` are supplied:
        //     the FFI computes `M_net = M_live · M_decoded⁻¹` matching
        //     `apply_delta`. With `decoded == asShot`, the matrix is identity
        //     at `live == asShot` (default slider value), mirroring the CPU
        //     `processSceneLinear` contract. When asShot is unknown / not
        //     supplied, write the 0/0 sentinel so the FFI takes the legacy
        //     ABSOLUTE branch (`M_net = M_live`) — explicitly NOT 6500/0,
        //     because `wb_cat16_matrix(6500, 0)` is not exact identity and
        //     composing with its inverse would silently shift the legacy
        //     output. (Copilot review on #1262.) #1240 follow-up.
        //
        //     The 0/0 sentinel fallback is an ALL-OR-NOTHING pair, not a
        //     per-field default: `decodedAnchor` below requires BOTH
        //     `asShotCCT` and `asShotTint` to be non-nil before using either,
        //     so a caller that (by mistake) supplies only one of the two
        //     still gets the legacy sentinel instead of a silently
        //     half-populated anchor (temp=asShot, tint=0) that would corrupt
        //     the WB delta math. (#1747 review fix — an earlier version
        //     defaulted each field independently via `?? 0.0`.)
        let decodedAnchor: (temperature: Double, tint: Double) =
            if let asShotCCT, let asShotTint {
                (asShotCCT, asShotTint)
            } else {
                (0.0, 0.0)
            }

        // --- render-shaping profile (#1722) --- profile_id lives at the
        // struct TAIL (append-only ABI); 0 = AgX (Auto/Neutral view path),
        // 2 = AcrMatch baked-LUT transform.
        p.profile_id = model.profile == .acrMatch ? 2 : 0

        p.temperature = Float(model.temperature)
        p.tint = Float(model.tint)
        p.decoded_temperature = Float(decodedAnchor.temperature)
        p.decoded_tint = Float(decodedAnchor.tint)
        p.wb_method = 0 // CAT16 (the Apple model carries no method field)

        // --- scene tone controls ---
        p.exposure = Float(model.exposure)
        // Brightness (#1102): midtone-band gain — lives at the struct TAIL
        // in the C ABI (append-only convention) but belongs to the scene
        // tone group semantically; the FFI re-orders it into the chain's
        // tone array between exposure and highlights.
        p.brightness = Float(model.brightness)
        p.highlights = Float(model.highlights)
        p.shadows = Float(model.shadows)
        p.whites = Float(model.whites)
        p.blacks = Float(model.blacks)

        // --- AgX contrast (routed to the sigmoid slope) ---
        p.contrast = Float(model.contrast)

        // --- parametric tone-curve region sliders ---
        p.parametric_shadows = Float(model.parametricShadows)
        p.parametric_darks = Float(model.parametricDarks)
        p.parametric_lights = Float(model.parametricLights)
        p.parametric_highlights = Float(model.parametricHighlights)
        p.tone_curve_mode = 0 // PerChannel (Apple model has no per-channel mode field)

        // --- color / spatial sliders ---
        p.vibrance = Float(model.vibrance)
        p.saturation = Float(model.saturation)
        p.clarity = Float(model.clarity)
        p.texture = Float(model.texture)
        p.dehaze = Float(model.dehaze)

        // Vignette (#1109) — scene-linear radial gain; lives at the struct
        // TAIL in the C ABI (append-only convention, like brightness) but
        // belongs to the effects group semantically; the chain runs it
        // between dehaze and sharpen.
        p.vignette_amount = Float(model.vignetteAmount)
        p.vignette_feather = Float(model.vignetteFeather)

        // Film grain (#1110) — display-linear deterministic noise; struct
        // tail per the same convention; the chain runs it between agx and
        // display_encode.
        p.grain_amount = Float(model.grainAmount)
        p.grain_size = Float(model.grainSize)
        p.grain_roughness = Float(model.grainRoughness)

        // Split toning (#1111) — display-linear Oklab tint; struct tail
        // per the same convention; the chain runs it between agx and grain.
        p.split_tone_shadow_hue = Float(model.splitToneShadowHue)
        p.split_tone_shadow_saturation = Float(model.splitToneShadowSaturation)
        p.split_tone_highlight_hue = Float(model.splitToneHighlightHue)
        p.split_tone_highlight_saturation = Float(model.splitToneHighlightSaturation)
        p.split_tone_balance = Float(model.splitToneBalance)

        // Color Grading (#275) — the rest of the panel beyond the five
        // `split_tone_*` fields above (ACR's `crs:SplitToning*` shadow/
        // highlight pairs and balance); struct tail per the same
        // append-only ABI convention.
        p.color_grade_shadow_luminance = Float(model.colorGradeShadowLuminance)
        p.color_grade_midtone_hue = Float(model.colorGradeMidtoneHue)
        p.color_grade_midtone_saturation = Float(model.colorGradeMidtoneSaturation)
        p.color_grade_midtone_luminance = Float(model.colorGradeMidtoneLuminance)
        p.color_grade_highlight_luminance = Float(model.colorGradeHighlightLuminance)
        p.color_grade_global_hue = Float(model.colorGradeGlobalHue)
        p.color_grade_global_saturation = Float(model.colorGradeGlobalSaturation)
        p.color_grade_global_luminance = Float(model.colorGradeGlobalLuminance)

        // HSL 8-band adjustments (#1112) — scene-linear Oklab; the chain
        // runs after saturation / before clarity.
        p.hsl_hue_red      = Float(model.hueAdjustmentRed)
        p.hsl_hue_orange   = Float(model.hueAdjustmentOrange)
        p.hsl_hue_yellow   = Float(model.hueAdjustmentYellow)
        p.hsl_hue_green    = Float(model.hueAdjustmentGreen)
        p.hsl_hue_aqua     = Float(model.hueAdjustmentAqua)
        p.hsl_hue_blue     = Float(model.hueAdjustmentBlue)
        p.hsl_hue_purple   = Float(model.hueAdjustmentPurple)
        p.hsl_hue_magenta  = Float(model.hueAdjustmentMagenta)
        p.hsl_sat_red      = Float(model.saturationAdjustmentRed)
        p.hsl_sat_orange   = Float(model.saturationAdjustmentOrange)
        p.hsl_sat_yellow   = Float(model.saturationAdjustmentYellow)
        p.hsl_sat_green    = Float(model.saturationAdjustmentGreen)
        p.hsl_sat_aqua     = Float(model.saturationAdjustmentAqua)
        p.hsl_sat_blue     = Float(model.saturationAdjustmentBlue)
        p.hsl_sat_purple   = Float(model.saturationAdjustmentPurple)
        p.hsl_sat_magenta  = Float(model.saturationAdjustmentMagenta)
        p.hsl_lum_red      = Float(model.luminanceAdjustmentRed)
        p.hsl_lum_orange   = Float(model.luminanceAdjustmentOrange)
        p.hsl_lum_yellow   = Float(model.luminanceAdjustmentYellow)
        p.hsl_lum_green    = Float(model.luminanceAdjustmentGreen)
        p.hsl_lum_aqua     = Float(model.luminanceAdjustmentAqua)
        p.hsl_lum_blue     = Float(model.luminanceAdjustmentBlue)
        p.hsl_lum_purple   = Float(model.luminanceAdjustmentPurple)
        p.hsl_lum_magenta  = Float(model.luminanceAdjustmentMagenta)

        // Black & white mix (#276) — same 8-band Oklab stage as the HSL
        // fields above; `bw_active` non-zero switches it into its
        // monochrome path (chroma forced to zero, `bw_mix_*` become the
        // per-band luminance weights). Lives at the struct TAIL (append-
        // only ABI, same convention as brightness / vignette / etc.).
        p.bw_active       = model.blackWhite == .on ? 1 : 0
        p.bw_mix_red      = Float(model.grayMixerRed)
        p.bw_mix_orange   = Float(model.grayMixerOrange)
        p.bw_mix_yellow   = Float(model.grayMixerYellow)
        p.bw_mix_green    = Float(model.grayMixerGreen)
        p.bw_mix_aqua     = Float(model.grayMixerAqua)
        p.bw_mix_blue     = Float(model.grayMixerBlue)
        p.bw_mix_purple   = Float(model.grayMixerPurple)
        p.bw_mix_magenta  = Float(model.grayMixerMagenta)

        // REAL sharpen + NR — run IN the scene-linear chain (replacing the post-AgX
        // Metal kernels), the sanctioned convergence divergence.
        p.sharpen_amount = Float(model.sharpenAmount)
        p.sharpen_radius = Float(model.sharpenRadius)
        p.sharpen_detail = Float(model.sharpenDetail)
        p.sharpen_masking = Float(model.sharpenMasking)
        p.nr_luminance = Float(model.nrLuminance)
        p.nr_color = Float(model.nrColor)

        // CAPTURE SHARPENING: DISABLED — already baked into the decoded buffer at
        // decode time (the decode-boundary contract). Including it would double-
        // apply. The remaining capture-sharpening fields are inert when disabled.
        p.capture_sharpening_enabled = 0
        p.capture_sharpening_sigma = 0
        p.capture_sharpening_iterations = 0
        p.capture_sharpening_highlight_threshold = 0
        p.capture_sharpening_strength = 0

        // Variable-length arrays — wired by the caller in a live `withUnsafe…`
        // scope (NULL/zero here so a forgotten wire is an explicit identity, not a
        // dangling read). Point tone curves are not mirrored on Swift yet.
        p.tone_curve_luma_ptr = nil
        p.tone_curve_luma_len = 0
        p.tone_curve_red_ptr = nil
        p.tone_curve_red_len = 0
        p.tone_curve_green_ptr = nil
        p.tone_curve_green_len = 0
        p.tone_curve_blue_ptr = nil
        p.tone_curve_blue_len = 0
        p.profile_curve_ptr = nil
        p.profile_curve_len = 0
        p.residual_lut_size = 0
        p.residual_lut_ptr = nil
        p.residual_lut_len = 0

        // Target display primaries (#1337): 0 = sRGB (legacy-compatible default).
        // Phase 2 (#1338) will set this from the user-facing settings toggle;
        // until then all renders stay on the sRGB path — no visible change.
        p.target_primaries = 0
        // Input shape tag (#1331): forwarded from the driver so the chain knows
        // which leading stages to run. 0 = RAW (full chain), 1 = pano PNG
        // (skip WB + capture_sharpening). The default (0) preserves the
        // pre-#1331 RAW behaviour for any caller that doesn't pass it.
        p.input_shape = inputShape

        // WB slider frame (#1781) — appended at the struct tail; absent
        // (`nil`, or !isPresent) leaves the zero-filled legacy state.
        if let wbFrame, wbFrame.isPresent {
            wbFrame.fill(&p)
        }

        return p
    }
}
