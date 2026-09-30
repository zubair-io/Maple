using System;
using System.Linq;
using Maple.UI;
using Maple.WinUI.Models;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private void VerifyMaskSelection()
    {
        var layers = ViewModel.Adjustments.LocalAdjustments;
        var original = layers.ToArray();
        var originalSelection = _selectedMaskIndex;
        var depth = ViewModel.UndoCount;
        try
        {
            layers.Clear();
            layers.Add(new LocalAdjustment(new LinearMask(new(.3, .5), new(.7, .5), .5),
                new PartialAdjustments { Exposure = .25 }));
            layers.Add(new LocalAdjustment(new RadialMask(new(.5, .5), new(.2, .2), 0, .7, true),
                new PartialAdjustments { Exposure = -.5 }));
            _selectedMaskIndex = -1;
            SyncMaskFromModel();
            if (_activeGroup == "Mask") CloseGroupPanel();
            ToggleGroupPanel("Mask");
            if (!MaskPanel.Layers[0].Selected || MaskPanel.Layers[1].Selected ||
                MaskPanel.Adjustments.Exposure != .25 || MaskOverlay.Shape is not MuiLinearMaskShape)
                throw new InvalidOperationException("Opening Mask did not select and expose the existing first layer.");
            SelectMaskLayer(1);
            if (MaskPanel.Layers[0].Selected || !MaskPanel.Layers[1].Selected ||
                MaskPanel.Adjustments.Exposure != -.5 || !MaskPanel.Invert ||
                MaskOverlay.Shape is not MuiRadialMaskShape)
                throw new InvalidOperationException("Selecting a radial layer left panel and overlay selection out of sync.");
            SelectMaskLayer(0);
            if (!MaskPanel.Layers[0].Selected || MaskPanel.Layers[1].Selected ||
                MaskPanel.Invert || MaskPanel.Adjustments.Exposure != .25 || ViewModel.UndoCount != depth)
                throw new InvalidOperationException("Switching mask selection changed history or retained radial state.");
        }
        finally
        {
            CloseGroupPanel();
            layers.Clear();
            layers.AddRange(original);
            _selectedMaskIndex = originalSelection;
            SyncMaskFromModel();
        }
    }
}
