using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Windows.Graphics;
using Maple.WinUI.Services;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    // #4174: exercise the production preference owner and actual XAML layout.
    // Settings checkbox input is separately qualified through the live window.
    private async Task VerifySidebarPreferenceAsync(string output)
    {
        var originalSize = AppWindow.Size;
        var originalMode = _mode;
        var originalHidden = AppSettings.Load().LeftPanelHidden;
        var originalDrawer = _compactSourcesOpen;
        var photo = ViewModel.SelectedPhoto;
        var adjustments = ViewModel.Adjustments;
        var folders = AppSettings.Load().LibraryFolders.ToArray();
        var root = (FrameworkElement)Content;
        if (WinRT.Interop.WindowNative.GetWindowHandle(this) == IntPtr.Zero)
            throw new InvalidOperationException("Sidebar qualification requires a real window.");
        try
        {
            var loadDeadline = Environment.TickCount64 + 5000;
            while (root.XamlRoot == null && Environment.TickCount64 < loadDeadline)
                await Task.Delay(50);
            if (root.XamlRoot == null)
                throw new InvalidOperationException("Sidebar qualification requires attached XAML.");
            await ResizeAsync(1200, compact: false);
            SetMode(ShellMode.Preview);
            foreach (var hidden in new[] { true, false, true })
            {
                SetSidebarHidden(hidden);
                Check("wide-preview-preference", hidden, visible: false);
            }
            SetMode(ShellMode.Browse);
            Check("wide-browse-retained-off", hidden: true, visible: false);
            SetSidebarHidden(false);
            Check("wide-browse-enabled", hidden: false, visible: true);
            OnToggleSidebar(this, new RoutedEventArgs());
            Check("wide-browse-toggle", hidden: true, visible: false);

            await ResizeAsync(600, compact: true);
            foreach (var hidden in new[] { true, false })
            {
                _compactSourcesOpen = false;
                SetSidebarHidden(hidden);
                Check("compact-browse-preference", hidden, visible: false);
                OnToggleSidebar(this, new RoutedEventArgs());
                Check("compact-drawer-open", hidden, visible: true);
                OnToggleSidebar(this, new RoutedEventArgs());
                Check("compact-drawer-closed", hidden, visible: false);
            }
            SetMode(ShellMode.Preview);
            foreach (var hidden in new[] { true, false, true })
            {
                SetSidebarHidden(hidden);
                Check("compact-preview-preference", hidden, visible: false);
            }
        }
        finally
        {
            // Setup can fail before attachment, before any preference mutation.
            if (root.XamlRoot != null)
            {
                SetSidebarHidden(originalHidden);
                _compactSourcesOpen = originalDrawer;
                SetMode(originalMode);
                AppWindow.Resize(originalSize);
            }
        }

        async Task ResizeAsync(int logicalWidth, bool compact)
        {
            var scale = root.XamlRoot.RasterizationScale;
            AppWindow.Resize(new SizeInt32((int)Math.Round(logicalWidth * scale), (int)Math.Round(800 * scale)));
            var deadline = Environment.TickCount64 + 5000;
            do
            {
                await Task.Delay(100);
                root.UpdateLayout();
            } while ((IsCompactShell != compact || Math.Abs(root.ActualWidth - logicalWidth) > 32)
                && Environment.TickCount64 < deadline);
            if (IsCompactShell != compact || Math.Abs(root.ActualWidth - logicalWidth) > 32)
                throw new InvalidOperationException("Sidebar qualification did not reach the requested window width.");
        }

        void Check(string stage, bool hidden, bool visible)
        {
            root.UpdateLayout();
            var saved = AppSettings.Load();
            // UpdateResponsiveShell owns this layout rule (MainWindow.Responsive.cs).
            var expectedColumn = _mode == ShellMode.Browse && !IsCompactShell && !hidden
                ? _settings.LeftPanelWidth : 0;
            if (_settings.LeftPanelHidden != hidden || saved.LeftPanelHidden != hidden ||
                (SidebarPane.Visibility == Visibility.Visible) != visible ||
                Math.Abs(SidebarColDef.Width.Value - expectedColumn) > .1 ||
                (visible && SidebarPane.ActualWidth <= 0) ||
                !folders.SequenceEqual(saved.LibraryFolders) ||
                !ReferenceEquals(photo, ViewModel.SelectedPhoto) ||
                !ReferenceEquals(adjustments, ViewModel.Adjustments))
                throw new InvalidOperationException($"Sidebar preference/layout regression: {stage}, hidden={hidden}.");
            File.AppendAllText(Path.Combine(output, "sidebar-preference.jsonl"), JsonSerializer.Serialize(new
            {
                stage, hidden, visible, mode = _mode.ToString(), compact = IsCompactShell,
                drawerOpen = _compactSourcesOpen, columnWidth = SidebarColDef.Width.Value,
                paneWidth = SidebarPane.ActualWidth, rasterizationScale = root.XamlRoot.RasterizationScale,
                passed = true
            }) + Environment.NewLine);
        }
    }
}
