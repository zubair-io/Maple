//! Shared `MapleAdjustmentParams` -> chain-input mapping for every
//! scene-linear FFI entry (fp16, f32, and their `_with_patches` siblings).
//!
//! Before #1486 this ~180-line slider->`AdjustmentModel` mapping was copied
//! verbatim into `scene_linear_chain.rs` and `scene_linear_chain_f32_entry.rs`.
//! Adding the two patch-compositing entries would have made four copies of a
//! block that encodes load-bearing colour contracts (#1725/#1729 WB seen-flags,
//! the #1331/#1734 non-RAW D65 delta, the #1781 WB slider frame) — so it is
//! hoisted here once and shared. This is a pure extraction: the statements and
//! their ordering are unchanged from the fp16 entry.

use super::*;
use crate::wb_frame_flat::{wb_frame_from_flat, WbFrameFlat};

/// Everything the scene-linear chain needs that is derived purely from the
/// C-ABI params. `wb_frame` is owned here so callers can hand
/// `ChainOptions::wb_frame` a borrow that outlives the options struct.
pub(crate) struct ChainInputs<'a> {
    pub model: raw_core::xmp::AdjustmentModel,
    pub decoded_temp: f32,
    pub decoded_tint: f32,
    pub primaries: raw_core::view::encode::TargetPrimaries,
    pub wb_frame: raw_core::stages::wb_camera::SliderFrameExport,
    pub noise_profile: Option<&'a [f32]>,
    pub iso: u32,
}

