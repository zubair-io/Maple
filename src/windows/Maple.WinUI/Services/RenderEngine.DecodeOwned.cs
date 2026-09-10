using System;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// The decode/chain split: which adjustment fields the DECODED BASE owns,
    /// and which the per-tick chain re-applies on top of it.
    ///
    /// Split out of RenderEngine.cs for the file-size budget (#2311). These two
    /// members are each other's mirror — <see cref="StripChainStages"/> says
    /// what the decode must NOT bake in, <see cref="DecodeInputsChanged"/> says
    /// what invalidates the base it produced — so a field added to one almost
    /// always belongs in the other, and keeping them adjacent is the point of
    /// the file. `partial` so both halves stay one `RenderEngine` type and no
    /// call site moves.
    /// </summary>
    public static unsafe partial class RenderEngine
    {
        /// <summary>
        /// Fields the per-tick chain re-applies must be zeroed in the decode
        /// model or they bake into the base image and double-apply
        /// (mirror of RawCoreBridge.stripAppleGPUStages on Apple).
        /// Profile is preserved: decode selects the AE anchor and fits the
        /// Auto tail that both the GPU and CPU per-tick paths apply.
        /// </summary>
        public static AdjustmentState StripChainStages(AdjustmentState model)
        {
            var d = new AdjustmentState();
            var m = model.Clone();
            m.Temperature = d.Temperature;
            m.Tint = d.Tint;
            m.Exposure = 0; m.Brightness = 0; m.Contrast = 0;
            m.Highlights = 0; m.Shadows = 0; m.Whites = 0; m.Blacks = 0;
            m.ParametricHighlights = 0; m.ParametricLights = 0;
            m.ParametricDarks = 0; m.ParametricShadows = 0;
            // Split points ride the same tone_curves stage as the four
            // scalars above (#3223, mirror of RawCoreBridge.stripAppleGPUStages).
            m.ParametricShadowSplit = d.ParametricShadowSplit;
            m.ParametricMidtoneSplit = d.ParametricMidtoneSplit;
            m.ParametricHighlightSplit = d.ParametricHighlightSplit;
            m.ToneCurveLuma.Clear(); m.ToneCurveRed.Clear();
            m.ToneCurveGreen.Clear(); m.ToneCurveBlue.Clear();
            m.DisplayToneCurveLuma.Clear(); m.DisplayToneCurveRed.Clear();
            m.DisplayToneCurveGreen.Clear(); m.DisplayToneCurveBlue.Clear();
            m.Crop = Models.CropState.Identity;   // display-side (#2582), never baked at decode
            m.Vibrance = 0; m.Saturation = 0; m.Clarity = 0; m.Texture = 0; m.Dehaze = 0;
            m.HueAdjustmentRed = 0; m.HueAdjustmentOrange = 0; m.HueAdjustmentYellow = 0;
            m.HueAdjustmentGreen = 0; m.HueAdjustmentAqua = 0; m.HueAdjustmentBlue = 0;
            m.HueAdjustmentPurple = 0; m.HueAdjustmentMagenta = 0;
            m.SaturationAdjustmentRed = 0; m.SaturationAdjustmentOrange = 0;
            m.SaturationAdjustmentYellow = 0; m.SaturationAdjustmentGreen = 0;
            m.SaturationAdjustmentAqua = 0; m.SaturationAdjustmentBlue = 0;
            m.SaturationAdjustmentPurple = 0; m.SaturationAdjustmentMagenta = 0;
            m.LuminanceAdjustmentRed = 0; m.LuminanceAdjustmentOrange = 0;
            m.LuminanceAdjustmentYellow = 0; m.LuminanceAdjustmentGreen = 0;
            m.LuminanceAdjustmentAqua = 0; m.LuminanceAdjustmentBlue = 0;
            m.LuminanceAdjustmentPurple = 0; m.LuminanceAdjustmentMagenta = 0;
            m.BlackWhite = ToggleMode.Off;
            m.GrayMixerRed = 0; m.GrayMixerOrange = 0; m.GrayMixerYellow = 0;
            m.GrayMixerGreen = 0; m.GrayMixerAqua = 0; m.GrayMixerBlue = 0;
            m.GrayMixerPurple = 0; m.GrayMixerMagenta = 0;
            m.SplitToneShadowHue = 0; m.SplitToneShadowSaturation = 0;
            m.SplitToneHighlightHue = 0; m.SplitToneHighlightSaturation = 0;
            m.SplitToneBalance = 0;
            m.ColorGradeShadowLuminance = 0; m.ColorGradeMidtoneHue = 0;
            m.ColorGradeMidtoneSaturation = 0; m.ColorGradeMidtoneLuminance = 0;
            m.ColorGradeHighlightLuminance = 0; m.ColorGradeGlobalHue = 0;
            m.ColorGradeGlobalSaturation = 0; m.ColorGradeGlobalLuminance = 0;
            m.VignetteAmount = 0; m.VignetteFeather = d.VignetteFeather;
            m.GrainAmount = 0; m.GrainSize = d.GrainSize; m.GrainRoughness = d.GrainRoughness;
            m.SharpenAmount = 0; m.SharpenRadius = d.SharpenRadius;
            m.SharpenDetail = d.SharpenDetail; m.SharpenMasking = 0;
            m.NrLuminance = 0; m.NrColor = 0;
            // Profile is PRESERVED (Auto by default): the decode owns the
            // AE-off anchor decision under Auto, and the fitted tail is applied
            // per tick (GPU curve/residual passes, CPU display LUT). Forcing
            // Neutral here measured mean ΔE00 ≈ 19 off the embedded JPEG.
            return m;
        }

        /// <summary>Fields owned by the decoded base, including the profile's
        /// AE anchor and fitted tail. A slider-only change reuses the base.</summary>
        public static bool DecodeInputsChanged(AdjustmentState before, AdjustmentState after) =>
            before.Profile != after.Profile
            || before.AutoExposure != after.AutoExposure
            || before.LensProfileEnable != after.LensProfileEnable
            // The imported profile and all three strengths are applied in the
            // scene-linear decode stage (#3480), never by the per-tick chain.
            || before.LensProfile != after.LensProfile
            || Math.Abs(before.LensCorrectionDistortion - after.LensCorrectionDistortion) > 1e-6
            || Math.Abs(before.LensCorrectionCa - after.LensCorrectionCa) > 1e-6
            || Math.Abs(before.LensCorrectionVignetting - after.LensCorrectionVignetting) > 1e-6
            || Math.Abs(before.CaptureSharpeningAmount - after.CaptureSharpeningAmount) > 1e-6
            // Sigma is the deconvolution PSF width — as decode-owned as Amount
            // (#3414). Without it a Sigma-only edit changed the sidecar and
            // never re-decoded, so the preview kept the old kernel.
            || Math.Abs(before.CaptureSharpeningSigma - after.CaptureSharpeningSigma) > 1e-6
            || Math.Abs(before.DeepDenoise - after.DeepDenoise) > 1e-6;
    }
}
