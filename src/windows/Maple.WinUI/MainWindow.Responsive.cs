using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private bool _compactSourcesOpen;
    private bool IsCompactShell => ShellColumns.ActualWidth is > 0 and < 800;

    private void OnShellSizeChanged(object sender, SizeChangedEventArgs e)
    {
        UpdateResponsiveShell();
        UpdateViewerChromeSize();
    }

    private void UpdateResponsiveShell()
    {
        if (SidebarPane == null || InfoPane == null) return;
        var compact = IsCompactShell;
        var browse = _mode == ShellMode.Browse;
        // Overlay Sources only at narrow desktop widths. The user's wide-window
        // preference is retained; resizing never changes the selected document.
        Grid.SetColumnSpan(SidebarPane, compact ? 2 : 1);
        Canvas.SetZIndex(SidebarPane, compact ? 5 : 0);
        SidebarPane.Width = compact ? Math.Clamp(ShellColumns.ActualWidth - 32, 0, 280) : double.NaN;
        SidebarPane.HorizontalAlignment = compact ? HorizontalAlignment.Left : HorizontalAlignment.Stretch;
        SidebarPane.Visibility = browse && (compact ? _compactSourcesOpen : !_settings.LeftPanelHidden)
            ? Visibility.Visible : Visibility.Collapsed;
        SidebarColDef.Width = new GridLength(browse && !compact && !_settings.LeftPanelHidden ? _settings.LeftPanelWidth : 0);
        CloseCompactSources.Visibility = compact ? Visibility.Visible : Visibility.Collapsed;
        var overlayInfo = compact && _mode == ShellMode.Preview && _infoPaneOpen;
        Grid.SetColumn(InfoPane, overlayInfo ? 0 : 1);
        Grid.SetColumnSpan(InfoPane, overlayInfo ? 2 : 1);
        InfoPane.Width = overlayInfo ? Math.Clamp(ShellColumns.ActualWidth - 24, 0, 320) : double.NaN;
        InfoPane.HorizontalAlignment = overlayInfo ? HorizontalAlignment.Right : HorizontalAlignment.Stretch;
        InfoColDef.Width = new GridLength(_mode == ShellMode.Preview && _infoPaneOpen && !overlayInfo ? 320 : 0);
    }
}
