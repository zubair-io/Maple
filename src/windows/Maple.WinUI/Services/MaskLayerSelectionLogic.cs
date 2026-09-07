// MaskLayerSelectionLogic — pure selection-index arithmetic for deleting a
// mask layer (MainWindow.Mask.cs's DeleteMaskLayer, #3435 review).
// WinUI-free (no Microsoft.UI.Xaml dependency) so it is directly
// unit-testable, the same split DragMoveLogic.cs/RenameLogic.cs keep from
// their MainWindow.*.cs UI partials.
//
// The bug this fixes: deleting a row unconditionally clamped the selection
// to Math.Min(deletedIndex, newCount - 1), which silently moved the active
// selection to a DIFFERENT layer whenever the deleted row wasn't the
// selected one (e.g. deleting layer 0 while layer 2 was selected jumped
// the selection to whatever layer ended up at index 0, instead of
// following layer 2 to its new index 1).

namespace Maple.WinUI.Services
{
    public static class MaskLayerSelectionLogic
    {
        /// <summary>
        /// The selection index to carry forward after deleting the layer at
        /// <paramref name="deletedIndex"/> from a stack whose selection was
        /// <paramref name="selectedIndex"/> (-1 = none) and whose length
        /// AFTER the delete is <paramref name="newCount"/>.
        ///
        /// - No layer was selected: stays unselected.
        /// - A layer BEFORE the selection is removed: the selected layer's
        ///   identity is preserved, so its index decrements by one.
        /// - The SELECTED layer itself is removed: the nearest remaining
        ///   layer takes over — the previous one if there is one, else the
        ///   layer that shifted into its old slot, else none (the stack is
        ///   now empty).
        /// - A layer AFTER the selection is removed: the selection index is
        ///   untouched (nothing before it moved).
        /// </summary>
        public static int AfterDelete(int selectedIndex, int deletedIndex, int newCount)
        {
            if (selectedIndex < 0)
                return -1;
            if (deletedIndex < selectedIndex)
                return selectedIndex - 1;
            if (deletedIndex > selectedIndex)
                return selectedIndex;
            // deletedIndex == selectedIndex: the active layer itself was removed.
            if (deletedIndex > 0)
                return deletedIndex - 1;             // previous
            return newCount > 0 ? 0 : -1;             // next (shifted into slot 0), else none
        }
    }
}
