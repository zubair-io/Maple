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
