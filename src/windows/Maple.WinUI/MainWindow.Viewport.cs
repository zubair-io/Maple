using System;
using System.Runtime.InteropServices.WindowsRuntime;
using Maple.WinUI.Services;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.System;

namespace Maple.WinUI
{
    /// <summary>Viewport presentation: the GPU/CPU frame paths that feed the
    /// SwapChainPanel/Image pair (#2587), panel sizing, and the input
    /// plumbing of the shared zoom model (#5714).</summary>
    public sealed partial class MainWindow
    {
        private WriteableBitmap? _viewportBitmap;
        private (int Width, int Height)? _gpuFrameDims;

        // --- Rendering ---

        private void OnGpuFrameReady(Services.DecodedImage source, int width, int height, double millis, bool fullRes)
        {
            App.MainDispatcherQueue?.TryEnqueue(() =>
            {
                if (_closing || !ViewModel.Renderer.IsCurrentFrame(source)) return;
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
            UpdateCropDisplay();
            UpdateMaskDisplay();
            UpdateRepairCanvas();
        }

        private void OnCanvasHostSizeChanged(object sender, SizeChangedEventArgs e)
        {
            ViewerViewport.Clip = new RectangleGeometry
            {
                Rect = new Windows.Foundation.Rect(0, 0, ViewerViewport.ActualWidth, ViewerViewport.ActualHeight),
            };
            UpdateViewerChromeSize();
            UpdatePanelFit();
            UpdateCropDisplay();
            UpdateMaskDisplay();
            UpdateRepairCanvas();
            QueueDetailRefresh();
        }

        private void UpdateViewerChromeSize()
        {
            if (CanvasHost.ActualHeight <= 0) return;
            EditTopBar.MaxWidth = Math.Max(0, CanvasHost.ActualWidth - 32);
            PreviewTopBar.MaxWidth = Math.Max(160, Math.Min(480, CanvasHost.ActualWidth - FilmstripRail.ActualWidth - 24));
            PreviewTopBar.Width = PreviewTopBar.MaxWidth;
            EditPanel.MaxHeight = Math.Max(100, CanvasHost.ActualHeight - 132);
            EditRail.MaxHeight = Math.Max(100, CanvasHost.ActualHeight - 116);
            FilmstripRail.MaxHeight = _mode == ShellMode.Edit
                ? 42 + Math.Max(1, Math.Min(5, Math.Floor((CanvasHost.ActualHeight - 162) / 60))) * 60
                : double.PositiveInfinity;
        }

        // --- Zoom / pan (#5714): the shared Rust zoom model drives one scale +
        //     translate over the fit layout, so ZoomHost and everything in it
        //     (crop, mask, repair, native detail) stay in fit coordinates. ---

        private readonly CanvasZoomController _canvasZoom = new();
        private readonly CanvasTouchTracker _canvasTouches = new();
        private CanvasZoomView _appliedZoomView;
        private Windows.Foundation.Point? _mouseDragStart;

        /// <summary>The picture's extent for the zoom model — source pixels
        /// once the source size is read, the current stand-in frame's pixels
        /// until then — and the committed crop's share of it (the crop
        /// display scales the crop itself to fit). They stay separate so the
        /// model can tell the picture resolving from a crop change.</summary>
        private (double Width, double Height, double CropWidthFraction, double CropHeightFraction) CanvasZoomExtent()
        {
            var source = ReferenceEquals(_nativeGeometryPhoto, ViewModel.SelectedPhoto) ? _nativeGeometry : null;
            var (width, height) = source is { } geometry
                ? ((double)geometry.CropWidth, (double)geometry.CropHeight)
                : DisplayedFrameDims();
            var crop = ViewModel.Adjustments.Crop;
            return !_cropArmed && !crop.IsIdentity && crop.RectIsValid
                ? (width, height, crop.Right - crop.Left, crop.Bottom - crop.Top)
                : (width, height, 1, 1);
        }

        /// <summary>Feed the live viewport and extent to the zoom model and
        /// present the result.</summary>
        private void SyncCanvasZoom(bool refreshDetail = true)
        {
            if (ViewerViewport == null) return;
            var (width, height, cropWidthFraction, cropHeightFraction) = CanvasZoomExtent();
            _canvasZoom.UpdateGeometry(ViewerViewport.ActualWidth, ViewerViewport.ActualHeight,
                width, height, DisplayScale, cropWidthFraction, cropHeightFraction);
            ApplyCanvasZoom(refreshDetail);
        }

        private void ApplyCanvasZoom(bool refreshDetail = true)
        {
            if (ZoomPanTransform == null) return;
            var view = _canvasZoom.View;
            if (view == _appliedZoomView) return;
            _appliedZoomView = view;
            ZoomPanTransform.ScaleX = view.ScaleToFit;
            ZoomPanTransform.ScaleY = view.ScaleToFit;
            ZoomPanTransform.TranslateX = view.PanX;
            ZoomPanTransform.TranslateY = view.PanY;
            if (refreshDetail) QueueDetailRefresh();
        }

        // The XAML core stores transform values as float, so a read-back
        // equals the applied double only after the same rounding.
        private static bool TransformHolds(double applied, double value) => applied == (float)value;

        private void ResetZoom()
        {
            _canvasZoom.ResetToFit();
            ApplyCanvasZoom();
        }

        private void StepZoom(bool zoomIn)
        {
            SyncCanvasZoom(refreshDetail: false);
            if (zoomIn) _canvasZoom.StepIn();
            else _canvasZoom.StepOut();
            ApplyCanvasZoom();
        }

        private void ZoomToFill()
        {
            SyncCanvasZoom(refreshDetail: false);
            _canvasZoom.ZoomToFill();
            ApplyCanvasZoom();
        }

        private void OnViewerDoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
        {
            e.Handled = true;
            if (!_canvasZoom.IsFit)
            {
                ResetZoom();
                return;
            }
            _ = SetActualSizeAsync(e.GetPosition(ViewerViewport));
        }

        private void HookViewerPan()
        {
            ViewerViewport.PointerPressed += OnViewerPointerPressed;
            ViewerViewport.PointerMoved += OnViewerPointerMoved;
            // The pickers and the repair canvas mark their releases handled;
            // a contact the viewer tracks must still be dropped on every end.
            ViewerViewport.AddHandler(UIElement.PointerReleasedEvent,
                new PointerEventHandler(OnViewerPointerReleased), handledEventsToo: true);
            ViewerViewport.AddHandler(UIElement.PointerCanceledEvent,
                new PointerEventHandler(OnViewerPointerEnded), handledEventsToo: true);
            ViewerViewport.AddHandler(UIElement.PointerCaptureLostEvent,
                new PointerEventHandler(OnViewerPointerEnded), handledEventsToo: true);
            ViewerViewport.PointerExited += OnViewerPointerExited;
            ViewerViewport.PointerWheelChanged += OnViewerPointerWheelChanged;
        }

        /// <summary>The white-balance and colour-curve pickers read the
        /// press/release pair on ZoomHost, which a capture on the viewer would
        /// swallow, so a touch made while a picker is armed is left to the
        /// picker: neither captured nor tracked.</summary>
        private bool CanvasPickArmed => _wbPickArmed || _colorCurvePickArmed;

        /// <summary>A tracked touch whose capture did not take never reports
        /// its lift here once it leaves the viewer; drop it so the next touch
        /// is not read as a pinch. Exits bubbling up from children are not
        /// the viewer's.</summary>
        private void OnViewerPointerExited(object sender, PointerRoutedEventArgs e)
        {
            if (e.Pointer.PointerDeviceType != PointerDeviceType.Touch
                || !ReferenceEquals(e.OriginalSource, ViewerViewport)) return;
            foreach (var captured in ViewerViewport.PointerCaptures ?? [])
                if (captured.PointerId == e.Pointer.PointerId) return;
            ApplyTouch(_canvasTouches.Release(e.Pointer.PointerId));
        }

        private void OnViewerPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            var point = e.GetCurrentPoint(ViewerViewport);
            SyncCanvasZoom(refreshDetail: false);
            if (e.Pointer.PointerDeviceType == PointerDeviceType.Touch)
            {
                if (CanvasPickArmed) return;
                ApplyTouch(_canvasTouches.Press(e.Pointer.PointerId, point.Position.X, point.Position.Y));
                ViewerViewport.CapturePointer(e.Pointer);
                return;
            }
            if (_mouseDragStart != null || _activeGroup == "Heal" || CanvasPickArmed
                || !point.Properties.IsLeftButtonPressed || !_canvasZoom.CanPan)
                return;
            _mouseDragStart = point.Position;
            _canvasZoom.DragBegan();
            ViewerViewport.CapturePointer(e.Pointer);
        }

        private void OnViewerPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            var position = e.GetCurrentPoint(ViewerViewport).Position;
            if (e.Pointer.PointerDeviceType == PointerDeviceType.Touch)
            {
                ApplyTouch(_canvasTouches.Move(e.Pointer.PointerId, position.X, position.Y));
                return;
            }
            if (_mouseDragStart is not { } start) return;
            _canvasZoom.DragChanged(position.X - start.X, position.Y - start.Y);
            ApplyCanvasZoom();
        }

