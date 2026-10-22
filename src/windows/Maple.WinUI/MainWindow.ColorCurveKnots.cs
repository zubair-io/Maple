using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Windows.System;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        private void SyncColorCurveKnotControls(List<CurvePoint> points, double width, double height)
        {
            var controls = _colorCurveCanvas.Children.OfType<Button>().ToList();
            for (var i = 0; i < points.Count; i++)
            {
                var knot = i < controls.Count ? controls[i] : CreateColorCurveKnotControl(i);
                if (i >= controls.Count) _colorCurveCanvas.Children.Add(knot);
                var point = points[i];
                AutomationProperties.SetName(knot,
                    $"{_activeColorCurve.Title()} knot {i + 1}, input {point.X:P0}, output {point.Y:P0}");
                Canvas.SetLeft(knot, point.X * width - 7);
                Canvas.SetTop(knot, (1 - point.Y) * height - 7);
            }
            for (var i = controls.Count - 1; i >= points.Count; i--)
            {
                var wasFocused = controls[i].FocusState != FocusState.Unfocused;
                _colorCurveCanvas.Children.Remove(controls[i]);
                if (wasFocused && points.Count > 0)
                    _colorCurveCanvas.Children.OfType<Button>().Last().Focus(FocusState.Keyboard);
                else if (wasFocused) _colorCurveTabBtns[_activeColorCurve].Focus(FocusState.Keyboard);
            }
        }

        private Button CreateColorCurveKnotControl(int index)
        {
            var knot = new Button
            {
                Width = 14, Height = 14, MinWidth = 0, MinHeight = 0,
                Padding = new Thickness(0), BorderThickness = new Thickness(0),
                Background = new SolidColorBrush(Colors.Transparent), Tag = index,
                Content = new Ellipse
                {
                    Width = 10, Height = 10, Fill = new SolidColorBrush(Colors.White),
                    Stroke = new SolidColorBrush(Colors.Black), StrokeThickness = 1.5,
                },
            };
            Canvas.SetZIndex(knot, 1);
            AutomationProperties.SetAutomationId(knot, $"color-curve-knot-{index}");
            AutomationProperties.SetHelpText(knot, "Arrow keys move the knot. Shift moves faster. Delete removes it.");
            knot.KeyDown += OnColorCurveKnotKeyDown;
            return knot;
        }

        private void OnColorCurveKnotKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (sender is not Button { Tag: int index }) return;
            var control = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Control)
                .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
            var alt = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Menu)
                .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
            if (control || alt) return;
            var points = ActiveColorCurvePoints();
            if (index < 0 || index >= points.Count) return;
            var next = new List<CurvePoint>(points);
            if (e.Key is VirtualKey.Delete or VirtualKey.Back)
                next.RemoveAt(index);
            else
            {
                if (e.Key is not (VirtualKey.Left or VirtualKey.Right or VirtualKey.Up or VirtualKey.Down)) return;
                var shift = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift)
                    .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
                var step = shift ? .05 : .01;
                var dx = e.Key == VirtualKey.Left ? -step : e.Key == VirtualKey.Right ? step : 0;
                var dy = e.Key == VirtualKey.Down ? -step : e.Key == VirtualKey.Up ? step : 0;
                var point = points[index];
                var x = ColorCurveMath.ClampX(_activeColorCurve, points, index, point.X + dx);
                next[index] = new CurvePoint(x, point.Y);
                next[index] = new CurvePoint(x, ColorCurveMath.ClampY(point.Y + dy, index, next, _activeColorCurve));
            }
            e.Handled = true;
            if (!next.SequenceEqual(points)) WriteActiveColorCurvePoints(next);
        }
    }
}
