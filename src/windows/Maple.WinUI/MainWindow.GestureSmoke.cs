using System;
using System.Threading.Tasks;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifySliderGestureUndoAsync(Maple.UI.Atoms.MuiAdjustmentSlider slider)
    {
        ViewModel.ResetToDefaults();
        var original = slider.Value;
        var originalStatus = EditStatusText.Text;
        if (originalStatus.Contains("Edited") || BrowseEditedStatus.Text.Length != 0)
            throw new InvalidOperationException("Reset left the editor marked as edited.");
        var depth = ViewModel.UndoCount;
        OnSliderGestureStarted(slider, EventArgs.Empty);
        slider.Value = original + .05;
        await Task.Delay(650);
        slider.Value = original + .25;
        await Task.Delay(650);
        if (ViewModel.UndoCount != depth || ViewModel.Adjustments.Exposure != original + .25)
            throw new InvalidOperationException("Bound Exposure slider split a paused edit or failed to update the model.");
        OnSliderGestureCompleted(slider, EventArgs.Empty);
        if (BrowseEditedStatus.Text != " · Edited")
            throw new InvalidOperationException("Browse detail did not reflect the completed adjustment.");
        if (ViewModel.UndoCount != depth + 1)
            throw new InvalidOperationException("Bound slider release did not commit one edit.");
        ViewModel.Undo();
        OnSliderGestureStarted(slider, EventArgs.Empty);
        slider.Value = original + .05;
        slider.Value = original;
        OnSliderGestureCompleted(slider, EventArgs.Empty);
        if (EditStatusText.Text != originalStatus || BrowseEditedStatus.Text.Length != 0 || ViewModel.UndoCount != depth)
            throw new InvalidOperationException("Returning a slider to its original value left stale edit status or history.");
        Content.UpdateLayout();
        if (ViewModel.Adjustments.Exposure != original || slider.Value != original)
            throw new InvalidOperationException("Slider Undo did not restore both model and visible control.");
        ViewModel.Redo();
        Content.UpdateLayout();
        if (ViewModel.Adjustments.Exposure != original + .25 || slider.Value != original + .25)
            throw new InvalidOperationException("Slider Redo did not restore the final value.");
        ViewModel.Undo();
        ViewModel.Undo();
    }

    private async Task VerifyAdjustmentGestureUndoAsync()
    {
        await VerifyHistoryBranchingAsync();
        var original = ViewModel.Adjustments.Exposure;
        var depth = ViewModel.UndoCount;
        var ruler = new object();
        ViewModel.BeginAdjustmentGesture(ruler);
        ViewModel.Adjustments.Exposure = original + .05;
        ViewModel.NotifyAdjustmentEdited();
        await Task.Delay(650);
        if (ViewModel.UndoCount != depth)
            throw new InvalidOperationException("Pause inside a ruler drag committed an intermediate undo entry.");
        ViewModel.Adjustments.Exposure = original + .25;
        ViewModel.NotifyAdjustmentEdited();
        await Task.Delay(650);
        ViewModel.EndAdjustmentGesture(new object());
        if (ViewModel.UndoCount != depth)
            throw new InvalidOperationException("Unrelated gesture completion closed the active drag.");
        ViewModel.EndAdjustmentGesture(ruler);
        ViewModel.EndAdjustmentGesture(ruler);
        if (ViewModel.UndoCount != depth + 1)
            throw new InvalidOperationException("Ruler drag did not produce exactly one undo entry.");
        ViewModel.Undo();
        if (ViewModel.Adjustments.Exposure != original || ViewModel.UndoCount != depth)
            throw new InvalidOperationException("Ruler Undo restored an intermediate value.");
        ViewModel.Redo();
        if (ViewModel.Adjustments.Exposure != original + .25)
            throw new InvalidOperationException("Ruler Redo lost the final value.");
        ViewModel.BeginAdjustmentGesture(ruler);
        ViewModel.EndAdjustmentGesture(ruler);
        if (ViewModel.UndoCount != depth + 1)
            throw new InvalidOperationException("Unchanged ruler gesture added an undo entry.");
        ViewModel.Undo();
        await Task.Delay(650);
        if (ViewModel.Adjustments.Exposure != original || ViewModel.UndoCount != depth)
            throw new InvalidOperationException("A stale gesture timer modified restored history.");
        await ViewModel.RetryLocalSaveAsync();
        RefreshSaveTime();
        for (var attempt = 0; attempt < 100 && _saveTimeRequest != null; attempt++)
            await Task.Delay(20);
        if (!BrowseSavedStatus.Text.StartsWith(" · Saved", StringComparison.Ordinal))
            throw new InvalidOperationException("Browse did not show the acknowledged sidecar save time.");
    }
}
