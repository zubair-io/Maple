using System;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media.Imaging;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private readonly NativeDetailDecoder _detailDecoder = new();
    private CancellationTokenSource? _detailCancellation;
    private Task _detailWork = Task.CompletedTask;
    private Task _geometryWork = Task.CompletedTask;
    private CancellationTokenSource _geometryCancellation = new();
    private PhotoItem? _geometryAttemptedPhoto;
    private long _detailVersion;
    private MapleRawGeometry? _nativeGeometry;
    private PhotoItem? _nativeGeometryPhoto;
    private string? _sourceGeometryError;
    private string? _nativeDetailError;

    private void HookNativeDetail()
    {
        ViewModel.Renderer.DetailInvalidated += OnDetailInvalidated;
        var lastScale = DisplayScale;
        ((FrameworkElement)Content).Loaded += (_, _) =>
        {
            if (ZoomHost.XamlRoot is not { } root) return;
            root.Changed += (_, _) =>
            {
                if (Math.Abs(lastScale - DisplayScale) < .001) return;
                lastScale = DisplayScale;
                SyncCanvasZoom();
                QueueDetailRefresh();
            };
        };
    }

    private void OnDetailInvalidated()
    {
        Interlocked.Increment(ref _detailVersion);
        DispatcherQueue.TryEnqueue(() => QueueDetailRefresh());
    }

    private CancellationToken BeginDetailRequest()
    {
        Interlocked.Increment(ref _detailVersion);
        _nativeDetailError = null;
        _detailCancellation?.Cancel();
        _detailCancellation?.Dispose();
        _detailCancellation = new CancellationTokenSource();
        return _detailCancellation.Token;
    }

    private void ClearNativeDetailSource()
    {
        BeginDetailRequest();
        _geometryCancellation.Cancel();
        _geometryCancellation.Dispose();
        _geometryCancellation = new CancellationTokenSource();
        _geometryAttemptedPhoto = null;
        _nativeGeometry = null;
        _nativeGeometryPhoto = null;
        _sourceGeometryError = null;
        // Zoom resets on navigation and on every mode change.
        _canvasZoom.ResetForNewPicture();
        _canvasTouches.Reset();
        _mouseDragStart = null;
        ApplyCanvasZoom(refreshDetail: false);
        if (NativeDetailOverlay != null) NativeDetailOverlay.Visibility = Visibility.Collapsed;
        if (ZoomReadout != null) ZoomReadout.Text = "Fit";
        _ = _detailDecoder.ResetAsync();
        NativeDetailHazeCache.Clear();
    }

    private double DisplayScale => ZoomHost.XamlRoot?.RasterizationScale ?? 1.0;

    /// <summary>100% needs the source size: wait for it, then zoom to
    /// 100% re-centred, or — from a double-click at fit — anchored at
    /// <paramref name="anchor"/> (viewport points).</summary>
    private async Task SetActualSizeAsync(Windows.Foundation.Point? anchor = null)
    {
        var photo = ViewModel.SelectedPhoto;
        if (_closing || photo == null || _mode == ShellMode.Browse) return;
        var sourceCancellation = _geometryCancellation.Token;
        if (_nativeGeometry == null && _geometryWork.IsCompleted) _geometryAttemptedPhoto = null;
        EnsureSourceGeometry();
        await _geometryWork;
        // Decode notification can precede the dispatcher frame that establishes
        // fit bounds. Never substitute preview scale 1 for an unknown source fit.
        var deadline = DateTime.UtcNow.AddSeconds(90);
        while (!_closing && !sourceCancellation.IsCancellationRequested && ContentFitRect() == null
            && DateTime.UtcNow < deadline) await Task.Delay(50);
        if (_closing || !ReferenceEquals(photo, ViewModel.SelectedPhoto)
            || sourceCancellation.IsCancellationRequested || ContentFitRect() == null
            || !ReferenceEquals(photo, _nativeGeometryPhoto)) return;
        SyncCanvasZoom(refreshDetail: false);
        if (anchor is not { } point) _canvasZoom.ZoomToActualSize();
        else if (_canvasZoom.IsFit) _canvasZoom.DoubleTap(point.X, point.Y);
        ApplyCanvasZoom();
    }

    private void EnsureSourceGeometry()
    {
        var photo = ViewModel.SelectedPhoto;
        if (_closing || photo == null || ReferenceEquals(photo, _geometryAttemptedPhoto)) return;
        _geometryAttemptedPhoto = photo;
        _geometryWork = ReadSourceGeometryAsync(photo, _geometryCancellation.Token);
    }

    private async Task ReadSourceGeometryAsync(PhotoItem photo, CancellationToken cancellation)
    {
        _sourceGeometryError = null;
        try
        {
            ZoomReadout.Text = "Loading source size…";
            var geometry = await _detailDecoder.ReadGeometryAsync(photo.EditPath, ViewModel.Adjustments.Clone(), cancellation);
            if (_closing || cancellation.IsCancellationRequested
                || !ReferenceEquals(photo, ViewModel.SelectedPhoto)) return;
            _nativeGeometry = geometry;
            _nativeGeometryPhoto = photo;
            SyncCanvasZoom();
            QueueDetailRefresh();
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            // Source geometry survives tile refreshes; its cancellation token
            // and photo identity own it, independently of the tile version.
            if (!_closing && !cancellation.IsCancellationRequested && ReferenceEquals(photo, ViewModel.SelectedPhoto))
            {
                DiagLog.Write($"[source-geometry] {error}");
                _sourceGeometryError = "Preview · source size unavailable";
                ZoomReadout.Text = _sourceGeometryError;
            }
        }
    }

    private void QueueDetailRefresh()
    {
        if (_closing || NativeDetailOverlay == null) return;
        var cancellation = BeginDetailRequest();
        NativeDetailOverlay.Visibility = Visibility.Collapsed;
        SyncCanvasZoom(refreshDetail: false);
        if (_nativeGeometry is not { } geometry || !ReferenceEquals(_nativeGeometryPhoto, ViewModel.SelectedPhoto)
            || ContentFitRect() == null)
        {
            // #4154: refreshes must retain the current source's explicit
            // unsupported-detail fallback until retry or photo change.
            ZoomReadout.Text = _sourceGeometryError ??
                (_canvasZoom.IsFit ? "Fit" : "Preview zoom");
            if (_mode == ShellMode.Edit && ViewModel.Renderer.DetailSource != null) EnsureSourceGeometry();
            return;
        }
        var scale = _canvasZoom.EffectiveScale;
        var percent = $"{scale * 100:0}%";
        if (scale < .999 || _mode != ShellMode.Edit)
        {
            ZoomReadout.Text = $"{percent} · preview";
            return;
        }
        var model = ViewModel.Adjustments.Clone();
        if (!model.Crop.IsIdentity || model.PerspectiveVertical != 0 || model.PerspectiveHorizontal != 0
            || model.PerspectiveRotate != 0 || model.PerspectiveScale != 100 || model.PerspectiveAspect != 0
            || model.PerspectiveX != 0 || model.PerspectiveY != 0)
        {
            ZoomReadout.Text = "Preview zoom · native detail unavailable with crop or geometry corrections";
            return;
        }
        var anchor = ViewModel.Renderer.DetailSource;
        var photo = ViewModel.SelectedPhoto;
        if (anchor == null || photo == null || ViewModel.IsDecoding)
        {
            ZoomReadout.Text = $"{percent} · waiting for image";
            return;
        }
        var visible = _canvasZoom.VisibleSourceRect;
        var (x, y) = (visible.x, visible.y);
        var (right, bottom) = (visible.x + visible.width, visible.y + visible.height);
        if (right <= x || bottom <= y) return;
        var margin = Math.Min(512, Math.Max(right - x, bottom - y) * .125);
        if (NativeDetailPatch.Fit(x, y, right, bottom, margin, NativeDetailPatch.Border(model, anchor, geometry), geometry)
            is not (var published, var decode))
        {
            ZoomReadout.Text = $"{percent} · preview · native detail patch too large";
            return;
        }
        ZoomReadout.Text = $"{percent} · refining…";
        var version = Volatile.Read(ref _detailVersion);
        _detailWork = RefineDetailAsync(_detailWork, photo, model, anchor, published, decode, geometry, version, percent, cancellation);
    }

    private async Task RefineDetailAsync(Task previous, PhotoItem photo, Models.AdjustmentState model, DecodedImage anchor,
        NativeDetailRegion published, NativeDetailRegion decode, MapleRawGeometry geometry,
        long version, string percent, CancellationToken cancellation)
    {
        try
        {
            // Drain the old native call before allocating another patch. Cancellation
            // rejects its result but cannot interrupt a running Rust operation.
            await previous;
            cancellation.ThrowIfCancellationRequested();
            await Task.Delay(180, cancellation);
            var patch = await _detailDecoder.DecodeAsync(photo.EditPath, model, anchor, decode, cancellation);
            var film = await ViewModel.Renderer.LoadDetailFilmAsync(model.FilmLook, cancellation);
            var pixels = await Task.Run(() =>
            {
                cancellation.ThrowIfCancellationRequested();
                var rendered = new byte[checked(patch.Image.Width * patch.Image.Height * 4)];
                float[]? scratch = null;
                RenderEngine.RenderTick(patch.Image, model, ref scratch, rendered, film,
                    new MapleChainWindow { X = decode.X, Y = decode.Y, FullWidth = geometry.CropWidth, FullHeight = geometry.CropHeight },
                    anchor);
                cancellation.ThrowIfCancellationRequested();
                var result = new byte[checked((int)(published.Width * published.Height * 4))];
                for (var row = 0u; row < published.Height; row++)
                    Buffer.BlockCopy(rendered, checked((int)(((published.Y - decode.Y + row) * decode.Width + published.X - decode.X) * 4)),
                        result, checked((int)(row * published.Width * 4)), checked((int)(published.Width * 4)));
                return result;
            }, cancellation);
            if (_closing || cancellation.IsCancellationRequested || version != Volatile.Read(ref _detailVersion)
                || !ReferenceEquals(photo, ViewModel.SelectedPhoto) || !ReferenceEquals(anchor, ViewModel.Renderer.DetailSource)
                || ContentFitRect() is not { } fit) return;
            var bitmap = new WriteableBitmap((int)published.Width, (int)published.Height);
            using (var stream = bitmap.PixelBuffer.AsStream()) stream.Write(pixels, 0, pixels.Length);
            bitmap.Invalidate();
            NativeDetailOverlay.Source = bitmap;
            NativeDetailOverlay.Width = published.Width * fit.W / geometry.CropWidth;
            NativeDetailOverlay.Height = published.Height * fit.H / geometry.CropHeight;
            NativeDetailOverlay.Margin = new Thickness(fit.X + published.X * fit.W / geometry.CropWidth,
                fit.Y + published.Y * fit.H / geometry.CropHeight, 0, 0);
            NativeDetailOverlay.Visibility = Visibility.Visible;
            ZoomReadout.Text = $"{percent} · native detail";
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            if (!_closing && !cancellation.IsCancellationRequested && version == Volatile.Read(ref _detailVersion)
                && ReferenceEquals(photo, ViewModel.SelectedPhoto) && ReferenceEquals(anchor, ViewModel.Renderer.DetailSource))
            {
                _nativeDetailError = error.ToString();
                DiagLog.Write($"[native-detail] {error}");
                ZoomReadout.Text = $"{percent} · preview · native detail unavailable";
            }
        }
    }
}
