using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.WinUI
{
    /// <summary>Folder picker and export dialogs.</summary>
    public sealed partial class MainWindow
    {
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
                SetMode(ShellMode.Browse);
            }
        }

        // The canonical export dialog options (web export-dialog.vm.ts, #943):
        // formats + detail lines, color spaces, long-edge presets, quality 92.
        private static readonly (string Value, string Label, string Detail, string Extension, string TypeLabel)[]
            ExportFormats =
        {
            ("jpeg", "JPEG", "8-bit, compressed — for sharing and the web.", ".jpg", "JPEG image"),
            ("tiff", "TIFF", "16-bit, lossless — the master for further grading.", ".tif", "TIFF image"),
            ("png", "PNG", "8-bit, lossless — larger files, no compression artefacts.", ".png", "PNG image"),
        };

        private async void OnExportPhotos(object sender, RoutedEventArgs e)
        {
            var photo = ViewModel.SelectedPhoto;
            if (photo == null)
            {
                await ShowMessageAsync("Export", "Select a photo to export first.");
                return;
            }

            var panel = new StackPanel { Spacing = 10, Width = 360 };
            var formatRadios = new RadioButtons { Header = "Format" };
            foreach (var (_, label, detail, _, _) in ExportFormats)
            {
                formatRadios.Items.Add(new RadioButton
                {
                    Content = new StackPanel
                    {
                        Children =
                        {
                            new TextBlock { Text = label, FontSize = 13 },
                            new TextBlock
                            {
                                Text = detail,
                                FontSize = 11,
                                TextWrapping = TextWrapping.Wrap,
                                Opacity = 0.6,
                            },
                        },
                    },
                });
            }
            formatRadios.SelectedIndex = 0;
            panel.Children.Add(formatRadios);

            var colorCombo = new ComboBox
            {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                SelectedIndex = 0,
                Header = "Color space",
            };
            colorCombo.Items.Add("sRGB — safest everywhere");
            colorCombo.Items.Add("Display P3 — wider gamut");
            panel.Children.Add(colorCombo);

            var sizeCombo = new ComboBox
            {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                SelectedIndex = 0,
                Header = "Long edge",
            };
            sizeCombo.Items.Add("Full resolution");
            foreach (var preset in new[] { 4096, 2560, 2048, 1024 })
                sizeCombo.Items.Add($"{preset} px");
            panel.Children.Add(sizeCombo);

            var qualitySlider = new Slider
            {
                Minimum = 1, Maximum = 100, Value = 92, StepFrequency = 1,
                Header = "Quality",
            };
            var qualityHint = new TextBlock
            {
                Text = "Higher keeps more detail and makes a larger file. "
                     + "90–95 is visually lossless on most photographs.",
                FontSize = 11,
                TextWrapping = TextWrapping.Wrap,
                Opacity = 0.6,
            };
            panel.Children.Add(qualitySlider);
            panel.Children.Add(qualityHint);
            // Quality applies to JPEG only (the lossless formats ignore it).
            formatRadios.SelectionChanged += (_, _) =>
            {
                var isJpeg = formatRadios.SelectedIndex == 0;
                qualitySlider.Visibility = isJpeg ? Visibility.Visible : Visibility.Collapsed;
                qualityHint.Visibility = isJpeg ? Visibility.Visible : Visibility.Collapsed;
            };

            var dialog = new ContentDialog
            {
                Title = $"Export {photo.FileName}",
                Content = new ScrollViewer { Content = panel, MaxHeight = 520 },
                PrimaryButtonText = "Export…",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary,
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            if (await dialog.ShowAsync() != ContentDialogResult.Primary)
                return;

            var format = ExportFormats[Math.Max(0, formatRadios.SelectedIndex)];
            var savePicker = new Windows.Storage.Pickers.FileSavePicker
            {
                SuggestedFileName = System.IO.Path.GetFileNameWithoutExtension(photo.FileName),
                SuggestedStartLocation = Windows.Storage.Pickers.PickerLocationId.PicturesLibrary,
            };
            savePicker.FileTypeChoices.Add(format.TypeLabel, new[] { format.Extension });
            WinRT.Interop.InitializeWithWindow.Initialize(
                savePicker, WinRT.Interop.WindowNative.GetWindowHandle(this));
            var file = await savePicker.PickSaveFileAsync();
            if (file == null)
                return;

            var maxLongEdge = sizeCombo.SelectedIndex switch
            {
                1 => 4096u,
                2 => 2560u,
                3 => 2048u,
                4 => 1024u,
                _ => 0u,        // native resolution
            };
            var colorSpace = colorCombo.SelectedIndex == 1 ? "display-p3" : "srgb";
            var (ok, error) = await ViewModel.ExportAsync(
                photo, file.Path, format.Value, (byte)qualitySlider.Value,
                colorSpace, maxLongEdge);
            await ShowMessageAsync("Export",
                ok ? $"Exported to {file.Path}" : $"Export failed: {error}");
        }

        private async void OnConnectCloud(object sender, RoutedEventArgs e)
        {
            var settings = Services.AppSettings.Load();
            var panel = new StackPanel { Spacing = 10, Width = 360 };
            var urlBox = new TextBox
            {
                Header = "Server URL",
                Text = settings.CloudServerUrl ?? "https://",
                PlaceholderText = "https://your-maple-server",
            };
            panel.Children.Add(urlBox);
            panel.Children.Add(new TextBlock
            {
                Text = "“Sign in with browser” opens your server's passkey sign-in; the app "
                     + "receives a one-time code and never sees your credentials. "
                     + "“Dev sign-in” only works on servers started with MAPLE_DEV_AUTH=1.",
                TextWrapping = TextWrapping.Wrap,
                FontSize = 11,
                Foreground = (Microsoft.UI.Xaml.Media.SolidColorBrush)
                    Application.Current.Resources["MapleTextMuted"],
            });

            var dialog = new ContentDialog
            {
                Title = "Connect to Maple Cloud",
                Content = panel,
                PrimaryButtonText = "Sign in with browser",
                SecondaryButtonText = "Dev sign-in",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary,
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            var result = await dialog.ShowAsync();
            var serverUrl = urlBox.Text.Trim().TrimEnd('/');
            if (result == ContentDialogResult.None || serverUrl.Length == 0)
                return;

            if (result == ContentDialogResult.Primary)
            {
                var (ok, message, _) = await ViewModel.StartBrowserSignInAsync(serverUrl);
                if (!ok)
                    await ShowMessageAsync("Maple Cloud", message);
                // Success continues in HandleAuthCallback when the browser
                // redirects maple-app://auth-success.
            }
            else
            {
                var (ok, message) = await ViewModel.DevSignInAsync(serverUrl);
                if (!ok)
                    await ShowMessageAsync("Maple Cloud", message);
            }
        }

        /// <summary>maple-app://auth-success?code=…&state=… — routed here from
        /// the protocol activation (Program/App).</summary>
        public async void HandleAuthCallback(Uri uri)
        {
            this.Activate();  // bring the app back in front of the browser
            await ViewModel.CompleteAuthCallbackAsync(uri);
        }

        private async void OnSelectCloudFolder(object sender, SelectionChangedEventArgs e)
        {
            if (CloudFoldersList.SelectedItem is Services.Cloud.CloudFolder folder)
            {
                ViewModel.SetDateFilter(null, null);
                SetMode(ShellMode.Browse);
                await ViewModel.LoadCloudFolderAsync(folder);
            }
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
}
