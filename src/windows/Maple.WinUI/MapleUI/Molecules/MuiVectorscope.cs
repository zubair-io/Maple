using System;
using System.Collections.Generic;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;
using Windows.UI;

namespace Maple.UI;

/// <summary>Broadcast graticule with legacy scatter or native Rec.709 density.
/// Density replaces scatter using one bitmap rather than thousands of shapes.
/// See docs/design/maple-ui/components/vectorscope.md.</summary>
public sealed class MuiVectorscope : ContentControl
{
    public static readonly DependencyProperty SamplesProperty =
        DependencyProperty.Register(nameof(Samples), typeof(IReadOnlyList<MuiVectorscopeSample>), typeof(MuiVectorscope),
            new PropertyMetadata(null, (d, _) => ((MuiVectorscope)d).RenderData()));
    public static readonly DependencyProperty BinsProperty =
        DependencyProperty.Register(nameof(Bins), typeof(IReadOnlyList<uint>), typeof(MuiVectorscope),
            new PropertyMetadata(null, (d, _) => ((MuiVectorscope)d).RenderData()));
    public static readonly DependencyProperty ScopeSizeProperty =
        DependencyProperty.Register(nameof(ScopeSize), typeof(double), typeof(MuiVectorscope),
            new PropertyMetadata(120.0, (d, _) => ((MuiVectorscope)d).Rebuild()));
    public static readonly DependencyProperty ShowSkinToneLineProperty =
        DependencyProperty.Register(nameof(ShowSkinToneLine), typeof(bool), typeof(MuiVectorscope),
            new PropertyMetadata(false, (d, _) => ((MuiVectorscope)d).Rebuild()));
    public static readonly DependencyProperty RedAt3OClockProperty =
        DependencyProperty.Register(nameof(RedAt3OClock), typeof(bool), typeof(MuiVectorscope),
            new PropertyMetadata(false, (d, _) => ((MuiVectorscope)d).Rebuild()));
    public static readonly DependencyProperty DotColorProperty =
        DependencyProperty.Register(nameof(DotColor), typeof(Brush), typeof(MuiVectorscope),
            new PropertyMetadata(null, (d, _) => ((MuiVectorscope)d).RenderData()));

    public IReadOnlyList<MuiVectorscopeSample>? Samples { get => (IReadOnlyList<MuiVectorscopeSample>?)GetValue(SamplesProperty); set => SetValue(SamplesProperty, value); }
    /// <summary>Native row-major [Cr][Cb] square grid; Cr increases with row.</summary>
    public IReadOnlyList<uint>? Bins { get => (IReadOnlyList<uint>?)GetValue(BinsProperty); set => SetValue(BinsProperty, value); }
    public double ScopeSize { get => (double)GetValue(ScopeSizeProperty); set => SetValue(ScopeSizeProperty, value); }
    public bool ShowSkinToneLine { get => (bool)GetValue(ShowSkinToneLineProperty); set => SetValue(ShowSkinToneLineProperty, value); }
    public bool RedAt3OClock { get => (bool)GetValue(RedAt3OClockProperty); set => SetValue(RedAt3OClockProperty, value); }
    public Brush? DotColor { get => (Brush?)GetValue(DotColorProperty); set => SetValue(DotColorProperty, value); }

    private readonly Grid _frame = new();
    private readonly Canvas _chrome = new();
    private readonly Canvas _data = new();
    private readonly Grid _plot = new();
    private WriteableBitmap? _density;
    private readonly Image _densityImage = new() { Stretch = Stretch.Fill, IsHitTestVisible = false };
    private double Radius => Math.Max(0, ScopeSize / 2 - 4);

    public MuiVectorscope()
    {
        _plot.Children.Add(_chrome);
        _plot.Children.Add(_data);
        _frame.Children.Add(_plot);
        Content = _frame;
        IsTabStop = false;
        AutomationProperties.SetName(this, "Vectorscope");
        AutomationProperties.SetAccessibilityView(_chrome, AccessibilityView.Raw);
        AutomationProperties.SetAccessibilityView(_data, AccessibilityView.Raw);
        ActualThemeChanged += (_, _) => Rebuild();
        Rebuild();
    }

    private static Brush R(string key) => (Brush)Application.Current.Resources[key];
    private static SolidColorBrush Rgb(double r, double g, double b) =>
        new(Color.FromArgb(255, (byte)Math.Round(r * 255), (byte)Math.Round(g * 255), (byte)Math.Round(b * 255)));
    private Point At(double angle, double radius)
    {
        var rad = angle * Math.PI / 180;
        return new(ScopeSize / 2 + Math.Cos(rad) * radius, ScopeSize / 2 - Math.Sin(rad) * radius);
    }
    private void Line(Point from, Point to, Brush stroke, double width, bool dashed = false)
    {
        var line = new Line { X1 = from.X, Y1 = from.Y, X2 = to.X, Y2 = to.Y,
            Stroke = stroke, StrokeThickness = width };
        if (dashed) line.StrokeDashArray = new DoubleCollection { 4, 6 };
        _chrome.Children.Add(line);
    }

