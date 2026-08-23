using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Drag Bar molecule (unified-component-catalog.md §2.1,
    /// "Drag Bar" row: "Tick-marked scrub control", built from Text) —
    /// a horizontal 21-tick scrub track (e.g. crop straighten, HSL band
    /// pickers) with click-to-value and relative-drag, plus keyboard
    /// arrows.
    ///
    /// Ticks render as a Canvas of small Rectangles (positioned from
    /// <see cref="MuiDragBarMath.BuildTicks"/>) rather than an
    /// ItemsRepeater-bound template — 21 fixed marks is cheap enough to lay
    /// out directly in code, and this wave has no compiler to verify an
    /// ItemsRepeater DataTemplate against. Ports
    /// `mui-drag-bar.component.ts`'s POSITION-based drag contract (unlike
    /// MuiLivingSlider's delta-based one): both pointer-down and every
    /// pointer-move snap the marker straight to the value under the
    /// pointer via <see cref="MuiDragBarMath.ValueAtPosition"/>.
    /// </summary>
    public sealed class MuiDragBar : ContentControl
    {
        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiDragBar),
                new PropertyMetadata(null, (d, _) => ((MuiDragBar)d).Rebuild()));

        public static readonly DependencyProperty ValueProperty =
            DependencyProperty.Register(nameof(Value), typeof(double), typeof(MuiDragBar),
                new PropertyMetadata(0.0, (d, _) => ((MuiDragBar)d).Rebuild()));

        public static readonly DependencyProperty MinimumProperty =
            DependencyProperty.Register(nameof(Minimum), typeof(double), typeof(MuiDragBar),
                new PropertyMetadata(-100.0, (d, _) => ((MuiDragBar)d).Rebuild()));

        public static readonly DependencyProperty MaximumProperty =
            DependencyProperty.Register(nameof(Maximum), typeof(double), typeof(MuiDragBar),
                new PropertyMetadata(100.0, (d, _) => ((MuiDragBar)d).Rebuild()));

        public static readonly DependencyProperty StepProperty =
            DependencyProperty.Register(nameof(Step), typeof(double), typeof(MuiDragBar),
                new PropertyMetadata(1.0, (d, _) => ((MuiDragBar)d).Rebuild()));

        public string? Label
        {
            get => (string?)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        public double Value
        {
            get => (double)GetValue(ValueProperty);
            set => SetValue(ValueProperty, value);
        }

        public double Minimum
        {
            get => (double)GetValue(MinimumProperty);
            set => SetValue(MinimumProperty, value);
        }

        public double Maximum
        {
            get => (double)GetValue(MaximumProperty);
            set => SetValue(MaximumProperty, value);
        }

        public double Step
        {
            get => (double)GetValue(StepProperty);
            set => SetValue(StepProperty, value);
        }

        /// <summary>Fires after a drag/keyboard change.</summary>
        public event EventHandler<double>? ValueChanged;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 4 };
        private readonly Grid _headerRow = new();
        private readonly MuiText _labelText = new() { Variant = MuiTextVariant.RowLabel };
        private readonly MuiText _valueText = new() { Variant = MuiTextVariant.ValueChip };
        private readonly Border _bar = new() { Height = 28, CornerRadius = new CornerRadius(6), BorderThickness = new Thickness(1) };
        private readonly Canvas _tickLayer = new();
        private readonly Border _marker = new() { Width = 2, VerticalAlignment = VerticalAlignment.Stretch };

        private bool _dragging;
        private uint? _activePointerId;

        public MuiDragBar()
        {
            _headerRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            _headerRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            Grid.SetColumn(_valueText, 1);
            _headerRow.Children.Add(_labelText);
            _headerRow.Children.Add(_valueText);

            _tickLayer.Children.Add(_marker);
            _bar.Child = _tickLayer;

            _root.Children.Add(_headerRow);
            _root.Children.Add(_bar);
            Content = _root;
            IsTabStop = true;

            _bar.PointerPressed += OnPointerPressed;
            _bar.PointerMoved += OnPointerMoved;
            _bar.PointerReleased += OnPointerReleased;
            _bar.PointerCanceled += OnPointerReleased;
            _bar.PointerCaptureLost += (_, _) => { _dragging = false; _activePointerId = null; };
            KeyDown += OnKeyDown;
            SizeChanged += (_, _) => Layout();
            IsEnabledChanged += (_, _) => Rebuild();

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (!IsEnabled || !e.GetCurrentPoint(_bar).Properties.IsLeftButtonPressed || _dragging) return;
            _dragging = true;
            _activePointerId = e.Pointer.PointerId;
            var x = e.GetCurrentPoint(_bar).Position.X;
            Value = MuiDragBarMath.ValueAtPosition(x, _bar.ActualWidth, Minimum, Maximum, fallback: Value);
            ValueChanged?.Invoke(this, Value);
            _bar.CapturePointer(e.Pointer);
            e.Handled = true;
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (!_dragging || e.Pointer.PointerId != _activePointerId) return;
            var x = e.GetCurrentPoint(_bar).Position.X;
            Value = MuiDragBarMath.ValueAtPosition(x, _bar.ActualWidth, Minimum, Maximum, fallback: Value);
            ValueChanged?.Invoke(this, Value);
            e.Handled = true;
        }

        private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (e.Pointer.PointerId != _activePointerId) return;
            _dragging = false;
            _activePointerId = null;
            _bar.ReleasePointerCapture(e.Pointer);
            e.Handled = true;
        }

        private void OnKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (!IsEnabled) return;
            var keyName = e.Key switch
            {
                Windows.System.VirtualKey.Left => "Left",
                Windows.System.VirtualKey.Right => "Right",
                Windows.System.VirtualKey.Up => "Up",
                Windows.System.VirtualKey.Down => "Down",
                _ => null,
            };
            if (keyName is null) return;
            var delta = MuiSliderMath.ArrowKeyDelta(keyName, Step > 0 ? Step : 1);
            if (delta is null) return;
            e.Handled = true;
            Value = MuiSliderMath.Clamp(Value + delta.Value, Minimum, Maximum);
            ValueChanged?.Invoke(this, Value);
        }

        private void Layout()
        {
            var width = _bar.ActualWidth;
            var height = _bar.ActualHeight;
            if (width <= 0 || height <= 0) return;

            _tickLayer.Children.Clear();
            _tickLayer.Children.Add(_marker);

            foreach (var tick in MuiDragBarMath.BuildTicks())
            {
                var tickHeight = tick.Emphasized ? height * 0.7 : height * 0.4;
                var rect = new Rectangle
                {
                    Width = tick.Emphasized ? 2 : 1,
                    Height = tickHeight,
                    Fill = R(tick.Emphasized ? "MapleTextMuted" : "MapleBorder"),
                };
                Canvas.SetLeft(rect, tick.Pct / 100.0 * width - rect.Width / 2);
                Canvas.SetTop(rect, (height - tickHeight) / 2);
                _tickLayer.Children.Add(rect);
            }

            var markerPct = MuiDragBarMath.MarkerPct(Value, Minimum, Maximum) / 100.0;
            Canvas.SetLeft(_marker, MuiSliderMath.Clamp(markerPct, 0, 1) * width - _marker.Width / 2);
            Canvas.SetTop(_marker, 0);
            _marker.Height = height;
        }

        private void Rebuild()
        {
            _labelText.Text = Label ?? string.Empty;
            _headerRow.Visibility = string.IsNullOrEmpty(Label) ? Visibility.Collapsed : Visibility.Visible;

            var v = Value;
            _valueText.Text = v > 0 ? $"+{v:0.###}" : $"{v:0.###}";

            _bar.Background = R("MapleSurface");
            _bar.BorderBrush = R("MapleBorder");
            _marker.Background = R("MaplePrimary");

            Layout();

            Opacity = IsEnabled ? 1.0 : 0.45;

            AutomationProperties.SetName(this, string.IsNullOrEmpty(Label) ? "Drag bar" : Label!);
        }
    }
}
