using System.Collections.Generic;
using System.Collections.ObjectModel;

namespace Maple.WinUI.ViewModels
{
    /// <summary>
    /// Multi-selection state for the library grid (#2634). SelectedPhoto (the
    /// [ObservableProperty] in EditSessionViewModel.cs) stays the single
    /// well-defined edit/preview target — the only thing OpenForEditing,
    /// decode, and the sidecar-write path ever look at. SelectedPhotos below
    /// is the grid's full multi-selection; it never drives those per-photo
    /// session operations on its own. Kept in its own partial so it can move
    /// into Maple.WinUI.Tests once that project lands on main (#2672).
    /// </summary>
    public partial class EditSessionViewModel
    {
        /// <summary>The grid's current multi-selection, in GridView.SelectedItems
        /// order. Replaced wholesale on every SelectionChanged via
        /// SyncSelectedPhotos — selections are small relative to a library, so
        /// clear-and-refill is cheap and avoids hand-rolled diffing.</summary>
        public ObservableCollection<PhotoItem> SelectedPhotos { get; } = new();

        /// <summary>Narrator-facing summary shown next to the library count.
        /// Empty for 0 or 1 selected: GridView's own SelectionItem automation
        /// peer already announces a single selection change per item, so this
        /// only speaks up for the multi-select case this ticket adds.</summary>
        public string SelectionSummary =>
            SelectedPhotos.Count > 1 ? $"{SelectedPhotos.Count} selected" : string.Empty;

        /// <summary>Called by the grid's SelectionChanged handler. Replaces the
        /// tracked multi-selection and resolves SelectedPhoto: a single
        /// selected item becomes the well-defined edit/preview target; 0 or
        /// 2+ items leave SelectedPhoto untouched so a marquee/Ctrl+A
        /// selection never tears down an in-progress edit session.</summary>
        public void SyncSelectedPhotos(IReadOnlyList<PhotoItem> selected)
        {
            SelectedPhotos.Clear();
            foreach (var photo in selected)
                SelectedPhotos.Add(photo);
            OnPropertyChanged(nameof(SelectionSummary));
            if (selected.Count == 1)
                SelectedPhoto = selected[0];
        }

        /// <summary>The photo Enter/double-tap should open: the sole
        /// selection, else the first item of a larger selection (grid order),
        /// else the last well-defined single target (the grid was fully
        /// deselected but a photo was open before that), else the first photo
        /// in the current view. Pure and static so it is unit-testable
        /// without a live GridView.</summary>
        public static PhotoItem? ResolvePrimaryTarget(
            IReadOnlyList<PhotoItem> selectedPhotos, PhotoItem? lastSelectedPhoto,
            IReadOnlyList<PhotoItem> allPhotos) =>
            selectedPhotos.Count > 0 ? selectedPhotos[0]
                : lastSelectedPhoto ?? (allPhotos.Count > 0 ? allPhotos[0] : null);
    }
}
