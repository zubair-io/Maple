using System;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services;
using Microsoft.UI.Xaml;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    // Part of the existing explicitly invoked native lifecycle harness.
    // Exercises the real render loop and production panel, not a mock scope feed.
    private async Task VerifyScopesAsync()
    {
        var renderer = ViewModel.Renderer;
        ScopesMenuItem.IsChecked = true;
        OnToggleScopes(this, new RoutedEventArgs());
        var initial = await WaitForScopeAsync(-1);
        if (ScopesPanelHost.Visibility != Visibility.Visible || ScopesPlots.Visibility != Visibility.Visible
            || ScopesPlots.VectorscopeBins?.Count != 128 * 128)
            throw new InvalidOperationException("Production scopes panel did not display the native sample");

        var changed = ViewModel.Adjustments.Clone();
        changed.Exposure += 0.5;
        renderer.RequestRender(changed);
        if (renderer.IsScopeCurrent(initial.Version))
            throw new InvalidOperationException("Old scope survived adjustment invalidation");
        var edited = await WaitForScopeAsync(initial.Version);
        var source = renderer.DetailSource ?? throw new InvalidOperationException("Scope test needs decoded source");
        renderer.SetImage(source); // actual native session replacement, frame counter restarts
        renderer.RequestRender(ViewModel.Adjustments.Clone());
        var replaced = await WaitForScopeAsync(edited.Version);
        if (renderer.IsScopeCurrent(edited.Version))
            throw new InvalidOperationException("Old scope survived native session replacement");

        OnCloseScopes(this, new RoutedEventArgs());
        var afterClose = 0;
        void Sample(ScopePanelFrame _) => Interlocked.Increment(ref afterClose);
        renderer.ScopeReady += Sample;
        try
        {
            renderer.RequestRender(ViewModel.Adjustments.Clone());
            await Task.Delay(500);
            if (afterClose != 0 || renderer.IsScopeCurrent(replaced.Version) || ScopesPanelHost.Visibility != Visibility.Collapsed)
                throw new InvalidOperationException("Closed scopes continued publishing");
        }
        finally { renderer.ScopeReady -= Sample; }
    }

    private async Task<ScopePanelFrame> WaitForScopeAsync(long previous)
    {
        var deadline = Environment.TickCount64 + 15000;
        while (Environment.TickCount64 < deadline)
        {
            if (_scopeFrame is { } sample && sample.Version != previous && ViewModel.Renderer.IsScopeCurrent(sample.Version))
                return sample;
            if (ScopeStatus.Text.StartsWith("Scopes unavailable:", StringComparison.Ordinal))
                throw new InvalidOperationException(ScopeStatus.Text);
            await Task.Delay(25);
        }
        throw new TimeoutException("No current scope sample reached the production panel");
    }
}
