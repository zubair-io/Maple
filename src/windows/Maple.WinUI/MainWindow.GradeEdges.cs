using System;
using System.Collections.Generic;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Maple.UI;
using Windows.System;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        private readonly Dictionary<string, Button> _gradeEdgeButtons = new();

        private void SyncGradeEdgeControls(double width, double height)
        {
            foreach (var edge in new[] { "shadow", "highlight" })
            {
                if (!_gradeEdgeButtons.TryGetValue(edge, out var control))
                {
                    control = new Button
                    {
                        Width = 44, Height = 44, MinWidth = 0, MinHeight = 0,
                        Padding = new Thickness(0), BorderThickness = new Thickness(0), Tag = edge,
                        Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                        Content = new Ellipse
                        {
                            Width = 10, Height = 10,
                            Fill = new SolidColorBrush(edge == "shadow" ? Microsoft.UI.Colors.Cyan : Microsoft.UI.Colors.Yellow),
                            Stroke = new SolidColorBrush(Microsoft.UI.Colors.Black), StrokeThickness = 1,
                        },
                    };
                    Canvas.SetZIndex(control, 1);
                    AutomationProperties.SetAutomationId(control, $"color-grade-{edge}-edge");
                    AutomationProperties.SetHelpText(control, "Arrow keys adjust the edge. Shift moves faster. Enter resets it.");
                    control.AddHandler(UIElement.PointerPressedEvent,
                        new PointerEventHandler(OnGradeZonePointerPressed), handledEventsToo: true);
                    control.KeyDown += OnGradeEdgeKeyDown;
                    control.Click += (_, _) => SetGradeEdge(control, edge, edge == "shadow"
                        ? MuiColorGradeZoneWeightsMath.DefaultShadowEdge : MuiColorGradeZoneWeightsMath.DefaultHighlightEdge);
                    _gradeEdgeButtons.Add(edge, control);
                    _gradeZoneCanvas!.Children.Add(control);
                }
                var value = GradeEdgeValue(edge);
                AutomationProperties.SetName(control, $"{(edge == "shadow" ? "Shadow" : "Highlight")} edge {value:P1}");
                control.Height = 44;
                Canvas.SetLeft(control, MuiColorGradeZoneWeightsMath.PlotPosition(value, ViewModel.Adjustments.SplitToneBalance) * width - 22);
                Canvas.SetTop(control, edge == "shadow" ? 0 : height - 44);
            }
        }

        private double GradeEdgeValue(string edge) => edge == "shadow"
            ? ViewModel.Adjustments.ColorGradeShadowEdge : ViewModel.Adjustments.ColorGradeHighlightEdge;

        private void OnGradeEdgeKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (sender is not Button { Tag: string edge } control) return;
            if (e.Key is not (VirtualKey.Left or VirtualKey.Right or VirtualKey.Up or VirtualKey.Down)) return;
            bool Down(VirtualKey key) => InputKeyboardSource.GetKeyStateForCurrentThread(key)
                .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
            if (Down(VirtualKey.Control) || Down(VirtualKey.Menu)) return;
            var step = Down(VirtualKey.Shift) ? .05 : .01;
            var delta = e.Key is VirtualKey.Left or VirtualKey.Down ? -step : step;
            SetGradeEdge(control, edge, GradeEdgeValue(edge) + delta);
            e.Handled = true;
        }

        private void SetGradeEdge(Button control, string edge, double value)
        {
            ViewModel.BeginAdjustmentGesture(control);
            ApplyGradeEdgeDrag(edge, value);
            ViewModel.EndAdjustmentGesture(control);
        }
    }
}
