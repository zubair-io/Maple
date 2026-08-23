using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Tone Curve Panel organism (unified-component-catalog.md
    /// §4.3, "Tone Curve Panel" row: "Channel curve plus parametrics",
    /// built from Tabs, Curve Plot, Living Slider) — a channel
    /// <see cref="MuiTabs"/> (RGB/Red/Green/Blue) above a shared
    /// <see cref="MuiCurvePlot"/>, plus the four parametric range sliders
    /// (Highlights, Lights, Darks, Shadows) below it. Each channel keeps
    /// its own point set; switching tabs swaps which one the curve plot
    /// is bound to.
    /// </summary>
    public sealed class MuiToneCurvePanel : ContentControl
    {
        private static readonly MuiTab[] ChannelTabs =
        {
            new("rgb", "RGB"), new("red", "Red"), new("green", "Green"), new("blue", "Blue"),
        };

        public static readonly DependencyProperty ActiveChannelProperty =
            DependencyProperty.Register(nameof(ActiveChannel), typeof(string), typeof(MuiToneCurvePanel),
                new PropertyMetadata("rgb", (d, _) => ((MuiToneCurvePanel)d).Rebuild()));

        public static readonly DependencyProperty ChannelPointsProperty =
            DependencyProperty.Register(nameof(ChannelPoints), typeof(IReadOnlyDictionary<string, IReadOnlyList<MuiCurvePoint>>), typeof(MuiToneCurvePanel),
                new PropertyMetadata(null, (d, _) => ((MuiToneCurvePanel)d).Rebuild()));

        public static readonly DependencyProperty HighlightsProperty =
            DependencyProperty.Register(nameof(Highlights), typeof(double), typeof(MuiToneCurvePanel),
                new PropertyMetadata(0.0, (d, e) => ((MuiToneCurvePanel)d)._highlights.Value = (double)e.NewValue));

        public static readonly DependencyProperty LightsProperty =
            DependencyProperty.Register(nameof(Lights), typeof(double), typeof(MuiToneCurvePanel),
                new PropertyMetadata(0.0, (d, e) => ((MuiToneCurvePanel)d)._lights.Value = (double)e.NewValue));

        public static readonly DependencyProperty DarksProperty =
            DependencyProperty.Register(nameof(Darks), typeof(double), typeof(MuiToneCurvePanel),
                new PropertyMetadata(0.0, (d, e) => ((MuiToneCurvePanel)d)._darks.Value = (double)e.NewValue));

        public static readonly DependencyProperty ShadowsProperty =
            DependencyProperty.Register(nameof(Shadows), typeof(double), typeof(MuiToneCurvePanel),
                new PropertyMetadata(0.0, (d, e) => ((MuiToneCurvePanel)d)._shadows.Value = (double)e.NewValue));

        public string ActiveChannel { get => (string)GetValue(ActiveChannelProperty); set => SetValue(ActiveChannelProperty, value); }

        public IReadOnlyDictionary<string, IReadOnlyList<MuiCurvePoint>>? ChannelPoints
        {
            get => (IReadOnlyDictionary<string, IReadOnlyList<MuiCurvePoint>>?)GetValue(ChannelPointsProperty);
            set => SetValue(ChannelPointsProperty, value);
        }

        public double Highlights { get => (double)GetValue(HighlightsProperty); set => SetValue(HighlightsProperty, value); }
        public double Lights { get => (double)GetValue(LightsProperty); set => SetValue(LightsProperty, value); }
        public double Darks { get => (double)GetValue(DarksProperty); set => SetValue(DarksProperty, value); }
        public double Shadows { get => (double)GetValue(ShadowsProperty); set => SetValue(ShadowsProperty, value); }

        public event EventHandler<string>? ChannelChanged;
        public event EventHandler<(string Channel, IReadOnlyList<MuiCurvePoint> Points)>? CurveChanged;
        public event EventHandler<(string Parametric, double Value)>? ParametricChanged;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 16 };
        private readonly MuiTabs _tabs = new() { Tabs = ChannelTabs };
        private readonly MuiCurvePlot _curve = new() { PlotWidth = 260, PlotHeight = 200 };
        private readonly MuiLivingSlider _highlights = new() { Label = "Highlights", Minimum = -100, Maximum = 100, Bipolar = true };
        private readonly MuiLivingSlider _lights = new() { Label = "Lights", Minimum = -100, Maximum = 100, Bipolar = true };
        private readonly MuiLivingSlider _darks = new() { Label = "Darks", Minimum = -100, Maximum = 100, Bipolar = true };
        private readonly MuiLivingSlider _shadows = new() { Label = "Shadows", Minimum = -100, Maximum = 100, Bipolar = true };

        public MuiToneCurvePanel()
        {
            _root.Children.Add(_tabs);
            _root.Children.Add(_curve);
            var parametrics = new StackPanel { Orientation = Orientation.Vertical, Spacing = 12 };
            parametrics.Children.Add(_highlights);
            parametrics.Children.Add(_lights);
            parametrics.Children.Add(_darks);
            parametrics.Children.Add(_shadows);
            _root.Children.Add(parametrics);
            Content = _root;

            _tabs.SelectionChanged += (_, id) => { ActiveChannel = id; ChannelChanged?.Invoke(this, id); };
            _curve.PointsChanged += (_, points) => CurveChanged?.Invoke(this, (ActiveChannel, points));
            _highlights.ValueChanged += (_, v) => { Highlights = v; ParametricChanged?.Invoke(this, ("highlights", v)); };
            _lights.ValueChanged += (_, v) => { Lights = v; ParametricChanged?.Invoke(this, ("lights", v)); };
            _darks.ValueChanged += (_, v) => { Darks = v; ParametricChanged?.Invoke(this, ("darks", v)); };
            _shadows.ValueChanged += (_, v) => { Shadows = v; ParametricChanged?.Invoke(this, ("shadows", v)); };

            Rebuild();
        }

        private static readonly MuiCurvePoint[] DefaultCurve = { new(0, 0), new(1, 1) };

        private void Rebuild()
        {
            _tabs.ActiveId = ActiveChannel;
            _curve.Points = ChannelPoints is not null && ChannelPoints.TryGetValue(ActiveChannel, out var points)
                ? points
                : DefaultCurve;
        }
    }
}
