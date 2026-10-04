using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media.Imaging;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    // #4161: actual OS input and captured UI are required before acknowledging.
    private async Task VerifyNativeDetailCheckpointAsync(string raw, string output, bool tileFallback)
    {
        var frame = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Gpu(DecodedImage image, int width, int height, double ms, bool full) => frame.TrySetResult(true);
        void Cpu(DecodedImage image, byte[] pixels, int width, int height, uint[] bins, double ms) => frame.TrySetResult(true);
        ViewModel.Renderer.GpuFrameReady += Gpu;
        ViewModel.Renderer.FrameReady += Cpu;
        var photo = new PhotoItem { FilePath = raw, FileName = Path.GetFileName(raw), Format = "DNG" };
        try
        {
            ViewModel.AllPhotos.Add(photo);
            ViewModel.ApplyFilters();
            ViewModel.SelectedPhoto = photo;
            OnEnterEdit(this, new RoutedEventArgs());
            await frame.Task.WaitAsync(TimeSpan.FromSeconds(90));
        }
        finally
        {
            ViewModel.Renderer.GpuFrameReady -= Gpu;
            ViewModel.Renderer.FrameReady -= Cpu;
        }
        EnsureSourceGeometry();
        await _geometryWork;
        if (_nativeGeometry is not { } geometry || !ReferenceEquals(photo, _nativeGeometryPhoto))
            throw new InvalidOperationException("Native checkpoint requires current readable source geometry.");
        var document = ViewModel.Adjustments.Clone();
        var ready = Path.Combine(output, "native-detail.ready");
        await File.WriteAllTextAsync(ready, JsonSerializer.Serialize(new
            { sourceWidth = geometry.CropWidth, sourceHeight = geometry.CropHeight, scale = DisplayScale,
                tileFallback, action = "Capture Fit, press Ctrl+1, capture settled native or fallback state, then acknowledge" }));
        var deadline = DateTime.UtcNow.AddMinutes(5);
        while (!File.Exists(ready + ".continue") && DateTime.UtcNow < deadline) await Task.Delay(100);
        if (!File.Exists(ready + ".continue")) throw new TimeoutException("Native Actual Size checkpoint not acknowledged.");
        await _detailWork;
        if (!ReferenceEquals(photo, ViewModel.SelectedPhoto) || ContentFitRect() is not { } fit)
            throw new InvalidOperationException("Native checkpoint lost current source ownership or layout.");
        var physicalScale = fit.W * ViewerScroll.ZoomFactor * DisplayScale / geometry.CropWidth;
        if (Math.Abs(physicalScale - 1) > .002 || !ZoomReadout.Text.StartsWith("100%"))
            throw new InvalidOperationException($"Actual Size physical scale is incorrect: {physicalScale}, {ZoomReadout.Text}");
        if (tileFallback)
        {
            if (NativeDetailOverlay.Visibility == Visibility.Visible
                || ZoomReadout.Text != "100% · preview · native detail unavailable"
                || _nativeDetailError?.Contains("Native detail unavailable (10)", StringComparison.Ordinal) != true)
                throw new InvalidOperationException($"Unsupported tile did not present explicit fallback: {ZoomReadout.Text}");
        }
        else if (NativeDetailOverlay.Visibility != Visibility.Visible
            || NativeDetailOverlay.Source is not WriteableBitmap || !ZoomReadout.Text.EndsWith("native detail"))
            throw new InvalidOperationException($"Supported source did not present native detail: {ZoomReadout.Text}");
        if (!tileFallback && (!double.IsFinite(NativeDetailOverlay.ActualWidth)
            || !double.IsFinite(NativeDetailOverlay.ActualHeight)
            || NativeDetailOverlay.ActualWidth <= 0 || NativeDetailOverlay.ActualHeight <= 0))
            throw new InvalidOperationException("Visible native overlay has no finite rendered dimensions.");
        var before = Services.Xmp.XmpWriter.Serialize(new Services.Xmp.XmpSidecarDocument { Adjustments = document });
        var after = Services.Xmp.XmpWriter.Serialize(new Services.Xmp.XmpSidecarDocument { Adjustments = ViewModel.Adjustments });
        if (before != after) throw new InvalidOperationException("Actual Size changed the adjustment document.");
        await File.WriteAllTextAsync(Path.Combine(output, "native-detail-result.json"), JsonSerializer.Serialize(new
            { passed = true, tileFallback, physicalScale, scale = DisplayScale, status = ZoomReadout.Text,
                nativeDetailError = _nativeDetailError,
                sourceWidth = geometry.CropWidth, sourceHeight = geometry.CropHeight,
                overlayWidth = tileFallback ? (double?)null : NativeDetailOverlay.ActualWidth,
                overlayHeight = tileFallback ? (double?)null : NativeDetailOverlay.ActualHeight,
                documentUnchanged = true }));
    }
}
