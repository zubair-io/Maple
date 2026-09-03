using System.Collections.Generic;

namespace Maple.WinUI.Models
{
    public enum WbMethod { Cat16, DiagonalRec2020 }
    public enum HighlightRecoveryMode { Off, Blend, Luminance, ChromaticAdaptation, OklabChromaReduction }
    public enum LookMode { Neutral, Default }
    public enum ProfileMode { Auto, Neutral }
    public enum ToneCurveMode { PerChannel, RatioPreserving }
    public enum ToggleMode { Off, On }

    /// <summary>One point of a tone curve; sidecar storage is linear (x, y) in [0, 255].</summary>
    public readonly record struct CurvePoint(double X, double Y);

    /// <summary>Crop rect + straighten angle (#2582), mirroring raw-core's
    /// Crop: edges normalized [0,1] against the display-oriented dimensions
    /// (origin top-left), angle in degrees, positive = clockwise. The wire
    /// form is crs:HasCrop / crs:Crop* — see docs/xmp-canonical-format.md.</summary>
    public record struct CropState(double Top, double Left, double Bottom, double Right, double Angle)
    {
        public static readonly CropState Identity = new(0, 0, 1, 1, 0);

        public readonly bool IsIdentity => this == Identity;
        public readonly bool RectIsIdentity => Top == 0 && Left == 0 && Bottom == 1 && Right == 1;
        public readonly bool RectIsValid =>
            Right > Left && Bottom > Top
            && Left >= 0 && Top >= 0 && Right <= 1 && Bottom <= 1;
    }

    /// <summary>
    /// Canonical adjustment model, mirroring raw-core's ADJUSTMENT_SCHEMA
    /// (see adjustment-model.generated.ts / AdjustmentModel+Generated.swift).
    /// Field defaults are the canonical raw-core defaults.
    /// </summary>
    public sealed class AdjustmentState
    {
        // --- White balance ---
        public double Temperature = 6500.0;          // [2000, 12000]
        public double Tint = 0.0;                    // [-150, 150]
        public WbMethod WbMethod = WbMethod.Cat16;

        // --- Tone ---
        public double Exposure = 0.0;                // [-4, 4] EV
        public double Brightness = 0.0;              // [-100, 100]
        public double Contrast = 0.0;
        public double Highlights = 0.0;
        public double Shadows = 0.0;
        public double Whites = 0.0;
        public double Blacks = 0.0;
        public double ParametricHighlights = 0.0;
        public double ParametricLights = 0.0;
        public double ParametricDarks = 0.0;
        public double ParametricShadows = 0.0;

        // --- Presence / color ---
        public double Vibrance = 0.0;
        public double Saturation = 0.0;
        public double Clarity = 0.0;
        public double Texture = 0.0;
        public double Dehaze = 0.0;

        // --- Detail: sharpening ---
        public double SharpenAmount = 40.0;          // [0, 150]
        public double SharpenRadius = 1.0;           // [0.5, 3]
        public double SharpenDetail = 25.0;          // [0, 100]
        public double SharpenMasking = 0.0;
        public double CaptureSharpeningAmount = 0.0;
        public double CaptureSharpeningSigma = 1.0;  // [0.5, 2]

        // --- Detail: noise reduction ---
        public double NrLuminance = 0.0;
        public double NrColor = 25.0;
        public double ChromaPrefilter = 0.0;
        public double DeepDenoise = 0.0;
        public ToggleMode HotPixelSuppression = ToggleMode.Off;

        // --- Effects ---
        public double VignetteAmount = 0.0;          // [-100, 100]
        public double VignetteFeather = 50.0;        // [0, 100]
        public double GrainAmount = 0.0;
        public double GrainSize = 25.0;
        public double GrainRoughness = 50.0;

        // --- Split toning / color grading ---
        public double SplitToneShadowHue = 0.0;      // [0, 360]
        public double SplitToneShadowSaturation = 0.0;
        public double SplitToneHighlightHue = 0.0;
        public double SplitToneHighlightSaturation = 0.0;
        public double SplitToneBalance = 0.0;        // [-100, 100]
        public double ColorGradeShadowLuminance = 0.0;
        public double ColorGradeMidtoneHue = 0.0;
        public double ColorGradeMidtoneSaturation = 0.0;
        public double ColorGradeMidtoneLuminance = 0.0;
        public double ColorGradeHighlightLuminance = 0.0;
        public double ColorGradeGlobalHue = 0.0;
        public double ColorGradeGlobalSaturation = 0.0;
        public double ColorGradeGlobalLuminance = 0.0;

