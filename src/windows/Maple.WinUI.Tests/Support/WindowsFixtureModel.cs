// WindowsFixtureModel — the Windows-shell analogue of
// `XMPCanonicalFormatTests.canonicalFixtureModel` (Swift) /
// `canonicalFixtureModel` (`xmp-canonical.spec.ts`, TypeScript): every field
// the Windows model actually carries, set to a distinctive non-default
// value, so the writer's omit-at-default rule can't hide a field this suite
// forgot to exercise.
//
// It is deliberately NOT the same field set as the two-platform golden in
// `docs/xmp-canonical-format.md` / `XMPCanonicalFormatTests.swift` /
// `xmp-canonical.spec.ts`. `AdjustmentState` (Models/AdjustmentState.cs) is a
// structural subset of the full cross-platform `AdjustmentModel`: no crop,
// no keywords (`dc:subject`), no metadata block (title/creator/description/
// rights), and no `whiteBalancePreset` (so no `crs:WhiteBalance`) — none of
// these have a Windows editor surface yet. A byte-for-byte comparison against
// the cross-platform golden literal would therefore fail for reasons that
// are missing UI, not a broken serializer, which would bury any real
// divergence under noise. This fixture instead pins down everything Windows
// DOES model, at the same field values as the cross-platform golden wherever
// the field exists on both (temperature, tint, exposure, …) — same numbers,
// smaller field set — so the two suites stay easy to eyeball against each
// other without claiming an equivalence Windows can't back up yet.
//
// The tone-curve points are the two-platform golden's wire-domain values
// verbatim (`docs/xmp-canonical-format.md` § "Tone curves": Windows stores
// curve points already in the `[0, 255]` wire domain, unlike Apple/TS which
// store `[0, 1]` and rescale at the serializer boundary), so the same
// `rdf:li` text this fixture produces is directly comparable to the golden
// document's.

using System.Collections.Generic;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Tests.Support
{
    internal static class WindowsFixtureModel
    {
        /// <summary>Every <see cref="AdjustmentState"/> field at a distinctive
        /// non-default value.</summary>
        public static AdjustmentState BuildAdjustments() => new()
        {
            Temperature = 5200,
            Tint = -14.5,
            WbMethod = WbMethod.DiagonalRec2020,
            Exposure = 0.5,
            Brightness = 6,
            Contrast = 12,
            Highlights = -30,
            Shadows = 25,
            Whites = 8,
            Blacks = -6,
            ParametricHighlights = 4,
            ParametricLights = -3,
            ParametricDarks = 2.5,
            ParametricShadows = -1,
            Vibrance = 15,
            Saturation = -10,
            Clarity = 20,
            Texture = 7,
            Dehaze = 5,
            SharpenAmount = 55,
            SharpenRadius = 1.4,
            SharpenDetail = 30,
            SharpenMasking = 12,
            CaptureSharpeningAmount = 35,
            CaptureSharpeningSigma = 0.8,
            NrLuminance = 18,
            NrColor = 30,
            ChromaPrefilter = 3,
            DeepDenoise = 9,
            HotPixelSuppression = ToggleMode.On,
            VignetteAmount = -20,
            VignetteFeather = 40,
            GrainAmount = 10,
            GrainSize = 30,
            GrainRoughness = 45,
            SplitToneShadowHue = 210,
            SplitToneShadowSaturation = 12,
            SplitToneHighlightHue = 45,
            SplitToneHighlightSaturation = 8,
            SplitToneBalance = -5,
            ColorGradeShadowLuminance = 3,
            ColorGradeMidtoneHue = 120,
            ColorGradeMidtoneSaturation = 14,
            ColorGradeMidtoneLuminance = -2,
            ColorGradeHighlightLuminance = 6,
            ColorGradeGlobalHue = 300,
            ColorGradeGlobalSaturation = 9,
            ColorGradeGlobalLuminance = 1,
            HueAdjustmentRed = 5,
            HueAdjustmentAqua = -7,
            SaturationAdjustmentGreen = 11,
            LuminanceAdjustmentBlue = -13,
            BlackWhite = ToggleMode.On,
            GrayMixerRed = 22,
            GrayMixerMagenta = -18,
            ToneCurveLuma = new List<CurvePoint>
            {
                new(0, 0), new(127.5, 140.25), new(255, 255),
            },
            ToneCurveBlue = new List<CurvePoint> { new(0, 0), new(255, 204) },
            ToneCurveMode = ToneCurveMode.RatioPreserving,
            HighlightRecovery = HighlightRecoveryMode.Blend,
            AutoExposure = ToggleMode.Off,
            Look = LookMode.Neutral,
            Profile = ProfileMode.Neutral,
            LensProfileEnable = ToggleMode.Off,
            LensCorrectionDistortion = 85,
            LensCorrectionCa = 70,
            LensCorrectionVignetting = 60,
        };

        /// <summary>The full sidecar: <see cref="BuildAdjustments"/> plus every
        /// culling field set.</summary>
        public static XmpSidecarDocument BuildDocument() => new()
        {
            Adjustments = BuildAdjustments(),
            Rating = 4,
            Flag = "pick",
            ColorLabel = "green",
            Version = "11.0",
            ProcessVersion = "11.0",
            WbScaleVersion = 5,
        };
    }
}
