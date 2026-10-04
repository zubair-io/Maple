using System;
using System.Threading.Tasks;
using Maple.WinUI.Models;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyCropHistoryAspectAsync()
    {
        async Task ReadyAsync()
        {
            var deadline = DateTime.UtcNow.AddSeconds(30);
            while (!ViewModel.AdjustmentsReady || ViewModel.IsDecoding)
            {
                if (DateTime.UtcNow >= deadline) throw new TimeoutException("Crop history did not settle.");
                await Task.Delay(25);
            }
        }
        SetMode(ShellMode.Edit);
        ViewModel.ResetToDefaults();
        await ReadyAsync();
        EnterCropMode();
        var before = ViewModel.Adjustments.Crop;
        CropToolbar.SelectedAspectId = "9:16";
        OnCropAspectSelected();
        var selected = ViewModel.Adjustments.Crop;
        if (selected.RectIsIdentity || CropOverlay.AspectRatio != 9.0 / 16)
            throw new InvalidOperationException("Portrait Crop selection did not change geometry and constraint.");
        ViewModel.Undo();
        await ReadyAsync();
        if (ViewModel.Adjustments.Crop != before || CropToolbar.SelectedAspectId != "free"
            || CropOverlay.AspectRatio != null)
            throw new InvalidOperationException("Crop Undo retained the stale portrait aspect constraint.");
        ViewModel.Redo();
        await ReadyAsync();
        if (ViewModel.Adjustments.Crop != selected || CropToolbar.SelectedAspectId != "free"
            || CropOverlay.AspectRatio != null)
            throw new InvalidOperationException("Crop Redo lost geometry or reintroduced a transient constraint.");
        ViewModel.Undo();
        await ReadyAsync();
        ExitCropMode();
    }
}
