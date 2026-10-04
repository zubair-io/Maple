using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;

namespace Maple.UI;

internal sealed class MuiListRowAutomationPeer : FrameworkElementAutomationPeer, IInvokeProvider
{
    private MuiListRow Row => (MuiListRow)Owner;

    public MuiListRowAutomationPeer(MuiListRow owner) : base(owner) { }

    protected override string GetClassNameCore() => nameof(MuiListRow);
    protected override AutomationControlType GetAutomationControlTypeCore() =>
        Row.HasPressAction ? AutomationControlType.Button : AutomationControlType.Group;
    protected override string GetItemStatusCore() => Row.Active ? "Current" : string.Empty;
    protected override bool IsKeyboardFocusableCore() => Row.IsEnabled && Row.IsTabStop;
    protected override bool HasKeyboardFocusCore() => Row.FocusState != FocusState.Unfocused;
    protected override void SetFocusCore() => Row.Focus(FocusState.Keyboard);
    protected override object GetPatternCore(PatternInterface patternInterface) =>
        patternInterface == PatternInterface.Invoke && Row.HasPressAction ? this : base.GetPatternCore(patternInterface);

    public void Invoke()
    {
        Row.InvokeFromAutomation();
        RaiseAutomationEvent(AutomationEvents.InvokePatternOnInvoked);
    }

    internal void NotifyActiveChanged(bool oldValue, bool newValue) =>
        RaisePropertyChangedEvent(AutomationElementIdentifiers.ItemStatusProperty,
            oldValue ? "Current" : string.Empty, newValue ? "Current" : string.Empty);
}
