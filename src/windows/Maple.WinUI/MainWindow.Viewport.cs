using System;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media.Imaging;

namespace Maple.WinUI
{
    /// <summary>Viewport presentation: the GPU/CPU frame paths that feed the
    /// SwapChainPanel/Image pair (#2587), panel sizing, and the fit/1:1/pan
    /// zoom model (#2572) layered over the ScrollViewer.</summary>
    public sealed partial class MainWindow
    {
        private WriteableBitmap? _viewportBitmap;
        private (int Width, int Height)? _gpuFrameDims;

        // --- Rendering ---

        private void OnGpuFrameReady(int width, int height, double millis, bool fullRes)
        {
            App.MainDispatcherQueue?.TryEnqueue(() =>
            {
                if (_closing) return;
                RenderErrorBar.IsOpen = false;
                // Both phases present into ONE surface pinned at the full
                // session dims (#2587) — the half-res fast pass is upscaled in
                // the present shader — so the panel size never changes between
                // fast and refined frames. Re-fit only when the dims actually
                // change (a new image/session), not on every drag tick.
                if (_gpuFrameDims != (width, height))
                {
                    _gpuFrameDims = (width, height);
                    UpdatePanelFit();
                }
                ViewportSwapChainPanel.Visibility = Visibility.Visible;
                ViewportImage.Visibility = Visibility.Collapsed;
                QueueDetailRefresh();
                RenderStatsText.Text =
                    $"{width}×{height} · GPU {millis:0} ms{(fullRes ? string.Empty : " (fast)")}";
                ViewModel.LastRenderMillis = millis;
            });
        }

        /// <summary>Size the SwapChainPanel to exactly the session dims in DIPs:
        /// a SwapChainPanel composites its swapchain at 1 buffer pixel = 1 DIP
        /// (no stretch-to-element), so any other element size leaves bands or
        /// crops. Its parent Viewbox scales that surface uniformly to the current
        /// viewport, including when Info or the expanded filmstrip opens.</summary>
        private void UpdatePanelFit()
        {
            if (_gpuFrameDims is not { } dims)
                return;
            ViewportSwapChainPanel.Width = dims.Width;
            ViewportSwapChainPanel.Height = dims.Height;
            SizeZoomHost();
            UpdateCropDisplay();
            UpdateMaskDisplay();
        }

        private void OnCanvasHostSizeChanged(object sender, SizeChangedEventArgs e)
        {
            UpdateViewerChromeSize();
            UpdatePanelFit();
            SizeZoomHost();
            UpdateCropDisplay();
            UpdateMaskDisplay();
            QueueDetailRefresh();
        }

        private void UpdateViewerChromeSize()
        {
            if (CanvasHost.ActualHeight <= 0) return;
            HeaderHistogram.Visibility = CanvasHost.ActualWidth < 760 ? Visibility.Collapsed : Visibility.Visible;
            EditTopBar.MaxWidth = Math.Max(0, CanvasHost.ActualWidth - 32);
            PreviewTopBar.MaxWidth = Math.Max(160, Math.Min(480, CanvasHost.ActualWidth - FilmstripRail.ActualWidth - 24));
            PreviewTopBar.Width = PreviewTopBar.MaxWidth;
            EditPanel.MaxHeight = Math.Max(100, CanvasHost.ActualHeight - 132);
            EditRail.MaxHeight = Math.Max(100, CanvasHost.ActualHeight - 116);
            FilmstripRail.MaxHeight = _mode == ShellMode.Edit
                ? 42 + Math.Max(1, Math.Min(5, Math.Floor((CanvasHost.ActualHeight - 162) / 60))) * 60
                : double.PositiveInfinity;
        }

        // --- Zoom / pan (#2572): factor 1 = fit; drag pans when zoomed ---

        private bool _panning;
        private Windows.Foundation.Point _panStart;
        private (double H, double V) _panStartOffsets;

        /// <summary>The zoom host tracks the scroll viewport at factor 1, so
        /// "fit" is always zoomFactor 1 regardless of window size.</summary>
        private void SizeZoomHost()
        {
            var width = ViewerScroll.ViewportWidth;
            var height = ViewerScroll.ViewportHeight;
            if (width > 0 && height > 0)
            {
                var scale = _nativeZoomLayout && _nativeGeometry is { } geometry
                    ? Math.Max(geometry.CropWidth / width, geometry.CropHeight / height) / DisplayScale : 1;
                ZoomHost.Width = width * scale;
                ZoomHost.Height = height * scale;
            }
        }

