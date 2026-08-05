using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Models;

namespace Maple.WinUI.ViewModels
{
    /// <summary>One slider row in the inspector, bound to a single canonical
    /// AdjustmentState field via getter/setter lambdas.</summary>
    public partial class AdjustmentSliderViewModel : ObservableObject
    {
        private readonly Func<AdjustmentState, double> _get;
        private readonly Action<AdjustmentState, double> _set;
        private readonly Func<double, string> _format;
        private readonly EditSessionViewModel _session;
        private bool _suppress;

        public string Label { get; }
        public double Minimum { get; }
        public double Maximum { get; }
        public double StepFrequency { get; }
        public double DefaultValue { get; }

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(FormattedValue))]
        [NotifyPropertyChangedFor(nameof(IsModified))]
        private double _value;

        public string FormattedValue => _format(Value);
        public bool IsModified => Math.Abs(Value - DefaultValue) > 1e-6;

        public AdjustmentSliderViewModel(
            EditSessionViewModel session, string label,
            double min, double max, double step,
            Func<AdjustmentState, double> get, Action<AdjustmentState, double> set,
            Func<double, string>? format = null)
        {
            _session = session;
            Label = label;
            Minimum = min;
            Maximum = max;
            StepFrequency = step;
            _get = get;
            _set = set;
            _format = format ?? (v => v.ToString("0"));
            DefaultValue = get(new AdjustmentState());
            _value = get(session.Adjustments);
        }

        partial void OnValueChanged(double value)
        {
            if (_suppress) return;
            _set(_session.Adjustments, value);
            _session.NotifyAdjustmentEdited();
        }

        /// <summary>Refresh from the model without echoing back (sidecar reload,
        /// preset apply, undo).</summary>
        public void SyncFromModel()
        {
            _suppress = true;
            Value = _get(_session.Adjustments);
            _suppress = false;
        }

        /// <summary>Double-tap reset per the drag-bar spec.</summary>
        public void Reset() => Value = DefaultValue;
    }

    /// <summary>A titled expander group of sliders (Tone, Color & WB, ...).</summary>
    public sealed class AdjustmentSectionViewModel
    {
        public string Title { get; }
        public ObservableCollection<AdjustmentSliderViewModel> Sliders { get; }
        public bool InitiallyExpanded { get; }

        public AdjustmentSectionViewModel(
            string title, IEnumerable<AdjustmentSliderViewModel> sliders, bool expanded)
        {
            Title = title;
            Sliders = new ObservableCollection<AdjustmentSliderViewModel>(sliders);
            InitiallyExpanded = expanded;
        }
    }

    /// <summary>Builds the canonical inspector sections from ADJUSTMENT_SCHEMA
    /// ranges/defaults (adjustment-model.generated.ts is the reference).</summary>
    public static class AdjustmentSections
    {
        public static List<AdjustmentSectionViewModel> Build(EditSessionViewModel s)
        {
            AdjustmentSliderViewModel Sl(
                string label, double min, double max, double step,
                Func<AdjustmentState, double> get, Action<AdjustmentState, double> set,
                Func<double, string>? fmt = null) => new(s, label, min, max, step, get, set, fmt);

            var ev = (Func<double, string>)(v => $"{v:+0.00;-0.00;0.00} EV");
            var kelvin = (Func<double, string>)(v => $"{v:0} K");
            var deg = (Func<double, string>)(v => $"{v:0}°");
            var plain = (Func<double, string>)(v => $"{v:+0;-0;0}");

            // Section names follow the editor group/tool taxonomy from
            // s5-editor.md ("Groups & tools") — the Edit screen's tool rail
            // opens exactly one of these per group pill.
            return new List<AdjustmentSectionViewModel>
            {
                new("Light", new[]
                {
                    Sl("Exposure", -4, 4, 0.05, m => m.Exposure, (m, v) => m.Exposure = v, ev),
                    Sl("Contrast", -100, 100, 1, m => m.Contrast, (m, v) => m.Contrast = v, plain),
                    Sl("Highlights", -100, 100, 1, m => m.Highlights, (m, v) => m.Highlights = v, plain),
                    Sl("Shadows", -100, 100, 1, m => m.Shadows, (m, v) => m.Shadows = v, plain),
                    Sl("Whites", -100, 100, 1, m => m.Whites, (m, v) => m.Whites = v, plain),
                    Sl("Blacks", -100, 100, 1, m => m.Blacks, (m, v) => m.Blacks = v, plain),
                    Sl("Brightness", -100, 100, 1, m => m.Brightness, (m, v) => m.Brightness = v, plain),
                }, expanded: true),

                new("Color", new[]
                {
                    Sl("Temp", 2000, 12000, 50, m => m.Temperature, (m, v) => m.Temperature = v, kelvin),
                    Sl("Tint", -150, 150, 1, m => m.Tint, (m, v) => m.Tint = v, plain),
                    Sl("Vibrance", -100, 100, 1, m => m.Vibrance, (m, v) => m.Vibrance = v, plain),
                    Sl("Saturation", -100, 100, 1, m => m.Saturation, (m, v) => m.Saturation = v, plain),
                }, expanded: true),

                new("Effects", new[]
                {
                    Sl("Clarity", -100, 100, 1, m => m.Clarity, (m, v) => m.Clarity = v, plain),
                    Sl("Texture", -100, 100, 1, m => m.Texture, (m, v) => m.Texture = v, plain),
                    Sl("Dehaze", -100, 100, 1, m => m.Dehaze, (m, v) => m.Dehaze = v, plain),
                    Sl("Vignette", -100, 100, 1, m => m.VignetteAmount, (m, v) => m.VignetteAmount = v, plain),
                    Sl("Vignette Feather", 0, 100, 1, m => m.VignetteFeather, (m, v) => m.VignetteFeather = v),
                    Sl("Grain", 0, 100, 1, m => m.GrainAmount, (m, v) => m.GrainAmount = v),
                    Sl("Grain Size", 0, 100, 1, m => m.GrainSize, (m, v) => m.GrainSize = v),
                    Sl("Grain Roughness", 0, 100, 1, m => m.GrainRoughness, (m, v) => m.GrainRoughness = v),
                    Sl("Shadow Hue", 0, 360, 1, m => m.SplitToneShadowHue, (m, v) => m.SplitToneShadowHue = v, deg),
                    Sl("Shadow Sat", 0, 100, 1, m => m.SplitToneShadowSaturation, (m, v) => m.SplitToneShadowSaturation = v),
                    Sl("Highlight Hue", 0, 360, 1, m => m.SplitToneHighlightHue, (m, v) => m.SplitToneHighlightHue = v, deg),
                    Sl("Highlight Sat", 0, 100, 1, m => m.SplitToneHighlightSaturation, (m, v) => m.SplitToneHighlightSaturation = v),
                    Sl("Balance", -100, 100, 1, m => m.SplitToneBalance, (m, v) => m.SplitToneBalance = v, plain),
                    Sl("Grade Shadow Lum", -100, 100, 1, m => m.ColorGradeShadowLuminance, (m, v) => m.ColorGradeShadowLuminance = v, plain),
                    Sl("Grade Midtone Hue", 0, 360, 1, m => m.ColorGradeMidtoneHue, (m, v) => m.ColorGradeMidtoneHue = v, deg),
                    Sl("Grade Midtone Sat", 0, 100, 1, m => m.ColorGradeMidtoneSaturation, (m, v) => m.ColorGradeMidtoneSaturation = v),
                    Sl("Grade Midtone Lum", -100, 100, 1, m => m.ColorGradeMidtoneLuminance, (m, v) => m.ColorGradeMidtoneLuminance = v, plain),
                    Sl("Grade Highlight Lum", -100, 100, 1, m => m.ColorGradeHighlightLuminance, (m, v) => m.ColorGradeHighlightLuminance = v, plain),
                    Sl("Grade Global Hue", 0, 360, 1, m => m.ColorGradeGlobalHue, (m, v) => m.ColorGradeGlobalHue = v, deg),
                    Sl("Grade Global Sat", 0, 100, 1, m => m.ColorGradeGlobalSaturation, (m, v) => m.ColorGradeGlobalSaturation = v),
                    Sl("Grade Global Lum", -100, 100, 1, m => m.ColorGradeGlobalLuminance, (m, v) => m.ColorGradeGlobalLuminance = v, plain),
                }, expanded: false),

                new("Detail", new[]
                {
                    Sl("Sharpen", 0, 150, 1, m => m.SharpenAmount, (m, v) => m.SharpenAmount = v),
                    Sl("Sharpen Radius", 0.5, 3, 0.1, m => m.SharpenRadius, (m, v) => m.SharpenRadius = v,
                        v => v.ToString("0.0")),
                    Sl("Sharpen Detail", 0, 100, 1, m => m.SharpenDetail, (m, v) => m.SharpenDetail = v),
                    Sl("Sharpen Masking", 0, 100, 1, m => m.SharpenMasking, (m, v) => m.SharpenMasking = v),
                    Sl("Noise", 0, 100, 1, m => m.NrLuminance, (m, v) => m.NrLuminance = v),
                    Sl("Color NR", 0, 100, 1, m => m.NrColor, (m, v) => m.NrColor = v),
                }, expanded: false),

                new("Tone Curve", new[]
                {
                    Sl("Highlights", -100, 100, 1, m => m.ParametricHighlights, (m, v) => m.ParametricHighlights = v, plain),
                    Sl("Lights", -100, 100, 1, m => m.ParametricLights, (m, v) => m.ParametricLights = v, plain),
                    Sl("Darks", -100, 100, 1, m => m.ParametricDarks, (m, v) => m.ParametricDarks = v, plain),
                    Sl("Shadows", -100, 100, 1, m => m.ParametricShadows, (m, v) => m.ParametricShadows = v, plain),
                }, expanded: false),

                new("B&W", new[]
                {
                    Sl("Red", -100, 100, 1, m => m.GrayMixerRed, (m, v) => m.GrayMixerRed = v, plain),
                    Sl("Orange", -100, 100, 1, m => m.GrayMixerOrange, (m, v) => m.GrayMixerOrange = v, plain),
                    Sl("Yellow", -100, 100, 1, m => m.GrayMixerYellow, (m, v) => m.GrayMixerYellow = v, plain),
                    Sl("Green", -100, 100, 1, m => m.GrayMixerGreen, (m, v) => m.GrayMixerGreen = v, plain),
                    Sl("Aqua", -100, 100, 1, m => m.GrayMixerAqua, (m, v) => m.GrayMixerAqua = v, plain),
                    Sl("Blue", -100, 100, 1, m => m.GrayMixerBlue, (m, v) => m.GrayMixerBlue = v, plain),
                    Sl("Purple", -100, 100, 1, m => m.GrayMixerPurple, (m, v) => m.GrayMixerPurple = v, plain),
                    Sl("Magenta", -100, 100, 1, m => m.GrayMixerMagenta, (m, v) => m.GrayMixerMagenta = v, plain),
                }, expanded: false),
            };
        }

        /// <summary>Section lookup for the Edit screen's tool-rail panels.</summary>
        public static AdjustmentSectionViewModel Section(
            IEnumerable<AdjustmentSectionViewModel> sections, string title)
        {
            foreach (var section in sections)
                if (section.Title == title)
                    return section;
            throw new ArgumentException($"unknown section '{title}'");
        }

        /// <summary>The 8 HSL bands for the banded panel (hue/sat/lum per band).</summary>
        public static List<HslBandViewModel> BuildHslBands(EditSessionViewModel s) => new()
        {
            new(s, "Red",
                m => m.HueAdjustmentRed, (m, v) => m.HueAdjustmentRed = v,
                m => m.SaturationAdjustmentRed, (m, v) => m.SaturationAdjustmentRed = v,
                m => m.LuminanceAdjustmentRed, (m, v) => m.LuminanceAdjustmentRed = v),
            new(s, "Orange",
                m => m.HueAdjustmentOrange, (m, v) => m.HueAdjustmentOrange = v,
                m => m.SaturationAdjustmentOrange, (m, v) => m.SaturationAdjustmentOrange = v,
                m => m.LuminanceAdjustmentOrange, (m, v) => m.LuminanceAdjustmentOrange = v),
            new(s, "Yellow",
                m => m.HueAdjustmentYellow, (m, v) => m.HueAdjustmentYellow = v,
                m => m.SaturationAdjustmentYellow, (m, v) => m.SaturationAdjustmentYellow = v,
                m => m.LuminanceAdjustmentYellow, (m, v) => m.LuminanceAdjustmentYellow = v),
            new(s, "Green",
                m => m.HueAdjustmentGreen, (m, v) => m.HueAdjustmentGreen = v,
                m => m.SaturationAdjustmentGreen, (m, v) => m.SaturationAdjustmentGreen = v,
                m => m.LuminanceAdjustmentGreen, (m, v) => m.LuminanceAdjustmentGreen = v),
            new(s, "Aqua",
                m => m.HueAdjustmentAqua, (m, v) => m.HueAdjustmentAqua = v,
                m => m.SaturationAdjustmentAqua, (m, v) => m.SaturationAdjustmentAqua = v,
                m => m.LuminanceAdjustmentAqua, (m, v) => m.LuminanceAdjustmentAqua = v),
            new(s, "Blue",
                m => m.HueAdjustmentBlue, (m, v) => m.HueAdjustmentBlue = v,
                m => m.SaturationAdjustmentBlue, (m, v) => m.SaturationAdjustmentBlue = v,
                m => m.LuminanceAdjustmentBlue, (m, v) => m.LuminanceAdjustmentBlue = v),
            new(s, "Purple",
                m => m.HueAdjustmentPurple, (m, v) => m.HueAdjustmentPurple = v,
                m => m.SaturationAdjustmentPurple, (m, v) => m.SaturationAdjustmentPurple = v,
                m => m.LuminanceAdjustmentPurple, (m, v) => m.LuminanceAdjustmentPurple = v),
            new(s, "Magenta",
                m => m.HueAdjustmentMagenta, (m, v) => m.HueAdjustmentMagenta = v,
                m => m.SaturationAdjustmentMagenta, (m, v) => m.SaturationAdjustmentMagenta = v,
                m => m.LuminanceAdjustmentMagenta, (m, v) => m.LuminanceAdjustmentMagenta = v),
        };
    }

    /// <summary>One HSL band: three sliders sharing the band name.</summary>
    public sealed class HslBandViewModel
    {
        public string Band { get; }
        public AdjustmentSliderViewModel Hue { get; }
        public AdjustmentSliderViewModel Sat { get; }
        public AdjustmentSliderViewModel Lum { get; }

        public HslBandViewModel(
            EditSessionViewModel s, string band,
            Func<AdjustmentState, double> hGet, Action<AdjustmentState, double> hSet,
            Func<AdjustmentState, double> sGet, Action<AdjustmentState, double> sSet,
            Func<AdjustmentState, double> lGet, Action<AdjustmentState, double> lSet)
        {
            Band = band;
            Hue = new AdjustmentSliderViewModel(s, "Hue", -100, 100, 1, hGet, hSet);
            Sat = new AdjustmentSliderViewModel(s, "Saturation", -100, 100, 1, sGet, sSet);
            Lum = new AdjustmentSliderViewModel(s, "Luminance", -100, 100, 1, lGet, lSet);
        }
    }
}
