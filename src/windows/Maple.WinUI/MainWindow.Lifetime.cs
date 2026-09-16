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
        private Task? _shutdownTask;
        private int _panelReleaseCount;

        private void OnWindowClosed(object sender, WindowEventArgs args)
        {
            if (_closeReady) return;
            // WinUI 1.6 DesktopWindowImpl.CloseImpl checks Handled before
            // destroying XAML/the HWND. Return from this callback first;
            // re-enter Close only after the async drain on the live dispatcher.
            args.Handled = true;
            if (_closing) return;
            _closing = true;
            // Reject late producers before any already-queued present callback runs.
            ViewModel.Dispose();
            DispatcherQueue.TryEnqueue(async () =>
            {
                try
                {
                    await ShutdownAsync();
                    if (!_lifecycleSmokeActive)
                    {
                        _closeReady = true;
                        Close();
                    }
                }
                catch (Exception error)
                {
                    DiagLog.Write($"[lifetime] shutdown failed: {error}");
                    Environment.ExitCode = 1;
                }
            });
        }

        private Task ShutdownAsync() => _shutdownTask ??= DrainWindowAsync();

        private async Task DrainWindowAsync()
        {
            _closing = true;
            var renderer = ViewModel.Renderer;
            renderer.FrameReady -= OnFrameReady;
            renderer.GpuFrameReady -= OnGpuFrameReady;
            renderer.ClipSourceReady -= OnClipSourceReady;
            renderer.HistogramReady -= OnHistogramReady;
            renderer.GpuUnavailable -= OnGpuUnavailable;
            renderer.RenderFailed -= OnRenderFailed;
            ViewModel.Dispose();
            // CfDisconnect may wait for callbacks; leave the UI dispatcher live.
            await Task.Run(_cloudFiles.Dispose); // keep persistent registration
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

        private void OnRenderFailed(string message) => App.MainDispatcherQueue?.TryEnqueue(() =>
        {
            if (!_closing) RenderStatsText.Text = $"render error: {message}";
        });
    }
}
