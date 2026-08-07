using System;
using System.Collections.Generic;
using CommunityToolkit.Mvvm.ComponentModel;

namespace Maple.WinUI.ViewModels
{
    /// <summary>
    /// Multi-selection state for the library grid (#2634). SelectedPhoto (the
    /// [ObservableProperty] in EditSessionViewModel.cs) stays the single
    /// well-defined edit/preview target — the only thing OpenForEditing,
    /// decode, and the sidecar-write path ever look at. SelectedPhotos below
    /// is the grid's full multi-selection; it never drives those per-photo
    /// session operations on its own. This is a thin PhotoItem-typed wrapper
    /// over the WinUI-free SelectionLogic (SelectionLogic.cs), which carries
    /// the actual resolution rules and is what's unit-tested in
    /// Maple.WinUI.Tests (#2672).
    /// </summary>
    public partial class EditSessionViewModel
    {
        /// <summary>The grid's current multi-selection, in GridView.SelectedItems
        /// order. Reassigned wholesale on every SelectionChanged via
        /// SyncSelectedPhotos — a single list swap raises one PropertyChanged
        /// regardless of selection size, unlike clearing and re-adding into
        /// an ObservableCollection, which would fire one CollectionChanged
        /// per item (thousands of them on a Ctrl+A over a large library).</summary>
        [ObservableProperty]
        private IReadOnlyList<PhotoItem> _selectedPhotos = Array.Empty<PhotoItem>();

        /// <summary>Narrator-facing summary shown next to the library count.
        /// Empty for 0 or 1 selected: GridView's own SelectionItem automation
        /// peer already announces a single selection change per item, so this
        /// only speaks up for the multi-select case this ticket adds.</summary>
        public string SelectionSummary => SelectionLogic.SelectionSummary(SelectedPhotos.Count);

        /// <summary>Called by the grid's SelectionChanged handler. Replaces the
        /// tracked multi-selection and resolves SelectedPhoto: a single
        /// selected item becomes the well-defined edit/preview target; 0 or
        /// 2+ items leave SelectedPhoto untouched so a marquee/Ctrl+A
        /// selection never tears down an in-progress edit session.</summary>
        public void SyncSelectedPhotos(IReadOnlyList<PhotoItem> selected)
        {
            var summaryBefore = SelectionSummary;
            SelectedPhotos = selected;
            // Only notify when the summary text actually changed — 0<->1
            // transitions both render as empty, and a redundant notification
            // re-announces the (LiveSetting="Polite") count text to Narrator.
            if (SelectionSummary != summaryBefore)
                OnPropertyChanged(nameof(SelectionSummary));
            if (SelectionLogic.ShouldBecomeSingleTarget(selected.Count))
                SelectedPhoto = selected[0];
        }

        /// <summary>The photo Enter/double-tap should open. See
        /// SelectionLogic.ResolvePrimaryTarget for the fallback order; pure
        /// and static so it (via SelectionLogic) is unit-testable without a
        /// live GridView.</summary>
        public static PhotoItem? ResolvePrimaryTarget(
            IReadOnlyList<PhotoItem> selectedPhotos, PhotoItem? lastSelectedPhoto,
            IReadOnlyList<PhotoItem> allPhotos) =>
            SelectionLogic.ResolvePrimaryTarget(selectedPhotos, lastSelectedPhoto, allPhotos);
    }
}