    private void Rebuild()
    {
        if (!double.IsFinite(ScopeSize) || ScopeSize <= 8) return;
        _frame.Width = _frame.Height = ScopeSize;
        _frame.Background = R("MapleImageCanvas");
        _frame.CornerRadius = new CornerRadius(ScopeSize / 2);
        _plot.Width = _plot.Height = ScopeSize;
        _plot.RenderTransform = new RotateTransform { Angle = RedAt3OClock ? MuiVectorscopeMath.TargetAngle(0) : 0,
            CenterX = ScopeSize / 2, CenterY = ScopeSize / 2 };
        _chrome.Children.Clear();
        var center = new Point(ScopeSize / 2, ScopeSize / 2);
        for (var angle = 0; angle < 360; angle += 2)
        {
            var (r, g, b) = MuiVectorscopeMath.RingRgb(angle);
            Line(At(angle, Radius), At(angle + 2, Radius), Rgb(r, g, b), Math.Max(2, Radius * 0.06));
        }
        for (var i = 0; i < ScopeTargets.Values.Length; i++)
        {
            var target = ScopeTargets.Values[i];
            var point = At(MuiVectorscopeMath.TargetAngle(i), Radius);
            Line(center, point, R("MapleBorder"), 0.5, true);
            var dot = new Ellipse { Width = 7, Height = 7, Fill = Rgb(target.R, target.G, target.B) };
            Canvas.SetLeft(dot, point.X - 3.5);
            Canvas.SetTop(dot, point.Y - 3.5);
            _chrome.Children.Add(dot);
        }
        if (ShowSkinToneLine) DrawSkinBand(center);
        RenderData();
    }

    private void DrawSkinBand(Point center)
    {
        var white = new SolidColorBrush(Color.FromArgb(191, 255, 255, 255));
        var band = new Polygon { Fill = new SolidColorBrush(Color.FromArgb(41, 255, 255, 255)),
            Points = new PointCollection { center, At(113, Radius), At(133, Radius) } };
        _chrome.Children.Add(band);
        Line(center, At(123, Radius), white, 1);
        var box = Math.Max(9, Radius * 0.2);
        var marker = At(123, Radius - box * 0.75);
        var head = new Ellipse { Width = box * 0.36, Height = box * 0.36, Stroke = white, StrokeThickness = 1 };
        Canvas.SetLeft(head, marker.X - box * 0.18);
        Canvas.SetTop(head, marker.Y - box * 0.36);
        _chrome.Children.Add(head);
        var shoulders = new Polyline { Stroke = white, StrokeThickness = 1 };
        for (var a = 180; a >= 0; a -= 15)
        {
            var radians = a * Math.PI / 180;
            shoulders.Points.Add(new Point(marker.X + Math.Cos(radians) * box * 0.32,
                marker.Y + box * 0.34 - Math.Sin(radians) * box * 0.32));
        }
        _chrome.Children.Add(shoulders);
    }

    private void RenderData()
    {
        _data.Children.Clear();
        var brush = DotColor ?? R("MaplePrimary");
        if (Bins is { } bins)
        {
            var side = (int)Math.Sqrt(bins.Count);
            if (side == 0 || side > 512 || side * side != bins.Count) return;
            var color = (brush as SolidColorBrush)?.Color ?? ((SolidColorBrush)R("MaplePrimary")).Color;
            var pixels = MuiVectorscopeMath.DensityPixels(bins, side, color.R, color.G, color.B);
            if (_density == null || _density.PixelWidth != side) _density = new WriteableBitmap(side, side);
            using (var stream = _density.PixelBuffer.AsStream()) stream.Write(pixels, 0, pixels.Length);
            _density.Invalidate();
            _densityImage.Source = _density;
            _densityImage.Width = _densityImage.Height = Radius * 2;
            Canvas.SetLeft(_densityImage, 4);
            Canvas.SetTop(_densityImage, 4);
            _data.Children.Add(_densityImage);
            return;
        }
        foreach (var sample in Samples ?? Array.Empty<MuiVectorscopeSample>())
        {
            var (x, y) = MuiVectorscopeMath.ToPoint(sample.R, sample.G, sample.B, ScopeSize / 2, ScopeSize / 2, Radius);
            if (!double.IsFinite(x) || !double.IsFinite(y)) continue;
            var dot = new Ellipse { Width = 3, Height = 3, Fill = brush };
            Canvas.SetLeft(dot, x - 1.5);
            Canvas.SetTop(dot, y - 1.5);
            _data.Children.Add(dot);
        }
    }
}
