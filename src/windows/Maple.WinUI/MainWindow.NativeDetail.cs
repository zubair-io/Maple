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
    private bool _nativeZoomLayout;

    private void HookNativeDetail()
    {
        ViewModel.Renderer.DetailInvalidated += OnDetailInvalidated;
        ViewerScroll.ViewChanged += (_, _) => QueueDetailRefresh();
        var lastScale = DisplayScale;
        ((FrameworkElement)Content).Loaded += (_, _) =>
        {
            if (ZoomHost.XamlRoot is not { } root) return;
            root.Changed += (_, _) =>
            {
                if (Math.Abs(lastScale - DisplayScale) < .001) return;
                lastScale = DisplayScale;
                SizeZoomHost();
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
        _nativeZoomLayout = false;
        _nativeGeometryPhoto = null;
        if (NativeDetailOverlay != null) NativeDetailOverlay.Visibility = Visibility.Collapsed;
        if (ZoomReadout != null) ZoomReadout.Text = "Fit";
        _ = _detailDecoder.ResetAsync();
    }

    private double DisplayScale => ZoomHost.XamlRoot?.RasterizationScale ?? 1.0;

    private async Task SetActualSizeAsync(Windows.Foundation.Point? focus = null)
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
        // WinUI enforces a 0.1 minimum zoom. Give Actual Size a native-sized
        // layout so even tiny originals and very large sensors resolve exactly.
        var oldFit = ContentFitRect()!.Value;
        var oldFocus = focus ?? new Windows.Foundation.Point(
            (ViewerScroll.HorizontalOffset + ViewerScroll.ViewportWidth / 2) / ViewerScroll.ZoomFactor,
            (ViewerScroll.VerticalOffset + ViewerScroll.ViewportHeight / 2) / ViewerScroll.ZoomFactor);
        _nativeZoomLayout = true;
        SizeZoomHost();
        ZoomHost.UpdateLayout();
        var newFit = ContentFitRect()!.Value;
        var newFocus = new Windows.Foundation.Point(
            newFit.X + (oldFocus.X - oldFit.X) / oldFit.W * newFit.W,
            newFit.Y + (oldFocus.Y - oldFit.Y) / oldFit.H * newFit.H);
        ViewerScroll.MinZoomFactor = 0.1f;
        ViewerScroll.MaxZoomFactor = 8f;
        SetZoom(OneToOneZoomFactor(), newFocus);
        QueueDetailRefresh();
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
        try
        {
            ZoomReadout.Text = "Loading source size…";
            var geometry = await _detailDecoder.ReadGeometryAsync(photo.EditPath, ViewModel.Adjustments.Clone(), cancellation);
            if (_closing || cancellation.IsCancellationRequested
                || !ReferenceEquals(photo, ViewModel.SelectedPhoto)) return;
            _nativeGeometry = geometry;
            _nativeGeometryPhoto = photo;
            QueueDetailRefresh();
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            if (!_closing && !cancellation.IsCancellationRequested) ZoomReadout.Text = $"Preview · source size unavailable: {error.Message}";
        }
    }

    private void QueueDetailRefresh()
    {
        if (_closing || NativeDetailOverlay == null) return;
        var cancellation = BeginDetailRequest();
        NativeDetailOverlay.Visibility = Visibility.Collapsed;
        if (_nativeGeometry is not { } geometry || !ReferenceEquals(_nativeGeometryPhoto, ViewModel.SelectedPhoto)
            || ContentFitRect() is not { } fit)
        {
            ZoomReadout.Text = Math.Abs(ViewerScroll.ZoomFactor - 1) < .001 ? "Fit" : "Preview zoom";
            if (_mode == ShellMode.Edit && ViewModel.Renderer.DetailSource != null) EnsureSourceGeometry();
            return;
        }
        var scale = fit.W * ViewerScroll.ZoomFactor * DisplayScale / geometry.CropWidth;
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
        var zoom = ViewerScroll.ZoomFactor;
        var x = Math.Max(0, (ViewerScroll.HorizontalOffset / zoom - fit.X) * geometry.CropWidth / fit.W);
        var y = Math.Max(0, (ViewerScroll.VerticalOffset / zoom - fit.Y) * geometry.CropHeight / fit.H);
        var right = Math.Min(geometry.CropWidth, ((ViewerScroll.HorizontalOffset + ViewerScroll.ViewportWidth) / zoom - fit.X) * geometry.CropWidth / fit.W);
        var bottom = Math.Min(geometry.CropHeight, ((ViewerScroll.VerticalOffset + ViewerScroll.ViewportHeight) / zoom - fit.Y) * geometry.CropHeight / fit.H);
        if (right <= x || bottom <= y) return;
        var margin = Math.Min(512, Math.Max(right - x, bottom - y) * .125);
        var published = ExpandRegion(x, y, right, bottom, margin, geometry);
        var decode = ExpandRegion(published.X, published.Y, published.X + published.Width,
            published.Y + published.Height, 96, geometry);
        ZoomReadout.Text = $"{percent} · refining…";
        var version = Volatile.Read(ref _detailVersion);
        _detailWork = RefineDetailAsync(_detailWork, photo, model, anchor, published, decode, geometry, version, percent, cancellation);
    }

    private static NativeDetailRegion ExpandRegion(double x, double y, double right, double bottom,
        double margin, MapleRawGeometry geometry)
    {
        var left = (uint)Math.Max(0, Math.Floor(x - margin));
        var top = (uint)Math.Max(0, Math.Floor(y - margin));
        var r = (uint)Math.Min(geometry.CropWidth, Math.Ceiling(right + margin));
        var b = (uint)Math.Min(geometry.CropHeight, Math.Ceiling(bottom + margin));
        return new(left, top, r - left, b - top);
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
                    new MapleChainWindow { X = decode.X, Y = decode.Y, FullWidth = geometry.CropWidth, FullHeight = geometry.CropHeight });
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
            if (!_closing && version == Volatile.Read(ref _detailVersion)) ZoomReadout.Text = $"{percent} · preview: {error.Message}";
        }
    }
}
