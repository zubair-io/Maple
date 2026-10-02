using System;
using System.Globalization;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services.Xmp
{
    public static partial class XmpParser
    {
        // ── Value parsers ───────────────────────────────────────────────────

        private static bool TryParseDouble(string text, out double value) =>
            double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value) &&
            double.IsFinite(value);

        private static void Apply<T>(T? parsed, Action<T> assign) where T : struct
        {
            if (parsed.HasValue) assign(parsed.Value);
        }

        private static HighlightRecoveryMode? ParseHighlightRecovery(string v) => v.ToLowerInvariant() switch
        {
            "off" => HighlightRecoveryMode.Off,
            "blend" => HighlightRecoveryMode.Blend,
            "luminance" => HighlightRecoveryMode.Luminance,
            "chromaticadaptation" => HighlightRecoveryMode.ChromaticAdaptation,
            "oklabchromareduction" => HighlightRecoveryMode.OklabChromaReduction,
            _ => null,
        };

        private static ToggleMode? ParseToggle(string v) => v.ToLowerInvariant() switch
        {
            "on" => ToggleMode.On,
            "off" => ToggleMode.Off,
            _ => null,
        };

        /// <summary>ACR writes "1"/"0" for `crs:LensProfileEnable`; True/False/On/Off accepted too.</summary>
        private static ToggleMode? ParseOnOffBool(string v) => v.ToLowerInvariant() switch
        {
            "1" or "true" or "on" => ToggleMode.On,
            "0" or "false" or "off" => ToggleMode.Off,
            _ => null,
        };

        /// <summary>`crs:ConvertToGrayscale` accepts true/false in any case plus 1/0.</summary>
        private static ToggleMode? ParseTrueFalse(string v) => v.ToLowerInvariant() switch
        {
            "true" or "1" => ToggleMode.On,
            "false" or "0" => ToggleMode.Off,
            _ => null,
        };

        private static WbMethod? ParseWbMethod(string v) => v.ToLowerInvariant() switch
        {
            "cat16" => WbMethod.Cat16,
            "diagonalrec2020" => WbMethod.DiagonalRec2020,
            _ => null,
        };

        private static ToneCurveMode? ParseToneCurveMode(string v) => v.ToLowerInvariant() switch
        {
            "perchannel" => ToneCurveMode.PerChannel,
            "ratiopreserving" => ToneCurveMode.RatioPreserving,
            _ => null,
        };

        /// <summary>`papp:Look` parse + the legacy Look → Profile migration (#536).</summary>
        private static void ParseLook(string value, AdjustmentState state, ref bool profileSeen)
        {
            var v = value.ToLowerInvariant();
            if (v == "neutral") state.Look = LookMode.Neutral;
            else if (v == "default") state.Look = LookMode.Default;
            if (profileSeen) return;
            if (v is "default" or "auto") state.Profile = ProfileMode.Auto;
            else if (v == "neutral") state.Profile = ProfileMode.Neutral;
        }

        /// <summary>Rating clamped to 1..5; 0/absent/invalid = unrated (null).</summary>
        private static int? ParseRating(string value)
        {
            if (!TryParseDouble(value, out var n) || n < 0 || n > 5) return null;
            var rounded = (int)Math.Floor(n + 0.5);
            return rounded > 0 ? rounded : null;
        }

        private static string? ValidFlag(string? value) =>
            value is "pick" or "reject" ? value : null;

        private static string? ValidColorLabel(string? value) =>
            value is not null && XmpSchema.ColorLabels.Contains(value) ? value : null;

        /// <summary>Adobe `xmp:Label` color word → Maple color label (Lightroom interop).</summary>
        private static string? ColorLabelFromXmpLabel(string? label) => label switch
        {
            "Red" => "red",
            "Orange" => "orange",
            "Yellow" => "yellow",
            "Green" => "green",
            "Blue" => "blue",
            "Purple" => "purple",
            _ => null,
        };
    }
}
