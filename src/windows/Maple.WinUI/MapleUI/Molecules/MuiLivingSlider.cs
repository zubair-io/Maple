using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Maple.UI.Atoms;
using Windows.UI;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Living Slider molecule (unified-component-catalog.md §2.1,
    /// "Living Slider" row: "Gradient-track slider", built from Text,
    /// Input) — the Pro Editor's color-grading slider style: the whole
    /// track paints a gradient (e.g. cool-to-warm for temperature) instead
    /// of a plain progress fill, with a small thumb marking the current
    /// value.
    ///
    /// Hand-rolled from a <see cref="Border"/> track (a
    /// <see cref="LinearGradientBrush"/> background) plus a thumb-free
    /// pointer-drag puck — MainWindow.xaml's own slider styling only
    /// restyles a native <see cref="Slider"/>'s Foreground/track color, not
    /// a two-stop gradient fill, and there's no compiler in this worktree
    /// to verify a ControlTemplate rewrite that could paint one. This
    /// mirrors the CLAUDE.md brief's own suggested approach.
    ///
    /// Ports `mui-living-slider.component.ts`'s drag contract exactly:
    /// dragging is DELTA-based off the value at pointer-down (not a
    /// snap-to-click-position like MuiDragBar) — the pointer moving dx
    /// pixels moves the value by dx/trackWidth of the [min,max] span via
    /// <see cref="MuiSliderMath.ValueFromPointerDelta"/>. Double-tap resets
    /// to zero (clamped into range); arrow keys step by <see cref="Step"/>.
    /// </summary>
    public sealed class MuiLivingSlider : ContentControl
    {
        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiLivingSlider),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiLivingSlider)d).Rebuild()));

        public static readonly DependencyProperty ValueProperty =
            DependencyProperty.Register(nameof(Value), typeof(double), typeof(MuiLivingSlider),
                new PropertyMetadata(0.0, (d, _) => ((MuiLivingSlider)d).Rebuild()));

        public static readonly DependencyProperty MinimumProperty =
            DependencyProperty.Register(nameof(Minimum), typeof(double), typeof(MuiLivingSlider),
                new PropertyMetadata(-100.0, (d, _) => ((MuiLivingSlider)d).Rebuild()));

        public static readonly DependencyProperty MaximumProperty =
            DependencyProperty.Register(nameof(Maximum), typeof(double), typeof(MuiLivingSlider),
                new PropertyMetadata(100.0, (d, _) => ((MuiLivingSlider)d).Rebuild()));

        public static readonly DependencyProperty StepProperty =
            DependencyProperty.Register(nameof(Step), typeof(double), typeof(MuiLivingSlider),
                new PropertyMetadata(1.0, (d, _) => ((MuiLivingSlider)d).Rebuild()));

        public static readonly DependencyProperty UnitProperty =
            DependencyProperty.Register(nameof(Unit), typeof(string), typeof(MuiLivingSlider),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiLivingSlider)d).Rebuild()));

        public static readonly DependencyProperty GradientStartProperty =
            DependencyProperty.Register(nameof(GradientStart), typeof(Color?), typeof(MuiLivingSlider),
                new PropertyMetadata(null, (d, _) => ((MuiLivingSlider)d).Rebuild()));

        public static readonly DependencyProperty GradientEndProperty =
            DependencyProperty.Register(nameof(GradientEnd), typeof(Color?), typeof(MuiLivingSlider),
                new PropertyMetadata(null, (d, _) => ((MuiLivingSlider)d).Rebuild()));

        /// <summary>Draws a thin center notch when min mirrors max around
        /// zero (catalog: gradient-track slider used for bipolar tools like
        /// temperature/tint).</summary>
        public static readonly DependencyProperty BipolarProperty =
            DependencyProperty.Register(nameof(Bipolar), typeof(bool), typeof(MuiLivingSlider),
                new PropertyMetadata(false, (d, _) => ((MuiLivingSlider)d).Rebuild()));

        public string Label
        {
            get => (string)GetValue(LabelProperty);
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

        public string Unit
        {
            get => (string)GetValue(UnitProperty);
            set => SetValue(UnitProperty, value);
        }

        /// <summary>Left edge of the track gradient. Defaults to
        /// `color.border` (matching the web molecule's default gradient).</summary>
        public Color? GradientStart
        {
            get => (Color?)GetValue(GradientStartProperty);
            set => SetValue(GradientStartProperty, value);
        }

        /// <summary>Right edge of the track gradient. Defaults to
        /// `color.primary`.</summary>
        public Color? GradientEnd
        {
            get => (Color?)GetValue(GradientEndProperty);
            set => SetValue(GradientEndProperty, value);
        }

        public bool Bipolar
        {
            get => (bool)GetValue(BipolarProperty);
            set => SetValue(BipolarProperty, value);
        }

        /// <summary>Fires after a drag/keyboard/double-tap change.</summary>
        public event EventHandler<double>? ValueChanged;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 4 };
        private readonly Grid _headerRow = new();
        private readonly MuiText _labelText = new() { Variant = MuiTextVariant.RowLabel };
        private readonly MuiText _valueText = new() { Variant = MuiTextVariant.ValueChip };
        private readonly Border _track = new() { Height = 8, CornerRadius = new CornerRadius(999) };
        private readonly Grid _trackOverlay = new();
        private readonly Border _centerNotch = new() { Width = 1.5, HorizontalAlignment = HorizontalAlignment.Left };
        private readonly Ellipse _thumb = new() { Width = 16, Height = 16, StrokeThickness = 2, HorizontalAlignment = HorizontalAlignment.Left };

        private bool _dragging;
        private uint? _activePointerId;
        private double _pointerDownX;
        private double _pointerDownValue;
        private double _trackWidth;

        public MuiLivingSlider()
        {
            _headerRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            _headerRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            Grid.SetColumn(_valueText, 1);
            _headerRow.Children.Add(_labelText);
            _headerRow.Children.Add(_valueText);

            _trackOverlay.Children.Add(_centerNotch);
            _trackOverlay.Children.Add(_thumb);
            _track.Child = _trackOverlay;

            _root.Children.Add(_headerRow);
            _root.Children.Add(_track);
            Content = _root;
            IsTabStop = true;

            _track.PointerPressed += OnPointerPressed;
            _track.PointerMoved += OnPointerMoved;
            _track.PointerReleased += OnPointerReleased;
            _track.PointerCanceled += OnPointerReleased;
            _track.PointerCaptureLost += (_, _) => { _dragging = false; _activePointerId = null; };
            DoubleTapped += (_, _) => ResetToZero();
            KeyDown += OnKeyDown;
            SizeChanged += (_, _) => PositionThumb();
            IsEnabledChanged += (_, _) => Rebuild();

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];
        // The `Maple*Color` tokens are raw Color resources (Themes/Tokens.xaml
        // defines the brushes FROM them) — read them directly; casting
        // through SolidColorBrush throws InvalidCastException at first
        // construction.
        private static Color TokenColor(string key) => (Color)Application.Current.Resources[key];

        private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (!IsEnabled || !e.GetCurrentPoint(_track).Properties.IsLeftButtonPressed || _dragging) return;
            _trackWidth = _track.ActualWidth;
            _dragging = true;
            _activePointerId = e.Pointer.PointerId;
            _pointerDownX = e.GetCurrentPoint(_track).Position.X;
            _pointerDownValue = Value;
            _track.CapturePointer(e.Pointer);
            e.Handled = true;
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (!_dragging || e.Pointer.PointerId != _activePointerId) return;
            var dx = e.GetCurrentPoint(_track).Position.X - _pointerDownX;
            Value = MuiSliderMath.ValueFromPointerDelta(_pointerDownValue, dx, _trackWidth, Minimum, Maximum, Step > 0 ? Step : 1);
            ValueChanged?.Invoke(this, Value);
            e.Handled = true;
        }

        private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (e.Pointer.PointerId != _activePointerId) return;
            _dragging = false;
            _activePointerId = null;
            _track.ReleasePointerCapture(e.Pointer);
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

        private void ResetToZero()
        {
            if (!IsEnabled) return;
            Value = MuiSliderMath.Clamp(0, Minimum, Maximum);
            ValueChanged?.Invoke(this, Value);
        }

        private void PositionThumb()
        {
            var trackWidth = _track.ActualWidth;
            if (trackWidth <= 0) return;
            var pct = MuiSliderMath.PercentInRange(Value, Minimum, Maximum, fallbackPct: 50) / 100.0;
            var x = MuiSliderMath.Clamp(pct, 0, 1) * trackWidth;
            _thumb.Margin = new Thickness(x - _thumb.Width / 2, (_track.ActualHeight - _thumb.Height) / 2, 0, 0);

            var centerPct = MuiSliderMath.PercentInRange(0, Minimum, Maximum, fallbackPct: 50) / 100.0;
            _centerNotch.Margin = new Thickness(MuiSliderMath.Clamp(centerPct, 0, 1) * trackWidth, 0, 0, 0);
            _centerNotch.Height = _track.ActualHeight;
        }

        private void Rebuild()
        {
            _labelText.Text = Label;
            _valueText.Text = MuiSliderMath.FormatSignedValue(Value, Step > 0 ? Step : 1, Unit ?? string.Empty);

            var start = GradientStart ?? TokenColor("MapleBorderColor");
            var end = GradientEnd ?? TokenColor("MaplePrimaryColor");
            _track.Background = new LinearGradientBrush
            {
                StartPoint = new Windows.Foundation.Point(0, 0.5),
                EndPoint = new Windows.Foundation.Point(1, 0.5),
                GradientStops =
                {
                    new GradientStop { Color = start, Offset = 0 },
                    new GradientStop { Color = end, Offset = 1 },
                },
            };

            _thumb.Fill = R("MapleTextMain");
            _thumb.Stroke = R("MapleBg");
            _centerNotch.Background = R("MapleBg");
            _centerNotch.Visibility = Bipolar ? Visibility.Visible : Visibility.Collapsed;

            PositionThumb();

            Opacity = IsEnabled ? 1.0 : 0.45;

            if (!string.IsNullOrEmpty(Label))
                AutomationProperties.SetName(this, Label);
        }
    }
}
