using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>Focusable crop surface without a button's click semantics.</summary>
    internal sealed class MuiCropTarget : ContentControl
    {
        internal Border Frame { get; } = new();

        internal MuiCropTarget(string name)
        {
            Content = Frame;
            IsTabStop = true;
            UseSystemFocusVisuals = true;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;
            AutomationProperties.SetName(this, name);
            AutomationProperties.SetHelpText(this,
                "Use arrow keys to adjust the crop. Hold Shift for larger steps.");
        }

        protected override AutomationPeer OnCreateAutomationPeer() => new CropTargetPeer(this);

        private sealed class CropTargetPeer(MuiCropTarget owner) : FrameworkElementAutomationPeer(owner)
        {
            protected override string GetClassNameCore() => nameof(MuiCropTarget);
            protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.Thumb;
            protected override bool IsKeyboardFocusableCore() => owner.IsEnabled && owner.IsTabStop;
            protected override bool HasKeyboardFocusCore() => owner.FocusState != FocusState.Unfocused;
            protected override void SetFocusCore() => owner.Focus(FocusState.Programmatic);
        }
    }
}