impl<'a> ChainInputs<'a> {
    /// Assemble the `ChainOptions` view over these inputs.
    pub(crate) fn options(&'a self, skip_agx: bool) -> raw_core::pipeline::ChainOptions<'a> {
        raw_core::pipeline::ChainOptions {
            decoded_temp: self.decoded_temp,
            decoded_tint: self.decoded_tint,
            wb_frame: Some(&self.wb_frame),
            skip_agx,
            target_primaries: self.primaries,
            noise_profile: self.noise_profile,
            iso: self.iso,
        }
    }
}

/// # Safety
/// `p` must be a valid `MapleAdjustmentParams`; when `noise_profile_len > 0`
/// its `noise_profile_ptr` must be valid and aligned for that many `f32`s for
/// the duration of `'a`.
pub(crate) unsafe fn chain_inputs_from_params(p: &MapleAdjustmentParams) -> ChainInputs<'_> {
    // Build an AdjustmentModel from the C-ABI params. Fields the chain
    // uses get copied across; sharpen + nr_color stay default (they're
    // applied on the GPU after this call returns) and other fields keep
    // the AdjustmentModel::default() values so this matches the Rust
    // pipeline's behavior on the cheap-stage subset.
    let mut model = raw_core::xmp::AdjustmentModel::default();
    model.temperature = p.temperature;
    model.tint = p.tint;
    // FFI-supplied temperature and tint are ALWAYS explicit user state — the
    // Apple host serialises its live in-memory model and passes the values it
    // intends the pipeline to use verbatim.  Set both seen-flags to true so
    // `white_balance::resolve_wb` passes the values through unchanged.
    //
    // Without this, `resolve_wb` would fall through to its neither-seen branch
    // and compute `effective_tint = 0.0` regardless of the tint the host
    // supplied — zeroing any tint the user dialled in on every CPU refine render
    // while the GPU-live path applied it correctly, producing the horizontal
    // band visible when a refined region's WB differed from the live frame.
    // (#1725 / #1729)
    model.temperature_seen = true;
    model.tint_seen = true;
    model.exposure = p.exposure;
    model.brightness = p.brightness;
    model.contrast = p.contrast;
    model.highlights = p.highlights;
    model.shadows = p.shadows;
    model.whites = p.whites;
    model.blacks = p.blacks;
    model.vibrance = p.vibrance;
    model.saturation = p.saturation;
    model.clarity = p.clarity;
    model.texture = p.texture;
    model.nr_luminance = p.nr_luminance;
    model.dehaze = p.dehaze;
    model.vignette_amount = p.vignette_amount;
    model.vignette_feather = p.vignette_feather;
    model.grain_amount = p.grain_amount;
    model.grain_size = p.grain_size;
    model.grain_roughness = p.grain_roughness;
    model.split_tone_shadow_hue = p.split_tone_shadow_hue;
    model.split_tone_shadow_saturation = p.split_tone_shadow_saturation;
    model.split_tone_highlight_hue = p.split_tone_highlight_hue;
    model.split_tone_highlight_saturation = p.split_tone_highlight_saturation;
    model.split_tone_balance = p.split_tone_balance;
    // HSL 8-band adjustments (#1112)
    model.hue_adjustment_red = p.hsl_hue_red;
    model.hue_adjustment_orange = p.hsl_hue_orange;
    model.hue_adjustment_yellow = p.hsl_hue_yellow;
    model.hue_adjustment_green = p.hsl_hue_green;
    model.hue_adjustment_aqua = p.hsl_hue_aqua;
    model.hue_adjustment_blue = p.hsl_hue_blue;
    model.hue_adjustment_purple = p.hsl_hue_purple;
    model.hue_adjustment_magenta = p.hsl_hue_magenta;
    model.saturation_adjustment_red = p.hsl_sat_red;
    model.saturation_adjustment_orange = p.hsl_sat_orange;
    model.saturation_adjustment_yellow = p.hsl_sat_yellow;
    model.saturation_adjustment_green = p.hsl_sat_green;
    model.saturation_adjustment_aqua = p.hsl_sat_aqua;
    model.saturation_adjustment_blue = p.hsl_sat_blue;
    model.saturation_adjustment_purple = p.hsl_sat_purple;
    model.saturation_adjustment_magenta = p.hsl_sat_magenta;
    model.luminance_adjustment_red = p.hsl_lum_red;
    model.luminance_adjustment_orange = p.hsl_lum_orange;
    model.luminance_adjustment_yellow = p.hsl_lum_yellow;
    model.luminance_adjustment_green = p.hsl_lum_green;
    model.luminance_adjustment_aqua = p.hsl_lum_aqua;
    model.luminance_adjustment_blue = p.hsl_lum_blue;
    model.luminance_adjustment_purple = p.hsl_lum_purple;
    model.luminance_adjustment_magenta = p.hsl_lum_magenta;
    // Black & white mix (#276) — a stale host leaves `bw_active` 0 = colour.
    model.black_white = if p.bw_active != 0.0 {
        raw_core::types::BlackWhiteMode::On
    } else {
        raw_core::types::BlackWhiteMode::Off
    };
    model.gray_mixer_red = p.bw_mix_red;
    model.gray_mixer_orange = p.bw_mix_orange;
    model.gray_mixer_yellow = p.bw_mix_yellow;
    model.gray_mixer_green = p.bw_mix_green;
    model.gray_mixer_aqua = p.bw_mix_aqua;
    model.gray_mixer_blue = p.bw_mix_blue;
    model.gray_mixer_purple = p.bw_mix_purple;
    model.gray_mixer_magenta = p.bw_mix_magenta;
    model.look = raw_core::view::look::Look::from(p.look_mode);
    // Sharpen + chroma NR (#1043) — set EXPLICITLY from the params tail
    // rather than left at `AdjustmentModel::default()` (40 / 25), so a host
    // that predates the fields gets the identity short-circuit in both
    // stages instead of a surprise sharpen at 40.
    model.sharpen_amount = p.sharpen_amount;
    model.sharpen_radius = p.sharpen_radius;
    model.sharpen_detail = p.sharpen_detail;
    model.sharpen_masking = p.sharpen_masking;
    model.nr_color = p.nr_color;
    model.local_adjustments = read_local_adjustments(p);

