using System;
using System.Threading.Tasks;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyHistoryBranchingAsync()
    {
        var original = Snapshot();
        var exposure = ViewModel.Adjustments.Exposure;
        var depth = ViewModel.UndoCount;
        foreach (var reset in new Action[] { ViewModel.ResetToDefaults, ViewModel.RevertToOriginal })
        {
            CreateRedoBranch();
            reset();
            var replacement = Snapshot();
            ViewModel.Redo();
            if (Snapshot() != replacement || ViewModel.UndoCount != depth + 2)
                throw new InvalidOperationException("Redo restored a stale edit after Reset or Revert.");
            ViewModel.Undo();
            if (ViewModel.Adjustments.Exposure != exposure + .1)
                throw new InvalidOperationException("Reset or Revert Undo lost the preceding edit.");
            ViewModel.Undo();
            VerifyRestored();
        }

        CreateRedoBranch();
        ViewModel.Adjustments.Exposure = exposure + .15;
        ViewModel.NotifyAdjustmentEdited();
        var pending = Snapshot();
        ViewModel.Redo();
        await Task.Delay(650);
        if (Snapshot() != pending || ViewModel.UndoCount != depth + 2)
            throw new InvalidOperationException("Redo overwrote a pending edit or left a stale undo timer.");
        ViewModel.Undo();
        if (ViewModel.Adjustments.Exposure != exposure + .1)
            throw new InvalidOperationException("Pending edit did not become one undo boundary.");
        ViewModel.Undo();
        VerifyRestored();

        void CreateRedoBranch()
        {
            ViewModel.ApplyDecodeFieldEdit(model => model.Exposure = exposure + .1);
            ViewModel.ApplyDecodeFieldEdit(model => model.Exposure = exposure + .2);
            ViewModel.Undo();
        }
        string Snapshot() => XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = ViewModel.Adjustments });
        void VerifyRestored()
        {
            if (Snapshot() != original || ViewModel.UndoCount != depth)
                throw new InvalidOperationException("History branching check did not restore its starting document.");
        }
    }
}
