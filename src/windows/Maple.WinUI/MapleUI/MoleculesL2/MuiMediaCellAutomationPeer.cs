using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;

namespace Maple.UI;

internal sealed class MuiMediaCellAutomationPeer : FrameworkElementAutomationPeer, IInvokeProvider
{
    private MuiMediaCell Cell => (MuiMediaCell)Owner;

    public MuiMediaCellAutomationPeer(MuiMediaCell owner) : base(owner) { }

    protected override string GetClassNameCore() => nameof(MuiMediaCell);
    protected override AutomationControlType GetAutomationControlTypeCore() =>
        Cell.HasPressAction ? AutomationControlType.Button : AutomationControlType.Group;
    protected override string GetItemStatusCore() => Cell.Selected ? "Selected" : string.Empty;
    protected override object GetPatternCore(PatternInterface patternInterface) =>
        patternInterface == PatternInterface.Invoke && Cell.HasPressAction ? this : base.GetPatternCore(patternInterface);

    public void Invoke() => Cell.InvokeAction();
}
