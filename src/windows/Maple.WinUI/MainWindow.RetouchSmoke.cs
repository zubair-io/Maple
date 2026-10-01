using System;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyRetouchUndoAsync(string output)
    {
        var before = ViewModel.Adjustments.Retouch;
        var depth = ViewModel.UndoCount;
        RecordSmokeStage(output, "retouch-open-panel");
        ToggleGroupPanel("Heal");
        await ReadyAsync();
        await WaitAsync(() => RepairMap != null && _repairCanvas.Visibility == Microsoft.UI.Xaml.Visibility.Visible);
        RecordSmokeStage(output, "retouch-transforms");
        await VerifyRepairTransformsAsync();
        RecordSmokeStage(output, "retouch-add-spot");
        var invoke = (IInvokeProvider)new ButtonAutomationPeer(_repairAdd).GetPattern(PatternInterface.Invoke);
        invoke.Invoke();
        if (ViewModel.Renderer.DetailSource == null)
            throw new InvalidOperationException("Repair decode cleared the base needed for ordinary slider rendering");
        await WaitAsync(() => ViewModel.Adjustments.Retouch.Spots.Count == before.Spots.Count + 1);
        await ReadyAsync();
        if (ViewModel.UndoCount != depth + 1) throw new InvalidOperationException("Repair placement was not one undo entry");
        if (_repairCanvas.Children.Count < 3) throw new InvalidOperationException("Repair source, destination and connector were not drawn");
        RecordSmokeStage(output, "retouch-change-kind");
        _repairKind.SelectedItem = "Clone";
        await ReadyAsync();
        if (SelectedRepair?.Kind != RetouchKind.Clone || ViewModel.UndoCount != depth + 2)
            throw new InvalidOperationException("Repair type control did not commit one edit");
        var repairItems = _repairList.ItemsSource;
        _repairList.SelectedIndex = -1;
        _repairList.SelectedIndex = before.Spots.Count;
        if (!ReferenceEquals(repairItems, _repairList.ItemsSource) || SelectedRepair?.Kind != RetouchKind.Clone)
            throw new InvalidOperationException("Repair selection rebuilt its own list or lost the selected spot");
        RecordSmokeStage(output, "retouch-change-radius");
        _repairValues[0].Value = 4;
        await ReadyAsync();
        if (SelectedRepair?.Radius != .04 || ViewModel.UndoCount != depth + 3)
            throw new InvalidOperationException("Repair size control did not commit one edit");
        if (!ReferenceEquals(repairItems, _repairList.ItemsSource))
            throw new InvalidOperationException("Repair size edit unnecessarily rebuilt the spot list");
        RecordSmokeStage(output, "retouch-undo-redo-radius");
        ViewModel.Undo();
        await ReadyAsync();
        if (SelectedRepair?.Radius != .02) throw new InvalidOperationException("Repair size Undo failed");
        ViewModel.Redo();
        await ReadyAsync();
        if (SelectedRepair?.Radius != .04) throw new InvalidOperationException("Repair size Redo failed");
        RecordSmokeStage(output, "retouch-delete-spot");
        var delete = (IInvokeProvider)new ButtonAutomationPeer(_repairDelete).GetPattern(PatternInterface.Invoke);
        delete.Invoke();
        await WaitAsync(() => ViewModel.Adjustments.Retouch.Spots.Count == before.Spots.Count);
        await ReadyAsync();
        if (ViewModel.UndoCount != depth + 4) throw new InvalidOperationException("Repair delete was not one edit");
        RecordSmokeStage(output, "retouch-restore-history");
        for (var i = 0; i < 4; i++) { ViewModel.Undo(); await ReadyAsync(); }
        if (ViewModel.Adjustments.Retouch.Xml != before.Xml || ViewModel.UndoCount != depth)
            throw new InvalidOperationException("Repair controls did not restore the opening state");
        CloseGroupPanel();

        Task ReadyAsync() => WaitAsync(() => CanEditRepairs && !ViewModel.IsDecoding);
        static async Task WaitAsync(Func<bool> predicate)
        {
            var until = DateTime.UtcNow.AddSeconds(30);
            while (!predicate())
            {
                if (DateTime.UtcNow >= until) throw new TimeoutException("Repair diagnostic did not reach the expected state");
                await Task.Delay(25);
            }
        }
    }
}
