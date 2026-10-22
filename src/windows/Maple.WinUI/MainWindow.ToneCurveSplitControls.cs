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
        private readonly Dictionary<ParametricSplitHandle, Button> _splitButtons = new();
        private Line? _splitTrack;

        private void SyncSplitControls(double width, double shadow, double midtone, double highlight)
        {
            if (_curveSplitCanvas == null) return;
            if (_splitTrack == null)
            {
                _splitTrack = new Line
                {
                    X1 = 0, Y1 = 9, Y2 = 9, StrokeThickness = 1.5,
                    Stroke = (Brush)Application.Current.Resources["MapleBorder"],
                    IsHitTestVisible = false,
                };
                _curveSplitCanvas.Children.Insert(0, _splitTrack);
            }
            _splitTrack.X2 = width;
            foreach (var (handle, value) in new[]
            {
                (ParametricSplitHandle.Shadow, shadow),
                (ParametricSplitHandle.Midtone, midtone),
                (ParametricSplitHandle.Highlight, highlight),
            })
            {
                if (!_splitButtons.TryGetValue(handle, out var control))
                {
                    control = new Button
                    {
                        Width = 16, Height = 18, MinWidth = 0, MinHeight = 0,
                        Padding = new Thickness(0), BorderThickness = new Thickness(0), Tag = handle,
                        Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                        Content = new Polygon
                        {
                            Points = new PointCollection { new(5, 0), new(10, 5), new(5, 10), new(0, 5) },
                            Stroke = (Brush)Application.Current.Resources["MaplePrimary"],
                            StrokeThickness = 1,
                        },
                    };
                    AutomationProperties.SetAutomationId(control, $"tone-curve-split-{handle.ToString().ToLowerInvariant()}");
                    AutomationProperties.SetHelpText(control, "Arrow keys adjust the split. Shift moves faster. Enter resets it.");
                    control.AddHandler(UIElement.PointerPressedEvent,
                        new PointerEventHandler(OnSplitCanvasPointerPressed), handledEventsToo: true);
                    control.KeyDown += OnSplitKeyDown;
                    control.Click += (_, _) => SetSplitValue(control, handle, MuiToneCurveSplitsMath.DefaultValue(handle));
                    _splitButtons.Add(handle, control);
                    _curveSplitCanvas.Children.Add(control);
                }
                AutomationProperties.SetName(control, $"{handle} split {value:0}%");
                var diamond = (Polygon)control.Content;
                diamond.Fill = (Brush)Application.Current.Resources[
                    _draggingSplitHandle == handle ? "MaplePrimary" : "MapleTextMain"];
                Canvas.SetLeft(control, MuiToneCurveSplitsMath.AuthoringX(value) * width - 8);
                Canvas.SetTop(control, 0);
            }
        }

        private void OnSplitKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (sender is not Button { Tag: ParametricSplitHandle handle } control) return;
            if (e.Key is not (VirtualKey.Left or VirtualKey.Right or VirtualKey.Up or VirtualKey.Down)) return;
            bool Down(VirtualKey key) => InputKeyboardSource.GetKeyStateForCurrentThread(key)
                .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
            if (Down(VirtualKey.Control) || Down(VirtualKey.Menu)) return;
            var model = ViewModel.Adjustments;
            var value = handle switch
            {
                ParametricSplitHandle.Shadow => model.ParametricShadowSplit,
                ParametricSplitHandle.Midtone => model.ParametricMidtoneSplit,
                _ => model.ParametricHighlightSplit,
            };
            var step = Down(VirtualKey.Shift) ? 5 : 1;
            var delta = e.Key is VirtualKey.Left or VirtualKey.Down ? -step : step;
            SetSplitValue(control, handle, value + delta);
            e.Handled = true;
        }

        private void SetSplitValue(Button control, ParametricSplitHandle handle, double proposed)
        {
            if (_splitDragPointerId != null) return;
            ViewModel.BeginAdjustmentGesture(control);
            ApplySplitDrag(handle, proposed);
            ViewModel.EndAdjustmentGesture(control);
        }
    }
}
