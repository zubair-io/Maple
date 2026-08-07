using System.Collections.Generic;

namespace Maple.WinUI.ViewModels
{
    /// <summary>
    /// Pure, WinUI-free selection-resolution logic for the library grid
    /// multi-select (#2634). Generic over the item type on purpose: PhotoItem
    /// lives in EditSessionViewModel.Library.cs, a file that also carries the
    /// WinUI-dependent bulk of EditSessionViewModel's library-loading partial
    /// (ThumbnailService, App.MainDispatcherQueue, ...), so it can't be
    /// linked into Maple.WinUI.Tests (net8.0, no WindowsAppSDK) without
    /// dragging that in too. Staying generic means this file has zero
    /// dependency on Maple.WinUI.ViewModels beyond the BCL, so it links
    /// whole via a single &lt;Compile Include&gt; and is tested with a plain
    /// `string` stand-in for the item type — see SelectionLogicTests.
    ///
    /// EditSessionViewModel.Selection.cs is the actual view-model surface
    /// (SelectedPhotos, SelectionSummary, SyncSelectedPhotos,
    /// ResolvePrimaryTarget) and is a thin PhotoItem-typed wrapper over this.
    /// </summary>
    public static class SelectionLogic
    {
        /// <summary>The item Enter/double-tap should open: the sole
        /// selection, else the first item of a larger selection (grid
        /// order), else the last well-defined single target (the grid was
        /// fully deselected but an item was open before that), else the
        /// first item in the current view.</summary>
        public static T? ResolvePrimaryTarget<T>(
            IReadOnlyList<T> selectedItems, T? lastSelectedItem, IReadOnlyList<T> allItems)
            where T : class =>
            selectedItems.Count > 0 ? selectedItems[0]
                : lastSelectedItem ?? (allItems.Count > 0 ? allItems[0] : null);

        /// <summary>Narrator-facing summary text: empty for 0 or 1 selected —
        /// a single selection/deselection is already announced per item by
        /// the grid's own SelectionItem automation peer — "N selected" for
        /// 2+, which is the case that peer never surfaces as a count.</summary>
        public static string SelectionSummary(int selectedCount) =>
            selectedCount > 1 ? $"{selectedCount} selected" : string.Empty;

        /// <summary>True when a selection change should become the
        /// well-defined single edit/preview target — exactly one item
        /// selected. False for 0 or 2+, so a marquee/Ctrl+A selection never
        /// tears down an in-progress edit session by reassigning it.</summary>
        public static bool ShouldBecomeSingleTarget(int selectedCount) => selectedCount == 1;
    }
}
