using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI 2-D Pad molecule (unified-component-catalog.md §2.1, "2-D
    /// Pad" row: "Two-axis draggable puck", a primitive plot with no atom
    /// dependency) — a bordered square the puck drags freely across both
    /// axes at once (e.g. a split-tone balance control), sitting beside
    /// <see cref="MuiColorWheel"/> in the catalog as the other "primitive
    /// plot" molecule and sharing its y-up value convention and
    /// pointer-drag plumbing shape.
    ///
    /// Drives its pointer/keyboard math through the standalone,
    /// unit-tested <see cref="MuiPad2DMath"/>, token-styled chrome (no
    /// bitmap rendering needed — a plain bordered surface with a center
    /// crosshair reference, unlike the Color Wheel's hue disc).
    /// </summary>
    public sealed class MuiPad2D : ContentControl
    {
        public static readonly DependencyProperty XValueProperty =
            DependencyProperty.Register(nameof(XValue), typeof(double), typeof(MuiPad2D),
                new PropertyMetadata(0.0, (d, _) => ((MuiPad2D)d).OnValueChanged()));

        public static readonly DependencyProperty YValueProperty =
            DependencyProperty.Register(nameof(YValue), typeof(double), typeof(MuiPad2D),
                new PropertyMetadata(0.0, (d, _) => ((MuiPad2D)d).OnValueChanged()));

        public static readonly DependencyProperty MinXProperty =
            DependencyProperty.Register(nameof(MinX), typeof(double), typeof(MuiPad2D),
                new PropertyMetadata(-100.0, (d, _) => ((MuiPad2D)d).Rebuild()));

        public static readonly DependencyProperty MaxXProperty =
            DependencyProperty.Register(nameof(MaxX), typeof(double), typeof(MuiPad2D),
                new PropertyMetadata(100.0, (d, _) => ((MuiPad2D)d).Rebuild()));

        public static readonly DependencyProperty MinYProperty =
            DependencyProperty.Register(nameof(MinY), typeof(double), typeof(MuiPad2D),
                new PropertyMetadata(-100.0, (d, _) => ((MuiPad2D)d).Rebuild()));

        public static readonly DependencyProperty MaxYProperty =
            DependencyProperty.Register(nameof(MaxY), typeof(double), typeof(MuiPad2D),
                new PropertyMetadata(100.0, (d, _) => ((MuiPad2D)d).Rebuild()));

        public static readonly DependencyProperty StepProperty =
            DependencyProperty.Register(nameof(Step), typeof(double), typeof(MuiPad2D),
                new PropertyMetadata(1.0, (d, _) => ((MuiPad2D)d).Rebuild()));

        public static readonly DependencyProperty PadSizeProperty =
            DependencyProperty.Register(nameof(PadSize), typeof(double), typeof(MuiPad2D),
                new PropertyMetadata(96.0, (d, _) => ((MuiPad2D)d).Rebuild()));

        public static readonly DependencyProperty AccessibleLabelProperty =
            DependencyProperty.Register(nameof(AccessibleLabel), typeof(string), typeof(MuiPad2D),
                new PropertyMetadata("2-D pad", (d, _) => ((MuiPad2D)d).Rebuild()));

        public double XValue
        {
            get => (double)GetValue(XValueProperty);
            set => SetValue(XValueProperty, value);
        }

        public double YValue
        {
            get => (double)GetValue(YValueProperty);
            set => SetValue(YValueProperty, value);
        }

        public double MinX
        {
            get => (double)GetValue(MinXProperty);
            set => SetValue(MinXProperty, value);
        }

        public double MaxX
        {
            get => (double)GetValue(MaxXProperty);
            set => SetValue(MaxXProperty, value);
        }

        public double MinY
        {
            get => (double)GetValue(MinYProperty);
            set => SetValue(MinYProperty, value);
        }

        public double MaxY
        {
            get => (double)GetValue(MaxYProperty);
            set => SetValue(MaxYProperty, value);
        }

        public double Step
        {
            get => (double)GetValue(StepProperty);
            set => SetValue(StepProperty, value);
        }

        public double PadSize
        {
            get => (double)GetValue(PadSizeProperty);
            set => SetValue(PadSizeProperty, value);
        }

        public string AccessibleLabel
        {
            get => (string)GetValue(AccessibleLabelProperty);
            set => SetValue(AccessibleLabelProperty, value);
        }

        /// <summary>Fires on every drag/keyboard change.</summary>
        public event EventHandler<MuiPad2DValue>? ValueChanged;

        /// <summary>Fires on double-tap — the host should reset to the
        /// range's midpoint on both axes.</summary>
        public event EventHandler? ResetRequested;

        private readonly Border _chrome = new() { BorderThickness = new Thickness(1) };
        private readonly Grid _surface = new();
        private readonly Line _crosshairV = new() { StrokeThickness = 1 };
        private readonly Line _crosshairH = new() { StrokeThickness = 1 };
        private readonly Ellipse _puck = new()
        {
            Width = 12,
            Height = 12,
            StrokeThickness = 2,
            IsHitTestVisible = false,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Top,
        };

        private bool _dragging;
        private uint? _activePointerId;

        public MuiPad2D()
        {
            _surface.Children.Add(_crosshairV);
            _surface.Children.Add(_crosshairH);
            _surface.Children.Add(_puck);
            _chrome.Child = _surface;
            Content = _chrome;
            IsTabStop = true;

            PointerPressed += OnPointerPressed;
            PointerMoved += OnPointerMoved;
            PointerReleased += OnPointerReleased;
            PointerCanceled += OnPointerReleased;
            PointerCaptureLost += (_, _) => { _dragging = false; _activePointerId = null; };
            DoubleTapped += (_, _) => { if (IsEnabled) ResetRequested?.Invoke(this, EventArgs.Empty); };
            KeyDown += OnKeyDown;
            SizeChanged += (_, _) => Layout();
            IsEnabledChanged += (_, _) => Rebuild();

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void OnValueChanged() => Layout();

        private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (!IsEnabled || !e.GetCurrentPoint(_chrome).Properties.IsLeftButtonPressed || _dragging) return;
            _dragging = true;
            _activePointerId = e.Pointer.PointerId;
            CapturePointer(e.Pointer);
            ApplyPointer(e);
            e.Handled = true;
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (!_dragging || e.Pointer.PointerId != _activePointerId) return;
            ApplyPointer(e);
            e.Handled = true;
        }

        private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (e.Pointer.PointerId != _activePointerId) return;
            _dragging = false;
            _activePointerId = null;
            ReleasePointerCapture(e.Pointer);
            e.Handled = true;
        }

        private void ApplyPointer(PointerRoutedEventArgs e)
        {
            var width = _chrome.ActualWidth;
            var height = _chrome.ActualHeight;
            if (width <= 0 || height <= 0) return;
            var pt = e.GetCurrentPoint(_chrome).Position;
            var next = MuiPad2DMath.PointerToValue(pt.X / width, pt.Y / height, MinX, MaxX, MinY, MaxY);
            XValue = next.X;
            YValue = next.Y;
            ValueChanged?.Invoke(this, next);
        }

        private void OnKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (!IsEnabled) return;
            var step = Step > 0 ? Step : 1;
            double x = XValue, y = YValue;
            switch (e.Key)
            {
                case Windows.System.VirtualKey.Left: x = MuiSliderMath.Clamp(x - step, MinX, MaxX); break;
                case Windows.System.VirtualKey.Right: x = MuiSliderMath.Clamp(x + step, MinX, MaxX); break;
                case Windows.System.VirtualKey.Up: y = MuiSliderMath.Clamp(y + step, MinY, MaxY); break;
                case Windows.System.VirtualKey.Down: y = MuiSliderMath.Clamp(y - step, MinY, MaxY); break;
                default: return;
            }
            e.Handled = true;
            XValue = x;
            YValue = y;
            ValueChanged?.Invoke(this, new MuiPad2DValue(x, y));
        }

        private void Layout()
        {
            var width = _chrome.ActualWidth;
            var height = _chrome.ActualHeight;
            if (width <= 0 || height <= 0) return;

            var (x01, y01) = MuiPad2DMath.ValueToUnitPosition(XValue, YValue, MinX, MaxX, MinY, MaxY);
            _puck.Margin = new Thickness(x01 * width - 6, y01 * height - 6, 0, 0);

            var (centerX01, centerY01) = MuiPad2DMath.ValueToUnitPosition(0, 0, MinX, MaxX, MinY, MaxY);
            _crosshairV.X1 = centerX01 * width; _crosshairV.Y1 = 0;
            _crosshairV.X2 = centerX01 * width; _crosshairV.Y2 = height;
            _crosshairH.X1 = 0; _crosshairH.Y1 = centerY01 * height;
            _crosshairH.X2 = width; _crosshairH.Y2 = centerY01 * height;
        }

        private void Rebuild()
        {
            Width = PadSize;
            Height = PadSize;
            _chrome.Background = R("MapleSurface");
            _chrome.BorderBrush = R("MapleBorder");
            _chrome.CornerRadius = new CornerRadius(8);
            _crosshairV.Stroke = R("MapleBorder");
            _crosshairH.Stroke = R("MapleBorder");
            _puck.Fill = R("MaplePrimary");
            _puck.Stroke = R("MapleTextMain");

            Layout();

            Opacity = IsEnabled ? 1.0 : 0.45;

            var name = $"{AccessibleLabel}, x {Math.Round(XValue)}, y {Math.Round(YValue)}";
            AutomationProperties.SetName(this, name);
        }
    }
}
