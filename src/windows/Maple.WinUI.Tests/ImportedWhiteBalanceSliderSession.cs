using Maple.WinUI.Models;

namespace Maple.WinUI.ViewModels;

// The production slider is linked directly. Its WinUI session is replaced only
// by this notification recorder; imports and sidecars use their real code.
public sealed class EditSessionViewModel
{
    public AdjustmentState Adjustments { get; set; } = new();
    public int Commits { get; private set; }
    public AdjustmentState DefaultAdjustments() => new();
    public void NotifyAdjustmentEdited() => Commits++;
    public void ApplyDecodeFieldEdit(Action<AdjustmentState> edit)
    {
        edit(Adjustments);
        Commits++;
    }
    public static void OnUi(Action callback) => callback();
}
