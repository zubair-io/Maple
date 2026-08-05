using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    /// <summary>Edit-screen chrome: the floating tool rail and group panels,
    /// star row, EXIF flyout, and histogram plot.</summary>
    public sealed partial class MainWindow
    {
        private readonly Button[] _starButtons = new Button[5];
        private readonly Dictionary<string, Button> _railButtons = new();
        private string? _activeGroup;
        private string _colorTab = "Basic";

        // --- Tool rail ---

        private static readonly (string Title, string Glyph, string? DisabledNote)[] RailGroups =
        {
            ("Light", "\uE706", null),
            ("Color", "\uE790", null),
            ("Effects", "\uE71C", null),
            ("Detail", "\uE9D9", null),
            ("Tone Curve", "\uE9E9", null),
            ("Crop", "\uE7A8", "Crop overlay ships with #2582"),
        };

        private void BuildEditRail()
        {
            foreach (var (title, glyph, disabledNote) in RailGroups)
            {
                var button = new Button
                {
                    Style = (Style)((FrameworkElement)Content).Resources["PillButton"],
                    Width = 44,
                    Height = 40,
                    Content = new FontIcon { Glyph = glyph, FontSize = 15 },
                    IsEnabled = disabledNote == null,
                };
                ToolTipService.SetToolTip(button, disabledNote ?? title);
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, $"{title} tools");
                var group = title;
                button.Click += (_, _) => ToggleGroupPanel(group);
                _railButtons[title] = button;

                var label = new TextBlock
                {
                    Text = title,
                    FontSize = 9,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    Foreground = (SolidColorBrush)Application.Current.Resources["MapleTextMuted"],
                    Margin = new Thickness(0, -2, 0, 4),
                };
                EditRailStack.Children.Add(button);
                EditRailStack.Children.Add(label);
            }
        }

        private void ToggleGroupPanel(string group)
        {
            if (_activeGroup == group)
            {
                CloseGroupPanel();
                return;
            }
            _activeGroup = group;
            foreach (var (title, button) in _railButtons)
            {
                button.Background = title == group
                    ? (SolidColorBrush)Application.Current.Resources["MaplePrimaryDim"]
                    : null;
            }
            EditPanel.Visibility = Visibility.Visible;
            EditPanelTitle.Text = group.ToUpperInvariant();
            ColorTabRow.Visibility = group == "Color" ? Visibility.Visible : Visibility.Collapsed;
            PanelFootnote.Visibility = Visibility.Collapsed;

            if (group == "Color")
            {
                ShowColorTab(_colorTab);
                return;
            }

            PanelBwHeader.Visibility = Visibility.Collapsed;
            PanelHslBands.ItemsSource = null;
            PanelHslBands.Visibility = Visibility.Collapsed;
            PanelSliders.Visibility = Visibility.Visible;
            PanelSliders.ItemsSource = AdjustmentSections.Section(ViewModel.Sections, group).Sliders;
            if (group == "Tone Curve")
            {
                PanelFootnote.Text = "Parametric region controls. The interactive point-curve plot ships with #2576.";
                PanelFootnote.Visibility = Visibility.Visible;
            }
        }

        private void CloseGroupPanel()
        {
            _activeGroup = null;
            EditPanel.Visibility = Visibility.Collapsed;
            foreach (var button in _railButtons.Values)
                button.Background = null;
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
            var accent = (SolidColorBrush)Application.Current.Resources["MaplePrimaryDim"];
            ColorTabBasic.Background = tab == "Basic" ? accent : null;
            ColorTabHsl.Background = tab == "HSL" ? accent : null;
            ColorTabBw.Background = tab == "B&W" ? accent : null;

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
            var sectionTitle = _activeGroup == "Color"
                ? (_colorTab == "B&W" ? "B&W" : "Color")
                : _activeGroup;
            foreach (var slider in AdjustmentSections.Section(ViewModel.Sections, sectionTitle).Sliders)
                slider.Reset();
            if (sectionTitle == "B&W")
                ViewModel.BlackWhiteOn = false;
        }

        // --- Star row (Preview pill) ---

        private void BuildStarRow()
        {
            for (var i = 0; i < 5; i++)
            {
                var stars = i + 1;
                var button = new Button
                {
                    Content = new FontIcon { Glyph = "\uE734", FontSize = 12 },
                    Padding = new Thickness(3, 2, 3, 2),
                    Background = null,
                    BorderThickness = new Thickness(0),
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
            var rating = ViewModel.SelectedPhoto?.Rating ?? 0;
            var star = (SolidColorBrush)Application.Current.Resources["MapleStar"];
            var muted = (SolidColorBrush)Application.Current.Resources["MapleBorderHi"];
            for (var i = 0; i < 5; i++)
            {
                var icon = (FontIcon)_starButtons[i].Content;
                icon.Glyph = i < rating ? "\uE735" : "\uE734";
                icon.Foreground = i < rating ? star : muted;
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
                grid.Children.Add(new TextBlock
                {
                    Text = label,
                    FontSize = 12,
                    Foreground = (SolidColorBrush)Application.Current.Resources["MapleTextMuted"],
                });
                grid.Children.Add(new TextBlock
                {
                    Text = value,
                    FontSize = 12,
                    FontFamily = new FontFamily("Consolas"),
                    HorizontalAlignment = HorizontalAlignment.Right,
                    Foreground = (SolidColorBrush)Application.Current.Resources["MapleTextMain"],
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
