using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>Which color-grading wheel a value applies to.</summary>
    public enum MuiColorGradingBand { Shadows, Midtones, Highlights }

    /// <summary>
    /// Maple.UI Color Grading Panel organism (unified-component-catalog.md
    /// §4.3, "Color Grading Panel" row: "Shadows / mids / highlights",
    /// built from Color Wheel, Living Slider) — three
    /// <see cref="MuiColorWheel"/>s side by side (Shadows/Midtones/
    /// Highlights), each with its own Luminance <see cref="MuiLivingSlider"/>
    /// underneath, plus a Blending strength slider shared across all
    /// three.
    /// </summary>
    public sealed class MuiColorGradingPanel : ContentControl
    {
        public static readonly DependencyProperty ShadowsProperty =
            DependencyProperty.Register(nameof(Shadows), typeof(MuiColorWheelValue), typeof(MuiColorGradingPanel),
                new PropertyMetadata(default(MuiColorWheelValue), (d, _) => ((MuiColorGradingPanel)d).Rebuild()));

        public static readonly DependencyProperty MidtonesProperty =
            DependencyProperty.Register(nameof(Midtones), typeof(MuiColorWheelValue), typeof(MuiColorGradingPanel),
                new PropertyMetadata(default(MuiColorWheelValue), (d, _) => ((MuiColorGradingPanel)d).Rebuild()));

        public static readonly DependencyProperty HighlightsProperty =
            DependencyProperty.Register(nameof(Highlights), typeof(MuiColorWheelValue), typeof(MuiColorGradingPanel),
                new PropertyMetadata(default(MuiColorWheelValue), (d, _) => ((MuiColorGradingPanel)d).Rebuild()));

        public static readonly DependencyProperty ShadowsLuminanceProperty =
            DependencyProperty.Register(nameof(ShadowsLuminance), typeof(double), typeof(MuiColorGradingPanel),
                new PropertyMetadata(0.0, (d, e) => ((MuiColorGradingPanel)d)._shadowsLuma.Value = (double)e.NewValue));

        public static readonly DependencyProperty MidtonesLuminanceProperty =
            DependencyProperty.Register(nameof(MidtonesLuminance), typeof(double), typeof(MuiColorGradingPanel),
                new PropertyMetadata(0.0, (d, e) => ((MuiColorGradingPanel)d)._midtonesLuma.Value = (double)e.NewValue));

        public static readonly DependencyProperty HighlightsLuminanceProperty =
            DependencyProperty.Register(nameof(HighlightsLuminance), typeof(double), typeof(MuiColorGradingPanel),
                new PropertyMetadata(0.0, (d, e) => ((MuiColorGradingPanel)d)._highlightsLuma.Value = (double)e.NewValue));

        public static readonly DependencyProperty BlendingProperty =
            DependencyProperty.Register(nameof(Blending), typeof(double), typeof(MuiColorGradingPanel),
                new PropertyMetadata(50.0, (d, e) => ((MuiColorGradingPanel)d)._blending.Value = (double)e.NewValue));

        public MuiColorWheelValue Shadows { get => (MuiColorWheelValue)GetValue(ShadowsProperty); set => SetValue(ShadowsProperty, value); }
        public MuiColorWheelValue Midtones { get => (MuiColorWheelValue)GetValue(MidtonesProperty); set => SetValue(MidtonesProperty, value); }
        public MuiColorWheelValue Highlights { get => (MuiColorWheelValue)GetValue(HighlightsProperty); set => SetValue(HighlightsProperty, value); }
        public double ShadowsLuminance { get => (double)GetValue(ShadowsLuminanceProperty); set => SetValue(ShadowsLuminanceProperty, value); }
        public double MidtonesLuminance { get => (double)GetValue(MidtonesLuminanceProperty); set => SetValue(MidtonesLuminanceProperty, value); }
        public double HighlightsLuminance { get => (double)GetValue(HighlightsLuminanceProperty); set => SetValue(HighlightsLuminanceProperty, value); }
        public double Blending { get => (double)GetValue(BlendingProperty); set => SetValue(BlendingProperty, value); }

        public event EventHandler<(MuiColorGradingBand Band, MuiColorWheelValue Value)>? WheelChanged;
        public event EventHandler<(MuiColorGradingBand Band, double Value)>? LuminanceChanged;
        public event EventHandler<double>? BlendingChanged;

        private readonly StackPanel _root = new() { Orientation = Orientation.Horizontal, Spacing = 24 };
        private readonly MuiColorWheel _shadowsWheel = new() { WheelSize = 120, AccessibleLabel = "Shadows color" };
        private readonly MuiColorWheel _midtonesWheel = new() { WheelSize = 120, AccessibleLabel = "Midtones color" };
        private readonly MuiColorWheel _highlightsWheel = new() { WheelSize = 120, AccessibleLabel = "Highlights color" };
        private readonly MuiLivingSlider _shadowsLuma = new() { Label = "Luminance", Minimum = -50, Maximum = 50, Bipolar = true };
        private readonly MuiLivingSlider _midtonesLuma = new() { Label = "Luminance", Minimum = -50, Maximum = 50, Bipolar = true };
        private readonly MuiLivingSlider _highlightsLuma = new() { Label = "Luminance", Minimum = -50, Maximum = 50, Bipolar = true };
        private readonly MuiLivingSlider _blending = new() { Label = "Blending", Minimum = 0, Maximum = 100, Unit = "%" };

        public MuiColorGradingPanel()
        {
            _root.Children.Add(Column("Shadows", _shadowsWheel, _shadowsLuma));
            _root.Children.Add(Column("Midtones", _midtonesWheel, _midtonesLuma));
            _root.Children.Add(Column("Highlights", _highlightsWheel, _highlightsLuma));

            var side = new StackPanel { Orientation = Orientation.Vertical, Spacing = 20, VerticalAlignment = VerticalAlignment.Bottom };
            side.Children.Add(_blending);
            _root.Children.Add(side);
            Content = _root;

            _shadowsWheel.ValueChanged += (_, v) => { Shadows = v; WheelChanged?.Invoke(this, (MuiColorGradingBand.Shadows, v)); };
            _midtonesWheel.ValueChanged += (_, v) => { Midtones = v; WheelChanged?.Invoke(this, (MuiColorGradingBand.Midtones, v)); };
            _highlightsWheel.ValueChanged += (_, v) => { Highlights = v; WheelChanged?.Invoke(this, (MuiColorGradingBand.Highlights, v)); };
            _shadowsLuma.ValueChanged += (_, v) => { ShadowsLuminance = v; LuminanceChanged?.Invoke(this, (MuiColorGradingBand.Shadows, v)); };
            _midtonesLuma.ValueChanged += (_, v) => { MidtonesLuminance = v; LuminanceChanged?.Invoke(this, (MuiColorGradingBand.Midtones, v)); };
            _highlightsLuma.ValueChanged += (_, v) => { HighlightsLuminance = v; LuminanceChanged?.Invoke(this, (MuiColorGradingBand.Highlights, v)); };
            _blending.ValueChanged += (_, v) => { Blending = v; BlendingChanged?.Invoke(this, v); };

            Rebuild();
        }

        private static UIElement Column(string label, MuiColorWheel wheel, MuiLivingSlider luma)
        {
            var stack = new StackPanel { Orientation = Orientation.Vertical, Spacing = 10, HorizontalAlignment = HorizontalAlignment.Center };
            stack.Children.Add(new MuiText { Text = label, Variant = MuiTextVariant.Eyebrow, ColorRole = MuiTextColorRole.Muted });
            stack.Children.Add(wheel);
            stack.Children.Add(luma);
            return stack;
        }

        private void Rebuild()
        {
            _shadowsWheel.Hue = Shadows.Hue;
            _shadowsWheel.Saturation = Shadows.Saturation;
            _midtonesWheel.Hue = Midtones.Hue;
            _midtonesWheel.Saturation = Midtones.Saturation;
            _highlightsWheel.Hue = Highlights.Hue;
            _highlightsWheel.Saturation = Highlights.Saturation;
        }
    }
}
