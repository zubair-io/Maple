using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Windows.Graphics;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyNativeWindowLayoutAsync(string output)
    {
        var originalSize = AppWindow.Size;
        var root = (FrameworkElement)Content;
        var photo = ViewModel.SelectedPhoto;
        var adjustments = ViewModel.Adjustments;
        var group = _activeGroup;
        var originalExposure = adjustments.Exposure;
        var originalDepth = ViewModel.UndoCount;
        var exposureSlider = FindDescendant<Maple.UI.Atoms.MuiAdjustmentSlider>(EditPanel)
            ?? throw new InvalidOperationException("Resize qualification requires the visible Exposure slider");
        OnSliderGestureStarted(exposureSlider, EventArgs.Empty);
        exposureSlider.Value = originalExposure + .25;
        OnSliderGestureCompleted(exposureSlider, EventArgs.Empty);
        var editedState = Services.Xmp.XmpWriter.Serialize(
            new Services.Xmp.XmpSidecarDocument { Adjustments = adjustments });
        try
        {
            // A free scale holds its pixel scale across resizes (#5714).
            await _geometryWork;
            SyncCanvasZoom(refreshDetail: false);
            _canvasZoom.ResetToFit();
            for (var step = 0; step < 3; step++) _canvasZoom.StepIn();
            ApplyCanvasZoom();
            var zoomedScale = _canvasZoom.State.pixel_scale;
            if (_canvasZoom.CurrentStop != Native.RawFfi.MAPLE_CANVAS_ZOOM_STOP_NONE || ViewModel.UndoCount != originalDepth + 1 ||
                ViewModel.Adjustments.Exposure != exposureSlider.Value || exposureSlider.Value != originalExposure + .25)
                throw new InvalidOperationException("Resize qualification could not establish edited, zoomed state");
            foreach (var size in new[] { new SizeInt32(1440, 960), new SizeInt32(1024, 768) })
            {
                AppWindow.Resize(size);
                var deadline = Environment.TickCount64 + 5000;
                do
                {
                    await Task.Delay(100);
                    root.UpdateLayout();
                } while ((AppWindow.Size.Width != size.Width || AppWindow.Size.Height != size.Height) &&
                    Environment.TickCount64 < deadline);
                // Native size notifications and XAML measure run on separate dispatcher turns.
                await Task.Delay(200);
                root.UpdateLayout();
                await File.AppendAllTextAsync(Path.Combine(output, "native-window-layout.jsonl"),
                    JsonSerializer.Serialize(new
                    {
                        requestedWidth = size.Width, requestedHeight = size.Height,
                        actualWidth = AppWindow.Size.Width, actualHeight = AppWindow.Size.Height,
                        logicalWidth = root.ActualWidth, logicalHeight = root.ActualHeight,
                        rasterizationScale = root.XamlRoot.RasterizationScale
                    }) + Environment.NewLine);
                if (AppWindow.Size.Width != size.Width || AppWindow.Size.Height != size.Height)
                    throw new InvalidOperationException("Native window did not reach the requested qualification size");
                VerifyEditorHeaderBounds();
                await VerifyEditorPanelScrollingAsync();
                if (!ReferenceEquals(photo, ViewModel.SelectedPhoto) || !ReferenceEquals(adjustments, ViewModel.Adjustments) ||
                    group != _activeGroup || EditPanel.Visibility != Visibility.Visible)
                    throw new InvalidOperationException("Native resize changed the selected document or active tool");
                if (ViewModel.UndoCount != originalDepth + 1 || _canvasZoom.State.pixel_scale != zoomedScale ||
                    !TransformHolds(ZoomPanTransform.ScaleX, _canvasZoom.View.ScaleToFit) ||
                    editedState != Services.Xmp.XmpWriter.Serialize(
                        new Services.Xmp.XmpSidecarDocument { Adjustments = ViewModel.Adjustments }))
                    throw new InvalidOperationException("Native resize changed edits, undo history or zoom");
                await WaitForNativeVisualCheckpointAsync(output, size);
            }
            ViewModel.Undo();
            if (ViewModel.Adjustments.Exposure != originalExposure || ViewModel.UndoCount != originalDepth)
                throw new InvalidOperationException("Undo after native resize failed to restore the edit");
            ViewModel.Redo();
            if (editedState != Services.Xmp.XmpWriter.Serialize(
                new Services.Xmp.XmpSidecarDocument { Adjustments = ViewModel.Adjustments }))
                throw new InvalidOperationException("Redo after native resize failed to restore the edit");
            ViewModel.Undo();
        }
        finally
        {
            AppWindow.Resize(originalSize);
            await Task.Delay(200);
            root.UpdateLayout();
            ResetZoom();
        }
    }

    private static async Task WaitForNativeVisualCheckpointAsync(string output, SizeInt32 size)
    {
        if (Array.IndexOf(Environment.GetCommandLineArgs(), "--visual-checkpoints") < 0) return;
        // The explicit interactive harness holds the real HWND at each measured
        // size for an external screenshot. A missing acknowledgement fails;
        // holding a window alone never counts as visual qualification.
        var checkpoint = Path.Combine(output, $"visual-{size.Width}x{size.Height}");
        if (File.Exists(checkpoint + ".continue"))
            throw new InvalidOperationException("Visual qualification requires a fresh output directory");
        await File.WriteAllTextAsync(checkpoint + ".ready", DateTimeOffset.UtcNow.ToString("O"));
        var deadline = Environment.TickCount64 + 180000;
        while (!File.Exists(checkpoint + ".continue"))
        {
            if (Environment.TickCount64 >= deadline)
                throw new TimeoutException($"Visual checkpoint not acknowledged: {checkpoint}");
            await Task.Delay(100);
        }
    }
}