        // --- HSL 8-band (hue / sat / lum), all [-100, 100] ---
        public double HueAdjustmentRed, HueAdjustmentOrange, HueAdjustmentYellow, HueAdjustmentGreen,
                      HueAdjustmentAqua, HueAdjustmentBlue, HueAdjustmentPurple, HueAdjustmentMagenta;
        public double SaturationAdjustmentRed, SaturationAdjustmentOrange, SaturationAdjustmentYellow, SaturationAdjustmentGreen,
                      SaturationAdjustmentAqua, SaturationAdjustmentBlue, SaturationAdjustmentPurple, SaturationAdjustmentMagenta;
        public double LuminanceAdjustmentRed, LuminanceAdjustmentOrange, LuminanceAdjustmentYellow, LuminanceAdjustmentGreen,
                      LuminanceAdjustmentAqua, LuminanceAdjustmentBlue, LuminanceAdjustmentPurple, LuminanceAdjustmentMagenta;

        // --- Black & white ---
        public ToggleMode BlackWhite = ToggleMode.Off;
        public double GrayMixerRed, GrayMixerOrange, GrayMixerYellow, GrayMixerGreen,
                      GrayMixerAqua, GrayMixerBlue, GrayMixerPurple, GrayMixerMagenta;

        // --- Tone curves (identity = empty point list) ---
        public List<CurvePoint> ToneCurveLuma = new();
        public List<CurvePoint> ToneCurveRed = new();
        public List<CurvePoint> ToneCurveGreen = new();
        public List<CurvePoint> ToneCurveBlue = new();
        public ToneCurveMode ToneCurveMode = ToneCurveMode.PerChannel;

        // --- Display-referred tone curves (#2232, Adobe's crs:ToneCurvePV2012*).
        //     Applied post-AgX, independently per R/G/B channel — a different
        //     quantity from the scene-linear curves above. Identity = empty. ---
        public List<CurvePoint> DisplayToneCurveLuma = new();
        public List<CurvePoint> DisplayToneCurveRed = new();
        public List<CurvePoint> DisplayToneCurveGreen = new();
        public List<CurvePoint> DisplayToneCurveBlue = new();

        // --- Local adjustments (#280/#358): masked, per-region edits. A
        //     hand-written mirror of raw-core's `LocalAdjustment`, outside
        //     codegen because it is a nested list (Models/LocalAdjustment.cs).
        //     Empty = none; the writer emits the crs:GradientBasedCorrections /
        //     crs:CircularGradientBasedCorrections containers only when set. ---
        public List<LocalAdjustment> LocalAdjustments = new();

        // --- Render / recovery enums ---
        public HighlightRecoveryMode HighlightRecovery = HighlightRecoveryMode.ChromaticAdaptation;
        public ToggleMode AutoExposure = ToggleMode.On;
        public LookMode Look = LookMode.Default;
        public ProfileMode Profile = ProfileMode.Auto;

        // --- Lens corrections ---
        public ToggleMode LensProfileEnable = ToggleMode.On;

        // --- Geometry (#2582) ---
        public CropState Crop = CropState.Identity;
        public double LensCorrectionDistortion = 100.0;
        public double LensCorrectionCa = 100.0;
        public double LensCorrectionVignetting = 100.0;

        public AdjustmentState Clone()
        {
            var c = (AdjustmentState)MemberwiseClone();
            c.ToneCurveLuma = new List<CurvePoint>(ToneCurveLuma);
            c.ToneCurveRed = new List<CurvePoint>(ToneCurveRed);
            c.ToneCurveGreen = new List<CurvePoint>(ToneCurveGreen);
            c.ToneCurveBlue = new List<CurvePoint>(ToneCurveBlue);
            c.DisplayToneCurveLuma = new List<CurvePoint>(DisplayToneCurveLuma);
            c.DisplayToneCurveRed = new List<CurvePoint>(DisplayToneCurveRed);
            c.DisplayToneCurveGreen = new List<CurvePoint>(DisplayToneCurveGreen);
            c.DisplayToneCurveBlue = new List<CurvePoint>(DisplayToneCurveBlue);
            c.LocalAdjustments = new List<LocalAdjustment>(LocalAdjustments);
            return c;
        }
    }
}