    // Non-RAW WB contract (#1331 / #1734): for a non-RAW shape the uploaded
    // buffer is ALREADY at the correct linear Rec.2020 D65 white point (the
    // 8-bit JPEG/HEIF path was linearised at session open; the 16-bit pano
    // path was never WB-encoded) — there is no "as-shot" anchor to preserve,
    // only the D65 baseline. So the temp/tint sliders apply as a DELTA off
    // D65 (`decoded = 6500.0/0.0`), the SAME contract the GPU-live chain's
    // `inputs_from_params` uses when the host supplies a decoded anchor:
    // `M_net = wb(live) · wb(6500, 0)⁻¹`, identity at the default slider
    // position, shifting correctly as the user drags temp/tint.
    //
    // Earlier this branch collapsed the delta to IDENTITY outright
    // (`decoded = (p.temperature, p.tint)`, forcing `live == decoded`
    // unconditionally) — that made the temp/tint sliders permanently inert
    // on this CPU refine path regardless of the GPU-live half of the fix,
    // which is worse than the original drag-time-pop bug: a drag would shift
    // the image live on the GPU chain then SNAP BACK to unshifted on the next
    // CPU refine tick. Anchoring to D65 here instead keeps both paths
    // agreeing on the same delta at every slider position.
    //
    // Scoped to non-RAW only (`p.input_shape != 0`): RAW callers (shape 0)
    // keep the pre-existing `decoded_temperature`/`decoded_tint` passthrough
    // unchanged — the as-shot-anchored behavior legacy/headless RAW callers
    // depend on (Copilot review on #1262) is untouched by this fix.
    let (decoded_temp, decoded_tint) = if p.input_shape == 0 {
        (p.decoded_temperature, p.decoded_tint)
    } else {
        (6500.0, 0.0)
    };

    // Map the `target_primaries` u32 tag (#1337): 0 = sRGB (legacy / zero-init
    // default), 1 = Display P3.  Any other value falls back to sRGB —
    // matches the GPU-path convention (`Look::from` / `WbMethod` pattern).
    let primaries = raw_core::view::encode::TargetPrimaries::from_u32(p.target_primaries);

    // Decode the optional noise profile. `noise_profile_len == 0` or a null
    // pointer means "no profile" — pass `None` to the Rust chain so it falls
    // back to the ISO-based estimate (the pre-#1709 behaviour). When the host
    // provides a valid pointer + non-zero length, reconstruct a slice and
    // pass it through. The slice lifetime is bounded by this FFI call (the
    // host-owned buffer outlives the function call).
    let noise_profile_slice: Option<&[f32]> =
        if p.noise_profile_ptr.is_null() || p.noise_profile_len == 0 {
            None
        } else {
            // SAFETY: the caller guarantees the pointer is valid and aligned
            // for `noise_profile_len` f32 values for the duration of this call.
            Some(unsafe {
                std::slice::from_raw_parts(p.noise_profile_ptr, p.noise_profile_len as usize)
            })
        };
    let iso = if p.iso == 0 { 100 } else { p.iso };

    // WB slider frame (#1781): RAW shapes only — a non-RAW buffer has no
    // camera calibration and its D65-anchored delta stays on the generic
    // path. An absent frame (zeros) is `!is_present()` ⇒ legacy behaviour.
    let wb_frame = wb_frame_from_flat(&WbFrameFlat {
        m_cold: &p.wb_frame_m_cold,
        cct_cold: p.wb_frame_cct_cold,
        m_warm: &p.wb_frame_m_warm,
        cct_warm: p.wb_frame_cct_warm,
        scene_cct: if p.input_shape == 0 {
            p.wb_frame_scene_cct
        } else {
            0.0
        },
        as_shot_tint: p.wb_frame_as_shot_tint,
        render_cm: &p.wb_frame_render_cm,
        render_forward_matrix: &p.wb_frame_render_forward_matrix,
        render_scene_white_xyz: &p.wb_frame_render_scene_white_xyz,
        render_wb_already_baked: p.wb_frame_render_wb_already_baked,
        render_cm_cold: &p.wb_frame_render_cm_cold,
        render_cct_cold: p.wb_frame_render_cct_cold,
        render_cm_warm: &p.wb_frame_render_cm_warm,
        render_cct_warm: p.wb_frame_render_cct_warm,
        render_fm_cold: &p.wb_frame_render_fm_cold,
        render_fm_warm: &p.wb_frame_render_fm_warm,
    });
    ChainInputs {
        model,
        decoded_temp,
        decoded_tint,
        primaries,
        wb_frame,
        noise_profile: noise_profile_slice,
        iso,
    }
}
