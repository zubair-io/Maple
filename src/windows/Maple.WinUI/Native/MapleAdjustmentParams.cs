using System.Runtime.InteropServices;
using Maple.WinUI.Models;

namespace Maple.WinUI.Native
{
    /// <summary>
    /// C-ABI mirror of raw-ffi's MapleAdjustmentParams (scene_linear_chain.rs).
    /// Field order matches the Rust declaration byte-for-byte; fields are only
    /// ever appended at the tail (offset-stable ABI convention). Expected size
    /// on x64: 672 bytes — asserted at startup by RawFfi.VerifyAbi().
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    public unsafe struct MapleAdjustmentParams
    {
        public float temperature;
        public float tint;
        public float exposure;
        public float contrast;
        public float highlights;
        public float shadows;
        public float whites;
        public float blacks;
        public float vibrance;
        public float saturation;
        public float clarity;
        public float texture;
        public float nr_luminance;
        public float dehaze;
        public float decoded_temperature;
        public float decoded_tint;
        public uint skip_agx;
        public byte look_mode;             // u8 + 3 bytes implicit padding
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
        public uint target_primaries;      // 0 = sRGB
        public uint input_shape;           // 0 = PostDcpRec2020 RAW path
        public float* noise_profile_ptr;   // borrowed for the call only
        public uint noise_profile_len;
        public uint iso;
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
        public float sharpen_amount;
        public float sharpen_radius;
        public float sharpen_detail;
        public float sharpen_masking;
        public float nr_color;
        public float* local_adjustments_ptr;
        public nuint local_adjustments_len;

        /// <summary>
        /// Build params from the canonical model, mirroring the Swift reference
        /// (PipelineRenderer.makeParams). Pointer fields stay null here — the
        /// noise-profile pointer is set on a local copy inside the render call,
        /// scoped to the FFI invocation.
        /// </summary>
        public static MapleAdjustmentParams From(
            AdjustmentState m, float decodedTemperature, float decodedTint, uint iso)
        {
            var p = new MapleAdjustmentParams
            {
                temperature = (float)m.Temperature,
                tint = (float)m.Tint,
                exposure = (float)m.Exposure,
                contrast = (float)m.Contrast,
                highlights = (float)m.Highlights,
                shadows = (float)m.Shadows,
                whites = (float)m.Whites,
                blacks = (float)m.Blacks,
                vibrance = (float)m.Vibrance,
                saturation = (float)m.Saturation,
                clarity = (float)m.Clarity,
                texture = (float)m.Texture,
                nr_luminance = (float)m.NrLuminance,
                dehaze = (float)m.Dehaze,
                decoded_temperature = decodedTemperature,
                decoded_tint = decodedTint,
                skip_agx = 0,
                look_mode = (byte)(m.Look == LookMode.Default ? 1 : 0),
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
                sharpen_amount = (float)m.SharpenAmount,
                sharpen_radius = (float)m.SharpenRadius,
                sharpen_detail = (float)m.SharpenDetail,
                sharpen_masking = (float)m.SharpenMasking,
                nr_color = (float)m.NrColor,
                target_primaries = 0,
                input_shape = 0,
                iso = iso,
            };
            return p;
        }
    }
}
