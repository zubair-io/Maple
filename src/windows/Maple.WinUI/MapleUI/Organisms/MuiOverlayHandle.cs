using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Maple.UI
{
    /// <summary>Focusable canvas handle without a button's click semantics.</summary>
    internal sealed class MuiOverlayHandle : ContentControl
    {
        internal Border Frame { get; } = new();

        internal MuiOverlayHandle(string name, string helpText)
        {
            var hitArea = new Grid { Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };
            hitArea.Children.Add(Frame);
            Content = hitArea;
            IsTabStop = true;
            UseSystemFocusVisuals = true;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;
            AutomationProperties.SetName(this, name);
            AutomationProperties.SetHelpText(this,
                helpText);
        }

        protected override AutomationPeer OnCreateAutomationPeer() => new OverlayHandlePeer(this);

        private sealed class OverlayHandlePeer(MuiOverlayHandle owner) : FrameworkElementAutomationPeer(owner)
        {
            protected override string GetClassNameCore() => nameof(MuiOverlayHandle);
            protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.Thumb;
            protected override bool IsKeyboardFocusableCore() => owner.IsEnabled && owner.IsTabStop;
            protected override bool HasKeyboardFocusCore() => owner.FocusState != FocusState.Unfocused;
            protected override void SetFocusCore() => owner.Focus(FocusState.Programmatic);
        }
    }
}
