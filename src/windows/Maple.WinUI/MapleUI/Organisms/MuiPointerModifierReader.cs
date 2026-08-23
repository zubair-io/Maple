using Microsoft.UI.Input;
using Windows.System;

namespace Maple.UI
{
    /// <summary>Shared live-keyboard-state reader behind
    /// <see cref="MuiCollectionGrid"/>'s and <see cref="MuiListView"/>'s
    /// click/Ctrl-click/Shift-click selection — the same
    /// <c>InputKeyboardSource.GetKeyStateForCurrentThread</c> approach
    /// MainWindow.xaml.cs's OnRootKeyDown already uses for the culling
    /// shortcuts, factored out so both organisms share one implementation
    /// instead of duplicating it. Reads live OS state, so (unlike
    /// <see cref="MuiCollectionGridSelection"/>) this isn't unit-testable
    /// without a live Window — the logic worth testing is the selection
    /// math itself, which takes the resulting <see cref="MuiSelectionModifier"/>
    /// as a plain argument.</summary>
    public static class MuiPointerModifierReader
    {
        public static MuiSelectionModifier CurrentModifier()
        {
            var ctrl = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Control)
                .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
            var shift = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift)
                .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
            if (shift) return MuiSelectionModifier.Range;
            if (ctrl) return MuiSelectionModifier.Toggle;
            return MuiSelectionModifier.None;
        }
    }
}
