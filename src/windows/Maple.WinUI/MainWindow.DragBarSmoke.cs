using System;
using Maple.UI;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private static void VerifyDragBarAccessibility()
    {
        var bar = new MuiDragBar { Label = "Straighten", Minimum = -45, Maximum = 45, Step = .1 };
        var peer = FrameworkElementAutomationPeer.CreatePeerForElement(bar);
        if (peer?.GetAutomationControlType() != AutomationControlType.Slider || peer.GetName() != "Straighten" ||
            peer.GetPattern(PatternInterface.RangeValue) is not IRangeValueProvider range)
            throw new InvalidOperationException("Drag bar does not expose a named range slider");
        var changes = 0;
        var published = double.NaN;
        bar.ValueChanged += (_, value) => { changes++; published = value; };
        range.SetValue(1.5);
        if (bar.Value != 1.5 || range.Value != 1.5 || published != 1.5 || changes != 1 ||
            range.Minimum != -45 || range.Maximum != 45 || range.SmallChange != .1 || range.LargeChange != 1)
            throw new InvalidOperationException("Accessible drag-bar edit lost its value, bounds, step or notification");
        foreach (var invalid in new[] { double.NaN, double.PositiveInfinity, -46d, 46d })
        {
            try { range.SetValue(invalid); throw new InvalidOperationException("Invalid accessible value was accepted"); }
            catch (ArgumentOutOfRangeException) { }
        }
        bar.IsEnabled = false;
        if (!range.IsReadOnly) throw new InvalidOperationException("Disabled drag bar is exposed as writable");
        var rejected = false;
        try { range.SetValue(2); }
        catch (InvalidOperationException) { rejected = true; }
        if (!rejected || bar.Value != 1.5 || changes != 1)
            throw new InvalidOperationException("Disabled or invalid accessible edits changed the drag bar");
    }
}
