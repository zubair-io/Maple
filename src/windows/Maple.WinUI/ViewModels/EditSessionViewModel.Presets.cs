using System;
using Maple.WinUI.Models;
using Maple.WinUI.Services;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    public SparseAdjustmentResult ApplyPreset(PresetDocument preset, bool reset = false)
    {
        if (!AdjustmentsReady || SelectedPhoto == null) throw new InvalidOperationException("Wait for the photo's adjustments to load.");
        preset.Validate();
        var fields = reset ? AdjustmentFieldBridge.DefaultsFor(preset.Fields.Keys) : preset.Fields;
        var result = AdjustmentFieldBridge.Apply(Adjustments, fields);
        if (result.Applied.Length != 0)
            ApplyDecodeFieldEdit(model => AdjustmentFieldBridge.CommitTo(model, result));
        return result;
    }
}
