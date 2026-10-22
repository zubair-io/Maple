using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Maple.UI;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        private readonly Dictionary<string, MuiColorWheel> _gradeWheels = new();
        private Canvas? _gradeZoneCanvas;
        private TextBlock? _gradeZoneReadout;
        private string? _draggingGradeEdge;
        private uint? _gradeEdgePointerId;

        /// <summary>Build the four wheel cells (wheel + caption + luminance
        /// slider), the balance + blending sliders, and the tonal zone weights
        /// strip. Wheels are code-built per zone so each MuiColorWheel wires
        /// straight to its zone view model.</summary>
        private void BuildGradePanel()
        {
            _gradeEdgeButtons.Clear();
            var cells = new Dictionary<string, StackPanel>
            {
                ["Shadows"] = GradeCellShadows,
                ["Midtones"] = GradeCellMidtones,
                ["Highlights"] = GradeCellHighlights,
                ["Global"] = GradeCellGlobal,
            };
            var gradeSliders = AdjustmentSections.Section(ViewModel.Sections, "Grade").Sliders;
            foreach (var zone in ViewModel.GradeZones)
            {
                var wheel = new MuiColorWheel
                {
                    WheelSize = 108,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    AccessibleLabel = $"{zone.Name} color wheel",
                };
                var vm = zone;
                wheel.ValueChanged += (_, v) => vm.ApplyWheel(v.Hue, v.Saturation);
                wheel.ResetRequested += (_, _) => vm.Reset();
                _gradeWheels[zone.Name] = wheel;

                var label = new TextBlock
                {
                    Text = zone.Name,
                    FontSize = 11,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    Foreground = (SolidColorBrush)Application.Current.Resources["MapleTextMain"],
                };
                var value = new TextBlock
                {
                    FontSize = 10,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    Foreground = (SolidColorBrush)Application.Current.Resources["MapleTextMuted"],
                };
                void SyncCaption()
                {
                    value.Text = vm.ValueText;
                    wheel.Hue = vm.Hue;
                    wheel.Saturation = vm.Saturation;
                }
                vm.PropertyChanged += (_, _) => SyncCaption();
                SyncCaption();

                var cell = cells[zone.Name];
                cell.Children.Add(wheel);
                cell.Children.Add(label);
                cell.Children.Add(value);
                var lum = gradeSliders.FirstOrDefault(s => s.Label == $"{zone.Name} Lum");
                if (lum != null)
                {
                    cell.Children.Add(new ContentControl
                    {
                        Content = lum,
                        ContentTemplate = (DataTemplate)((FrameworkElement)Content).Resources["SliderRowTemplate"],
                        HorizontalContentAlignment = HorizontalAlignment.Stretch,
                    });
                }
            }
            var balanceSlider = gradeSliders.First(s => s.Label == "Balance");
            var blendingSlider = gradeSliders.First(s => s.Label == "Blending");
            GradeBalanceHost.Content = balanceSlider;
            balanceSlider.PropertyChanged += (_, _) => RenderGradeZoneStrip();
            blendingSlider.PropertyChanged += (_, _) => RenderGradeZoneStrip();

            var blendingHost = new ContentControl
            {
                Margin = new Thickness(0, 4, 0, 0),
                Content = blendingSlider,
                ContentTemplate = (DataTemplate)((FrameworkElement)Content).Resources["SliderRowTemplate"],
                HorizontalContentAlignment = HorizontalAlignment.Stretch,
            };
            PanelGradeHost.Children.Add(blendingHost);

            var stripStack = new StackPanel { Spacing = 4, Margin = new Thickness(0, 8, 0, 0) };
            var header = new Grid();
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            header.Children.Add(new TextBlock
            {
                Text = "TONAL ZONE WEIGHTS",
                FontSize = 9,
                Foreground = (Brush)Application.Current.Resources["MapleTextMuted"],
            });
            _gradeZoneReadout = new TextBlock
            {
                FontSize = 9,
                Foreground = (Brush)Application.Current.Resources["MapleTextMuted"],
            };
            Grid.SetColumn(_gradeZoneReadout, 1);
            header.Children.Add(_gradeZoneReadout);

            _gradeZoneCanvas = new Canvas
            {
                Height = 44,
                Background = new SolidColorBrush(Windows.UI.Color.FromArgb(0x48, 0, 0, 0)),
            };
            AutomationProperties.SetName(_gradeZoneCanvas, "Tonal zone weights");
            _gradeZoneCanvas.SizeChanged += (_, _) => RenderGradeZoneStrip();
            _gradeZoneCanvas.PointerPressed += OnGradeZonePointerPressed;
            _gradeZoneCanvas.PointerMoved += OnGradeZonePointerMoved;
            _gradeZoneCanvas.PointerReleased += OnGradeZonePointerReleased;
            _gradeZoneCanvas.PointerCanceled += OnGradeZonePointerReleased;
            _gradeZoneCanvas.PointerCaptureLost += (_, e) =>
            {
                if (ReferenceEquals(e.OriginalSource, _gradeZoneCanvas)) OnGradeZonePointerReleased(_gradeZoneCanvas, e);
            };
            _gradeZoneCanvas.DoubleTapped += OnGradeZoneDoubleTapped;

            stripStack.Children.Add(header);
            stripStack.Children.Add(_gradeZoneCanvas);
            PanelGradeHost.Children.Add(stripStack);
        }

        private void OnGradeZonePointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (_gradeZoneCanvas == null || _gradeZoneCanvas.ActualWidth <= 0) return;
            var pt = e.GetCurrentPoint(_gradeZoneCanvas);
            if (!pt.Properties.IsLeftButtonPressed) return;
            var norm = pt.Position.X / _gradeZoneCanvas.ActualWidth;
            var adj = ViewModel.Adjustments;
            var dSh = Math.Abs(norm - adj.ColorGradeShadowEdge);
            var dHi = Math.Abs(norm - adj.ColorGradeHighlightEdge);
            _draggingGradeEdge = dSh <= dHi ? "shadow" : "highlight";
            _gradeEdgePointerId = e.Pointer.PointerId;
            if (!_gradeZoneCanvas.CapturePointer(e.Pointer)) { _draggingGradeEdge = null; return; }
            ViewModel.BeginAdjustmentGesture(_gradeZoneCanvas);
            ApplyGradeEdgeDrag(_draggingGradeEdge, norm);
            e.Handled = true;
        }

        private void OnGradeZonePointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (_draggingGradeEdge is not { } edge || e.Pointer.PointerId != _gradeEdgePointerId) return;
            if (_gradeZoneCanvas == null || _gradeZoneCanvas.ActualWidth <= 0) return;
            var norm = e.GetCurrentPoint(_gradeZoneCanvas).Position.X / _gradeZoneCanvas.ActualWidth;
            ApplyGradeEdgeDrag(edge, norm);
            e.Handled = true;
        }

        private void OnGradeZonePointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (e.Pointer.PointerId != _gradeEdgePointerId) return;
            _draggingGradeEdge = null;
            _gradeEdgePointerId = null;
            ViewModel.EndAdjustmentGesture(_gradeZoneCanvas!);
            _gradeZoneCanvas?.ReleasePointerCapture(e.Pointer);
            RenderGradeZoneStrip();
            e.Handled = true;
        }

        private void OnGradeZoneDoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
        {
            if (_gradeZoneCanvas == null || _gradeZoneCanvas.ActualWidth <= 0) return;
            var norm = e.GetPosition(_gradeZoneCanvas).X / _gradeZoneCanvas.ActualWidth;
            var adj = ViewModel.Adjustments;
            if (Math.Abs(norm - adj.ColorGradeShadowEdge) <= Math.Abs(norm - adj.ColorGradeHighlightEdge))
                adj.ColorGradeShadowEdge = MuiColorGradeZoneWeightsMath.DefaultShadowEdge;
            else
                adj.ColorGradeHighlightEdge = MuiColorGradeZoneWeightsMath.DefaultHighlightEdge;
            ViewModel.NotifyAdjustmentEdited();
            RenderGradeZoneStrip();
            e.Handled = true;
        }

        private void ApplyGradeEdgeDrag(string edge, double norm)
        {
            var adj = ViewModel.Adjustments;
            if (edge == "shadow")
                adj.ColorGradeShadowEdge = MuiColorGradeZoneWeightsMath.SnapEdge(
                    norm, MuiColorGradeZoneWeightsMath.MinShadowEdge, MuiColorGradeZoneWeightsMath.DefaultShadowEdge);
            else
                adj.ColorGradeHighlightEdge = MuiColorGradeZoneWeightsMath.SnapEdge(
                    norm, MuiColorGradeZoneWeightsMath.DefaultHighlightEdge, MuiColorGradeZoneWeightsMath.MaxHighlightEdge);
            ViewModel.NotifyAdjustmentEdited();
            RenderGradeZoneStrip();
        }

        private void RenderGradeZoneStrip()
        {
            var adj = ViewModel.Adjustments;
            if (_gradeZoneReadout != null)
                _gradeZoneReadout.Text = $"Sh {adj.ColorGradeShadowEdge:0.00} · Hi {adj.ColorGradeHighlightEdge:0.00}";
            if (_gradeZoneCanvas == null || _gradeZoneCanvas.ActualWidth <= 0) return;
            var w = _gradeZoneCanvas.ActualWidth;
            var h = _gradeZoneCanvas.ActualHeight > 0 ? _gradeZoneCanvas.ActualHeight : 44.0;
            foreach (var shape in _gradeZoneCanvas.Children.OfType<Shape>().ToList())
                _gradeZoneCanvas.Children.Remove(shape);

            var shLine = new Polyline { Stroke = new SolidColorBrush(Windows.UI.Color.FromArgb(0xD8, 0x22, 0xD3, 0xEE)), StrokeThickness = 1.5 };
            var midLine = new Polyline { Stroke = new SolidColorBrush(Windows.UI.Color.FromArgb(0xD8, 0xFB, 0x92, 0x3C)), StrokeThickness = 1.5 };
            var hiLine = new Polyline { Stroke = new SolidColorBrush(Windows.UI.Color.FromArgb(0xE6, 0xFA, 0xCC, 0x15)), StrokeThickness = 1.5 };
            for (var i = 0; i <= 48; i++)
            {
                var t = i / 48.0;
                var x = t * w;
                var (wSh, wMid, wHi) = MuiColorGradeZoneWeightsMath.ComputeWeights(
                    t, adj.SplitToneBalance, adj.ColorGradeBlending, adj.ColorGradeShadowEdge, adj.ColorGradeHighlightEdge);
                shLine.Points.Add(new((float)x, (float)((1.0 - wSh) * (h - 8.0) + 4.0)));
                midLine.Points.Add(new((float)x, (float)((1.0 - wMid) * (h - 8.0) + 4.0)));
                hiLine.Points.Add(new((float)x, (float)((1.0 - wHi) * (h - 8.0) + 4.0)));
            }
            _gradeZoneCanvas.Children.Add(shLine);
            _gradeZoneCanvas.Children.Add(midLine);
            _gradeZoneCanvas.Children.Add(hiLine);

            foreach (var (pos, col) in new[] {
                (adj.ColorGradeShadowEdge, Windows.UI.Color.FromArgb(0xFF, 0x22, 0xD3, 0xEE)),
                (adj.ColorGradeHighlightEdge, Windows.UI.Color.FromArgb(0xFF, 0xFA, 0xCC, 0x15)) })
            {
                var cx = pos * w;
                _gradeZoneCanvas.Children.Add(new Line
                {
                    X1 = cx, Y1 = 2, X2 = cx, Y2 = h - 2,
                    Stroke = new SolidColorBrush(col), StrokeThickness = 1.5, IsHitTestVisible = false,
                });
            }
            SyncGradeEdgeControls(w, h);
        }

        private void SyncGradeWheels()
        {
            foreach (var zone in ViewModel.GradeZones)
            {
                if (_gradeWheels.TryGetValue(zone.Name, out var wheel))
                {
                    wheel.Hue = zone.Hue;
                    wheel.Saturation = zone.Saturation;
                }
            }
            RenderGradeZoneStrip();
        }
    }
}
