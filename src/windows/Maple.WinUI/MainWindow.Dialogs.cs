using System;
using System.Threading;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;
using Maple.WinUI.Services;

namespace Maple.WinUI
{
    /// <summary>Folder picker, export dialogs, and the Settings window.</summary>
    public sealed partial class MainWindow
    {
        private SettingsWindow? _settingsWindow;

        /// <summary>File → Settings… (MN3, #3052). One window at a time —
        /// reopening just activates the existing one. Actions that already
        /// have an owner here (cloud connect dialog, sidebar toggle) are
        /// handed over as callbacks so Settings never duplicates their
        /// state handling.</summary>
        private void OnOpenSettings(object sender, RoutedEventArgs e)
        {
            if (_settingsWindow == null)
            {
                var window = new SettingsWindow(
                    ViewModel,
                    openCloudConnect: () => OnConnectCloud(this, new RoutedEventArgs()),
                    toggleSidebar: () => OnToggleSidebar(this, new RoutedEventArgs()));
                window.Closed += (_, _) => _settingsWindow = null;
                _settingsWindow = window;
            }
            _settingsWindow.Activate();
        }

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
                            new MuiText { Text = label, Variant = MuiTextVariant.Body },
                            new MuiText
                            {
                                Text = detail,
                                Variant = MuiTextVariant.Body,
                                ColorRole = MuiTextColorRole.Muted,
                            },
                        },
                    },
                });
            }
            formatRadios.SelectedIndex = 0;
            panel.Children.Add(formatRadios);

            // SelectedIndex only after the Items exist — WinUI 3 rejects an
            // index into an empty ComboBox.
            var colorCombo = new ComboBox
            {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Header = "Color space",
            };
            colorCombo.Items.Add("sRGB — safest everywhere");
            colorCombo.Items.Add("Display P3 — wider gamut");
            colorCombo.SelectedIndex = 0;
            panel.Children.Add(colorCombo);

            var sizeCombo = new ComboBox
            {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Header = "Long edge",
            };
            sizeCombo.Items.Add("Full resolution");
            foreach (var preset in new[] { 4096, 2560, 2048, 1024 })
                sizeCombo.Items.Add($"{preset} px");
            sizeCombo.SelectedIndex = 0;
            panel.Children.Add(sizeCombo);

            var qualitySlider = new Slider
            {
                Minimum = 1, Maximum = 100, Value = 92, StepFrequency = 1,
                Header = "Quality",
            };
            var qualityHint = new MuiText
            {
                Text = "Higher keeps more detail and makes a larger file. "
                     + "90–95 is visually lossless on most photographs.",
                Variant = MuiTextVariant.Body,
                ColorRole = MuiTextColorRole.Muted,
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
            panel.Children.Add(new MuiText
            {
                Text = "“Sign in with browser” opens your server's passkey sign-in; the app "
                     + "receives a one-time code and never sees your credentials. "
                     + "“Dev sign-in” only works on servers started with MAPLE_DEV_AUTH=1.",
                Variant = MuiTextVariant.Body,
                ColorRole = MuiTextColorRole.Muted,
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

        // One-dialog-at-a-time protection (#2754) for this generic
        // informational/error dialog specifically — the shared entry point
        // Export, Connect to Maple Cloud, Remove Folder, and now
        // MainWindow.DropMount.cs's unsupported-drop explanation all funnel
        // through. A real SemaphoreSlim queue, not a SingleFlightGate:
        // unlike the per-FLOW gates (MainWindow.Trash.cs's _deleteGate and
        // friends), which reject a re-entrant call outright because it's
        // the SAME operation firing twice, two callers here are usually two
        // DIFFERENT, both-legitimate messages — dropping the second
        // silently would hide it from the user, so it waits its turn
        // instead. This does not (and can't, without a much bigger
        // refactor) protect the handful of flows that build their own
        // ad hoc ContentDialog directly (RunDragMoveAsync's progress
        // dialog, RunDeleteSelectedPhotosAsync's confirm/progress dialogs,
        // etc.) — each of those already carries its own SingleFlightGate
        // against re-entering itself, which is the collision that's
        // actually reachable in practice for those flows.
        private readonly SemaphoreSlim _messageDialogGate = new(1, 1);

        private async System.Threading.Tasks.Task ShowMessageAsync(string title, string message)
        {
            await _messageDialogGate.WaitAsync();
            try
            {
                // The window can close while this call was queued behind
                // another dialog (#2754) — XamlRoot goes null once Content
                // is torn down, and ContentDialog.ShowAsync() throws given
                // a null XamlRoot rather than just no-opping. Bail quietly:
                // there's no window left to show a message in.
                var xamlRoot = (this.Content as FrameworkElement)?.XamlRoot;
                if (xamlRoot == null)
                {
                    DiagLog.Write($"[dialog] skipped \"{title}\" — window has no XamlRoot");
                    return;
                }
                var dialog = new ContentDialog
                {
                    Title = title,
                    Content = new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap },
                    CloseButtonText = "OK",
                    XamlRoot = xamlRoot,
                };
                await dialog.ShowAsync();
            }
            finally
            {
                _messageDialogGate.Release();
            }
        }
    }
}
