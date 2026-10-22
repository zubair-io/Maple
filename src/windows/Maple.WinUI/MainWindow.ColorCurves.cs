using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Maple.UI.Atoms;
using Maple.WinUI.Models;
using Maple.WinUI.ViewModels;
using Maple.WinUI.Services;

namespace Maple.WinUI
{
    /// <summary>
    /// Oklab Secondary Color Curves UI (#5077) inside the Color › HSL tab:
    /// mode toggle (8-Band Mixer vs Color Curves), 6-curve selector pills,
    /// horizontal ribbon canvas with periodic/clamped Fritsch-Carlson spline,
    /// 6 quick hue anchors, skin-tone lock, and stage-input eyedropper.
    /// </summary>
    public sealed partial class MainWindow
    {
        private bool _hslCurvesMode;
        private ColorCurveKind _activeColorCurve = ColorCurveKind.HueVsHue;
        private int? _dragColorCurveKnot;
        private bool _colorCurvePickArmed;
        private long _colorCurvePickGeneration;
        private Windows.Foundation.Point? _colorCurvePressPoint;

        private readonly MuiActionButton _hslModeBandsBtn = new()
        {
            Label = "8-Band Mixer",
            ButtonSize = MuiActionButtonSize.Sm,
        };
        private readonly MuiActionButton _hslModeCurvesBtn = new()
        {
            Label = "Color Curves",
            ButtonSize = MuiActionButtonSize.Sm,
        };
        private readonly StackPanel _colorCurvesBody = new()
        {
            Spacing = 6,
            Visibility = Visibility.Collapsed,
        };
        private readonly Dictionary<ColorCurveKind, MuiActionButton> _colorCurveTabBtns = new();
        private readonly Canvas _colorCurveCanvas = new()
        {
            Height = 96,
            Background = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 24, 22, 20)),
        };
        private readonly StackPanel _colorCurveQuickAnchorsRow = new()
        {
            Orientation = Orientation.Horizontal,
            Spacing = 3,
        };
        private readonly MuiButton _colorCurveLockSkinBtn = new()
        {
            Label = "Lock Skin",
            Variant = MuiButtonVariant.Ghost,
            ButtonSize = MuiButtonSize.Sm,
        };
        private readonly MuiActionButton _colorCurvePickBtn = new()
        {
            IconName = "eyedrop",
            Label = "Pick",
            ButtonSize = MuiActionButtonSize.Sm,
        };
        private readonly TextBlock _colorCurveMessage = new()
        {
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            Visibility = Visibility.Collapsed,
        };

        private void BuildColorCurvesPanel()
        {
            var modeRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
            AutomationProperties.SetName(_hslModeBandsBtn, "8-Band Mixer mode");
            AutomationProperties.SetName(_hslModeCurvesBtn, "Color Curves mode");
            _hslModeBandsBtn.Click += (_, _) => SetHslCurvesMode(false);
            _hslModeCurvesBtn.Click += (_, _) => SetHslCurvesMode(true);
            modeRow.Children.Add(_hslModeBandsBtn);
            modeRow.Children.Add(_hslModeCurvesBtn);
            PanelColorCurvesHost.Children.Add(modeRow);

            var tabsGrid = new Grid { ColumnSpacing = 4, RowSpacing = 4 };
            for (var c = 0; c < 3; c++)
                tabsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            tabsGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            tabsGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            var kinds = Enum.GetValues<ColorCurveKind>();
            for (var i = 0; i < kinds.Length; i++)
            {
                var kind = kinds[i];
                var btn = new MuiActionButton
                {
                    Label = kind.ShortTitle(),
                    ButtonSize = MuiActionButtonSize.Sm,
                    HorizontalAlignment = HorizontalAlignment.Stretch,
                };
                AutomationProperties.SetName(btn, kind.Title());
                btn.Click += (_, _) =>
                {
                    _activeColorCurve = kind;
                    SyncColorCurvesPanel();
                };
                Grid.SetRow(btn, i / 3);
                Grid.SetColumn(btn, i % 3);
                _colorCurveTabBtns[kind] = btn;
                tabsGrid.Children.Add(btn);
            }
            _colorCurvesBody.Children.Add(tabsGrid);

            var ribbonBorder = new Border
            {
                CornerRadius = new CornerRadius(6),
                BorderThickness = new Thickness(1),
                BorderBrush = (Brush)Application.Current.Resources["MapleBorder"],
                Child = _colorCurveCanvas,
            };
            AutomationProperties.SetName(_colorCurveCanvas, "Oklab color curve ribbon");
            _colorCurveCanvas.SizeChanged += (_, _) => DrawColorCurveRibbon();
            _colorCurveCanvas.PointerPressed += OnColorCurveCanvasPointerPressed;
            _colorCurveCanvas.PointerMoved += OnColorCurveCanvasPointerMoved;
            _colorCurveCanvas.PointerReleased += OnColorCurveCanvasPointerReleased;
            _colorCurveCanvas.PointerCanceled += OnColorCurveCanvasPointerReleased;
            _colorCurveCanvas.PointerCaptureLost += OnColorCurveCanvasPointerReleased;
            _colorCurveCanvas.RightTapped += OnColorCurveCanvasRightTapped;
            _colorCurvesBody.Children.Add(ribbonBorder);

            foreach (var anchor in ColorCurveMath.QuickHueAnchors)
            {
                var chip = new MuiButton
                {
                    Label = anchor.Label[..1],
                    Variant = MuiButtonVariant.Ghost,
                    ButtonSize = MuiButtonSize.Sm,
                };
                ToolTipService.SetToolTip(chip, $"Insert {anchor.Label} anchor ({anchor.HueDeg:0}°)");
                AutomationProperties.SetName(chip, $"Insert {anchor.Label} hue anchor");
                var hueX = anchor.X;
                chip.Click += (_, _) => InsertColorCurveAnchorAt(hueX);
                _colorCurveQuickAnchorsRow.Children.Add(chip);
            }
            _colorCurvesBody.Children.Add(_colorCurveQuickAnchorsRow);

            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
            AutomationProperties.SetName(_colorCurveLockSkinBtn, "Lock skin tone");
            _colorCurveLockSkinBtn.Click += (_, _) => OnLockSkinToneClicked();
            footer.Children.Add(_colorCurveLockSkinBtn);

            AutomationProperties.SetName(_colorCurvePickBtn, "Pick color curve sample");
            _colorCurvePickBtn.Click += (_, _) =>
            {
                if (_colorCurvePickArmed) CancelColorCurvePick();
                else ArmColorCurvePick();
            };
            footer.Children.Add(_colorCurvePickBtn);

            var resetBtn = new MuiButton
            {
                Label = "Reset",
                Variant = MuiButtonVariant.Ghost,
                ButtonSize = MuiButtonSize.Sm,
            };
            AutomationProperties.SetName(resetBtn, "Reset active color curve");
            resetBtn.Click += (_, _) => ResetActiveColorCurve();
            footer.Children.Add(resetBtn);
            _colorCurvesBody.Children.Add(footer);

            _colorCurveMessage.Foreground = (Brush)Application.Current.Resources["MapleTextMuted"];
            _colorCurvesBody.Children.Add(_colorCurveMessage);
            PanelColorCurvesHost.Children.Add(_colorCurvesBody);

            ZoomHost.PointerPressed += OnColorCurveViewportPointerPressed;
            ZoomHost.PointerReleased += OnColorCurveViewportPointerReleased;
            ZoomHost.PointerCanceled += (_, _) => _colorCurvePressPoint = null;

            SyncColorCurvesPanel();
        }

        private void ShowColorCurvesHeader(bool hslTabActive)
        {
            PanelColorCurvesHost.Visibility = hslTabActive ? Visibility.Visible : Visibility.Collapsed;
            if (!hslTabActive)
            {
                CancelColorCurvePick();
                return;
            }
            PanelHslBands.Visibility = _hslCurvesMode ? Visibility.Collapsed : Visibility.Visible;
            _colorCurvesBody.Visibility = _hslCurvesMode ? Visibility.Visible : Visibility.Collapsed;
            SyncColorCurvesPanel();
        }

        private void SetHslCurvesMode(bool curvesMode)
        {
            _hslCurvesMode = curvesMode;
            if (!curvesMode)
                CancelColorCurvePick();
            if (_activeGroup == "Color" && _colorTab == "HSL")
            {
                PanelHslBands.Visibility = curvesMode ? Visibility.Collapsed : Visibility.Visible;
                _colorCurvesBody.Visibility = curvesMode ? Visibility.Visible : Visibility.Collapsed;
            }
            SyncColorCurvesPanel();
        }

        private void SyncColorCurvesPanel()
        {
            _hslModeBandsBtn.Selected = !_hslCurvesMode;
            _hslModeCurvesBtn.Selected = _hslCurvesMode;
            foreach (var (kind, btn) in _colorCurveTabBtns)
                btn.Selected = kind == _activeColorCurve;

            var isPeriodic = _activeColorCurve.IsPeriodic();
            _colorCurveQuickAnchorsRow.Visibility = isPeriodic ? Visibility.Visible : Visibility.Collapsed;
            _colorCurveLockSkinBtn.Visibility = isPeriodic ? Visibility.Visible : Visibility.Collapsed;
            _colorCurvePickBtn.Selected = _colorCurvePickArmed;
            DrawColorCurveRibbon();
        }

        private List<CurvePoint> ActiveColorCurvePoints() =>
            ColorCurveMath.CurvePoints(ViewModel.Adjustments, _activeColorCurve);

        private void WriteActiveColorCurvePoints(List<CurvePoint> next) =>
            WriteColorCurvePoints(_activeColorCurve, next);

        private void WriteColorCurvePoints(ColorCurveKind kind, List<CurvePoint> next)
        {
            ViewModel.ApplyDecodeFieldEdit(model =>
            {
                var target = ColorCurveMath.CurvePoints(model, kind);
                target.Clear();
                target.AddRange(next);
            });
            DrawColorCurveRibbon();
        }

        private void InsertColorCurveAnchorAt(double x)
        {
            var next = ColorCurveMath.InsertAnchor(ActiveColorCurvePoints(), x, _activeColorCurve);
            WriteActiveColorCurvePoints(next);
        }

        private void OnLockSkinToneClicked()
        {
            if (!_activeColorCurve.IsPeriodic()) return;
            var next = ColorCurveMath.LockSkinTone(ActiveColorCurvePoints());
            WriteActiveColorCurvePoints(next);
        }

        private void ResetActiveColorCurve()
        {
            WriteActiveColorCurvePoints(new List<CurvePoint>());
        }

        private void DrawColorCurveRibbon()
        {
            // Keep focused knot controls alive while rebuilding only the plotted paths.
            for (var i = _colorCurveCanvas.Children.Count - 1; i >= 0; i--)
                if (_colorCurveCanvas.Children[i] is not Button)
                    _colorCurveCanvas.Children.RemoveAt(i);
            var w = _colorCurveCanvas.ActualWidth > 10 ? _colorCurveCanvas.ActualWidth : 236.0;
            var h = _colorCurveCanvas.ActualHeight > 10 ? _colorCurveCanvas.ActualHeight : 96.0;

            var midline = new Line
            {
                X1 = 0,
                Y1 = h * 0.5,
                X2 = w,
                Y2 = h * 0.5,
                Stroke = new SolidColorBrush(Windows.UI.Color.FromArgb(90, 255, 255, 255)),
                StrokeThickness = 1,
            };
            _colorCurveCanvas.Children.Add(midline);

            var pts = ActiveColorCurvePoints();
            var poly = new Polyline
            {
                Stroke = new SolidColorBrush(Colors.White),
                StrokeThickness = 1.75,
            };
            const int samples = 96;
            for (var i = 0; i <= samples; i++)
            {
                var u = (double)i / samples;
                var y = ColorCurveMath.Evaluate(pts, u, _activeColorCurve);
                poly.Points.Add(new Windows.Foundation.Point(u * w, (1.0 - y) * h));
            }
            _colorCurveCanvas.Children.Add(poly);

            SyncColorCurveKnotControls(pts, w, h);
        }

        private void SetActiveColorCurvePointsDuringDrag(List<CurvePoint> next)
        {
            var target = ColorCurveMath.CurvePoints(ViewModel.Adjustments, _activeColorCurve);
            target.Clear();
            target.AddRange(next);
            ViewModel.NotifyAdjustmentEdited();
            DrawColorCurveRibbon();
        }

        private void OnColorCurveCanvasPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            var w = Math.Max(_colorCurveCanvas.ActualWidth, 1.0);
            var h = Math.Max(_colorCurveCanvas.ActualHeight, 1.0);
            var pos = e.GetCurrentPoint(_colorCurveCanvas).Position;
            var u = Math.Clamp(pos.X / w, 0.0, 1.0);
            var v = Math.Clamp(1.0 - pos.Y / h, 0.0, 1.0);

            var pts = ActiveColorCurvePoints();
            var hitIdx = -1;
            var bestDist = 14.0;
            for (var i = 0; i < pts.Count; i++)
            {
                var dx = pts[i].X * w - pos.X;
                var dy = (1.0 - pts[i].Y) * h - pos.Y;
                var dist = Math.Sqrt(dx * dx + dy * dy);
                if (dist <= bestDist)
                {
                    bestDist = dist;
                    hitIdx = i;
                }
            }

            ViewModel.BeginAdjustmentGesture(_colorCurveCanvas);
            if (hitIdx < 0)
            {
                var inserted = ColorCurveMath.InsertAnchor(
                    pts, u, _activeColorCurve, ColorCurveMath.DefaultSpread, v);
                var best = 0;
                var minDx = double.MaxValue;
                for (var i = 0; i < inserted.Count; i++)
                {
                    var d = Math.Abs(inserted[i].X - u);
                    if (d < minDx)
                    {
                        minDx = d;
                        best = i;
                    }
                }
                var clampedY = ColorCurveMath.ClampY(v, best, inserted, _activeColorCurve);
                inserted[best] = new CurvePoint(inserted[best].X, clampedY);
                _dragColorCurveKnot = best;
                SetActiveColorCurvePointsDuringDrag(inserted);
            }
            else
            {
                _dragColorCurveKnot = hitIdx;
            }
            _colorCurveCanvas.CapturePointer(e.Pointer);
            e.Handled = true;
        }

        private void OnColorCurveCanvasPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (_dragColorCurveKnot is not { } idx) return;
            var pts = ActiveColorCurvePoints();
            if (idx < 0 || idx >= pts.Count) return;

            var w = Math.Max(_colorCurveCanvas.ActualWidth, 1.0);
            var h = Math.Max(_colorCurveCanvas.ActualHeight, 1.0);
            var pos = e.GetCurrentPoint(_colorCurveCanvas).Position;
            var rawX = Math.Clamp(pos.X / w, 0.0, 1.0);
            var rawY = Math.Clamp(1.0 - pos.Y / h, 0.0, 1.0);
            var clampedX = ColorCurveMath.ClampX(_activeColorCurve, pts, idx, rawX);

            var next = new List<CurvePoint>(pts);
            next[idx] = new CurvePoint(clampedX, next[idx].Y);
            var clampedY = ColorCurveMath.ClampY(rawY, idx, next, _activeColorCurve);
            next[idx] = new CurvePoint(clampedX, clampedY);
            SetActiveColorCurvePointsDuringDrag(next);
            e.Handled = true;
        }

        private void OnColorCurveCanvasPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (_dragColorCurveKnot == null) return;
            _dragColorCurveKnot = null;
            _colorCurveCanvas.ReleasePointerCaptures();
            ViewModel.EndAdjustmentGesture(_colorCurveCanvas);
            e.Handled = true;
        }

        private void OnColorCurveCanvasRightTapped(object sender, RightTappedRoutedEventArgs e)
        {
            var w = Math.Max(_colorCurveCanvas.ActualWidth, 1.0);
            var h = Math.Max(_colorCurveCanvas.ActualHeight, 1.0);
            var pos = e.GetPosition(_colorCurveCanvas);
            var pts = ActiveColorCurvePoints();
            for (var i = 0; i < pts.Count; i++)
            {
                var dx = pts[i].X * w - pos.X;
                var dy = (1.0 - pts[i].Y) * h - pos.Y;
                if (Math.Sqrt(dx * dx + dy * dy) <= 14.0)
                {
                    var next = new List<CurvePoint>(pts);
                    next.RemoveAt(i);
                    WriteActiveColorCurvePoints(next);
                    e.Handled = true;
                    return;
                }
            }
        }

        private void ArmColorCurvePick()
        {
            ++_colorCurvePickGeneration;
            CancelWhiteBalancePick();
            _colorCurvePickArmed = true;
            _colorCurveMessage.Text = "Click the photo to place a stage-input anchor on the active curve (Esc cancels).";
            _colorCurveMessage.Visibility = Visibility.Visible;
            SyncColorCurvesPanel();
        }

        private void CancelColorCurvePick()
        {
            ++_colorCurvePickGeneration;
            if (!_colorCurvePickArmed) return;
            _colorCurvePickArmed = false;
            _colorCurvePressPoint = null;
            _colorCurveMessage.Visibility = Visibility.Collapsed;
            SyncColorCurvesPanel();
        }

        private void OnColorCurveViewportPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            _colorCurvePressPoint = _colorCurvePickArmed ? e.GetCurrentPoint(this.Content).Position : null;
        }

        private void OnColorCurveViewportPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (!_colorCurvePickArmed || _colorCurvePressPoint is not { } start)
                return;
            _colorCurvePressPoint = null;
            var end = e.GetCurrentPoint(this.Content).Position;
            if (!WhiteBalancePickLogic.IsClick(start.X, start.Y, end.X, end.Y))
                return;

            var local = e.GetCurrentPoint(CropRotateHost).Position;
            var point = ContentFitRect() is { } f
                ? WhiteBalancePickLogic.Normalize(local.X, local.Y, f.X, f.Y, f.W, f.H)
                : null;
            e.Handled = true;
            if (point is not { } p || ViewModel.SelectedPhoto is not { } photo)
            {
                CancelColorCurvePick();
                return;
            }
            var before = ViewModel.Adjustments.Clone();
            var kind = _activeColorCurve;
            var fingerprint = Services.Xmp.XmpWriter.Fingerprint(before);
            CancelColorCurvePick();
            var generation = _colorCurvePickGeneration;
            _ = Task.Run(() =>
            {
                var result = ColorCurveMath.SampleStageInput(photo.EditPath, before, p.X, p.Y);
                DispatcherQueue.TryEnqueue(() =>
                {
                    if (generation != _colorCurvePickGeneration
                        || !ReferenceEquals(ViewModel.SelectedPhoto, photo) || _activeColorCurve != kind
                        || Services.Xmp.XmpWriter.Fingerprint(ViewModel.Adjustments) != fingerprint) return;
                    if (result.Sample is not { } s)
                    {
                        _colorCurvePickArmed = true;
                        _colorCurveMessage.Text = result.Error + " (Esc cancels)";
                        _colorCurveMessage.Visibility = Visibility.Visible;
                        SyncColorCurvesPanel();
                        return;
                    }
                    var current = ColorCurveMath.CurvePoints(ViewModel.Adjustments, kind);
                    WriteColorCurvePoints(kind, ColorCurveMath.InsertAnchor(current, kind.SampleX(s), kind));
                });
            });
        }
    }
}
