using System.Runtime.InteropServices;
using Maple.WinUI.Models;
using Maple.WinUI.Services;

namespace Maple.WinUI.Native
{
    /// <summary>
    /// C-ABI mirror of raw-ffi's MapleGpuLiveParams (gpu_live.rs) — the per-tick
    /// params for the wgpu live chain. Field order matches the Rust declaration;
    /// fields are append-only at the tail. All pointer fields are borrowed for
    /// the call only and stay null here (tone curves ship with #2576; the Auto
    /// Profile curve/LUT are unused on the Neutral-profile Windows decode path).
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    public unsafe struct MapleGpuLiveParams
    {
        public float temperature;
        public float tint;
        public uint wb_method;            // 0 = CAT16, 1 = diagonal Rec.2020
        public float exposure;
        public float highlights;
        public float shadows;
        public float whites;
        public float blacks;
        public float contrast;
        public float parametric_shadows;
        public float parametric_darks;
        public float parametric_lights;
        public float parametric_highlights;
        public uint tone_curve_mode;      // 0 = PerChannel, 1 = RatioPreserving
        public float vibrance;
        public float saturation;
        public float clarity;
        public float texture;
        public float dehaze;
        public float sharpen_amount;
        public float sharpen_radius;
        public float sharpen_detail;
        public float sharpen_masking;
        public float nr_luminance;
        public float nr_color;
        public uint capture_sharpening_enabled;
        public float capture_sharpening_sigma;
        public uint capture_sharpening_iterations;
        public float capture_sharpening_highlight_threshold;
        public float capture_sharpening_strength;
        public float* tone_curve_luma_ptr;
        public nuint tone_curve_luma_len;
        public float* tone_curve_red_ptr;
        public nuint tone_curve_red_len;
        public float* tone_curve_green_ptr;
        public nuint tone_curve_green_len;
        public float* tone_curve_blue_ptr;
        public nuint tone_curve_blue_len;
        public float* profile_curve_ptr;
        public nuint profile_curve_len;
        public uint residual_lut_size;
        public float* residual_lut_ptr;
        public nuint residual_lut_len;
        public float brightness;
        public float vignette_amount;
        public float vignette_feather;
        public float grain_amount;
        public float grain_size;
        public float grain_roughness;
        public float split_tone_shadow_hue;
        public float split_tone_shadow_saturation;
        public float split_tone_highlight_hue;
        public float split_tone_highlight_saturation;
        public float split_tone_balance;
        public float hsl_hue_red;
        public float hsl_hue_orange;
        public float hsl_hue_yellow;
        public float hsl_hue_green;
        public float hsl_hue_aqua;
        public float hsl_hue_blue;
        public float hsl_hue_purple;
        public float hsl_hue_magenta;
        public float hsl_sat_red;
        public float hsl_sat_orange;
        public float hsl_sat_yellow;
        public float hsl_sat_green;
        public float hsl_sat_aqua;
        public float hsl_sat_blue;
        public float hsl_sat_purple;
        public float hsl_sat_magenta;
        public float hsl_lum_red;
        public float hsl_lum_orange;
        public float hsl_lum_yellow;
        public float hsl_lum_green;
        public float hsl_lum_aqua;
        public float hsl_lum_blue;
        public float hsl_lum_purple;
        public float hsl_lum_magenta;
        public float decoded_temperature;
        public float decoded_tint;
        public uint target_primaries;     // 0 = sRGB
        public uint input_shape;          // 0 = PostDcpRec2020 RAW path
        public fixed float wb_frame_m_cold[9];
        public float wb_frame_cct_cold;
        public fixed float wb_frame_m_warm[9];
        public float wb_frame_cct_warm;
        public float wb_frame_scene_cct;
        public float wb_frame_as_shot_tint;
        public fixed float wb_frame_render_cm[9];
        public fixed float wb_frame_render_forward_matrix[9];
        public fixed float wb_frame_render_scene_white_xyz[3];
        public float wb_frame_render_wb_already_baked;
        public fixed float wb_frame_render_cm_cold[9];
        public float wb_frame_render_cct_cold;
        public fixed float wb_frame_render_cm_warm[9];
        public float wb_frame_render_cct_warm;
        public fixed float wb_frame_render_fm_cold[9];
        public fixed float wb_frame_render_fm_warm[9];
        public float bw_active;
        public float bw_mix_red;
        public float bw_mix_orange;
        public float bw_mix_yellow;
        public float bw_mix_green;
        public float bw_mix_aqua;
        public float bw_mix_blue;
        public float bw_mix_purple;
        public float bw_mix_magenta;
        public float color_grade_shadow_luminance;
        public float color_grade_midtone_hue;
        public float color_grade_midtone_saturation;
        public float color_grade_midtone_luminance;
        public float color_grade_highlight_luminance;
        public float color_grade_global_hue;
        public float color_grade_global_saturation;
        public float color_grade_global_luminance;
        public float* local_adjustments_ptr;
        public nuint local_adjustments_len;
        public float* noise_profile_ptr;
        public uint noise_profile_len;
        public uint iso;
        // Film look (epic #2683, Task 8) — the C# side has no LUT-provisioning
        // path yet (out of scope here), so these are always left at their
        // struct-default zero/null, which raw-ffi's own doc contract reads as
        // "no look loaded" — a bit-identical no-op, same as every pre-#2683
        // host. Present ONLY to keep this mirror's memory layout aligned with
        // the real Rust struct for the fields appended after them (#3152).
        public float film_strength;
        public uint film_lut_size;
        public uint film_lut_key;
        public float* film_lut_ptr;
        public nuint film_lut_len;
        // Parametric tone-curve split points (#3152) — ACR default 25/50/75,
        // populated from the model's `Parametric*Split` fields (#3223).
        // raw-ffi's `inputs_from_params` treats the WHOLE TRIPLE being
        // exactly 0.0 as "host predates this field" and substitutes the
        // canonical defaults, so a genuine 0 in one of the three is still
        // expressible as long as the other two aren't also 0.
        public float parametric_shadow_split;
        public float parametric_midtone_split;
        public float parametric_highlight_split;
        // Display-referred (post-AgX) tone curves (#2232) — crs:ToneCurvePV2012*.
        // Left null/0 below, same convention as tone_curve_*_ptr above and
        // parametric_shadow_split's comment: raw-ffi reads a null pointer /
        // zero len as "identity curve" (no pass), so leaving these unset here
        // is the correct legacy-equivalent behavior on this struct until the
        // fast-preview GPU path wires real curve pointers through (tracked
        // with the same pre-existing gap as tone_curve_luma_ptr et al., not
        // introduced by this field addition).
        public float* display_tone_curve_luma_ptr;
        public nuint display_tone_curve_luma_len;
        public float* display_tone_curve_red_ptr;
        public nuint display_tone_curve_red_len;
        public float* display_tone_curve_green_ptr;
        public nuint display_tone_curve_green_len;
        public float* display_tone_curve_blue_ptr;
        public nuint display_tone_curve_blue_len;
        // Vectorscope scope statistics (#3272, raw-ffi's mask_registry/scope_stats
        // work). Left at the struct default (0 / 0 / null) by every builder below —
        // Windows does not yet drive the scope pass — which reads as "disabled",
        // the same "zeroed tail = pre-#3272 behaviour" convention every other
        // tail field on this mirror already follows. `scope_out` is untyped
        // (`void*`, not a `MapleScopeStats*`) because that struct has no C# mirror
        // yet — nothing here ever writes through it while it stays null.
        public int scope_layer;
        public byte scope_enabled;
        public void* scope_out;
        // Geometry follows the pre-existing scope fields in raw-ffi's ABI.
        public float geo_perspective_h;
        public float geo_perspective_v;
        public float geo_rotation;
        public float geo_aspect;
        public float geo_scale;

        /// <summary>
        /// Build live-chain params from the canonical model + decode exports.
        /// The wb_frame block is applied separately (WriteWbFrame) and the
        /// noise-profile pointer is set inside the render call's fixed scope.
        /// </summary>
        public static MapleGpuLiveParams From(
            AdjustmentState m, DecodedImage image)
        {
            var p = new MapleGpuLiveParams
            {
                temperature = (float)m.Temperature,
                geo_perspective_h = (float)m.GeoPerspectiveH,
                geo_perspective_v = (float)m.GeoPerspectiveV,
                geo_rotation = (float)m.GeoRotation,
                geo_aspect = (float)m.GeoAspect,
                geo_scale = (float)m.GeoScale,
                tint = (float)m.Tint,
                wb_method = m.WbMethod == WbMethod.DiagonalRec2020 ? 1u : 0u,
                exposure = (float)m.Exposure,
                highlights = (float)m.Highlights,
                shadows = (float)m.Shadows,
                whites = (float)m.Whites,
                blacks = (float)m.Blacks,
                contrast = (float)m.Contrast,
                parametric_shadows = (float)m.ParametricShadows,
                parametric_darks = (float)m.ParametricDarks,
                parametric_lights = (float)m.ParametricLights,
                parametric_highlights = (float)m.ParametricHighlights,
                parametric_shadow_split = (float)m.ParametricShadowSplit,
                parametric_midtone_split = (float)m.ParametricMidtoneSplit,
                parametric_highlight_split = (float)m.ParametricHighlightSplit,
                tone_curve_mode = m.ToneCurveMode == ToneCurveMode.RatioPreserving ? 1u : 0u,
                vibrance = (float)m.Vibrance,
                saturation = (float)m.Saturation,
                clarity = (float)m.Clarity,
                texture = (float)m.Texture,
                dehaze = (float)m.Dehaze,
                sharpen_amount = (float)m.SharpenAmount,
                sharpen_radius = (float)m.SharpenRadius,
                sharpen_detail = (float)m.SharpenDetail,
                sharpen_masking = (float)m.SharpenMasking,
                nr_luminance = (float)m.NrLuminance,
                nr_color = (float)m.NrColor,
                capture_sharpening_enabled = 0,
                brightness = (float)m.Brightness,
                vignette_amount = (float)m.VignetteAmount,
                vignette_feather = (float)m.VignetteFeather,
                grain_amount = (float)m.GrainAmount,
                grain_size = (float)m.GrainSize,
                grain_roughness = (float)m.GrainRoughness,
                split_tone_shadow_hue = (float)m.SplitToneShadowHue,
                split_tone_shadow_saturation = (float)m.SplitToneShadowSaturation,
                split_tone_highlight_hue = (float)m.SplitToneHighlightHue,
                split_tone_highlight_saturation = (float)m.SplitToneHighlightSaturation,
                split_tone_balance = (float)m.SplitToneBalance,
                hsl_hue_red = (float)m.HueAdjustmentRed,
                hsl_hue_orange = (float)m.HueAdjustmentOrange,
                hsl_hue_yellow = (float)m.HueAdjustmentYellow,
                hsl_hue_green = (float)m.HueAdjustmentGreen,
                hsl_hue_aqua = (float)m.HueAdjustmentAqua,
                hsl_hue_blue = (float)m.HueAdjustmentBlue,
                hsl_hue_purple = (float)m.HueAdjustmentPurple,
                hsl_hue_magenta = (float)m.HueAdjustmentMagenta,
                hsl_sat_red = (float)m.SaturationAdjustmentRed,
                hsl_sat_orange = (float)m.SaturationAdjustmentOrange,
                hsl_sat_yellow = (float)m.SaturationAdjustmentYellow,
                hsl_sat_green = (float)m.SaturationAdjustmentGreen,
                hsl_sat_aqua = (float)m.SaturationAdjustmentAqua,
                hsl_sat_blue = (float)m.SaturationAdjustmentBlue,
                hsl_sat_purple = (float)m.SaturationAdjustmentPurple,
                hsl_sat_magenta = (float)m.SaturationAdjustmentMagenta,
                hsl_lum_red = (float)m.LuminanceAdjustmentRed,
                hsl_lum_orange = (float)m.LuminanceAdjustmentOrange,
                hsl_lum_yellow = (float)m.LuminanceAdjustmentYellow,
                hsl_lum_green = (float)m.LuminanceAdjustmentGreen,
                hsl_lum_aqua = (float)m.LuminanceAdjustmentAqua,
                hsl_lum_blue = (float)m.LuminanceAdjustmentBlue,
                hsl_lum_purple = (float)m.LuminanceAdjustmentPurple,
                hsl_lum_magenta = (float)m.LuminanceAdjustmentMagenta,
                decoded_temperature = image.DecodedTemperature,
                decoded_tint = image.DecodedTint,
                target_primaries = 0,
                input_shape = 0,
                bw_active = m.BlackWhite == ToggleMode.On ? 1f : 0f,
                bw_mix_red = (float)m.GrayMixerRed,
                bw_mix_orange = (float)m.GrayMixerOrange,
                bw_mix_yellow = (float)m.GrayMixerYellow,
                bw_mix_green = (float)m.GrayMixerGreen,
                bw_mix_aqua = (float)m.GrayMixerAqua,
                bw_mix_blue = (float)m.GrayMixerBlue,
                bw_mix_purple = (float)m.GrayMixerPurple,
                bw_mix_magenta = (float)m.GrayMixerMagenta,
                color_grade_shadow_luminance = (float)m.ColorGradeShadowLuminance,
                color_grade_midtone_hue = (float)m.ColorGradeMidtoneHue,
                color_grade_midtone_saturation = (float)m.ColorGradeMidtoneSaturation,
                color_grade_midtone_luminance = (float)m.ColorGradeMidtoneLuminance,
                color_grade_highlight_luminance = (float)m.ColorGradeHighlightLuminance,
                color_grade_global_hue = (float)m.ColorGradeGlobalHue,
                color_grade_global_saturation = (float)m.ColorGradeGlobalSaturation,
                color_grade_global_luminance = (float)m.ColorGradeGlobalLuminance,
                iso = image.Iso,
            };
            WriteWbFrame(ref p, image.WbFrame);
            return p;
        }

        /// <summary>Apply the 82-float decode-exported wb_frame block (same field
        /// order as MapleAdjustmentParams / MapleSceneLinearBufferF32).</summary>
        private static void WriteWbFrame(ref MapleGpuLiveParams p, float[] f)
        {
            var i = 0;
            fixed (MapleGpuLiveParams* pp = &p)
            {
                for (var k = 0; k < 9; k++) pp->wb_frame_m_cold[k] = f[i++];
                pp->wb_frame_cct_cold = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_m_warm[k] = f[i++];
                pp->wb_frame_cct_warm = f[i++];
                pp->wb_frame_scene_cct = f[i++];
                pp->wb_frame_as_shot_tint = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_cm[k] = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_forward_matrix[k] = f[i++];
                for (var k = 0; k < 3; k++) pp->wb_frame_render_scene_white_xyz[k] = f[i++];
                pp->wb_frame_render_wb_already_baked = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_cm_cold[k] = f[i++];
                pp->wb_frame_render_cct_cold = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_cm_warm[k] = f[i++];
                pp->wb_frame_render_cct_warm = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_fm_cold[k] = f[i++];
                for (var k = 0; k < 9; k++) pp->wb_frame_render_fm_warm[k] = f[i++];
            }
        }
    }
}
