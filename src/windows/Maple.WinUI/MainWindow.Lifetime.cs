using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Maple.WinUI.Services;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        private bool _closing;
        private bool _closeReady;
        private bool _closeSavePending;
        private Task? _shutdownTask;
        private int _panelReleaseCount;

        private async void OnWindowClosed(object sender, WindowEventArgs args)
        {
            if (_closeReady) return;
            // WinUI 1.6 DesktopWindowImpl.CloseImpl checks Handled before
            // destroying XAML/the HWND. Return from this callback first;
            // re-enter Close only after the async drain on the live dispatcher.
            args.Handled = true;
            if (_closing || _closeSavePending || _modalFlowGate.IsEntered) return;
            _closeSavePending = true;
            try
            {
                await RunModalFlowGuardedAsync(async () =>
                {
                    Exception? saveError = null;
                    var finished = false;
                    var saving = new Microsoft.UI.Xaml.Controls.ContentDialog
                    {
                        Title = "Saving changes",
                        Content = "Finishing local saves and cloud preview uploads…",
                        XamlRoot = Content.XamlRoot
                    };
                    saving.Opened += async (_, _) =>
                    {
                        try { await ViewModel.PrepareCloseAsync(); }
                        catch (Exception error) { saveError = error; }
                        finally { finished = true; saving.Hide(); }
                    };
                    saving.Closing += (_, closing) => closing.Cancel = !finished;
                    await saving.ShowAsync();
                    if (saveError != null) throw saveError;
                });
            }
            catch (Exception error)
            {
                try
                {
                    await RunModalFlowGuardedAsync(() => ShowMessageAsync("Could not finish saving",
                        error.Message + "\nThe window remains open. Check the connection or save location, then close again to retry."));
                }
                finally { _closeSavePending = false; }
                return;
            }
            _closeSavePending = false;
            _closing = true;
            StopSaveTime();
            DisposeCloudMap();
            _repairMappingRequest?.Cancel();
            ResetComparison();
            // Reject late producers before any already-queued present callback runs.
            ViewModel.Dispose();
            DispatcherQueue.TryEnqueue(async () =>
            {
                try
                {
                    await ShutdownAsync();
                }
                catch (Exception error)
                {
                    DiagLog.Write($"[lifetime] shutdown failed: {error}");
                    Environment.ExitCode = 1;
                }
                finally
                {
                    if (!_lifecycleSmokeActive && ViewModel.Renderer.IsStopped && _panelNative == IntPtr.Zero)
                    {
                        _closeReady = true;
                        Close();
                    }
                }
            });
        }

        private Task ShutdownAsync() => _shutdownTask ??= DrainWindowAsync();

        private async Task DrainWindowAsync()
        {
            _closing = true;
            StopSaveTime();
            _infoCancellation?.Cancel();
            _infoCancellation?.Dispose();
            _infoCancellation = null;
            var renderer = ViewModel.Renderer;
            renderer.DetailInvalidated -= OnDetailInvalidated;
            _detailCancellation?.Cancel();
            _geometryCancellation.Cancel();
            await _geometryWork;
            _geometryCancellation.Dispose();
            await _detailWork;
            _detailCancellation?.Dispose();
            await _detailDecoder.DisposeAsync();
            renderer.FrameReady -= OnFrameReady;
            renderer.GpuFrameReady -= OnGpuFrameReady;
            renderer.ClipSourceReady -= OnClipSourceReady;
            renderer.HistogramReady -= OnHistogramReady;
            renderer.ScopeReady -= OnScopeReady;
            renderer.ScopeInvalidated -= OnScopeInvalidated;
            renderer.ScopeFailed -= OnScopeFailed;
            renderer.GpuUnavailable -= OnGpuUnavailable;
            renderer.RenderFailed -= OnRenderFailed;
            ViewModel.Dispose();
            try
            {
                // CfDisconnect may wait for callbacks; leave the dispatcher live.
                await Task.Run(_cloudFiles.Dispose); // keep persistent registration
            }
            finally
            {
                try { await renderer.StopAsync(); }
                finally
                {
                    if (_panelNative != IntPtr.Zero)
                    {
                        var panel = _panelNative;
                        _panelNative = IntPtr.Zero;
                        Marshal.Release(panel);
                        _panelReleaseCount++;
                        DiagLog.Write("[lifetime] window panel reference released");
                    }
                }
            }
        }

        private void OnHistogramReady(uint[] bins) => App.MainDispatcherQueue?.TryEnqueue(() =>
        {
            if (_closing) return;
            _lastHistogramBins = bins;
            HistogramView.Draw(HistogramCanvas, bins);
            UpdateCurveHistogram();
            UpdateClipIndicators();
        });

        private void OnGpuUnavailable(string reason) => App.MainDispatcherQueue?.TryEnqueue(() =>
        {
            if (_closing) return;
            DiagLog.Write($"[Gpu] downgraded to CPU path: {reason}");
            ViewportSwapChainPanel.Visibility = Visibility.Collapsed;
            ViewportImage.Visibility = Visibility.Visible;
        });

        private void OnRetryPreview(object sender, Microsoft.UI.Xaml.RoutedEventArgs e) => ViewModel.RetryPreview();

        private void OnRenderFailed(string message) => App.MainDispatcherQueue?.TryEnqueue(() =>
        {
            if (_closing) return;
            RenderStatsText.Text = $"render error: {message}";
            RenderErrorBar.Message = message;
            RenderErrorBar.IsOpen = true;
        });
    }
}
