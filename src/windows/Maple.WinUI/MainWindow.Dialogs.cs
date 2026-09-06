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
                    toggleSidebar: () => OnToggleSidebar(this, new RoutedEventArgs()),
                    setCloudFiles: SetCloudFilesEnabled);
                window.Closed += (_, _) => _settingsWindow = null;
                _settingsWindow = window;
            }
            _settingsWindow.Activate();
        }

        /// <summary>Settings-page toggle for the File Explorer sync root
        /// (#2589). Persists only what actually took effect: an enable that
        /// fails to register leaves the setting off and returns the failure
        /// for the settings page to surface.</summary>
        private string? SetCloudFilesEnabled(bool enabled)
        {
            if (enabled)
            {
                var error = _cloudFiles.Start();
                if (error != null)
                    return error;
            }
            else
            {
                _cloudFiles.Stop(unregister: true);
            }
            Services.AppSettings.Update(s => s.CloudFilesEnabled = enabled);
            return null;
        }

        private readonly Services.CloudFiles.CloudFilesSyncRoot _cloudFiles;

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

        /// <summary>Open a server directory in the browse grid. Mirrors
        /// OnFolderNodeInvoked (MainWindow.xaml.cs) for the local tree — the
        /// two sides of the sidebar behave identically.</summary>
        private async void OnCloudNodeInvoked(TreeView sender, TreeViewItemInvokedEventArgs args)
        {
            if (args.InvokedItem is ViewModels.CloudFolderNode { IsPlaceholder: false } node)
            {
                SetMode(ShellMode.Browse);
                await ViewModel.LoadCloudDirectoryAsync(node);
            }
        }

        private void OnCloudFolderExpanding(TreeView sender, TreeViewExpandingEventArgs args)
        {
            if (args.Item is ViewModels.CloudFolderNode node)
                ViewModel.LoadCloudFolderChildren(node);
        }

        /// <summary>Drill into a subfolder from its grid tile — the inline
        /// counterpart of the sidebar trees. Dispatches on node type: the
        /// tiles collection carries local FolderNode and cloud
        /// CloudFolderNode alike (docs/spec/13-windows-shell.md).</summary>
        private async void OnBrowseFolderTileClick(object sender, ItemClickEventArgs e)
        {
            switch (e.ClickedItem)
            {
                case ViewModels.CloudFolderNode cloud:
                    await ViewModel.LoadCloudDirectoryAsync(cloud);
                    break;
                case ViewModels.FolderNode { IsPlaceholder: false, IsUnavailable: false } local:
                    ViewModel.LoadDirectory(local.Path);
                    break;
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
