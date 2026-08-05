using System;
using System.IO;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    /// <summary>Inspector chrome: star row, EXIF info rows, histogram plot,
    /// and the folder / export dialogs.</summary>
    public sealed partial class MainWindow
    {
        private readonly Button[] _starButtons = new Button[5];

        private void BuildStarRow()
        {
            for (var i = 0; i < 5; i++)
            {
                var stars = i + 1;
                var button = new Button
                {
                    Content = new FontIcon { Glyph = "\uE734", FontSize = 13 },
                    Padding = new Thickness(4, 2, 4, 2),
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

        private void RefreshInfoPanel()
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

        // --- Dialogs ---

        private async void OnOpenDirectory(object sender, RoutedEventArgs e)
        {
            var picker = new Windows.Storage.Pickers.FolderPicker
            {
                SuggestedStartLocation = Windows.Storage.Pickers.PickerLocationId.PicturesLibrary,
            };
            picker.FileTypeFilter.Add("*");
            WinRT.Interop.InitializeWithWindow.Initialize(
                picker, WinRT.Interop.WindowNative.GetWindowHandle(this));

            var folder = await picker.PickSingleFolderAsync();
            if (folder != null)
            {
                ViewModel.AddLibraryFolder(folder.Path);
                SwitchMode(develop: false);
            }
        }

        private async void OnExportPhotos(object sender, RoutedEventArgs e)
        {
            var photo = ViewModel.SelectedPhoto;
            if (photo == null)
            {
                await ShowMessageAsync("Export", "Select a photo to export first.");
                return;
            }

            var panel = new StackPanel { Spacing = 10, Width = 340 };
            panel.Children.Add(new TextBlock
            {
                Text = "Exports through the full Rust develop chain (Amaze quality) with the "
                     + "current sidecar adjustments applied. JPEG output.",
                TextWrapping = TextWrapping.Wrap,
                FontSize = 12,
            });
            var qualitySlider = new Slider
            {
                Minimum = 50, Maximum = 100, Value = 92, StepFrequency = 1,
                Header = "JPEG quality",
            };
            panel.Children.Add(qualitySlider);
            var sizeCombo = new ComboBox
            {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                SelectedIndex = 0,
                Header = "Long edge",
            };
            sizeCombo.Items.Add("Full resolution");
            sizeCombo.Items.Add("4096 px");
            sizeCombo.Items.Add("2048 px");
            sizeCombo.Items.Add("1024 px");
            panel.Children.Add(sizeCombo);

            var dialog = new ContentDialog
            {
                Title = $"Export {photo.FileName}",
                Content = panel,
                PrimaryButtonText = "Export…",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary,
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            if (await dialog.ShowAsync() != ContentDialogResult.Primary)
                return;

            var savePicker = new Windows.Storage.Pickers.FileSavePicker
            {
                SuggestedFileName = System.IO.Path.GetFileNameWithoutExtension(photo.FileName),
                SuggestedStartLocation = Windows.Storage.Pickers.PickerLocationId.PicturesLibrary,
            };
            savePicker.FileTypeChoices.Add("JPEG image", new[] { ".jpg" });
            WinRT.Interop.InitializeWithWindow.Initialize(
                savePicker, WinRT.Interop.WindowNative.GetWindowHandle(this));
            var file = await savePicker.PickSaveFileAsync();
            if (file == null)
                return;

            var maxPx = sizeCombo.SelectedIndex switch
            {
                1 => 4096u,
                2 => 2048u,
                3 => 1024u,
                _ => 65535u,
            };
            var (ok, error) = await ViewModel.ExportJpegAsync(
                photo, file.Path, maxPx, (byte)qualitySlider.Value);
            await ShowMessageAsync("Export",
                ok ? $"Exported to {file.Path}" : $"Export failed: {error}");
        }

        private async System.Threading.Tasks.Task ShowMessageAsync(string title, string message)
        {
            var dialog = new ContentDialog
            {
                Title = title,
                Content = new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap },
                CloseButtonText = "OK",
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            await dialog.ShowAsync();
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
