using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Maple.UI;
using Maple.UI.Atoms;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    /// <summary>Edit-screen chrome: the floating tool rail and group panels,
    /// star row, EXIF flyout, and histogram plot.</summary>
    public sealed partial class MainWindow
    {
        private readonly MuiButton[] _starButtons = new MuiButton[5];
        private readonly Dictionary<string, MuiActionButton> _railButtons = new();
        private string? _activeGroup;
        private string _colorTab = "Basic";
        private string _effectsTab = "Basic";
        private string _curveChannel = "Luma";
        private readonly Dictionary<string, MuiColorWheel> _gradeWheels = new();

        private static readonly Dictionary<string, Windows.UI.Color> CurveChannelColors = new()
        {
            ["Luma"] = Windows.UI.Color.FromArgb(0xFF, 0xC4, 0x49, 0x3A),   // --pro-accent
            ["Red"] = Windows.UI.Color.FromArgb(0xFF, 0xD1, 0x58, 0x4A),
            ["Green"] = Windows.UI.Color.FromArgb(0xFF, 0x5A, 0xA3, 0x61),
            ["Blue"] = Windows.UI.Color.FromArgb(0xFF, 0x4F, 0x7F, 0xC4),
        };

        // --- Tool rail ---
        // Icons come from the shared Maple stroke family (MapleIconShapes) \u2014
        // the same names/artwork the web tool dock and Apple use.

        private static readonly (string Title, string Icon, string? DisabledNote)[] RailGroups =
        {
            ("Light", "tool-exposure", null),
            ("Color", "tool-tint", null),
            ("Effects", "tool-vignette", null),
            ("Detail", "tool-sharpen", null),
            ("Tone Curve", "tool-contrast", null),
            ("Crop", "tool-crop", null),
        };

        private void BuildEditRail()
        {
            foreach (var (title, icon, disabledNote) in RailGroups)
            {
                var button = new MuiActionButton
                {
                    IconName = icon,
                    Label = title,
                    ButtonSize = MuiActionButtonSize.Sm,
                    Orientation = MuiActionButtonOrientation.Stacked,
                    IsEnabled = disabledNote == null,
                };
                ToolTipService.SetToolTip(button, disabledNote ?? title);
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, $"{title} tools");
                var group = title;
                button.Click += (_, _) => ToggleGroupPanel(group);
                _railButtons[title] = button;
                EditRailStack.Children.Add(button);
            }
        }

        private void ToggleGroupPanel(string group)
        {
            if (_activeGroup == group)
            {
                CloseGroupPanel();
                return;
            }
            if (_activeGroup == "Crop" && group != "Crop")
                ExitCropMode();
            _activeGroup = group;
            RefreshRailArming(group);
            EditPanel.Visibility = Visibility.Visible;
            EditPanelTitle.Text = group.ToUpperInvariant();
            ColorTabRow.Visibility = group == "Color" ? Visibility.Visible : Visibility.Collapsed;
            EffectsTabRow.Visibility = group == "Effects" ? Visibility.Visible : Visibility.Collapsed;
            PanelFootnote.Visibility = Visibility.Collapsed;
            PanelGradeHost.Visibility = Visibility.Collapsed;
            PanelProfileHost.Visibility = group == "Color" ? Visibility.Visible : Visibility.Collapsed;
            PanelCurveHost.Visibility = group == "Tone Curve" ? Visibility.Visible : Visibility.Collapsed;
            PanelCropHost.Visibility = group == "Crop" ? Visibility.Visible : Visibility.Collapsed;

            if (group == "Color")
            {
                ShowColorTab(_colorTab);
                return;
            }
            if (group == "Effects")
            {
                ShowEffectsTab(_effectsTab);
                return;
            }
            if (group == "Crop")
            {
                PanelBwHeader.Visibility = Visibility.Collapsed;
                PanelHslBands.ItemsSource = null;
                PanelHslBands.Visibility = Visibility.Collapsed;
                PanelSliders.Visibility = Visibility.Collapsed;
                PanelSliders.ItemsSource = null;
                EnterCropMode();
                return;
            }

            PanelBwHeader.Visibility = Visibility.Collapsed;
            PanelHslBands.ItemsSource = null;
            PanelHslBands.Visibility = Visibility.Collapsed;
            PanelSliders.Visibility = Visibility.Visible;
            PanelSliders.ItemsSource = AdjustmentSections.Section(ViewModel.Sections, group).Sliders;
            if (group == "Tone Curve")
                RefreshCurvePlot();
        }

        // --- Tone curve plot (#2576) ---

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
            var points = CurveChannelPoints();
            CurvePlot.AccentBrush = new SolidColorBrush(CurveChannelColors[_curveChannel]);
            CurvePlot.Points = points.Select(p => new MuiCurvePoint(p.X, p.Y)).ToList();
            CurveResetButton.IsEnabled = points.Count > 0;
            UpdateCurveHistogram();
        }

        /// <summary>Feed the luma bins (ComputeHistogram tail) to the plot
        /// backdrop; called whenever new histogram bins arrive.</summary>
        private void UpdateCurveHistogram()
        {
            if (PanelCurveHost.Visibility != Visibility.Visible || _lastHistogramBins is not { Length: >= 1024 } bins)
                return;
            CurvePlot.HistogramBins = bins[768..1024];
        }

        private void CloseGroupPanel()
        {
            if (_activeGroup == "Crop")
                ExitCropMode();
            _activeGroup = null;
            EditPanel.Visibility = Visibility.Collapsed;
            RefreshRailArming(null);
        }

        /// <summary>Armed pill: MuiActionButton's own Selected state drives
        /// the primary-dim fill + primary stroke on the glyph (the web
        /// dock's iconColor behavior) — same look the manual Background/icon
        /// swap used to hand-roll here.</summary>
        private void RefreshRailArming(string? armedGroup)
        {
            foreach (var (title, _, _) in RailGroups)
            {
                if (_railButtons.TryGetValue(title, out var button))
                    button.Selected = title == armedGroup;
            }
        }

        private void OnColorTab(object sender, RoutedEventArgs e)
        {
            if (sender == ColorTabBasic) ShowColorTab("Basic");
            else if (sender == ColorTabHsl) ShowColorTab("HSL");
            else ShowColorTab("B&W");
        }

        private void ShowColorTab(string tab)
        {
            _colorTab = tab;
            ColorTabBasic.Selected = tab == "Basic";
            ColorTabHsl.Selected = tab == "HSL";
            ColorTabBw.Selected = tab == "B&W";

            PanelBwHeader.Visibility = tab == "B&W" ? Visibility.Visible : Visibility.Collapsed;
            PanelHslBands.Visibility = tab == "HSL" ? Visibility.Visible : Visibility.Collapsed;
            PanelHslBands.ItemsSource = tab == "HSL" ? ViewModel.HslBands : null;
            PanelSliders.Visibility = tab == "HSL" ? Visibility.Collapsed : Visibility.Visible;
            PanelSliders.ItemsSource = tab switch
            {
                "Basic" => AdjustmentSections.Section(ViewModel.Sections, "Color").Sliders,
                "B&W" => AdjustmentSections.Section(ViewModel.Sections, "B&W").Sliders,
                _ => null,
            };
        }

        private void OnEffectsTab(object sender, RoutedEventArgs e)
        {
            ShowEffectsTab(ReferenceEquals(sender, EffectsTabGrade) ? "Grade" : "Basic");
        }

        private void ShowEffectsTab(string tab)
        {
            _effectsTab = tab;
            EffectsTabBasic.Selected = tab == "Basic";
            EffectsTabGrade.Selected = tab == "Grade";

            PanelBwHeader.Visibility = Visibility.Collapsed;
            PanelHslBands.ItemsSource = null;
            PanelHslBands.Visibility = Visibility.Collapsed;
            PanelGradeHost.Visibility = tab == "Grade" ? Visibility.Visible : Visibility.Collapsed;
            PanelSliders.Visibility = tab == "Grade" ? Visibility.Collapsed : Visibility.Visible;
            PanelSliders.ItemsSource = tab == "Grade"
                ? null
                : AdjustmentSections.Section(ViewModel.Sections, "Effects").Sliders;
            if (tab == "Grade")
                SyncGradeWheels();
        }

        /// <summary>Build the four wheel cells (wheel + caption + luminance
        /// slider) and the balance slider. Wheels are code-built per zone so
        /// each MuiColorWheel wires straight to its zone view model.</summary>
        private void BuildGradePanel()
        {
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
            GradeBalanceHost.Content = gradeSliders.First(s => s.Label == "Balance");
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
        }

        private void OnResetGroup(object sender, RoutedEventArgs e)
        {
            if (_activeGroup == null)
                return;
            if (_activeGroup == "Color" && _colorTab == "HSL")
            {
                foreach (var band in ViewModel.HslBands)
                {
                    band.Hue.Reset();
                    band.Sat.Reset();
                    band.Lum.Reset();
                }
                return;
            }
            if (_activeGroup == "Crop")
            {
                OnCropReset(sender, e);
                return;
            }
            if (_activeGroup == "Effects" && _effectsTab == "Grade")
            {
                foreach (var zone in ViewModel.GradeZones)
                    zone.Reset();
                foreach (var slider in AdjustmentSections.Section(ViewModel.Sections, "Grade").Sliders)
                    slider.Reset();
                return;
            }
            if (_activeGroup == "Tone Curve")
            {
                ViewModel.Adjustments.ToneCurveLuma.Clear();
                ViewModel.Adjustments.ToneCurveRed.Clear();
                ViewModel.Adjustments.ToneCurveGreen.Clear();
                ViewModel.Adjustments.ToneCurveBlue.Clear();
                foreach (var slider in AdjustmentSections.Section(ViewModel.Sections, "Tone Curve").Sliders)
                    slider.Reset();
                ViewModel.NotifyAdjustmentEdited();
                RefreshCurvePlot();
                return;
            }
            var sectionTitle = _activeGroup == "Color"
                ? (_colorTab == "B&W" ? "B&W" : "Color")
                : _activeGroup;
            foreach (var slider in AdjustmentSections.Section(ViewModel.Sections, sectionTitle).Sliders)
                slider.Reset();
            if (sectionTitle == "B&W")
                ViewModel.BlackWhiteOn = false;
        }

        // --- Star row (Preview pill) ---

        /// <summary>MuiButton stars, not MuiRatingFlags: the molecule's
        /// same-star click DECREMENTS and it bundles a cycling flag icon,
        /// while this pill's contract is click-current-to-clear plus the
        /// separate Pick/Reject buttons — behavior preserved as-is (MN4).</summary>
        private void BuildStarRow()
        {
            for (var i = 0; i < 5; i++)
            {
                var stars = i + 1;
                var button = new MuiButton
                {
                    IconName = "star",
                    Variant = MuiButtonVariant.Ghost,
                    ButtonSize = MuiButtonSize.Sm,
                    IconColor = (SolidColorBrush)Application.Current.Resources["MapleBorderHi"],
                };
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, $"Set rating {stars}");
                button.Click += (_, _) =>
                {
                    var current = ViewModel.SelectedPhoto?.Rating ?? 0;
                    ViewModel.SetRating(current == stars ? 0 : stars);
                    UpdateStarRow();
                };
                _starButtons[i] = button;
                StarRow.Children.Add(button);
            }
        }

        private void UpdateStarRow()
        {
            if (_starButtons[0] == null)
                return;  // selection can fire before the chrome is built
            var rating = ViewModel.SelectedPhoto?.Rating ?? 0;
            var star = (SolidColorBrush)Application.Current.Resources["MapleStar"];
            var muted = (SolidColorBrush)Application.Current.Resources["MapleBorderHi"];
            for (var i = 0; i < 5; i++)
            {
                _starButtons[i].IconName = i < rating ? "star-filled" : "star";
                _starButtons[i].IconColor = i < rating ? star : muted;
            }
        }

        // --- Info flyout (Preview pill) ---

        private void OnInfoFlyoutOpening(object? sender, object e)
        {
            var photo = ViewModel.SelectedPhoto;
            ExifRows.Children.Clear();
            FileRows.Children.Clear();
            if (photo == null)
                return;

            void AddRow(StackPanel host, string label, string value)
            {
                var grid = new Grid();
                grid.Children.Add(new MuiText
                {
                    Text = label,
                    Variant = MuiTextVariant.Body,
                    ColorRole = MuiTextColorRole.Muted,
                });
                grid.Children.Add(new MuiText
                {
                    Text = value,
                    Variant = MuiTextVariant.Filename,          // mono, per the value column's Consolas
                    HorizontalAlignment = HorizontalAlignment.Right,
                });
                host.Children.Add(grid);
            }

            AddRow(ExifRows, "Camera", photo.CameraModel);
            AddRow(ExifRows, "Lens", photo.LensInfo);
            AddRow(ExifRows, "ISO", photo.IsoDisplay);
            AddRow(ExifRows, "Aperture", photo.Aperture);
            AddRow(ExifRows, "Shutter", photo.ShutterSpeed);
            AddRow(ExifRows, "Captured", photo.DateTaken);
            AddRow(FileRows, "Name", photo.FileName);
            AddRow(FileRows, "Format", photo.Format);
            AddRow(FileRows, "Size", $"{photo.FileSizeBytes / (1024.0 * 1024.0):0.0} MB");
            AddRow(FileRows, "Pixels", photo.Dimensions);
        }
    }

    /// <summary>Draws the 768-bin channel-major RGB histogram into a Canvas as
    /// three translucent filled polylines (log-scaled counts).</summary>
    public static class HistogramView
    {
        public static void Draw(Canvas canvas, uint[] bins)
        {
            canvas.Children.Clear();
            var width = canvas.ActualWidth;
            var height = canvas.ActualHeight;
            if (width <= 0 || height <= 0 || bins.Length < 768)
                return;

            double max = 0;
            for (var i = 0; i < 768; i++)
                max = Math.Max(max, Math.Log(1 + bins[i]));
            if (max <= 0)
                return;

            var channels = new (int offset, Windows.UI.Color color)[]
            {
                (0, Windows.UI.Color.FromArgb(110, 244, 88, 80)),
                (256, Windows.UI.Color.FromArgb(110, 110, 220, 110)),
                (512, Windows.UI.Color.FromArgb(110, 90, 140, 255)),
            };

            foreach (var (offset, color) in channels)
            {
                var polygon = new Polygon { Fill = new SolidColorBrush(color) };
                polygon.Points.Add(new Windows.Foundation.Point(0, height));
                for (var i = 0; i < 256; i++)
                {
                    var x = i / 255.0 * width;
                    var y = height - Math.Log(1 + bins[offset + i]) / max * height;
                    polygon.Points.Add(new Windows.Foundation.Point(x, y));
                }
                polygon.Points.Add(new Windows.Foundation.Point(width, height));
                canvas.Children.Add(polygon);
            }
        }
    }
}