        private void ResetZoom()
        {
            _nativeZoomLayout = false;
            SizeZoomHost();
            ViewerScroll.ChangeView(0, 0, 1.0f, disableAnimation: true);
            QueueDetailRefresh();
        }

        /// <summary>1:1 uses oriented RAW pixels per physical display pixel.</summary>
        private float OneToOneZoomFactor()
        {
            return _nativeGeometry is { } geometry && ContentFitRect() is { } fit && fit.W > 0
                ? (float)(geometry.CropWidth / (fit.W * DisplayScale)) : 1f;
        }

        private void SetZoom(float factor, Windows.Foundation.Point? focus = null)
        {
            factor = Math.Clamp(factor, (float)ViewerScroll.MinZoomFactor, (float)ViewerScroll.MaxZoomFactor);
            var current = ViewerScroll.ZoomFactor;
            // Keep the focus point (content coords) stationary in the viewport.
            var focusContent = focus ?? new Windows.Foundation.Point(
                (ViewerScroll.HorizontalOffset + ViewerScroll.ViewportWidth / 2) / current,
                (ViewerScroll.VerticalOffset + ViewerScroll.ViewportHeight / 2) / current);
            var offsetX = focusContent.X * factor - ViewerScroll.ViewportWidth / 2;
            var offsetY = focusContent.Y * factor - ViewerScroll.ViewportHeight / 2;
            ViewerScroll.ChangeView(Math.Max(0, offsetX), Math.Max(0, offsetY), factor,
                disableAnimation: false);
        }

        private void OnViewerDoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
        {
            var position = e.GetPosition(ZoomHost);
            if (_nativeZoomLayout || Math.Abs(ViewerScroll.ZoomFactor - 1) > .001f) ResetZoom();
            else _ = SetActualSizeAsync(position);
            e.Handled = true;
        }

        private void HookViewerPan()
        {
            ZoomHost.PointerPressed += (_, e) =>
            {
                if (ViewerScroll.ScrollableWidth <= 0 && ViewerScroll.ScrollableHeight <= 0)
                    return;
                _panning = true;
                _panStart = e.GetCurrentPoint(this.Content).Position;
                _panStartOffsets = (ViewerScroll.HorizontalOffset, ViewerScroll.VerticalOffset);
                ZoomHost.CapturePointer(e.Pointer);
            };
            ZoomHost.PointerMoved += (_, e) =>
            {
                if (!_panning)
                    return;
                var position = e.GetCurrentPoint(this.Content).Position;
                ViewerScroll.ChangeView(
                    _panStartOffsets.H - (position.X - _panStart.X),
                    _panStartOffsets.V - (position.Y - _panStart.Y),
                    null, disableAnimation: true);
            };
            ZoomHost.PointerReleased += (_, e) =>
            {
                _panning = false;
                ZoomHost.ReleasePointerCapture(e.Pointer);
            };
            ZoomHost.PointerCanceled += (_, _) => _panning = false;
        }

        private void OnFrameReady(byte[] bgra, int width, int height, uint[] bins, double millis)
        {
            var copy = new byte[bgra.Length];
            Buffer.BlockCopy(bgra, 0, copy, 0, bgra.Length);
            App.MainDispatcherQueue?.TryEnqueue(() =>
            {
                if (_closing) return;
                RenderErrorBar.IsOpen = false;
                ViewportSwapChainPanel.Visibility = Visibility.Collapsed;
                ViewportImage.Visibility = Visibility.Visible;
                if (_viewportBitmap == null || _viewportBitmap.PixelWidth != width
                    || _viewportBitmap.PixelHeight != height)
                {
                    _viewportBitmap = new WriteableBitmap(width, height);
                    ViewportImage.Source = _viewportBitmap;
                }
                using (var stream = _viewportBitmap.PixelBuffer.AsStream())
                {
                    stream.Write(copy, 0, copy.Length);
                }
                _viewportBitmap.Invalidate();
                QueueDetailRefresh();
                RenderStatsText.Text = $"{millis:0} ms";
                ViewModel.LastRenderMillis = millis;
                _lastHistogramBins = bins;
                HistogramView.Draw(HistogramCanvas, bins);
                UpdateCurveHistogram();
                UpdateClipIndicators();
            });
        }
    }
}