        /// <summary>A mouse drag ends when its left button lifts, not when
        /// another button does.</summary>
        private void OnViewerPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (e.Pointer.PointerDeviceType != PointerDeviceType.Touch
                && e.GetCurrentPoint(ViewerViewport).Properties.IsLeftButtonPressed)
                return;
            OnViewerPointerEnded(sender, e);
        }

        private void OnViewerPointerEnded(object sender, PointerRoutedEventArgs e)
        {
            if (e.Pointer.PointerDeviceType == PointerDeviceType.Touch)
            {
                ApplyTouch(_canvasTouches.Release(e.Pointer.PointerId));
                return;
            }
            if (_mouseDragStart == null) return;
            _mouseDragStart = null;
            _canvasZoom.DragEnded();
            ViewerViewport.ReleasePointerCapture(e.Pointer);
            ApplyCanvasZoom();
        }

        private void ApplyTouch(CanvasTouchUpdate update)
        {
            _canvasZoom.ApplyTouch(update, dragPans: _activeGroup != "Heal" && !CanvasPickArmed);
            ApplyCanvasZoom();
        }

        private void OnViewerPointerWheelChanged(object sender, PointerRoutedEventArgs e)
        {
            var point = e.GetCurrentPoint(ViewerViewport);
            SyncCanvasZoom(refreshDetail: false);
            var handled = _canvasZoom.Wheel(point.Properties.MouseWheelDelta,
                point.Properties.IsHorizontalMouseWheel,
                e.KeyModifiers.HasFlag(VirtualKeyModifiers.Control),
                e.KeyModifiers.HasFlag(VirtualKeyModifiers.Shift),
                point.Position.X, point.Position.Y);
            if (!handled) return;
            e.Handled = true;
            ApplyCanvasZoom();
        }

        private void OnFrameReady(Services.DecodedImage source, byte[] bgra, int width, int height, uint[] bins, double millis)
        {
            var copy = new byte[bgra.Length];
            Buffer.BlockCopy(bgra, 0, copy, 0, bgra.Length);
            App.MainDispatcherQueue?.TryEnqueue(() =>
            {
                if (_closing || !ViewModel.Renderer.IsCurrentFrame(source)) return;
                RenderErrorBar.IsOpen = false;
                ViewportSwapChainPanel.Visibility = Visibility.Collapsed;
                ViewportImage.Visibility = Visibility.Visible;
                if (_viewportBitmap == null || _viewportBitmap.PixelWidth != width
                    || _viewportBitmap.PixelHeight != height)
                {
                    _viewportBitmap = new WriteableBitmap(width, height);
                    ViewportImage.Source = _viewportBitmap;
                    SyncCanvasZoom();
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
