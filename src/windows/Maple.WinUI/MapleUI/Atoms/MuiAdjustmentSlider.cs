using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Maple.UI.Atoms;

/// <summary>A native Slider with Maple's origin-to-value track. Retains Slider's
/// RangeValue automation peer, focus, keyboard, wheel and pointer-capture contract.
/// Decoration is isolated from input and never allocates on a slider tick.</summary>
public sealed class MuiAdjustmentSlider : Slider
{
    public static readonly DependencyProperty OriginProperty = DependencyProperty.Register(
        nameof(Origin), typeof(double), typeof(MuiAdjustmentSlider), new PropertyMetadata(0.0, (d, _) => ((MuiAdjustmentSlider)d).UpdateTrack()));
    public double Origin { get => (double)GetValue(OriginProperty); set => SetValue(OriginProperty, value); }
    private Grid? _horizontal;
    private Thumb? _thumb;
    private Canvas? _decoration;
    private Rectangle? _segment;
    private Rectangle? _origin;
    private uint? _gesturePointer;
    public event EventHandler? GestureStarted;
    public event EventHandler? GestureCompleted;

    public MuiAdjustmentSlider()
    {
        DefaultStyleKey = typeof(Slider);
        MinHeight = 36;
        ValueChanged += (_, _) => UpdateTrack();
        RegisterPropertyChangedCallback(MinimumProperty, (_, _) => UpdateTrack());
        RegisterPropertyChangedCallback(MaximumProperty, (_, _) => UpdateTrack());
        IsEnabledChanged += (_, _) => UpdateTrack();
        Unloaded += (_, _) => CompleteGesture();
    }

    protected override void OnPointerPressed(PointerRoutedEventArgs e)
    {
        if (IsEnabled && _gesturePointer == null && e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
        {
            _gesturePointer = e.Pointer.PointerId;
            GestureStarted?.Invoke(this, EventArgs.Empty);
        }
        base.OnPointerPressed(e);
    }

    protected override void OnPointerReleased(PointerRoutedEventArgs e)
    {
        base.OnPointerReleased(e);
        if (_gesturePointer == e.Pointer.PointerId) CompleteGesture();
    }

    protected override void OnPointerCanceled(PointerRoutedEventArgs e)
    {
        base.OnPointerCanceled(e);
        if (_gesturePointer == e.Pointer.PointerId) CompleteGesture();
    }

    protected override void OnPointerCaptureLost(PointerRoutedEventArgs e)
    {
        base.OnPointerCaptureLost(e);
        if (_gesturePointer == e.Pointer.PointerId) CompleteGesture();
    }

    private void CompleteGesture()
    {
        if (_gesturePointer == null) return;
        _gesturePointer = null;
        GestureCompleted?.Invoke(this, EventArgs.Empty);
    }

    protected override void OnApplyTemplate()
    {
        if (_horizontal != null)
        {
            _horizontal.SizeChanged -= OnTrackSizeChanged;
            if (_decoration != null) _horizontal.Children.Remove(_decoration);
        }
        base.OnApplyTemplate();
        _horizontal = GetTemplateChild("HorizontalTemplate") as Grid;
        _thumb = GetTemplateChild("HorizontalThumb") as Thumb;
        if (_horizontal == null || _thumb == null) return;
        if (GetTemplateChild("HorizontalDecreaseRect") is Rectangle decrease) decrease.Opacity = 0;
        if (GetTemplateChild("HorizontalTrackRect") is Rectangle track)
        {
            track.Height = 2;
            track.Fill = (Brush)Application.Current.Resources["MapleBorder"];
        }
        _thumb.Width = _thumb.Height = 12;
        _thumb.Template = (ControlTemplate)XamlReader.Load("""
            <ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
                <Ellipse Fill="{StaticResource MapleTextMain}" Stroke="{StaticResource MaplePrimary}" StrokeThickness="1.5" />
            </ControlTemplate>
            """);
        _segment = new Rectangle { Height = 2, Fill = (Brush)Application.Current.Resources["MaplePrimary"] };
        _origin = new Rectangle { Width = 1, Height = 10, Fill = (Brush)Application.Current.Resources["MapleTextMuted"] };
        _decoration = new Canvas { Height = 2, IsHitTestVisible = false };
        _decoration.Children.Add(_segment);
        _decoration.Children.Add(_origin);
        Canvas.SetTop(_origin, -4);
        Grid.SetColumnSpan(_decoration, 3);
        Grid.SetRow(_decoration, 1);
        _horizontal.Children.Insert(Math.Max(0, _horizontal.Children.IndexOf(_thumb)), _decoration);
        _horizontal.SizeChanged += OnTrackSizeChanged;
        UpdateTrack();
    }

    private void OnTrackSizeChanged(object sender, SizeChangedEventArgs e) => UpdateTrack();
    private void UpdateTrack()
    {
        if (_horizontal == null || _thumb == null || _segment == null || _origin == null || _decoration == null) return;
        var span = Maximum - Minimum;
        if (span <= 0) return;
        var width = Math.Max(0, _horizontal.ActualWidth - _thumb.Width);
        var start = _thumb.Width / 2 + width * (Math.Clamp(Origin, Minimum, Maximum) - Minimum) / span;
        var end = _thumb.Width / 2 + width * (Math.Clamp(Value, Minimum, Maximum) - Minimum) / span;
        Canvas.SetLeft(_segment, Math.Min(start, end));
        _segment.Width = Math.Abs(end - start);
        Canvas.SetLeft(_origin, start);
        _origin.Visibility = Origin > Minimum && Origin < Maximum ? Visibility.Visible : Visibility.Collapsed;
        _decoration.Opacity = IsEnabled ? 1 : .4;
    }
}
