using System;
using System.Threading.Tasks;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyAdjustmentGestureUndoAsync()
    {
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
    }
}
