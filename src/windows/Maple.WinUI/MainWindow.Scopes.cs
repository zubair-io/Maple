using System;
using Maple.WinUI.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private bool _showScopes;
    private bool _focusScopesAfterMenu;
    private ScopePanelFrame? _scopeFrame;

    private void OnToggleScopes(object sender, RoutedEventArgs e)
    {
        _showScopes = ScopesMenuItem.IsChecked;
        _focusScopesAfterMenu = _showScopes;
        UpdateScopesVisibility();
        if (_showScopes) CloseScopesButton.Focus(FocusState.Programmatic);
    }

    private void OnEditActionsClosed(object sender, object e)
    {
        if (!_focusScopesAfterMenu) return;
        _focusScopesAfterMenu = false;
        // A flyout restores its previous focus as it closes. Move into the
        // panel only after that restoration has completed.
        App.MainDispatcherQueue?.TryEnqueue(() =>
        {
            if (!_closing && _showScopes && _mode == ShellMode.Edit)
                CloseScopesButton.Focus(FocusState.Keyboard);
        });
    }

    private void OnCloseScopes(object sender, RoutedEventArgs e)
    {
        _showScopes = ScopesMenuItem.IsChecked = false;
        _focusScopesAfterMenu = false;
        UpdateScopesVisibility();
        MoreEditActions.Focus(FocusState.Programmatic);
    }

    private void UpdateScopesVisibility()
    {
        if (ScopesPanelHost == null) return;
        var open = _showScopes && _mode == ShellMode.Edit && !_closing;
        ScopesPanelHost.Visibility = open ? Visibility.Visible : Visibility.Collapsed;
        ViewModel.Renderer.SetScopesEnabled(open);
        UpdateScopesSize();
    }

    private void UpdateScopesSize()
    {
        if (ScopesPanelHost == null) return;
        ScopesPanelHost.MaxWidth = Math.Max(100, Math.Min(346, ViewerContainer.ActualWidth - 144));
        ScopesPanelHost.MaxHeight = Math.Max(60, ViewerContainer.ActualHeight - 120);
    }

    private void OnScopeInvalidated() => App.MainDispatcherQueue?.TryEnqueue(() =>
    {
        if (_closing || (_scopeFrame != null && ViewModel.Renderer.IsScopeCurrent(_scopeFrame.Version))) return;
        _scopeFrame = null;
        ScopeStatus.Text = "Updating scopes…";
        ScopeStatus.Visibility = Visibility.Visible;
        ScopesPlots.Visibility = Visibility.Collapsed;
    });

    private void OnScopeReady(ScopePanelFrame frame) => App.MainDispatcherQueue?.TryEnqueue(() =>
    {
        if (_closing || !_showScopes || _mode != ShellMode.Edit || !ViewModel.Renderer.IsScopeCurrent(frame.Version)) return;
        _scopeFrame = frame;
        var values = frame.Values;
        ScopesPlots.RedValues = values[0..64];
        ScopesPlots.GreenValues = values[64..128];
        ScopesPlots.BlueValues = values[128..192];
        ScopesPlots.LumaValues = values[192..256];
        ScopesPlots.ParadeRedValues = values[256..320];
        ScopesPlots.ParadeGreenValues = values[320..384];
        ScopesPlots.ParadeBlueValues = values[384..448];
        ScopesPlots.VectorscopeBins = frame.ChromaBins;
        ScopeStatus.Visibility = Visibility.Collapsed;
        ScopesPlots.Visibility = Visibility.Visible;
        AutomationProperties.SetHelpText(ScopesPanelHost, "Scopes for the current photo and adjustments");
    });

    private void OnScopeFailed(long version, string error) => App.MainDispatcherQueue?.TryEnqueue(() =>
    {
        if (_closing || !ViewModel.Renderer.IsScopeCurrent(version)) return;
        _scopeFrame = null;
        ScopesPlots.Visibility = Visibility.Collapsed;
        ScopeStatus.Text = "Scopes unavailable: " + error;
        ScopeStatus.Visibility = Visibility.Visible;
    });
}
