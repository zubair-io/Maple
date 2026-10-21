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
using Maple.UI.Atoms;
using Maple.WinUI.Models;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        private string _curveChannel = "Luma";

        private MuiActionButton? _curveModePerChannelBtn;
        private MuiActionButton? _curveModeRatioBtn;
        private Canvas? _curveSplitCanvas;
        private TextBlock? _curveSplitsReadout;
        private MuiButton? _curveResetSplitsBtn;
        private ParametricSplitHandle? _draggingSplitHandle;
        private uint? _splitDragPointerId;

        private static readonly Dictionary<string, Windows.UI.Color> CurveChannelColors = new()
        {
            ["Luma"] = Windows.UI.Color.FromArgb(0xFF, 0xC4, 0x49, 0x3A),   // --pro-accent
            ["Red"] = Windows.UI.Color.FromArgb(0xFF, 0xD1, 0x58, 0x4A),
            ["Green"] = Windows.UI.Color.FromArgb(0xFF, 0x5A, 0xA3, 0x61),
            ["Blue"] = Windows.UI.Color.FromArgb(0xFF, 0x4F, 0x7F, 0xC4),
        };

        // --- Tone curve plot (#2576, #5039) ---

        private void BuildToneCurveControls()
        {
            // 1. Mode row (Per-Channel vs Ratio-Preserving) inserted at index 0 of PanelCurveHost
            var modeRow = new Grid { Margin = new Thickness(0, 0, 0, 2) };
            modeRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            modeRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            modeRow.Children.Add(new TextBlock
            {
                Text = "Mode",
                FontSize = 10,
                VerticalAlignment = VerticalAlignment.Center,
                Foreground = (Brush)Application.Current.Resources["MapleTextMuted"],
            });

            var modeBtns = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
            _curveModePerChannelBtn = new MuiActionButton
            {
                Label = "Per-Channel",
                ButtonSize = MuiActionButtonSize.Sm,
            };
            AutomationProperties.SetName(_curveModePerChannelBtn, "Per-Channel tone curve mode");
            _curveModePerChannelBtn.Click += (_, _) => SetToneCurveMode(ToneCurveMode.PerChannel);

            _curveModeRatioBtn = new MuiActionButton
            {
                Label = "Ratio-Preserving",
                ButtonSize = MuiActionButtonSize.Sm,
            };
            AutomationProperties.SetName(_curveModeRatioBtn, "Ratio-Preserving tone curve mode");
            _curveModeRatioBtn.Click += (_, _) => SetToneCurveMode(ToneCurveMode.RatioPreserving);

            modeBtns.Children.Add(_curveModePerChannelBtn);
            modeBtns.Children.Add(_curveModeRatioBtn);
            Grid.SetColumn(modeBtns, 1);
            modeRow.Children.Add(modeBtns);
            PanelCurveHost.Children.Insert(0, modeRow);

            // 2. Parametric split diamond strip inserted right below CurvePlot
            var splitContainer = new StackPanel { Spacing = 4, Margin = new Thickness(0, 2, 0, 2) };
            _curveSplitCanvas = new Canvas
            {
                Height = 18,
                Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            };
            AutomationProperties.SetName(_curveSplitCanvas, "Parametric split points");
            _curveSplitCanvas.SizeChanged += (_, _) => RenderSplitDiamonds();
            _curveSplitCanvas.PointerPressed += OnSplitCanvasPointerPressed;
            _curveSplitCanvas.PointerMoved += OnSplitCanvasPointerMoved;
            _curveSplitCanvas.PointerReleased += OnSplitCanvasPointerReleased;
            _curveSplitCanvas.PointerCanceled += OnSplitCanvasPointerReleased;
            _curveSplitCanvas.DoubleTapped += OnSplitCanvasDoubleTapped;

            var splitFooter = new Grid();
            splitFooter.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            splitFooter.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            _curveSplitsReadout = new TextBlock
            {
                FontSize = 9,
                VerticalAlignment = VerticalAlignment.Center,
                Foreground = (Brush)Application.Current.Resources["MapleTextMuted"],
            };
            _curveResetSplitsBtn = new MuiButton
            {
                Label = "Reset splits",
                Variant = MuiButtonVariant.Ghost,
                ButtonSize = MuiButtonSize.Sm,
                Visibility = Visibility.Collapsed,
            };
            AutomationProperties.SetName(_curveResetSplitsBtn, "Reset parametric splits");
            _curveResetSplitsBtn.Click += (_, _) => ResetParametricSplits();
            Grid.SetColumn(_curveResetSplitsBtn, 1);
            splitFooter.Children.Add(_curveSplitsReadout);
            splitFooter.Children.Add(_curveResetSplitsBtn);

            splitContainer.Children.Add(_curveSplitCanvas);
            splitContainer.Children.Add(splitFooter);
            PanelCurveHost.Children.Add(splitContainer);
        }

        private void SetToneCurveMode(ToneCurveMode mode)
        {
            if (ViewModel.Adjustments.ToneCurveMode == mode) return;
            ViewModel.Adjustments.ToneCurveMode = mode;
            ViewModel.NotifyAdjustmentEdited();
            RefreshCurvePlot();
        }

        private void ResetParametricSplits()
        {
            ViewModel.Adjustments.ParametricShadowSplit = MuiToneCurveSplitsMath.DefaultShadowSplit;
            ViewModel.Adjustments.ParametricMidtoneSplit = MuiToneCurveSplitsMath.DefaultMidtoneSplit;
            ViewModel.Adjustments.ParametricHighlightSplit = MuiToneCurveSplitsMath.DefaultHighlightSplit;
            ViewModel.NotifyAdjustmentEdited();
            RenderSplitDiamonds();
        }

        private void OnSplitCanvasPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (_curveSplitCanvas == null || _curveSplitCanvas.ActualWidth <= 0) return;
            var pt = e.GetCurrentPoint(_curveSplitCanvas);
            if (!pt.Properties.IsLeftButtonPressed) return;
            var pct = pt.Position.X / _curveSplitCanvas.ActualWidth * 100.0;
            var adj = ViewModel.Adjustments;
            var candidates = new (ParametricSplitHandle Handle, double Dist)[]
            {
                (ParametricSplitHandle.Shadow, Math.Abs(pct - adj.ParametricShadowSplit)),
                (ParametricSplitHandle.Midtone, Math.Abs(pct - adj.ParametricMidtoneSplit)),
                (ParametricSplitHandle.Highlight, Math.Abs(pct - adj.ParametricHighlightSplit)),
            };
            var nearest = candidates.OrderBy(c => c.Dist).First();
            if (nearest.Dist > 8.0) return;

            _draggingSplitHandle = nearest.Handle;
            _splitDragPointerId = e.Pointer.PointerId;
            _curveSplitCanvas.CapturePointer(e.Pointer);
            ApplySplitDrag(nearest.Handle, pct);
            e.Handled = true;
        }

        private void OnSplitCanvasPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (_draggingSplitHandle is not { } handle || e.Pointer.PointerId != _splitDragPointerId) return;
            if (_curveSplitCanvas == null || _curveSplitCanvas.ActualWidth <= 0) return;
            var pct = e.GetCurrentPoint(_curveSplitCanvas).Position.X / _curveSplitCanvas.ActualWidth * 100.0;
            ApplySplitDrag(handle, pct);
            e.Handled = true;
        }

        private void OnSplitCanvasPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (e.Pointer.PointerId != _splitDragPointerId) return;
            _curveSplitCanvas?.ReleasePointerCapture(e.Pointer);
            _draggingSplitHandle = null;
            _splitDragPointerId = null;
            RenderSplitDiamonds();
            e.Handled = true;
        }

        private void OnSplitCanvasDoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
        {
            if (_curveSplitCanvas == null || _curveSplitCanvas.ActualWidth <= 0) return;
            var pct = e.GetPosition(_curveSplitCanvas).X / _curveSplitCanvas.ActualWidth * 100.0;
            var adj = ViewModel.Adjustments;
            var candidates = new (ParametricSplitHandle Handle, double Dist)[]
            {
                (ParametricSplitHandle.Shadow, Math.Abs(pct - adj.ParametricShadowSplit)),
                (ParametricSplitHandle.Midtone, Math.Abs(pct - adj.ParametricMidtoneSplit)),
                (ParametricSplitHandle.Highlight, Math.Abs(pct - adj.ParametricHighlightSplit)),
            };
            var nearest = candidates.OrderBy(c => c.Dist).First();
            if (nearest.Dist > 8.0) return;
            ApplySplitDrag(nearest.Handle, MuiToneCurveSplitsMath.DefaultValue(nearest.Handle));
            e.Handled = true;
        }

        private void ApplySplitDrag(ParametricSplitHandle handle, double proposed)
        {
            var adj = ViewModel.Adjustments;
            var clamped = MuiToneCurveSplitsMath.ClampSplit(
                handle, proposed,
                adj.ParametricShadowSplit,
                adj.ParametricMidtoneSplit,
                adj.ParametricHighlightSplit);
            switch (handle)
            {
                case ParametricSplitHandle.Shadow:
                    adj.ParametricShadowSplit = clamped;
                    break;
                case ParametricSplitHandle.Midtone:
                    adj.ParametricMidtoneSplit = clamped;
                    break;
                case ParametricSplitHandle.Highlight:
                    adj.ParametricHighlightSplit = clamped;
                    break;
            }
            ViewModel.NotifyAdjustmentEdited();
            RenderSplitDiamonds();
        }

        private void RenderSplitDiamonds()
        {
            var adj = ViewModel.Adjustments;
            var (s, m, h) = MuiToneCurveSplitsMath.OrderedSplits(
                adj.ParametricShadowSplit,
                adj.ParametricMidtoneSplit,
                adj.ParametricHighlightSplit);

            if (_curveSplitsReadout != null)
                _curveSplitsReadout.Text = $"Splits: {s:0} / {m:0} / {h:0}";
            if (_curveResetSplitsBtn != null)
            {
                var modified = Math.Abs(s - MuiToneCurveSplitsMath.DefaultShadowSplit) > 0.5
                    || Math.Abs(m - MuiToneCurveSplitsMath.DefaultMidtoneSplit) > 0.5
                    || Math.Abs(h - MuiToneCurveSplitsMath.DefaultHighlightSplit) > 0.5;
                _curveResetSplitsBtn.Visibility = modified ? Visibility.Visible : Visibility.Collapsed;
            }

            if (_curveSplitCanvas == null || _curveSplitCanvas.ActualWidth <= 0) return;
            var w = _curveSplitCanvas.ActualWidth;
            _curveSplitCanvas.Children.Clear();

            var track = new Line
            {
                X1 = 0, Y1 = 9, X2 = w, Y2 = 9,
                Stroke = (Brush)Application.Current.Resources["MapleBorder"],
                StrokeThickness = 1.5,
                IsHitTestVisible = false,
            };
            _curveSplitCanvas.Children.Add(track);

            var splits = new (ParametricSplitHandle Handle, double Val)[]
            {
                (ParametricSplitHandle.Shadow, s),
                (ParametricSplitHandle.Midtone, m),
                (ParametricSplitHandle.Highlight, h),
            };
            var accent = (Brush)Application.Current.Resources["MaplePrimary"];
            var textBrush = (Brush)Application.Current.Resources["MapleTextMain"];

            foreach (var (handle, val) in splits)
            {
                var cx = val / 100.0 * w;
                var active = _draggingSplitHandle == handle;
                var diamond = new Polygon
                {
                    Points = new PointCollection
                    {
                        new(cx, 4),
                        new(cx + 5, 9),
                        new(cx, 14),
                        new(cx - 5, 9),
                    },
                    Fill = active ? accent : textBrush,
                    Stroke = accent,
                    StrokeThickness = active ? 1.5 : 1.0,
                    IsHitTestVisible = false,
                };
                _curveSplitCanvas.Children.Add(diamond);
            }
        }

        private List<Models.CurvePoint> CurveChannelPoints() => _curveChannel switch
        {
            "Red" => ViewModel.Adjustments.ToneCurveRed,
            "Green" => ViewModel.Adjustments.ToneCurveGreen,
            "Blue" => ViewModel.Adjustments.ToneCurveBlue,
            _ => ViewModel.Adjustments.ToneCurveLuma,
        };

        private void OnCurveChannel(object sender, RoutedEventArgs e)
        {
            _curveChannel = ReferenceEquals(sender, CurveTabRed) ? "Red"
                : ReferenceEquals(sender, CurveTabGreen) ? "Green"
                : ReferenceEquals(sender, CurveTabBlue) ? "Blue"
                : "Luma";
            RefreshCurvePlot();
        }

        private void OnCurvePointsChanged(object? sender, IReadOnlyList<MuiCurvePoint> points)
        {
            var target = CurveChannelPoints();
            target.Clear();
            target.AddRange(points.Select(p => new Models.CurvePoint(p.X, p.Y)));
            ViewModel.NotifyAdjustmentEdited();
            CurveResetButton.IsEnabled = points.Count > 0;
        }

        private void OnCurveReset(object sender, RoutedEventArgs e)
        {
            CurveChannelPoints().Clear();
            ViewModel.NotifyAdjustmentEdited();
            RefreshCurvePlot();
        }

        private void RefreshCurvePlot()
        {
            CurveTabLuma.Selected = _curveChannel == "Luma";
            CurveTabRed.Selected = _curveChannel == "Red";
            CurveTabGreen.Selected = _curveChannel == "Green";
            CurveTabBlue.Selected = _curveChannel == "Blue";
            if (_curveModePerChannelBtn != null)
                _curveModePerChannelBtn.Selected = ViewModel.Adjustments.ToneCurveMode == ToneCurveMode.PerChannel;
            if (_curveModeRatioBtn != null)
                _curveModeRatioBtn.Selected = ViewModel.Adjustments.ToneCurveMode == ToneCurveMode.RatioPreserving;
            var points = CurveChannelPoints();
            CurvePlot.AccentBrush = new SolidColorBrush(CurveChannelColors[_curveChannel]);
            CurvePlot.Points = points.Select(p => new MuiCurvePoint(p.X, p.Y)).ToList();
            CurveResetButton.IsEnabled = points.Count > 0;
            UpdateCurveHistogram();
            RenderSplitDiamonds();
        }

        /// <summary>Feed the luma bins (ComputeHistogram tail) to the plot
        /// backdrop; called whenever new histogram bins arrive.</summary>
        private void UpdateCurveHistogram()
        {
            if (PanelCurveHost.Visibility != Visibility.Visible || _lastHistogramBins is not { Length: >= 1024 } bins)
                return;
            CurvePlot.HistogramBins = bins[768..1024];
        }
    }
}
