using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Threading;
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

        /// <summary>DECODE-PRODUCT field: writing it invalidates the decoded
        /// base, so the model write is held until the gesture ENDS instead of
        /// firing per tick. The per-tick path (<see cref="EditSessionViewModel
        /// .NotifyAdjustmentEdited"/>) only re-runs the GPU chain over the
        /// existing base, so it could not show these fields at all; the
        /// deferred write goes through <see cref="EditSessionViewModel
        /// .ApplyDecodeFieldEdit"/>, which re-decodes once. Mirrors the web
        /// `ToolSubParam.commitOnRelease` flag (#1153 / #3414).</summary>
        public bool CommitOnRelease { get; }

        /// <summary>The one-write-per-gesture state machine for a
        /// commit-on-release row (null for the per-tick rows, which never park
        /// anything). Owns the wheel-burst idle flush too — see
        /// <see cref="DeferredCommit"/>.</summary>
        private readonly DeferredCommit? _deferred;

        /// <summary>Backs the injected scheduler. Held so the timer is not
        /// collected before it fires, and disposed on re-arm so a superseded
        /// burst leaves nothing running.</summary>
        private Timer? _flushTimer;

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
            Func<double, string>? format = null, bool commitOnRelease = false)
        {
            _session = session;
            Label = label;
            Minimum = min;
            Maximum = max;
            StepFrequency = step;
            _get = get;
            _set = set;
            _format = format ?? (v => v.ToString("0"));
            CommitOnRelease = commitOnRelease;
            DefaultValue = get(new AdjustmentState());
            _value = get(session.Adjustments);
            _deferred = commitOnRelease
                ? new DeferredCommit(
                    value => _session.ApplyDecodeFieldEdit(state => _set(state, value)),
                    ScheduleFlush)
                : null;
        }

        /// <summary>The `schedule` half of <see cref="DeferredCommit"/>: a
        /// one-shot timer marshalled back onto the UI thread, since the commit
        /// writes observable properties and drives a re-decode. Re-arming
        /// disposes the previous timer; `DeferredCommit`'s own generation
        /// counter is what makes a superseded callback a no-op if it already
        /// fired.</summary>
        private void ScheduleFlush(int delayMs, Action callback)
        {
            _flushTimer?.Dispose();
            _flushTimer = new Timer(
                _ => EditSessionViewModel.OnUi(callback), null, delayMs, Timeout.Infinite);
        }

        partial void OnValueChanged(double value)
        {
            if (_suppress) return;
            if (_deferred is not null)
            {
                // Park it: the value chip and the modified dot read `Value`,
                // not the model, so the row still tracks the drag live while
                // the expensive re-decode waits for the release.
                _deferred.Park(value);
                return;
            }
            _set(_session.Adjustments, value);
            _session.NotifyAdjustmentEdited();
        }

        /// <summary>Flush a parked commit-on-release value as the single model
        /// write of the whole gesture. Called from the slider row's
        /// pointer-capture-lost / key-up handlers; a no-op for every per-tick
        /// row, which never parks anything.</summary>
        public void CommitDeferred() => _deferred?.Flush();

        /// <summary>A mouse-wheel detent over the row. The wheel raises neither
        /// `PointerCaptureLost` nor `KeyUp`, so without this a wheel-adjusted
        /// value would stay parked forever and the edit would be lost on
        /// navigate. The burst commits once, `WheelIdleFlushMs` after the last
        /// detent — one gesture, one undo entry, matching the web editor.</summary>
        public void NotifyWheelTick() => _deferred?.WheelTick();

        /// <summary>Refresh from the model without echoing back (sidecar reload,
        /// preset apply, undo). Drops any parked value: the model it would have
        /// been written onto is gone.</summary>
        public void SyncFromModel()
        {
            _suppress = true;
            _deferred?.Discard();
            Value = _get(_session.Adjustments);
            _suppress = false;
        }

        /// <summary>Double-tap reset per the drag-bar spec. A reset is an
        /// explicit, discrete edit, so it writes through immediately even on a
        /// commit-on-release row — the assignment parks the default, and the
        /// flush below is what lands it (and no-ops when the row was already
        /// at its default, so nothing was parked).</summary>
        public void Reset()
        {
            Value = DefaultValue;
            CommitDeferred();
        }
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
                Func<double, string>? fmt = null, bool commitOnRelease = false) =>
                new(s, label, min, max, step, get, set, fmt, commitOnRelease);

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
                    // A slider write to the pair is a manual edit: it clears
                    // any sampled/preset/auto provenance with it (#2434).
                    Sl("Temp", 2000, 12000, 50, m => m.Temperature, WhiteBalanceProvenance.SetManualTemperature, kelvin),
                    Sl("Tint", -150, 150, 1, m => m.Tint, WhiteBalanceProvenance.SetManualTint, plain),
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
                }, expanded: false),

                // Wheel-adjacent sliders for the Grade tab (#2578). Hue/sat per
                // zone are written by the wheels, not sliders.
                new("Grade", new[]
                {
                    Sl("Shadows Lum", -100, 100, 1, m => m.ColorGradeShadowLuminance, (m, v) => m.ColorGradeShadowLuminance = v, plain),
                    Sl("Midtones Lum", -100, 100, 1, m => m.ColorGradeMidtoneLuminance, (m, v) => m.ColorGradeMidtoneLuminance = v, plain),
                    Sl("Highlights Lum", -100, 100, 1, m => m.ColorGradeHighlightLuminance, (m, v) => m.ColorGradeHighlightLuminance = v, plain),
                    Sl("Global Lum", -100, 100, 1, m => m.ColorGradeGlobalLuminance, (m, v) => m.ColorGradeGlobalLuminance = v, plain),
                    Sl("Balance", -100, 100, 1, m => m.SplitToneBalance, (m, v) => m.SplitToneBalance = v, plain),
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
                    // Capture sharpening (#3414) — Richardson-Lucy deconvolution.
                    // Both fields are DECODE-OWNED (`StripChainStages` keeps them,
                    // `DecodeInputsChanged` watches them), so both commit on
                    // release: a per-tick write would re-decode the RAW on every
                    // pointer sample. Ranges match the canonical schema
                    // (0..100 default 0; 0.5..2.0 default 1.0) and Apple's pills.
                    Sl("Deconv", 0, 100, 1,
                        m => m.CaptureSharpeningAmount, (m, v) => m.CaptureSharpeningAmount = v,
                        commitOnRelease: true),
                    Sl("Deconv Sigma", 0.5, 2, 0.01,
                        m => m.CaptureSharpeningSigma, (m, v) => m.CaptureSharpeningSigma = v,
                        v => v.ToString("0.00"), commitOnRelease: true),
                    // Defringe (#3411) — ACR's purple / green fringe controls.
                    // Per-tick sliders (the stage runs between dehaze and local
                    // adjustments), unlike the decode-product lens scales.
                    Sl("Defringe Purple", 0, 20, 1, m => m.DefringePurpleAmount, (m, v) => m.DefringePurpleAmount = v),
                    Sl("Purple Hue Low", 0, 100, 1, m => m.DefringePurpleHueLo, (m, v) => m.DefringePurpleHueLo = v),
                    Sl("Purple Hue High", 0, 100, 1, m => m.DefringePurpleHueHi, (m, v) => m.DefringePurpleHueHi = v),
                    Sl("Defringe Green", 0, 20, 1, m => m.DefringeGreenAmount, (m, v) => m.DefringeGreenAmount = v),
                    Sl("Green Hue Low", 0, 100, 1, m => m.DefringeGreenHueLo, (m, v) => m.DefringeGreenHueLo = v),
                    Sl("Green Hue High", 0, 100, 1, m => m.DefringeGreenHueHi, (m, v) => m.DefringeGreenHueHi = v),
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

                // Manual geometry (#3410) — the seven `crs:Perspective*`
                // scalars. Windows exposes the sliders; the guided line-drawing
                // mode is web-only. `Scale` is a percentage and `Rotate` is in
                // degrees, so both take a unit-carrying formatter rather than
                // the bipolar `plain`.
                new("Geometry", new[]
                {
                    Sl("Vertical", -100, 100, 1, m => m.PerspectiveVertical, (m, v) => m.PerspectiveVertical = v, plain),
                    Sl("Horizontal", -100, 100, 1, m => m.PerspectiveHorizontal, (m, v) => m.PerspectiveHorizontal = v, plain),
                    Sl("Rotate", -10, 10, 0.1, m => m.PerspectiveRotate, (m, v) => m.PerspectiveRotate = v,
                        v => $"{v:0.0}°"),
                    Sl("Scale", 50, 150, 1, m => m.PerspectiveScale, (m, v) => m.PerspectiveScale = v,
                        v => $"{v:0}%"),
                    Sl("Aspect", -100, 100, 1, m => m.PerspectiveAspect, (m, v) => m.PerspectiveAspect = v, plain),
                    Sl("X Offset", -100, 100, 1, m => m.PerspectiveX, (m, v) => m.PerspectiveX = v, plain),
                    Sl("Y Offset", -100, 100, 1, m => m.PerspectiveY, (m, v) => m.PerspectiveY = v, plain),
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

        /// <summary>The 4 color-grading wheel zones (#2578). Shadow/highlight
        /// hue+sat ride the SplitToning fields per the canonical schema.</summary>
        public static List<GradeZoneViewModel> BuildGradeZones(EditSessionViewModel s) => new()
        {
            new(s, "Shadows",
                m => m.SplitToneShadowHue, (m, v) => m.SplitToneShadowHue = v,
                m => m.SplitToneShadowSaturation, (m, v) => m.SplitToneShadowSaturation = v),
            new(s, "Midtones",
                m => m.ColorGradeMidtoneHue, (m, v) => m.ColorGradeMidtoneHue = v,
                m => m.ColorGradeMidtoneSaturation, (m, v) => m.ColorGradeMidtoneSaturation = v),
            new(s, "Highlights",
                m => m.SplitToneHighlightHue, (m, v) => m.SplitToneHighlightHue = v,
                m => m.SplitToneHighlightSaturation, (m, v) => m.SplitToneHighlightSaturation = v),
            new(s, "Global",
                m => m.ColorGradeGlobalHue, (m, v) => m.ColorGradeGlobalHue = v,
                m => m.ColorGradeGlobalSaturation, (m, v) => m.ColorGradeGlobalSaturation = v),
        };

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
