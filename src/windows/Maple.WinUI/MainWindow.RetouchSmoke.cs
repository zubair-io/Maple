using System;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyRetouchUndoAsync()
    {
        var before = ViewModel.Adjustments.Retouch;
        var depth = ViewModel.UndoCount;
        ToggleGroupPanel("Heal");
        await ReadyAsync();
        var invoke = (IInvokeProvider)new ButtonAutomationPeer(_repairAdd).GetPattern(PatternInterface.Invoke);
        invoke.Invoke();
        await WaitAsync(() => ViewModel.Adjustments.Retouch.Spots.Count == before.Spots.Count + 1);
        await ReadyAsync();
        if (ViewModel.UndoCount != depth + 1) throw new InvalidOperationException("Repair placement was not one undo entry");
        _repairKind.SelectedItem = "Clone";
        await ReadyAsync();
        if (SelectedRepair?.Kind != RetouchKind.Clone || ViewModel.UndoCount != depth + 2)
            throw new InvalidOperationException("Repair type control did not commit one edit");
        _repairValues[0].Value = 4;
        await ReadyAsync();
        if (SelectedRepair?.Radius != .04 || ViewModel.UndoCount != depth + 3)
            throw new InvalidOperationException("Repair size control did not commit one edit");
        ViewModel.Undo();
        await ReadyAsync();
        if (SelectedRepair?.Radius != .02) throw new InvalidOperationException("Repair size Undo failed");
        ViewModel.Redo();
        await ReadyAsync();
        if (SelectedRepair?.Radius != .04) throw new InvalidOperationException("Repair size Redo failed");
        var delete = (IInvokeProvider)new ButtonAutomationPeer(_repairDelete).GetPattern(PatternInterface.Invoke);
        delete.Invoke();
        await WaitAsync(() => ViewModel.Adjustments.Retouch.Spots.Count == before.Spots.Count);
        await ReadyAsync();
        if (ViewModel.UndoCount != depth + 4) throw new InvalidOperationException("Repair delete was not one edit");
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
